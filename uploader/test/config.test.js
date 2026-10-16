import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const ok = { UPLOAD_PASSWORD: 'a-long-enough-password' };
const problems = (env) => { try { loadConfig(env); return []; } catch (e) { assert.ok(e instanceof ConfigError); return e.problems; } };

test('minimal valid config loads with defaults', () => {
  const c = loadConfig(ok);
  assert.equal(c.port, 3000);
  assert.equal(c.photosDir, '/photos');
  assert.equal(c.maxEdge, 2560);
  assert.equal(c.jpegQuality, 82);
  assert.equal(c.frameMaxPhotos, 500);
  assert.equal(c.trustProxy, 1);
});

test('a missing password is reported', () => {
  assert.match(problems({}).join('\n'), /UPLOAD_PASSWORD is required/);
});

test('every problem is reported at once, not just the first', () => {
  const p = problems({ UPLOAD_PASSWORD: 'short', PORT: '99999', MAX_EDGE: 'abc', JPEG_QUALITY: '5', PHOTOS_DIR: 'relative' });
  assert.ok(p.length >= 5, p.join('\n'));
});

test('placeholder and padded passwords are refused', () => {
  assert.match(problems({ UPLOAD_PASSWORD: 'changeme' }).join(), /12 to 128|placeholder/);
  assert.match(problems({ UPLOAD_PASSWORD: ' a-long-enough-password' }).join(), /whitespace/);
  assert.match(problems({ UPLOAD_PASSWORD: 'replace-me' }).join(), /12 to 128|placeholder/);
  assert.match(problems({ UPLOAD_PASSWORD: 'x'.repeat(129) }).join(), /12 to 128/);
});

test('TRUST_PROXY accepts false or a small hop count only', () => {
  assert.equal(loadConfig({ ...ok, TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ ...ok, TRUST_PROXY: '2' }).trustProxy, 2);
  assert.match(problems({ ...ok, TRUST_PROXY: 'true' }).join(), /TRUST_PROXY/);
  assert.match(problems({ ...ok, TRUST_PROXY: '99' }).join(), /TRUST_PROXY/);
});

test('the returned config is frozen', () => {
  const c = loadConfig(ok);
  assert.throws(() => { 'use strict'; c.port = 1; });
});
