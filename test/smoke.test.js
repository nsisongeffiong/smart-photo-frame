/**
 * smart-photo-frame — smoke tests
 *
 * Deliberately dependency-free (node:test only, no devDependencies, no lockfile
 * churn) so `npm test` is runnable the moment the repository is cloned. This
 * covers the boot-time trust boundary (config validation), the auth gate's
 * redirect and throttling behaviour, and the photo library's containment and
 * determinism rules. The fuller matrix listed in final-review.md is still owed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, AuthGate, HomeAssistantClient, PhotoLibrary } from '../server.js';

const FRAME_KEY = 'a1b2c3d4e5f6g7h8i9';

/**
 * @param {Record<string, string>} [extra] Overrides.
 * @returns {NodeJS.ProcessEnv} A minimal valid environment.
 */
function baseEnv(extra = {}) {
  return /** @type {NodeJS.ProcessEnv} */ ({
    HA_BASE_URL: 'http://ha.internal:8123/',
    HA_TOKEN: 'token-'.padEnd(48, 'x'),
    FRAME_KEY,
    ...extra
  });
}

/** @returns {any} A response double recording what a handler did to it. */
function fakeRes() {
  return {
    headers: Object.create(null),
    statusCode: 200,
    body: null,
    location: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    redirect(code, target) {
      this.statusCode = code;
      this.location = target;
      return this;
    }
  };
}

/**
 * @param {string} name Prefix.
 * @returns {Promise<string>} A fresh temporary directory.
 */
function tempRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `spf-${name}-`));
}

/* --------------------------------- config -------------------------------- */

test('loadConfig accepts a minimal valid environment', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.port, 3000);
  assert.deepEqual(config.haRoutes, [{ name: 'primary', base: 'http://ha.internal:8123' }]);
  assert.equal(config.haPollMs, 10_000);
  assert.equal(config.haTimeoutMs, 9_000);
  assert.equal(config.entities.album, 'input_select.photo_frame_album');
  assert.match(config.sessionToken, /^[0-9a-f]{64}$/);
  assert.notEqual(config.sessionToken, FRAME_KEY);
});

test('TRUST_PROXY defaults to false and parses every supported form', () => {
  assert.equal(loadConfig(baseEnv()).trustProxy, false);
  assert.equal(loadConfig(baseEnv({ TRUST_PROXY: '1' })).trustProxy, 1);
  assert.equal(loadConfig(baseEnv({ TRUST_PROXY: 'true' })).trustProxy, true);
  assert.equal(loadConfig(baseEnv({ TRUST_PROXY: 'false' })).trustProxy, false);
  assert.equal(loadConfig(baseEnv({ TRUST_PROXY: 'loopback' })).trustProxy, 'loopback');
});

test('loadConfig rejects missing, weak and unsafe values', () => {
  assert.throws(() => loadConfig(/** @type {NodeJS.ProcessEnv} */ ({})), /missing required environment variable/);
  assert.throws(() => loadConfig(baseEnv({ FRAME_KEY: 'short' })), /at least 16 characters/);
  assert.throws(() => loadConfig(baseEnv({ FRAME_KEY: 'changemechangeme' })), /well-known placeholder/);
  assert.throws(() => loadConfig(baseEnv({ FRAME_KEY: 'aaaaaaaaaaaaaaaaaa' })), /distinct characters/);
  assert.throws(() => loadConfig(baseEnv({ HA_BASE_URL: 'ftp://ha.internal/' })), /http: or https:/);
  assert.throws(() => loadConfig(baseEnv({ HA_BASE_URL: 'http://u:p@ha.internal/' })), /must not embed credentials/);
  assert.throws(() => loadConfig(baseEnv({ PORT: '80.5' })), /must be an integer/);
  assert.throws(() => loadConfig(baseEnv({ ENTITY_ALBUM: 'not-an-entity' })), /domain\.object_id/);
});

test('a duplicate fallback URL collapses to a single route', () => {
  const config = loadConfig(baseEnv({ HA_BASE_URL_FALLBACK: 'http://ha.internal:8123' }));
  assert.equal(config.haRoutes.length, 1);
});

test('a distinct fallback URL adds a second route', () => {
  const config = loadConfig(baseEnv({ HA_BASE_URL_FALLBACK: 'https://ha.example.net/' }));
  assert.deepEqual(
    config.haRoutes.map((route) => route.name),
    ['primary', 'fallback']
  );
});

/* ---------------------------------- auth --------------------------------- */

test('a valid key sets the cookie and never redirects off-origin', () => {
  const gate = new AuthGate({
    sessionToken: 'session-token',
    frameKey: FRAME_KEY,
    maxFails: 5,
    windowMs: 60_000
  });

  const evil = fakeRes();
  gate.middleware(
    /** @type {any} */ ({ path: '//evil.example.com', query: { k: FRAME_KEY }, headers: {}, ip: '203.0.113.7' }),
    evil,
    () => assert.fail('next() must not run for a redirect')
  );
  assert.equal(evil.statusCode, 303);
  assert.equal(evil.location, '/');
  assert.match(String(evil.headers['set-cookie']), /^__Host-spf=session-token;/);

  const backslash = fakeRes();
  gate.middleware(
    /** @type {any} */ ({ path: '/\\evil.example.com', query: { k: FRAME_KEY }, headers: {}, ip: '203.0.113.7' }),
    backslash,
    () => assert.fail('next() must not run for a redirect')
  );
  assert.equal(backslash.location, '/');

  const ordinary = fakeRes();
  gate.middleware(
    /** @type {any} */ ({ path: '/album', query: { k: FRAME_KEY }, headers: {}, ip: '203.0.113.7' }),
    ordinary,
    () => assert.fail('next() must not run for a redirect')
  );
  assert.equal(ordinary.location, '/album');
});

test('an unauthenticated request is rejected and then throttled', () => {
  const gate = new AuthGate({
    sessionToken: 's'.repeat(64),
    frameKey: FRAME_KEY,
    maxFails: 1,
    windowMs: 60_000
  });
  const req = /** @type {any} */ ({ path: '/', query: {}, headers: {}, ip: '203.0.113.8' });

  const first = fakeRes();
  gate.middleware(req, first, () => assert.fail('next() must not run unauthenticated'));
  assert.equal(first.statusCode, 401);

  const second = fakeRes();
  gate.middleware(req, second, () => assert.fail('next() must not run unauthenticated'));
  assert.equal(second.statusCode, 429);
  assert.ok(second.headers['retry-after']);
});

test('a malformed Cookie header degrades to 401, never to a throw', () => {
  const gate = new AuthGate({
    sessionToken: 's'.repeat(64),
    frameKey: FRAME_KEY,
    maxFails: 10,
    windowMs: 60_000
  });
  const res = fakeRes();
  gate.middleware(
    /** @type {any} */ ({ path: '/', query: {}, headers: { cookie: '__Host-spf=%E0%A4%A' }, ip: '203.0.113.9' }),
    res,
    () => assert.fail('next() must not run unauthenticated')
  );
  assert.equal(res.statusCode, 401);
});

test('/healthz stays open even with a bad key present', () => {
  const gate = new AuthGate({
    sessionToken: 's'.repeat(64),
    frameKey: FRAME_KEY,
    maxFails: 10,
    windowMs: 60_000,
    openPaths: ['/healthz']
  });
  let passed = false;
  gate.middleware(
    /** @type {any} */ ({ path: '/healthz', query: { k: 'wrong-but-long-enough' }, headers: {}, ip: '203.0.113.10' }),
    fakeRes(),
    () => {
      passed = true;
    }
  );
  assert.equal(passed, true);
});

/* -------------------------------- ha client ------------------------------ */

test('HomeAssistantClient starts with optimistic last-known-good state', () => {
  const ha = new HomeAssistantClient({
    routes: [{ name: 'primary', base: 'http://ha.internal:8123' }],
    token: 'token',
    entities: {
      album: 'input_select.a',
      display: 'input_boolean.b',
      brightness: 'input_number.c',
      interval: 'input_number.d'
    },
    timeoutMs: 2_000,
    reprobeEvery: 30
  });

  const snap = ha.snapshot;
  assert.equal(snap.haOk, false);
  assert.equal(snap.haError, 'not polled yet');
  assert.equal(snap.album, null);
  assert.equal(snap.display, true);
  assert.equal(snap.brightness, 100);
  assert.equal(snap.interval, 15);
  assert.equal(snap.haVia, 'primary');
  assert.equal(snap.haLastOk, null);
});

/* ------------------------------ photo library ---------------------------- */

test('PhotoLibrary skips unsafe entries and sorts naturally', async () => {
  const root = await tempRoot('scan');
  try {
    await fs.mkdir(path.join(root, 'Trip 2020'));
    await fs.writeFile(path.join(root, 'Trip 2020', 'b2.jpg'), 'x');
    await fs.writeFile(path.join(root, 'Trip 2020', 'a1.JPG'), 'x');
    await fs.writeFile(path.join(root, 'Trip 2020', '.hidden.jpg'), 'x');
    await fs.writeFile(path.join(root, 'Trip 2020', 'notes.txt'), 'x');
    await fs.mkdir(path.join(root, '.secret'));
    await fs.mkdir(path.join(root, '__proto__'));
    await fs.writeFile(path.join(root, 'loose.jpg'), 'x');

    const library = new PhotoLibrary({ root, maxPhotosPerAlbum: 100 });
    await library.scan();
    const snap = library.snapshot;

    assert.equal(snap.ok, true);
    assert.deepEqual(Object.keys(snap.albums), ['Trip 2020']);
    assert.deepEqual(snap.albums['Trip 2020'], [
      'photos/Trip%202020/a1.JPG',
      'photos/Trip%202020/b2.jpg'
    ]);
    assert.equal(snap.photoCount, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the per-album cap selects a deterministic sorted subset', async () => {
  const root = await tempRoot('cap');
  try {
    await fs.mkdir(path.join(root, 'Album'));
    for (const name of ['5.jpg', '3.jpg', '1.jpg', '4.jpg', '2.jpg']) {
      await fs.writeFile(path.join(root, 'Album', name), 'x');
    }

    const library = new PhotoLibrary({ root, maxPhotosPerAlbum: 2 });
    await library.scan();

    assert.deepEqual(library.snapshot.albums.Album, ['photos/Album/1.jpg', 'photos/Album/2.jpg']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an unreadable photo root reports unhealthy without throwing', async () => {
  const missing = path.join(os.tmpdir(), `spf-missing-${process.pid}-${Date.now()}`);
  const library = new PhotoLibrary({ root: missing, maxPhotosPerAlbum: 10 });
  await library.scan();

  const snap = library.snapshot;
  assert.equal(snap.ok, false);
  assert.match(String(snap.error), /cannot read PHOTOS_DIR/);
  assert.equal(snap.albumCount, 0);
});
