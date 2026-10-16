import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD } from './helpers.js';

test('everything but healthz, login and session needs a session', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  assert.equal((await a.req('GET', '/healthz')).status, 200);
  for (const [m, u] of [['GET', '/api/albums'], ['POST', '/api/albums'], ['GET', '/api/albums/x/photos'], ['DELETE', '/api/albums/x'],
    ['GET', '/thumb/x/y.jpg'], ['GET', '/photo/x/y.jpg']]) {
    assert.equal((await a.req(m, u)).status, 401, `${m} ${u}`);
  }
  assert.deepEqual((await a.req('GET', '/api/session')).data, { authenticated: false });
});

test('login sets a hardened cookie and the cookie then works', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  const bad = await a.login('wrong password here');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await a.login();
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /^__Host-upl=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(flag), flag);
  assert.ok(!/Domain=/i.test(sc));
  assert.equal((await a.req('GET', '/api/albums')).status, 200);
  const s = await a.req('GET', '/api/session');
  assert.equal(s.data.authenticated, true);
  assert.equal(s.data.limits.maxEdge, 2560);
});

test('COOKIE_SECURE=false (local http) drops the Secure flag and __Host- prefix', async (t) => {
  const a = await startApp({ COOKIE_SECURE: 'false' }); t.after(() => a.close());
  const sc = (await a.login()).headers.get('set-cookie');
  assert.match(sc, /^upl=/);
  assert.ok(!sc.includes('Secure'));
});

test('malformed, tampered, truncated and expired cookies are 401, never 500', async (t) => {
  let clock = 1_800_000_000_000;
  const a = await startApp({ SESSION_HOURS: '1' }, { now: () => clock }); t.after(() => a.close());
  await a.login();
  const good = a.cookie;
  assert.equal((await a.req('GET', '/api/albums')).status, 200);
  const value = good.split('=')[1];
  const parts = value.split('.');
  const cases = [
    '__Host-upl=%E0%A4%A',                                       // bad percent-encoding
    '__Host-upl=',                                               // empty
    '__Host-upl=' + 'a'.repeat(5000),                            // oversized
    '__Host-upl=' + value.slice(0, -3),                          // truncated signature
    '__Host-upl=' + [parts[0], Number(parts[1]) + 99999999, parts[2]].join('.'), // expiry extended, signature stale
    '__Host-upl=v1.9999999999999.' + parts[2],
    'garbage',
  ];
  for (const c of cases) assert.equal((await a.req('GET', '/api/albums', { cookie: c })).status, 401, c.slice(0, 40));
  clock += 2 * 3_600_000; // two hours later
  assert.equal((await a.req('GET', '/api/albums')).status, 401, 'expired');
});

test('a session signed with one secret is rejected under another', async (t) => {
  const a = await startApp({ SESSION_SECRET: 's'.repeat(40) });
  const b = await startApp({ SESSION_SECRET: 't'.repeat(40) });
  t.after(() => Promise.all([a.close(), b.close()]));
  await a.login();
  assert.equal((await b.req('GET', '/api/albums', { cookie: a.cookie })).status, 401);
});

test('failed logins are throttled per client address, not globally', async (t) => {
  const a = await startApp({ AUTH_MAX_FAILS: '3' }); t.after(() => a.close());
  const from = (ip) => ({ 'x-forwarded-for': ip });
  for (let i = 0; i < 3; i += 1) assert.equal((await a.login('nope nope nope nope', from('203.0.113.9'))).status, 401);
  const blocked = await a.login('nope nope nope nope', from('203.0.113.9'));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Even the right password is refused from the throttled address...
  assert.equal((await a.login(PASSWORD, from('203.0.113.9'))).status, 429);
  // ...while a different address is unaffected.
  assert.equal((await a.login('nope nope nope nope', from('198.51.100.7'))).status, 401);
  assert.equal((await a.login(PASSWORD, from('198.51.100.7'))).status, 200);
});

test('a successful login resets that address\'s failure count', async (t) => {
  const a = await startApp({ AUTH_MAX_FAILS: '3' }); t.after(() => a.close());
  const h = { 'x-forwarded-for': '203.0.113.20' };
  await a.login('bad bad bad bad bad', h); await a.login('bad bad bad bad bad', h);
  assert.equal((await a.login(PASSWORD, h)).status, 200);
  await a.login('bad bad bad bad bad', h); await a.login('bad bad bad bad bad', h);
  assert.equal((await a.login('bad bad bad bad bad', h)).status, 401); // 3rd failure since reset, not yet blocked
});

test('with TRUST_PROXY=false a spoofed X-Forwarded-For cannot dodge the throttle', async (t) => {
  const a = await startApp({ AUTH_MAX_FAILS: '3', TRUST_PROXY: 'false' }); t.after(() => a.close());
  for (let i = 0; i < 3; i += 1) await a.login('bad bad bad bad bad', { 'x-forwarded-for': `10.0.0.${i}` });
  assert.equal((await a.login('bad bad bad bad bad', { 'x-forwarded-for': '10.9.9.9' })).status, 429);
});

test('the throttle map is swept so it cannot grow forever', async (t) => {
  let clock = 1_800_000_000_000;
  const a = await startApp({ AUTH_WINDOW_MS: '1000' }, { now: () => clock }); t.after(() => a.close());
  for (let i = 0; i < 50; i += 1) a.auth.recordFailure('10.0.0.' + i);
  assert.equal(a.auth.fails.size, 50);
  clock += 5000;
  a.auth.recordFailure('10.1.1.1');
  assert.equal(a.auth.fails.size, 1);
});

test('state-changing requests from another origin are refused', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  await a.login();
  const evil = await a.req('POST', '/api/albums', { json: { name: 'Pwned' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const same = await a.req('POST', '/api/albums', { json: { name: 'Fine' }, headers: { origin: a.base } });
  assert.equal(same.status, 201);
  const forwarded = await a.req('POST', '/api/albums', { json: { name: 'Proxied' }, headers: { origin: 'https://up.example.com', 'x-forwarded-host': 'up.example.com' } });
  assert.equal(forwarded.status, 201);
});

test('security headers are present on the page and the API', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  for (const url of ['/', '/api/session', '/healthz']) {
    const r = await a.req('GET', url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', url);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'), url);
    assert.ok(r.headers.get('strict-transport-security'), url);
    assert.equal(r.headers.get('x-powered-by'), null);
  }
  assert.equal((await a.req('GET', '/api/session')).headers.get('cache-control'), 'no-store');
});

test('the page itself is served without a login (it only holds the sign-in form)', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  const r = await a.req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Frame Uploads<\/title>/);
  assert.equal((await a.req('GET', '/app.js')).status, 200);
});

test('paths that try to escape the public directory are not served', async (t) => {
  const a = await startApp(); t.after(() => a.close());
  for (const u of ['/..%2fpackage.json', '/%2e%2e/package.json', '/.env', '/src/server.js']) {
    const r = await a.req('GET', u);
    assert.ok([400, 404].includes(r.status), `${u} -> ${r.status}`);
  }
});

test('rotating addresses does not give unlimited guesses: all addresses share one ceiling', async (t) => {
  let clock = 1_800_000_000_000;
  const a = await startApp({ AUTH_MAX_FAILS: '3', AUTH_WINDOW_MS: '60000' }, { now: () => clock }); t.after(() => a.close());
  // Ceiling is 5 x 3 = 15 wrong passwords in total, whoever they come from.
  for (let i = 0; i < 15; i += 1) assert.equal((await a.login('nope nope nope nope', { 'x-forwarded-for': `203.0.113.${i}` })).status, 401, String(i));
  const fresh = await a.login('nope nope nope nope', { 'x-forwarded-for': '198.51.100.99' });
  assert.equal(fresh.status, 429);
  assert.ok(Number(fresh.headers.get('retry-after')) > 0);
  // The right password does not slip through while locked.
  assert.equal((await a.login(PASSWORD, { 'x-forwarded-for': '198.51.100.98' })).status, 429);
  clock += 61_000;
  assert.equal((await a.login(PASSWORD, { 'x-forwarded-for': '198.51.100.97' })).status, 200);
});

test('a global lockout does not end sessions that already exist', async (t) => {
  const a = await startApp({ AUTH_MAX_FAILS: '1' }); t.after(() => a.close());
  await a.login(PASSWORD, { 'x-forwarded-for': '10.0.0.1' });
  for (let i = 0; i < 5; i += 1) await a.login('nope nope nope nope', { 'x-forwarded-for': `10.0.1.${i}` });
  assert.equal((await a.login(PASSWORD, { 'x-forwarded-for': '10.0.2.1' })).status, 429);
  assert.equal((await a.req('GET', '/api/albums')).status, 200);
});

test('overflowing the throttle map evicts the oldest entries instead of clearing everyone', async (t) => {
  const a = await startApp({}, { maxTracked: 20 }); t.after(() => a.close());
  for (let i = 0; i < 30; i += 1) a.auth.recordFailure('10.0.0.' + i);
  assert.ok(a.auth.fails.size <= 20 && a.auth.fails.size >= 19, String(a.auth.fails.size));
  assert.ok(a.auth.fails.has('10.0.0.29'), 'the newest entry survives');
  assert.ok(!a.auth.fails.has('10.0.0.0'), 'the oldest was evicted');
});
