import express from 'express';
import Busboy from 'busboy';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp({ cfg, log, auth, library }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.set('query parser', 'simple'); // plain querystring; no nested-object parsing needed here

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    if (cfg.cookieSecure) res.set('Strict-Transport-Security', 'max-age=15552000');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // Cross-site request guard for anything that changes state. SameSite=Strict
  // already keeps the cookie off cross-site requests; this is the second layer.
  app.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    const own = [req.get('host'), cfg.trustProxy ? req.get('x-forwarded-host') : null].filter(Boolean);
    if (host && own.includes(host)) return next();
    next(new HttpError(403, 'bad_origin', 'Cross-site request refused.'));
  });

  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- unauthenticated ----------

  app.get('/healthz', asyncRoute(async (_req, res) => {
    try {
      await fs.access(cfg.photosDir, fs.constants.R_OK | fs.constants.W_OK);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'photos directory is not writable' });
    }
  }));

  app.post('/api/login', express.json({ limit: '4kb' }), (req, res, next) => {
    const wait = auth.retryAfterSeconds(req.ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return next(new HttpError(429, 'too_many_attempts', `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minute(s).`));
    }
    if (!auth.checkPassword(req.body?.password)) {
      auth.recordFailure(req.ip);
      log.warn('login failed', { ip: req.ip });
      return next(new HttpError(401, 'bad_password', 'That password is not right.'));
    }
    auth.clearFailures(req.ip);
    res.set('Set-Cookie', auth.setCookieHeader(auth.issue()));
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.set('Set-Cookie', auth.clearCookieHeader());
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    if (!auth.isAuthenticated(req)) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      limits: { maxUploadMb: cfg.maxUploadMb, maxEdge: cfg.maxEdge, frameMaxPhotos: cfg.frameMaxPhotos },
    });
  });

  // ---------- authenticated API ----------

  const api = express.Router();
  api.use(auth.require);

  const albumsPayload = async () => {
    const { albums, skipped } = await library.listAlbums();
    return { albums, skipped, frameMaxPhotos: cfg.frameMaxPhotos };
  };

  api.get('/albums', asyncRoute(async (_req, res) => res.json(await albumsPayload())));

  api.post('/albums', express.json({ limit: '4kb' }), asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    await library.createAlbum(name);
    res.status(201).json({ name });
  }));

  api.delete('/albums/:name', asyncRoute(async (req, res) => {
    await library.deleteAlbum(req.params.name, { withPhotos: req.query.withPhotos === '1' });
    res.json({ ok: true });
  }));

  api.get('/albums/:name/photos', asyncRoute(async (req, res) => {
    const photos = await library.listPhotos(req.params.name);
    res.json({ album: req.params.name, photos, frameMaxPhotos: cfg.frameMaxPhotos });
  }));

  api.delete('/albums/:name/photos/:file', asyncRoute(async (req, res) => {
    await library.deletePhoto(req.params.name, req.params.file);
    res.json({ ok: true });
  }));

  // One photo per request. The page sends a queue of them one after another,
  // so a failure on photo 37 of 80 loses only photo 37.
  api.post('/albums/:name/photos', asyncRoute(async (req, res) => {
    const maxBytes = cfg.maxUploadMb * 1048576;
    const declared = Number(req.get('content-length') || 0);
    if (declared > maxBytes + 65536) {
      res.set('Connection', 'close');
      throw new HttpError(413, 'too_large', `That file is larger than the ${cfg.maxUploadMb} MB limit.`);
    }
    const type = req.get('content-type') || '';
    if (!/^multipart\/form-data/i.test(type)) throw new HttpError(415, 'not_multipart', 'Send the photo as multipart/form-data.');
    await library.albumPath(req.params.name); // fail fast, before reading the body

    const upload = await new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 4, parts: 8, fileSize: maxBytes, fieldSize: 1024 } });
      } catch {
        return reject(new HttpError(400, 'bad_upload', 'The upload was not formed correctly.'));
      }
      const chunks = [];
      let filename = '';
      let got = false;
      let tooBig = false;
      bb.on('file', (_field, stream, info) => {
        got = true;
        filename = info.filename || '';
        stream.on('data', (c) => { chunks.push(c); });
        stream.on('limit', () => { tooBig = true; chunks.length = 0; });
      });
      bb.on('filesLimit', () => reject(new HttpError(400, 'one_file', 'Send one photo per request.')));
      bb.on('error', () => reject(new HttpError(400, 'bad_upload', 'The upload was not formed correctly.')));
      bb.on('close', () => {
        if (tooBig) return reject(new HttpError(413, 'too_large', `That file is larger than the ${cfg.maxUploadMb} MB limit.`));
        if (!got || chunks.length === 0) return reject(new HttpError(400, 'no_file', 'No photo was received.'));
        resolve({ buffer: Buffer.concat(chunks), filename });
      });
      // Client went away before the body finished: settle the promise so it cannot hang.
      req.on('close', () => { if (!req.complete) reject(new HttpError(400, 'aborted', 'The upload was interrupted.')); });
      req.pipe(bb);
    });

    const result = await library.savePhoto(req.params.name, upload.buffer, upload.filename);
    res.status(201).json({
      ...result,
      onFrame: cfg.frameMaxPhotos === 0 || result.albumCount <= cfg.frameMaxPhotos,
    });
  }));

  app.use('/api', api);

  // Images are fetched by <img> tags, which send the cookie, so these use the
  // same gate as the API.
  app.get('/thumb/:album/:file', auth.require, asyncRoute(async (req, res) => {
    const buf = await library.thumbnail(req.params.album, req.params.file);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }).send(buf);
  }));

  app.get('/photo/:album/:file', auth.require, asyncRoute(async (req, res) => {
    const { rel } = await library.resolvePhoto(req.params.album, req.params.file);
    res.set('Cache-Control', 'private, max-age=300');
    // `root` keeps send's dotfile check to the relative part, so a photos
    // directory that itself sits under a dot-folder still works.
    res.sendFile(rel, { root: library.root, dotfiles: 'deny' });
  }));

  // ---------- static page ----------

  app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: 'index.html', maxAge: 0, etag: true }));

  app.use((req, _res, next) => next(new HttpError(404, 'not_found', 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (res.headersSent) return req.destroy();
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ error: 'bad_request', message: 'The request could not be read.' });
    }
    if (err?.status === 400 && err.name === 'URIError') {
      return res.status(400).json({ error: 'bad_request', message: 'Bad request.' });
    }
    log.error('unhandled error', { path: req.path, error: err?.message, code: err?.code });
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  });

  return app;
}
