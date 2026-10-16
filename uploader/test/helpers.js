import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Auth } from '../src/auth.js';
import { Library } from '../src/library.js';
import { createApp } from '../src/app.js';

export const PASSWORD = 'correct horse battery staple';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// Start the real app on an ephemeral port with a throwaway photos directory.
export async function startApp(env = {}, { now, maxTracked } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-'));
  const photos = path.join(dir, 'photos');
  await fs.mkdir(photos);
  const cfg = loadConfig({ UPLOAD_PASSWORD: PASSWORD, PHOTOS_DIR: photos, MIN_FREE_MB: '0', ...env });
  const auth = new Auth(cfg, { ...(now ? { now } : {}), ...(maxTracked ? { maxTracked } : {}) });
  const library = new Library(cfg, quiet);
  const app = createApp({ cfg, log: quiet, auth, library });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = {
    cfg, auth, library, photos, base, server,
    cookie: '',
    async close() {
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      await fs.rm(dir, { recursive: true, force: true });
    },
    // fetch with the session cookie attached
    async req(method, url, { json, form, headers = {}, cookie = ctx.cookie, raw } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      let body;
      if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form;
      if (raw !== undefined) body = raw;
      const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, headers: res.headers, text, data };
    },
    async login(password = PASSWORD, headers = {}) {
      const r = await ctx.req('POST', '/api/login', { json: { password }, headers, cookie: '' });
      const sc = r.headers.get('set-cookie');
      if (r.status === 200 && sc) ctx.cookie = sc.split(';')[0];
      return r;
    },
    async upload(album, buf, filename = 'photo.jpg', opts = {}) {
      const form = new FormData();
      form.append('file', new Blob([buf]), filename);
      return ctx.req('POST', `/api/albums/${encodeURIComponent(album)}/photos`, { form, ...opts });
    },
  };
  return ctx;
}

export async function jpeg(w, h, { orientation, exif, icc, color = { r: 200, g: 100, b: 50 } } = {}) {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: color } });
  if (icc) p = p.withIccProfile(icc);
  if (orientation) p = p.withMetadata({ orientation });
  if (exif) p = p.withExif(exif);
  return p.jpeg({ quality: 90 }).toBuffer();
}

export async function png(w, h, alpha) {
  return sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 10, g: 200, b: 10, alpha: 0.5 } : { r: 10, g: 200, b: 10 } } }).png().toBuffer();
}

// A stand-in for Home Assistant, used only to let the real frame server boot.
export async function stubHA({ options = ['old'], status = 200 } = {}) {
  const calls = [];
  const state = { options: [...options], status };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (state.status !== 200) { res.writeHead(state.status).end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/states/input_select.photo_frame_album') {
        res.end(JSON.stringify({ state: state.options[0], attributes: { options: state.options } }));
      } else if (req.method === 'POST' && req.url === '/api/services/input_select/set_options') {
        state.options = JSON.parse(body).options;
        res.end('[]');
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls, state,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
  };
}

export const exists = (p) => fs.access(p).then(() => true, () => false);
