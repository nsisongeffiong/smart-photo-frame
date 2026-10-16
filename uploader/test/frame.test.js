import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startApp, stubHA, jpeg, png } from './helpers.js';

// Integration: photos saved by the uploader must show up on the real frame
// server. This runs the frame's own server.js as a child process against the
// same directory. It is skipped when the frame source is not alongside:
//   FRAME_SERVER=/path/to/server.js npm test      (or keep it at ../server.js)

const candidates = [process.env.FRAME_SERVER, path.join(import.meta.dirname, '..', '..', 'server.js')].filter(Boolean);
let frameServer = null;
for (const c of candidates) { try { await fs.access(c); frameServer = c; break; } catch { /* next */ } }

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const until = async (fn, what, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 250));
  }
};

test('photos and albums made by the uploader appear on the real frame server', { skip: !frameServer && 'frame server.js not found (set FRAME_SERVER)' }, async (t) => {
  const a = await startApp({ MAX_EDGE: '2560' });
  const ha = await stubHA();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-'));
  await fs.copyFile(frameServer, path.join(work, 'server.js'));
  await fs.mkdir(path.join(work, 'public'));
  await fs.writeFile(path.join(work, 'public', 'index.html'), '<!doctype html><title>frame</title>');
  await fs.writeFile(path.join(work, 'package.json'), '{"type":"module"}');
  await fs.symlink(path.join(import.meta.dirname, '..', 'node_modules'), path.join(work, 'node_modules'));

  const port = await freePort();
  const key = [...'0123456789abcdefghijklmnopqrstuvwxyz'].sort(() => 0.5 - Math.random()).join('') + 'Z9';
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: work,
    env: { PATH: process.env.PATH, PORT: String(port), HA_BASE_URL: ha.url, HA_TOKEN: 'frame-test-token', FRAME_KEY: key, PHOTOS_DIR: a.photos, SCAN_MS: '5000', HA_POLL_MS: '1000', TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  t.after(async () => { child.kill('SIGKILL'); await ha.close(); await a.close(); await fs.rm(work, { recursive: true, force: true }); });

  const frame = `http://127.0.0.1:${port}`;
  const health = () => fetch(frame + '/healthz').then((r) => r.json());
  await until(() => health().then((h) => h.ok), 'frame to start\n' + logs);

  // Use the uploader exactly as the person would.
  await a.login();
  for (const name of ['Family', 'Summer 2026', 'Kids.2']) assert.equal((await a.req('POST', '/api/albums', { json: { name } })).status, 201);
  const ups = [
    await a.upload('Family', await jpeg(4000, 3000, { orientation: 6 }), 'IMG 0001.JPG'),
    await a.upload('Family', await png(300, 200, true), 'logo.png'),
    await a.upload('Summer 2026', await jpeg(1200, 800), 'beach.jpg'),
    await a.upload('Kids.2', await jpeg(800, 800), 'café ☃.jpg'),
  ];
  assert.ok(ups.every((u) => u.status === 201), ups.map((u) => u.text).join('\n'));

  // Log in to the frame the way the iPad does (?k=). Newer frame versions return only
  // { ok } from /healthz, so the counts are read from the gated /api/state instead.
  const gate = await fetch(frame + '/?k=' + key, { redirect: 'manual' });
  assert.equal(gate.status, 303);
  const cookie = gate.headers.get('set-cookie').split(';')[0];
  const stateOf = () => fetch(frame + '/api/state', { headers: { cookie } }).then((r) => r.json());
  const photoCount = (st) => Object.values(st.albums || {}).reduce((n, list) => n + list.length, 0);

  // The frame rescans on its own schedule (5 s at the floor).
  const state = await until(() => stateOf().then((st) => (Object.keys(st.albums || {}).length === 3 && photoCount(st) === 4 ? st : null)), 'frame to rescan\n' + logs);
  assert.deepEqual(Object.keys(state.albums).sort(), ['Family', 'Kids.2', 'Summer 2026']);
  assert.equal(state.albums.Family.length, 2);
  const url = state.albums.Family.find((u) => u.endsWith('IMG%200001.jpg'));
  assert.ok(url, JSON.stringify(state.albums.Family));
  const img = await fetch(`${frame}/${url}`, { headers: { cookie } });
  assert.equal(img.status, 200);
  const m = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.deepEqual([m.width, m.height], [1920, 2560], 'oriented upright and fitted, as the iPad will receive it');
});
