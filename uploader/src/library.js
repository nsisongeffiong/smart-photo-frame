import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { HttpError } from './errors.js';

// Everything here mirrors what the frame's scanner will and will not show, so
// that a photo this service accepts is a photo the frame displays.

export const ALBUM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const FRAME_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp']);
// What sharp can decode that is worth accepting. SVG is deliberately absent.
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif']);

// AVIF is decoded whole, at roughly 17 MB per megapixel (measured: 50 MP peaked
// at 952 MB, over the container's 768 MB cap; 12 MP at 294 MB). JPEG, PNG, WebP
// and TIFF stream and stay near 150-270 MB at 50 MP, so only AVIF gets a lower limit.
export const HEIF_MAX_PIXELS = 16_000_000;

const heicError = () => new HttpError(415, 'unsupported_heic', 'This looks like an iPhone HEIC photo, which this server cannot decode. On the iPhone, choose "Most Compatible" under Settings > Camera > Formats, or pick the photo from the Photos picker (which converts it to JPEG).');

const frameCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export function validAlbumName(name) {
  return typeof name === 'string' && ALBUM_RE.test(name) && !RESERVED.has(name.toLowerCase())
    && !name.endsWith(' ') && !name.endsWith('.')
    && !name.includes('..'); // the frame skips any album whose name contains ".."; so must we
}

function isPhotoName(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 255
    && !name.startsWith('.')
    && !/[\\/\0]/.test(name)
    && FRAME_EXTENSIONS.has(path.extname(name).toLowerCase());
}

class Semaphore {
  constructor(n, maxQueue = 20) { this.n = n; this.active = 0; this.queue = []; this.maxQueue = maxQueue; }
  async run(fn) {
    if (this.active >= this.n) {
      if (this.queue.length >= this.maxQueue) throw new HttpError(503, 'busy', 'The server is busy processing other photos. Try again in a moment.');
      await new Promise((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // hand the slot straight over
      else this.active -= 1;
    }
  }
}

export function sanitizeBaseName(original) {
  const base = String(original ?? '').replace(/\\/g, '/').split('/').pop();
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s_-]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, 80);
  return cleaned || 'photo';
}

export class Library {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.root = cfg.photosDir;
    // Waiting uploads already hold their bytes in memory, so keep the line short.
    this.gate = new Semaphore(cfg.concurrency, cfg.concurrency * 2);
    // Thumbnails get their own line, and they wait rather than being refused: a
    // browser asks for a whole page of them at once (HTTP/2 has no 6-connection
    // limit), and neither a broken tile nor a bounced upload is a good outcome.
    this.thumbGate = new Semaphore(2, 500);
    this.thumbs = new Map();
    this.thumbBytes = 0;
    sharp.concurrency(Math.max(1, cfg.concurrency));
    sharp.cache({ memory: 50, files: 0, items: 50 });
  }

  // ---------- albums ----------

  async albumPath(name) {
    if (!validAlbumName(name)) {
      throw new HttpError(400, 'bad_album_name', 'Album names use letters, numbers, spaces, dots, dashes and underscores (up to 64 characters, starting with a letter or number).');
    }
    const p = path.join(this.root, name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'no_such_album', 'That album does not exist.');
      throw e;
    }
    if (!st.isDirectory()) throw new HttpError(404, 'no_such_album', 'That album does not exist.');
    return p;
  }

  async listAlbums() {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const albums = [];
    const skipped = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink() || !e.isDirectory()) continue;
      if (!validAlbumName(e.name)) { skipped.push(e.name); continue; }
      albums.push({ name: e.name, count: await this.countPhotos(path.join(this.root, e.name)) });
    }
    albums.sort((a, b) => frameCompare(a.name, b.name));
    skipped.sort();
    return { albums, skipped };
  }

  async countPhotos(dir) {
    let n = 0;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isFile() && !e.isSymbolicLink() && isPhotoName(e.name)) n += 1;
    }
    return n;
  }

  async createAlbum(name) {
    if (!validAlbumName(name)) {
      throw new HttpError(400, 'bad_album_name', 'Album names use letters, numbers, spaces, dots, dashes and underscores (up to 64 characters, starting with a letter or number).');
    }
    const p = path.join(this.root, name);
    try {
      await fs.mkdir(p, { mode: 0o755 });
    } catch (e) {
      if (e.code === 'EEXIST') throw new HttpError(409, 'album_exists', 'An album with that name already exists.');
      throw e;
    }
    await fs.chmod(p, 0o755); // umask must not make it unreadable to the frame's user
    this.log.info('album created', { album: name });
  }

  async deleteAlbum(name, { withPhotos = false } = {}) {
    const dir = await this.albumPath(name);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory())) {
      throw new HttpError(409, 'has_subfolders', 'This folder contains sub-folders, so it will not be removed from here.');
    }
    if (entries.length && !withPhotos) {
      throw new HttpError(409, 'not_empty', `This album still has ${entries.length} file(s).`, { files: entries.length });
    }
    // Decide everything before removing anything: a refusal must leave the album untouched.
    const removable = (e) => e.name.startsWith('.') || isPhotoName(e.name);
    if (!entries.every(removable)) {
      throw new HttpError(409, 'has_other_files', 'This folder holds files that are not photos, so nothing was deleted.');
    }
    for (const e of entries) await fs.unlink(path.join(dir, e.name));
    try {
      await fs.rmdir(dir);
    } catch (e) {
      if (e.code === 'ENOTEMPTY') throw new HttpError(409, 'has_other_files', 'Files appeared in this folder while it was being deleted, so it was left in place.');
      throw e;
    }
    this.log.info('album deleted', { album: name });
  }

  // ---------- photos ----------

  async listPhotos(album) {
    const dir = await this.albumPath(album);
    const names = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isFile() && !e.isSymbolicLink() && isPhotoName(e.name)) names.push(e.name);
    }
    names.sort(frameCompare);
    const limit = this.cfg.frameMaxPhotos;
    const photos = [];
    for (let i = 0; i < names.length; i += 1) {
      let st;
      try { st = await fs.stat(path.join(dir, names[i])); } catch { continue; }
      photos.push({ name: names[i], size: st.size, mtimeMs: st.mtimeMs, onFrame: limit === 0 || i < limit });
    }
    return photos;
  }

  async resolvePhoto(album, file) {
    const dir = await this.albumPath(album);
    if (!isPhotoName(file)) throw new HttpError(404, 'no_such_photo', 'That photo does not exist.');
    const p = path.join(dir, file);
    let st;
    try { st = await fs.lstat(p); } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'no_such_photo', 'That photo does not exist.');
      throw e;
    }
    if (!st.isFile()) throw new HttpError(404, 'no_such_photo', 'That photo does not exist.');
    return { path: p, rel: path.join(album, file), stat: st };
  }

  async deletePhoto(album, file) {
    const { path: p } = await this.resolvePhoto(album, file);
    await fs.unlink(p);
    this.log.info('photo deleted', { album, file });
  }

  // Remove temp files left by a crash or a full disk. Call once at startup,
  // when nothing can be mid-upload. Returns how many were removed.
  async sweepTemps() {
    let removed = 0;
    for (const d of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.isSymbolicLink() || !validAlbumName(d.name)) continue;
      const dir = path.join(this.root, d.name);
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && /^\.upl-[0-9a-f]{16}\.tmp$/.test(e.name)) {
          await fs.unlink(path.join(dir, e.name)).then(() => { removed += 1; }, () => {});
        }
      }
    }
    if (removed) this.log.info('removed leftover upload temp files', { count: removed });
    return removed;
  }

  async freeBytes() {
    const s = await fs.statfs(this.root);
    return Number(s.bavail) * Number(s.bsize);
  }

  // Decode, auto-orient, shrink to fit, re-encode. This is the whole of
  //   mogrify -auto-orient -resize 2560x2560\> -quality 82 -strip
  // sharp converts to sRGB and drops all metadata (GPS included) by default.
  async convert(buffer) {
    const opts = { limitInputPixels: this.cfg.maxPixels };
    let meta;
    try {
      meta = await sharp(buffer, opts).metadata();
    } catch (e) {
      if (/pixel limit/i.test(e.message)) throw new HttpError(413, 'too_many_pixels', 'That image is larger than this server will decode.');
      throw new HttpError(415, 'not_an_image', 'That file is not an image this server can read.');
    }
    if (!INPUT_FORMATS.has(meta.format)) {
      throw new HttpError(415, 'unsupported_format', 'Only JPEG, PNG, WebP, GIF, TIFF and AVIF photos are accepted.');
    }
    if (meta.format === 'heif' && meta.compression === 'hevc') throw heicError();
    if (meta.format === 'heif' && (meta.width ?? 0) * (meta.height ?? 0) > Math.min(this.cfg.maxPixels, HEIF_MAX_PIXELS)) {
      throw new HttpError(413, 'too_many_pixels', 'That AVIF image is larger than this server will decode (about 16 megapixels). Export it as JPEG instead.');
    }
    if ((meta.pages ?? 1) > 1) {
      // A multi-image HEIC that is not AV1 is still an iPhone photo (burst, Live Photo): give the HEIC advice.
      throw meta.format === 'heif' && meta.compression !== 'av1'
        ? heicError()
        : new HttpError(415, 'animated', 'Animated images are not supported on the frame.');
    }
    const asPng = Boolean(meta.hasAlpha) && meta.format !== 'jpeg';
    try {
      let pipe = sharp(buffer, opts)
        .rotate()
        .resize({ width: this.cfg.maxEdge, height: this.cfg.maxEdge, fit: 'inside', withoutEnlargement: true });
      pipe = asPng
        ? pipe.png({ compressionLevel: 9, effort: 7 })
        : pipe.jpeg({ quality: this.cfg.jpegQuality, mozjpeg: true });
      const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
      return { data, info, ext: asPng ? '.png' : '.jpg', sourceFormat: meta.format };
    } catch (e) {
      if (meta.format === 'heif') throw heicError();
      if (/pixel limit/i.test(e.message)) throw new HttpError(413, 'too_many_pixels', 'That image is larger than this server will decode.');
      this.log.warn('image decode failed', { error: e.message });
      throw new HttpError(415, 'corrupt_image', 'That image could not be decoded. It may be damaged or cut short.');
    }
  }

  async savePhoto(album, buffer, originalName) {
    const dir = await this.albumPath(album);

    if (this.cfg.frameMaxPhotos > 0) {
      const have = await this.countPhotos(dir);
      if (have >= this.cfg.frameMaxPhotos) {
        throw new HttpError(409, 'album_full', `This album already has ${have} photos, which is the most the frame will show. Start a new album instead.`, { limit: this.cfg.frameMaxPhotos });
      }
    }
    if (this.cfg.minFreeMb > 0) {
      const free = await this.freeBytes();
      if (free < (this.cfg.minFreeMb + buffer.length / 1048576) * 1048576) {
        throw new HttpError(507, 'disk_low', 'The server is almost out of disk space.');
      }
    }

    const out = await this.gate.run(() => this.convert(buffer));
    const base = sanitizeBaseName(originalName);
    const tmp = path.join(dir, `.upl-${crypto.randomBytes(8).toString('hex')}.tmp`);
    let final;
    try {
      await fs.writeFile(tmp, out.data, { flag: 'wx', mode: 0o644 });
      await fs.chmod(tmp, 0o644);
      for (let i = 1; i <= 1000; i += 1) {
        final = `${base}${i === 1 ? '' : '-' + i}${out.ext}`;
        const target = path.join(dir, final);
        try {
          await fs.link(tmp, target); // fails with EEXIST rather than overwriting
          break;
        } catch (e) {
          if (e.code === 'EEXIST') { final = null; continue; }
          if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(e.code)) {
            // Filesystem without hard links: fall back to check-then-rename.
            try { await fs.access(target); final = null; continue; } catch { /* free */ }
            await fs.rename(tmp, target);
            break;
          }
          throw e;
        }
      }
      if (!final) throw new HttpError(409, 'name_taken', 'Too many photos share that name.');
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    this.log.info('photo saved', { album, file: final, bytesIn: buffer.length, bytesOut: out.data.length, w: out.info.width, h: out.info.height, from: out.sourceFormat });
    const count = await this.countPhotos(dir);
    return {
      name: final,
      bytesIn: buffer.length,
      bytesOut: out.data.length,
      width: out.info.width,
      height: out.info.height,
      sourceFormat: out.sourceFormat,
      albumCount: count,
    };
  }

  // ---------- thumbnails ----------

  async thumbnail(album, file, size = 320) {
    const { path: p, stat } = await this.resolvePhoto(album, file);
    const key = `${p}:${stat.mtimeMs}:${stat.size}:${size}`;
    const hit = this.thumbs.get(key);
    if (hit) { this.thumbs.delete(key); this.thumbs.set(key, hit); return hit; }
    const buf = await this.thumbGate.run(() =>
      sharp(p, { limitInputPixels: this.cfg.maxPixels })
        .rotate()
        .resize(size, size, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer()
        .catch(() => { throw new HttpError(422, 'no_preview', 'No preview available.'); }));
    this.thumbs.set(key, buf);
    this.thumbBytes += buf.length;
    while (this.thumbBytes > 32 * 1048576 || this.thumbs.size > 1000) {
      const [oldKey, oldBuf] = this.thumbs.entries().next().value;
      this.thumbs.delete(oldKey);
      this.thumbBytes -= oldBuf.length;
    }
    return buf;
  }
}
