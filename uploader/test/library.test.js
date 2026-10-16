import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { startApp, jpeg, png, exists } from './helpers.js';
import { sanitizeBaseName, validAlbumName } from '../src/library.js';

const setup = async (t, env) => { const a = await startApp(env); t.after(() => a.close()); await a.login(); return a; };
const mkAlbum = async (a, name = 'Family') => { const r = await a.req('POST', '/api/albums', { json: { name } }); assert.equal(r.status, 201); };
const leftovers = async (dir) => (await fs.readdir(dir)).filter((f) => f.startsWith('.upl-'));

// ---------- names ----------

test('album names match exactly what the frame accepts', () => {
  for (const ok of ['Family', 'Summer 2026', 'a', 'x_y-z.1', 'A'.repeat(64)]) assert.ok(validAlbumName(ok), ok);
  for (const bad of ['', '.hidden', '-lead', ' lead', 'trail ', 'trail.', '../x', 'a/b', 'a\\b', 'a\0b', 'A'.repeat(65), 'café',
    '__proto__', 'constructor', 'prototype', 'Constructor', '<img src=x onerror=alert(1)>', 'a\nb']) {
    assert.ok(!validAlbumName(bad), JSON.stringify(bad));
  }
  assert.ok(!validAlbumName(undefined) && !validAlbumName(42) && !validAlbumName(null));
});

test('uploaded file names are reduced to a safe base name', () => {
  assert.equal(sanitizeBaseName('IMG_0001.JPG'), 'IMG_0001');
  assert.equal(sanitizeBaseName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeBaseName('..\\..\\win.jpg'), 'win');
  assert.equal(sanitizeBaseName('.hidden.jpg'), 'hidden');
  assert.equal(sanitizeBaseName('café ☃.jpg'), 'cafe _');
  assert.equal(sanitizeBaseName('   '), 'photo');
  assert.equal(sanitizeBaseName(''), 'photo');
  assert.equal(sanitizeBaseName(undefined), 'photo');
  assert.equal(sanitizeBaseName('<script>.jpg'), 'script_');
  assert.ok(sanitizeBaseName('x'.repeat(300)).length <= 80);
  assert.equal(sanitizeBaseName('a\u0000b.jpg'), 'a_b');
});

// ---------- albums ----------

test('create, list, duplicate and delete an album', async (t) => {
  const a = await setup(t);
  await mkAlbum(a, 'Summer 2026');
  const st = await fs.stat(path.join(a.photos, 'Summer 2026'));
  assert.equal(st.mode & 0o777, 0o755, 'world-readable so the frame container can list it');
  assert.equal((await a.req('POST', '/api/albums', { json: { name: 'Summer 2026' } })).status, 409);
  assert.deepEqual((await a.req('GET', '/api/albums')).data.albums, [{ name: 'Summer 2026', count: 0 }]);
  assert.equal((await a.req('DELETE', '/api/albums/Summer%202026')).status, 200);
  assert.equal(await exists(path.join(a.photos, 'Summer 2026')), false);
  assert.equal((await a.req('DELETE', '/api/albums/Summer%202026')).status, 404);
});

test('hostile album names are rejected and nothing is created', async (t) => {
  const a = await setup(t);
  for (const name of ['../escape', '__proto__', 'constructor', '.hidden', 'a/b', '', ' ', 'x'.repeat(65), '<img src=x onerror=alert(1)>', 42, null, { toString: 'x' }]) {
    const r = await a.req('POST', '/api/albums', { json: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
  }
  assert.deepEqual(await fs.readdir(a.photos), []);
  assert.deepEqual(await fs.readdir(path.dirname(a.photos)), ['photos']);
});

test('path-traversal in the URL cannot reach outside the album tree', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await fs.writeFile(path.join(path.dirname(a.photos), 'secret.jpg'), await jpeg(10, 10));
  for (const u of ['/api/albums/..%2F/photos', '/api/albums/..%2Fphotos/photos', '/api/albums/%2e%2e/photos', '/api/albums/Family/photos/..%2F..%2Fsecret.jpg',
    '/thumb/Family/..%2Fsecret.jpg', '/photo/Family/..%2F..%2Fsecret.jpg', '/photo/..%2F/secret.jpg', '/photo/Family/%2e%2e%2fsecret.jpg']) {
    const r = await a.req(u.startsWith('/api') && !u.includes('/photos/') ? 'GET' : (u.startsWith('/api') ? 'DELETE' : 'GET'), u);
    assert.ok([400, 404].includes(r.status), `${u} -> ${r.status}`);
  }
  assert.ok(await exists(path.join(path.dirname(a.photos), 'secret.jpg')));
});

test('symlinked, dot-prefixed and oddly named folders are not listed as albums', async (t) => {
  const a = await setup(t);
  await mkAlbum(a, 'Real');
  await fs.mkdir(path.join(a.photos, '.hidden'));
  await fs.mkdir(path.join(a.photos, 'café'));
  await fs.symlink('/tmp', path.join(a.photos, 'Link'));
  await fs.writeFile(path.join(a.photos, 'stray.jpg'), 'x');
  const d = (await a.req('GET', '/api/albums')).data;
  assert.deepEqual(d.albums.map((x) => x.name), ['Real']);
  assert.deepEqual(d.skipped, ['café']);
  assert.equal((await a.req('GET', '/api/albums/Link/photos')).status, 404);
});

test('deleting a non-empty album needs explicit confirmation and removes only photos', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await a.upload('Family', await jpeg(100, 80), 'a.jpg');
  const refuse = await a.req('DELETE', '/api/albums/Family');
  assert.equal(refuse.status, 409);
  assert.equal(refuse.data.error, 'not_empty');
  assert.ok(await exists(path.join(a.photos, 'Family')));
  await fs.mkdir(path.join(a.photos, 'Family', 'sub'));
  assert.equal((await a.req('DELETE', '/api/albums/Family?withPhotos=1')).data?.error, 'has_subfolders');
  await fs.rmdir(path.join(a.photos, 'Family', 'sub'));
  await fs.writeFile(path.join(a.photos, 'Family', 'notes.txt'), 'keep me');
  assert.equal((await a.req('DELETE', '/api/albums/Family?withPhotos=1')).data?.error, 'has_other_files');
  assert.ok(await exists(path.join(a.photos, 'Family', 'notes.txt')), 'non-photo files are never deleted');
  await fs.unlink(path.join(a.photos, 'Family', 'notes.txt'));
  assert.equal((await a.req('DELETE', '/api/albums/Family?withPhotos=1')).status, 200);
  assert.equal(await exists(path.join(a.photos, 'Family')), false);
});

// ---------- the conversion (the mogrify flow) ----------

test('large photos are shrunk to fit 2560 px, re-encoded and made world-readable', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const src = await jpeg(5000, 3000);
  const r = await a.upload('Family', src, 'IMG_0001.JPG');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.name, 'IMG_0001.jpg');
  assert.equal(r.data.width, 2560);
  assert.equal(r.data.height, 1536);
  const file = path.join(a.photos, 'Family', 'IMG_0001.jpg');
  const meta = await sharp(file).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 2560);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  assert.deepEqual(await leftovers(path.join(a.photos, 'Family')), []);
});

test('small photos are never enlarged', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const r = await a.upload('Family', await jpeg(800, 600), 'small.jpg');
  assert.deepEqual([r.data.width, r.data.height], [800, 600]);
});

test('EXIF orientation is applied, then the tag and all metadata are removed', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const src = await jpeg(3000, 2000, { orientation: 6, exif: { IFD0: { Copyright: 'private-note', Software: 'secret-cam' } } });
  assert.equal((await sharp(src).metadata()).orientation, 6);
  const r = await a.upload('Family', src, 'rot.jpg');
  assert.deepEqual([r.data.width, r.data.height], [1707, 2560], 'portrait after rotation, fit to 2560');
  const out = await fs.readFile(path.join(a.photos, 'Family', 'rot.jpg'));
  const meta = await sharp(out).metadata();
  assert.equal(meta.orientation, undefined);
  assert.equal(meta.exif, undefined);
  assert.ok(!out.includes(Buffer.from('private-note')) && !out.includes(Buffer.from('secret-cam')));
});

test('wide-gamut photos are converted to sRGB rather than just stripped', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  // pixel value 200,100,50 interpreted in Display P3; in sRGB that is clearly more saturated
  const src = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } } }).withIccProfile('p3', { attach: false }).jpeg({ quality: 100 }).toBuffer();
  const tagged = await sharp(src).withIccProfile('p3', { attach: true }).toBuffer().catch(() => null);
  if (!tagged) return t.skip('this sharp build cannot attach a P3 profile');
  await a.upload('Family', tagged, 'p3.jpg');
  const out = path.join(a.photos, 'Family', 'p3.jpg');
  assert.equal((await sharp(out).metadata()).icc, undefined, 'no profile left behind');
  assert.equal((await sharp(out).metadata()).space, 'srgb');
});

test('PNG with transparency stays PNG; opaque PNG becomes JPEG', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  assert.equal((await a.upload('Family', await png(50, 50, true), 'logo.png')).data.name, 'logo.png');
  assert.equal((await a.upload('Family', await png(50, 50, false), 'shot.png')).data.name, 'shot.jpg');
  assert.equal((await sharp(path.join(a.photos, 'Family', 'logo.png')).metadata()).format, 'png');
});

test('WebP is accepted and stored as JPEG', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const webp = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#336699' } }).webp().toBuffer();
  const r = await a.upload('Family', webp, 'pic.webp');
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'pic.jpg');
  assert.equal(r.data.sourceFormat, 'webp');
});

test('the same name uploaded again gets a numeric suffix, never an overwrite', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const img = await jpeg(100, 100);
  const names = [];
  for (let i = 0; i < 3; i += 1) names.push((await a.upload('Family', img, 'dup.jpg')).data.name);
  assert.deepEqual(names, ['dup.jpg', 'dup-2.jpg', 'dup-3.jpg']);
});

test('parallel uploads with one name all survive', async (t) => {
  const a = await setup(t, { PROCESS_CONCURRENCY: '6' }); // 6 + 2 uploads may be in flight
  await mkAlbum(a);
  const img = await jpeg(100, 100);
  const rs = await Promise.all(Array.from({ length: 8 }, () => a.upload('Family', img, 'same.jpg')));
  assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
  assert.equal(new Set(rs.map((r) => r.data.name)).size, 8);
  assert.equal((await fs.readdir(path.join(a.photos, 'Family'))).length, 8);
  assert.deepEqual(await leftovers(path.join(a.photos, 'Family')), []);
});

test('hostile file names cannot write outside the album', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  for (const name of ['../../evil.jpg', '..\\..\\evil.jpg', '/etc/cron.d/x.jpg', '.htaccess.jpg', 'CON.jpg', '%2e%2e%2fevil.jpg']) {
    const r = await a.upload('Family', await jpeg(20, 20), name);
    assert.equal(r.status, 201, name);
  }
  // A NUL byte makes the multipart header itself invalid; refusing it is fine.
  assert.equal((await a.upload('Family', await jpeg(20, 20), 'a\0b.jpg')).status, 400);
  assert.deepEqual(await fs.readdir(path.dirname(a.photos)), ['photos']);
  assert.deepEqual(await fs.readdir(a.photos), ['Family']);
  for (const f of await fs.readdir(path.join(a.photos, 'Family'))) assert.ok(!f.startsWith('.') && !f.includes('/'), f);
});

test('things that are not photos are refused with a clear reason', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const cases = {
    'text renamed .jpg': Buffer.from('this is not an image'),
    'svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'),
    'html': Buffer.from('<html><script>alert(1)</script></html>'),
    'truncated jpeg': (await jpeg(400, 400)).subarray(0, 300),
    'zip': Buffer.from('PK\u0003\u0004rest-of-zip'),
  };
  for (const [label, buf] of Object.entries(cases)) {
    const r = await a.upload('Family', buf, 'x.jpg');
    assert.ok([415].includes(r.status), `${label}: ${r.status} ${r.text}`);
  }
  assert.deepEqual(await fs.readdir(path.join(a.photos, 'Family')), []);
});

test('animated GIFs are refused rather than flattened', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const frame = (c) => sharp({ create: { width: 20, height: 20, channels: 3, background: c } }).raw().toBuffer();
  const frames = Buffer.concat([await frame('#f00'), await frame('#0f0'), await frame('#00f')]);
  const gif = await sharp(frames, { raw: { width: 20, height: 60, channels: 3, pageHeight: 20 } }).gif({ loop: 0, delay: [100, 100, 100] }).toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 3, 'fixture really is animated');
  const r = await a.upload('Family', gif, 'anim.gif');
  assert.equal(r.status, 415);
  assert.equal(r.data.error, 'animated');
});

test('an image with too many pixels is refused before it is decoded', async (t) => {
  const a = await setup(t, { MAX_PIXELS: '1000000' });
  await mkAlbum(a);
  const r = await a.upload('Family', await jpeg(2000, 1000), 'big.jpg');
  assert.equal(r.status, 413);
  assert.equal(r.data.error, 'too_many_pixels');
});

test('files over the size limit are refused', async (t) => {
  const a = await setup(t, { MAX_UPLOAD_MB: '1' });
  await mkAlbum(a);
  const noise = Buffer.alloc(1048576 + 4096, 7); // just over the limit, inside the header slack
  const r = await a.upload('Family', noise, 'huge.jpg');
  assert.equal(r.status, 413);
  assert.equal(r.data.error, 'too_large');
  assert.deepEqual(await fs.readdir(path.join(a.photos, 'Family')), []);
});

test('a declared length far beyond the limit is refused up front', async (t) => {
  const a = await setup(t, { MAX_UPLOAD_MB: '1' });
  await mkAlbum(a);
  let status;
  try {
    status = (await a.upload('Family', Buffer.alloc(3 * 1048576, 1), 'huge.jpg')).status;
  } catch (e) {
    status = 'connection closed early'; // the server may hang up before reading the body
  }
  assert.ok(status === 413 || status === 'connection closed early', String(status));
  assert.deepEqual(await fs.readdir(path.join(a.photos, 'Family')), []);
});

test('uploading to a missing album, or without a file, fails cleanly', async (t) => {
  const a = await setup(t);
  assert.equal((await a.upload('Nope', await jpeg(10, 10))).status, 404);
  await mkAlbum(a);
  const form = new FormData(); form.append('note', 'hello');
  assert.equal((await a.req('POST', '/api/albums/Family/photos', { form })).data.error, 'no_file');
  assert.equal((await a.req('POST', '/api/albums/Family/photos', { json: { a: 1 } })).status, 415);
});

test('an album that has reached the frame\'s limit refuses more photos', async (t) => {
  const a = await setup(t, { FRAME_MAX_PHOTOS_PER_ALBUM: '2' });
  await mkAlbum(a);
  const img = await jpeg(50, 50);
  assert.equal((await a.upload('Family', img, 'a.jpg')).status, 201);
  assert.equal((await a.upload('Family', img, 'b.jpg')).status, 201);
  const r = await a.upload('Family', img, 'c.jpg');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'album_full');
  assert.equal((await fs.readdir(path.join(a.photos, 'Family'))).length, 2);
});

test('photos past the frame\'s limit are flagged in the listing', async (t) => {
  const a = await setup(t, { FRAME_MAX_PHOTOS_PER_ALBUM: '2' });
  await mkAlbum(a);
  const img = await jpeg(20, 20);
  for (const n of ['p1.jpg', 'p2.jpg', 'p10.jpg']) await fs.writeFile(path.join(a.photos, 'Family', n), img);
  const { photos } = (await a.req('GET', '/api/albums/Family/photos')).data;
  assert.deepEqual(photos.map((p) => [p.name, p.onFrame]), [['p1.jpg', true], ['p2.jpg', true], ['p10.jpg', false]], 'natural order: p2 before p10, as the frame sorts');
});

test('the server refuses uploads when the disk is nearly full', async (t) => {
  const a = await setup(t, { MIN_FREE_MB: '1000000' });
  await mkAlbum(a);
  const r = await a.upload('Family', await jpeg(20, 20));
  assert.equal(r.status, 507);
});

// ---------- photos ----------

test('list, preview, open and delete a photo', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await a.upload('Family', await jpeg(2000, 1000), 'view me.jpg');
  const list = (await a.req('GET', '/api/albums/Family/photos')).data.photos;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'view me.jpg');
  assert.equal(list[0].onFrame, true);

  const thumb = await fetch(a.base + '/thumb/Family/view%20me.jpg', { headers: { cookie: a.cookie } });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const tm = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.deepEqual([tm.width, tm.height], [320, 320]);

  const full = await fetch(a.base + '/photo/Family/view%20me.jpg', { headers: { cookie: a.cookie } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');

  assert.equal((await a.req('DELETE', '/api/albums/Family/photos/view%20me.jpg')).status, 200);
  assert.equal((await a.req('DELETE', '/api/albums/Family/photos/view%20me.jpg')).status, 404);
  assert.deepEqual((await a.req('GET', '/api/albums/Family/photos')).data.photos, []);
});

test('only image files can be fetched or deleted through the photo routes', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await fs.writeFile(path.join(a.photos, 'Family', 'notes.txt'), 'hello');
  await fs.writeFile(path.join(a.photos, 'Family', '.secret.jpg'), 'hidden');
  await fs.symlink('/etc/passwd', path.join(a.photos, 'Family', 'link.jpg'));
  for (const f of ['notes.txt', '.secret.jpg', 'link.jpg']) {
    assert.equal((await a.req('GET', `/photo/Family/${f}`)).status, 404, f);
    assert.equal((await a.req('DELETE', `/api/albums/Family/photos/${f}`)).status, 404, f);
  }
  assert.ok(await exists(path.join(a.photos, 'Family', 'notes.txt')));
  assert.deepEqual((await a.req('GET', '/api/albums/Family/photos')).data.photos, []);
});

test('a photo that cannot be previewed gives a 422, not a crash', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await fs.writeFile(path.join(a.photos, 'Family', 'broken.jpg'), 'not really a jpeg');
  assert.equal((await a.req('GET', '/thumb/Family/broken.jpg')).status, 422);
  assert.equal((await a.req('GET', '/healthz')).status, 200);
});

test('healthz reports a photos directory that is not writable', async (t) => {
  const a = await setup(t);
  assert.equal((await a.req('GET', '/healthz')).status, 200);
  await fs.rm(a.photos, { recursive: true });
  assert.equal((await a.req('GET', '/healthz')).status, 503);
});

test('a photos directory that sits under a dot-folder still serves photos', async (t) => {
  const os = await import('node:os');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), '.dotparent-'));
  const dir = path.join(parent, 'photos');
  await fs.mkdir(dir);
  const a = await startApp({ PHOTOS_DIR: dir });
  t.after(async () => { await a.close(); await fs.rm(parent, { recursive: true, force: true }); });
  await a.login();
  await mkAlbum(a);
  await a.upload('Family', await jpeg(100, 100), 'a.jpg');
  const r = await fetch(a.base + '/photo/Family/a.jpg', { headers: { cookie: a.cookie } });
  assert.equal(r.status, 200);
});

test('when the line of waiting uploads is full the server says so instead of piling up memory', async (t) => {
  const a = await setup(t, { PROCESS_CONCURRENCY: '1' });
  await mkAlbum(a);
  const heavy = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#888', noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => a.upload('Family', heavy, `h${i}.jpg`)));
  const ok = rs.filter((r) => r.status === 201).length;
  const busy = rs.filter((r) => r.status === 503 && r.data.error === 'busy').length;
  assert.equal(ok + busy, 12, rs.map((r) => r.status).join());
  assert.ok(busy >= 1, 'expected some uploads to be turned away');
  assert.ok(ok >= 3, 'the ones that fit were still served');
  assert.equal((await fs.readdir(path.join(a.photos, 'Family'))).length, ok);
});

test('a client that disconnects mid-upload leaves nothing behind and the server keeps working', async (t) => {
  const net = await import('node:net');
  const a = await setup(t);
  await mkAlbum(a);
  await new Promise((resolve) => {
    const sock = net.connect(new URL(a.base).port, '127.0.0.1', () => {
      sock.write([
        'POST /api/albums/Family/photos HTTP/1.1', 'Host: x', `Cookie: ${a.cookie}`,
        'Content-Type: multipart/form-data; boundary=zz', 'Content-Length: 900000', '', '--zz',
        'Content-Disposition: form-data; name="file"; filename="a.jpg"', 'Content-Type: image/jpeg', '', 'partial-bytes',
      ].join('\r\n'));
      setTimeout(() => { sock.destroy(); resolve(); }, 100);
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await a.req('GET', '/healthz')).status, 200);
  assert.deepEqual(await fs.readdir(path.join(a.photos, 'Family')), []);
  assert.equal((await a.upload('Family', await jpeg(50, 50), 'after.jpg')).status, 201);
});

// ---------- findings from the audit ----------

test('a refused album delete leaves every photo in place', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await a.upload('Family', await jpeg(100, 100), 'a.jpg');
  await a.upload('Family', await jpeg(100, 100), 'b.jpg');
  await fs.writeFile(path.join(a.photos, 'Family', 'clip.MOV'), 'video');
  const r = await a.req('DELETE', '/api/albums/Family?withPhotos=1');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'has_other_files');
  assert.deepEqual((await fs.readdir(path.join(a.photos, 'Family'))).sort(), ['a.jpg', 'b.jpg', 'clip.MOV']);
});

test('dotfiles go with a confirmed delete, photos and all', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  await a.upload('Family', await jpeg(100, 100), 'a.jpg');
  await fs.writeFile(path.join(a.photos, 'Family', '.DS_Store'), 'x');
  assert.equal((await a.req('DELETE', '/api/albums/Family?withPhotos=1')).status, 200);
  assert.equal(await exists(path.join(a.photos, 'Family')), false);
});

test('names the frame would skip are refused here too (double dots)', async (t) => {
  assert.ok(!validAlbumName('Trip..2020'));
  assert.ok(validAlbumName('Trip.2020') && validAlbumName('a.b.c'));
  const a = await setup(t);
  assert.equal((await a.req('POST', '/api/albums', { json: { name: 'Trip..2020' } })).status, 400);
  await fs.mkdir(path.join(a.photos, 'Old..Trip'));
  const l = (await a.req('GET', '/api/albums')).data;
  assert.deepEqual(l.albums, []);
  assert.deepEqual(l.skipped, ['Old..Trip']);
});

test('a page full of thumbnails is served, none refused, and uploads still get through', async (t) => {
  const a = await setup(t, { PROCESS_CONCURRENCY: '1' });
  await mkAlbum(a);
  const img = await jpeg(800, 600);
  for (let i = 0; i < 30; i += 1) await fs.writeFile(path.join(a.photos, 'Family', `p${String(i).padStart(2, '0')}.jpg`), img, { mode: 0o644 });
  const [up, ...thumbs] = await Promise.all([
    a.upload('Family', await jpeg(100, 100), 'new.jpg'),
    ...Array.from({ length: 30 }, (_, i) => a.req('GET', `/thumb/Family/p${String(i).padStart(2, '0')}.jpg`)),
  ]);
  assert.equal(up.status, 201, up.text);
  assert.deepEqual([...new Set(thumbs.map((r) => r.status))], [200]);
});

test('a failed write leaves no temp file, and leftovers from a crash are swept at startup', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const dir = path.join(a.photos, 'Family');
  // Make the write fail: the temp name is taken by a directory.
  const orig = (await import('node:fs/promises')).default.writeFile;
  const fsp = (await import('node:fs/promises')).default;
  fsp.writeFile = async (p, ...rest) => { if (String(p).includes('.upl-')) { await orig(p, 'partial'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } return orig(p, ...rest); };
  let r;
  try { r = await a.upload('Family', await jpeg(100, 100), 'x.jpg'); } finally { fsp.writeFile = orig; }
  assert.equal(r.status, 500);
  assert.deepEqual(await leftovers(dir), [], 'the partial temp file was removed');

  await fs.writeFile(path.join(dir, '.upl-0123456789abcdef.tmp'), 'junk');
  await fs.writeFile(path.join(dir, '.upl-notours.tmp'), 'keep');          // wrong shape: not ours
  await fs.writeFile(path.join(dir, 'keep.jpg'), await jpeg(10, 10));
  assert.equal(await a.library.sweepTemps(), 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.upl-notours.tmp', 'keep.jpg']);
});

test('uploads past the in-flight limit are refused before their bodies are read', async (t) => {
  const net = await import('node:net');
  const a = await setup(t, { PROCESS_CONCURRENCY: '1' }); // limit: 3 in flight
  await mkAlbum(a);
  const port = new URL(a.base).port;
  const open = [];
  const start = () => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(['POST /api/albums/Family/photos HTTP/1.1', 'Host: x', `Cookie: ${a.cookie}`, 'Content-Type: multipart/form-data; boundary=zz',
        'Content-Length: 5000000', '', '--zz', 'Content-Disposition: form-data; name="file"; filename="a.jpg"', 'Content-Type: image/jpeg', '', 'start'].join('\r\n'));
      open.push(sock);
      setTimeout(resolve, 80);
    });
  });
  t.after(() => open.forEach((s) => s.destroy()));
  for (let i = 0; i < 3; i += 1) await start(); // three slow uploads, bodies never finished
  const r = await a.upload('Family', await jpeg(50, 50), 'fourth.jpg');
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'busy');
  open.forEach((s) => s.destroy());
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await a.upload('Family', await jpeg(50, 50), 'after.jpg')).status, 201, 'slots are released when clients go away');
});

test('AVIF is decoded whole, so it has a lower size limit than other formats', async (t) => {
  const a = await setup(t);
  await mkAlbum(a);
  const avif = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#468' } }).avif({ quality: 30, effort: 0 }).toBuffer();
  const small = await a.upload('Family', await avif(2000, 1500), 'ok.avif');
  assert.equal(small.status, 201, small.text);
  assert.equal(small.data.sourceFormat, 'heif');
  const big = await a.upload('Family', await avif(5000, 4000), 'big.avif'); // 20 MP
  assert.equal(big.status, 413);
  assert.equal(big.data.error, 'too_many_pixels');
  assert.match(big.data.message, /AVIF/);
});

test('the compose file forwards every setting the README documents', async () => {
  const compose = await fs.readFile(new URL('../docker-compose.yaml', import.meta.url), 'utf8');
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const documented = [...readme.matchAll(/^\| `([A-Z_]+)`(?: \/ `([A-Z_]+)`)?/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
  const hostOnly = new Set(['UPLOAD_UID', 'UPLOAD_GID', 'PHOTOS_HOST_DIR', 'PORT', 'PHOTOS_DIR']);
  const missing = documented.filter((k) => !hostOnly.has(k) && !new RegExp(`^\\s+${k}:`, 'm').test(compose));
  assert.deepEqual(missing, []);
});
