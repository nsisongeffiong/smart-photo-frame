#!/usr/bin/env bash
#
# smart-photo-frame — verification harness
#
# Regression net for everything the server has ever shipped, plus the four
# changes from the pre-open-source review:
#
#   1. haOk derives from the number of entity states actually accepted, not from
#      the number of HTTP 200s. A poll where every entity is "unavailable" is not
#      a successful poll and must not advance haLastOk.
#   2. /healthz returns { ok } only. Status semantics (200/503) unchanged, because
#      the container HEALTHCHECK reads statusCode and nothing else.
#   3. TRUST_PROXY still defaults to false, but a falsy effective value now emits
#      exactly one warning line at boot.
#   4. .heic/.heif/.webp are out of the default image set (iOS 12 cannot decode
#      them); the set is overridable with IMAGE_EXTENSIONS; the scanner logs a
#      count of skipped images.
#
# Conventions, learned the hard way:
#   - Every assertion that can 401 gets its own X-Forwarded-For address. Trust
#     proxy is enabled for the main run, so a shared address would drag later
#     requests into an earlier assertion's cooldown bucket.
#   - grep is always fed by a herestring, never a pipe: `printf ... | grep -q`
#     under `set -o pipefail` dies of SIGPIPE when grep exits on the first match,
#     and whether it does is a race decided by the size of the haystack.
#
# Exit code: 0 when every assertion passes, 1 otherwise.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$ROOT/server.js"

PASS=0
FAIL=0
XFF_N=0
PIDS=()
WORK=""

CODE=""
BODY=""
HEADERS=""
BASE=""

FRAME_KEY="verify-frame-key-7Qx3Zk91Ap"
HA_TOKEN="verify-ha-token-b41c9d7e2f8a"
PROBE_IP="192.0.2.250"

# --------------------------------------------------------------------------- #
# Harness plumbing
# --------------------------------------------------------------------------- #

ok() {
  PASS=$((PASS + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  if [ -n "${2:-}" ]; then
    printf 'FAIL  %s -- %s\n' "$1" "$2"
  else
    printf 'FAIL  %s\n' "$1"
  fi
}

assert_eq() { # name actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected [$3], got [$2]"; fi
}

assert_ne() { # name actual unexpected
  if [ "$2" != "$3" ]; then ok "$1"; else fail "$1" "got the forbidden value [$3]"; fi
}

assert_contains() { # name haystack needle
  if grep -qF -- "$3" <<< "$2"; then ok "$1"; else fail "$1" "missing [$3]"; fi
}

assert_not_contains() { # name haystack needle
  if grep -qF -- "$3" <<< "$2"; then fail "$1" "unexpectedly present [$3]"; else ok "$1"; fi
}

assert_matches() { # name haystack extended-regex
  if grep -qiE -- "$3" <<< "$2"; then ok "$1"; else fail "$1" "no match for /$3/"; fi
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
  return 0
}
trap cleanup EXIT

for tool in node curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'verify.sh: required tool not found: %s\n' "$tool" >&2
    exit 1
  fi
done

if [ ! -f "$SERVER" ]; then
  printf 'verify.sh: server.js not found at %s\n' "$SERVER" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/spf-verify-XXXXXX")"

next_xff() {
  XFF_N=$((XFF_N + 1))
  printf '198.51.100.%d' "$XFF_N"
}

free_port() {
  "$NODE_BIN" -e '
    const net = require("net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => process.stdout.write(String(p)));
    });
  '
}

jfield() { # path json
  "$NODE_BIN" -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { process.stdout.write("<invalid-json>"); return; }
      // Own properties only. A plain a[k] walks the prototype chain, so a path
      // like "albums.__proto__" resolves to Object.prototype ({} once
      // stringified) for every object and an assertion that no such album is
      // listed can never fail. Array indices stay reachable: hasOwnProperty is
      // true for "0", "1", ... on an array.
      const out = String(process.argv[1]).split(".").reduce(
        (a, k) => (a !== null && typeof a === "object"
          && Object.prototype.hasOwnProperty.call(a, k) ? a[k] : undefined), v);
      if (out === undefined) { process.stdout.write("<missing>"); return; }
      process.stdout.write(typeof out === "object" ? JSON.stringify(out) : String(out));
    });
  ' "$1" <<< "$2"
}

jkeys() { # json
  "$NODE_BIN" -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { process.stdout.write("<invalid-json>"); return; }
      if (v === null || typeof v !== "object") { process.stdout.write("<not-an-object>"); return; }
      process.stdout.write(Object.keys(v).sort().join(","));
    });
  ' <<< "$1"
}

req_ip() { # path ip [curl args...]
  local path="$1" ip="$2"
  shift 2
  local bodyf="$WORK/resp.body" hdrf="$WORK/resp.head"
  : > "$bodyf"
  : > "$hdrf"
  CODE="$(curl -sS --max-time 15 -o "$bodyf" -D "$hdrf" -w '%{http_code}' \
    -H "X-Forwarded-For: $ip" "$@" "$BASE$path" 2>>"$WORK/curl.err" || printf '000')"
  BODY="$(cat "$bodyf")"
  HEADERS="$(cat "$hdrf")"
}

req() { # path [curl args...]
  local path="$1"
  shift
  req_ip "$path" "$(next_xff)" "$@"
}

start_server() { # logfile VAR=VAL...
  local log="$1"
  shift
  : > "$log"
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" "$NODE_BIN" "$SERVER" >> "$log" 2>&1 &
  SERVER_PID=$!
  PIDS+=("$SERVER_PID")
  local i=0
  while [ "$i" -lt 150 ]; do
    if grep -q '"message":"listening"' "$log" 2>/dev/null; then return 0; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then return 1; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

stop_server() { # pid
  local pid="${1:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

write_ha_state() { # json
  printf '%s' "$1" > "$WORK/ha-state.next"
  mv "$WORK/ha-state.next" "$WORK/ha-state.json"
}

state_value() { # field
  req_ip /api/state "$PROBE_IP" -H "Cookie: __Host-spf=$SESSION"
  jfield "$1" "$BODY"
}

wait_state() { # field expected tries
  local i=0
  while [ "$i" -lt "$3" ]; do
    if [ "$(state_value "$1")" = "$2" ]; then return 0; fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

run_unit() { # script.mjs
  local script="$1"
  local out=""
  if ! out="$("$NODE_BIN" "$script" 2>&1)"; then
    fail "unit $(basename "$script")" "$(printf '%s' "$out" | tail -n 5 | tr '\n' ' ')"
    return 0
  fi
  local line
  while IFS= read -r line; do
    case "$line" in
      'ok '*) ok "${line#ok }" ;;
      'not ok '*) fail "${line#not ok }" ;;
      *) : ;;
    esac
  done <<< "$out"
}

SESSION="$("$NODE_BIN" -e '
  const crypto = require("crypto");
  process.stdout.write(
    crypto.createHmac("sha256", process.argv[1]).update("smart-photo-frame:session:v1").digest("hex"));
' "$FRAME_KEY")"

export SPF_SERVER="$SERVER"
export SPF_FRAME_KEY="$FRAME_KEY"

printf '== smart-photo-frame verification ==\n\n'

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

cat > "$WORK/fake-ha.mjs" <<'FAKEHA'
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.FAKE_HA_PORT);
const stateFile = process.env.FAKE_HA_STATE;
const expected = `Bearer ${process.env.FAKE_HA_TOKEN}`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const match = /^\/api\/states\/(.+)$/.exec(url.pathname);
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"not found"}');
    return;
  }
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"message":"unauthorized"}');
    return;
  }
  const entity = decodeURIComponent(match[1]);
  let states = {};
  try {
    states = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    states = {};
  }
  if (!Object.prototype.hasOwnProperty.call(states, entity)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"Entity not found."}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ entity_id: entity, state: String(states[entity]), attributes: {} }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('fake-ha listening\n');
});
FAKEHA

cat > "$WORK/cfg.mjs" <<'CFG'
import { pathToFileURL } from 'node:url';

const { loadConfig } = await import(pathToFileURL(process.env.SPF_SERVER).href);
const KEY = process.env.SPF_FRAME_KEY;
const lines = [];

function check(name, condition, detail = '') {
  lines.push(condition ? `ok ${name}` : `not ok ${name}: ${detail}`);
}

function env(extra = {}) {
  return {
    HA_BASE_URL: 'http://ha.internal:8123/',
    HA_TOKEN: 'ha-token-value',
    FRAME_KEY: KEY,
    ...extra
  };
}

function expectThrow(name, overrides, pattern) {
  try {
    loadConfig(env(overrides));
    check(name, false, 'no error thrown');
  } catch (error) {
    const message = String(error && error.message);
    check(name, pattern.test(message), message);
  }
}

const cfg = loadConfig(env());
check('config: PORT defaults to 3000', cfg.port === 3000, String(cfg.port));
check('config: HA_POLL_MS defaults to 10000', cfg.haPollMs === 10_000, String(cfg.haPollMs));
check('config: haTimeoutMs derives to 9000', cfg.haTimeoutMs === 9_000, String(cfg.haTimeoutMs));
check('config: SCAN_MS defaults to 300000', cfg.scanMs === 300_000, String(cfg.scanMs));
check('config: HA_REPROBE_EVERY defaults to 30', cfg.haReprobeEvery === 30, String(cfg.haReprobeEvery));
check('config: MAX_PHOTOS_PER_ALBUM defaults to 5000', cfg.maxPhotosPerAlbum === 5_000, String(cfg.maxPhotosPerAlbum));
check('config: AUTH_MAX_FAILS defaults to 10', cfg.authMaxFails === 10, String(cfg.authMaxFails));
check('config: AUTH_WINDOW_MS defaults to 900000', cfg.authWindowMs === 900_000, String(cfg.authWindowMs));
check('config: PHOTOS_DIR defaults to /photos', cfg.photosDir === '/photos', cfg.photosDir);
check('config: ALLOW_QUERY_KEY defaults to false', cfg.allowQueryKey === false, String(cfg.allowQueryKey));
check('config: base URL keeps no trailing slash',
  cfg.haRoutes[0].base === 'http://ha.internal:8123', cfg.haRoutes[0].base);
check('config: single primary route by default', cfg.haRoutes.length === 1, String(cfg.haRoutes.length));
check('config: default album entity', cfg.entities.album === 'input_select.photo_frame_album', cfg.entities.album);
check('config: default display entity', cfg.entities.display === 'input_boolean.photo_frame_display', cfg.entities.display);
check('config: session token is 64 hex chars', /^[0-9a-f]{64}$/.test(cfg.sessionToken), cfg.sessionToken);
check('config: session token is not the frame key', cfg.sessionToken !== KEY, 'token equals key');

check('config: TRUST_PROXY defaults to false', loadConfig(env()).trustProxy === false, 'not false');
check('config: TRUST_PROXY=1 parses to 1', loadConfig(env({ TRUST_PROXY: '1' })).trustProxy === 1, 'not 1');
check('config: TRUST_PROXY=true parses to true', loadConfig(env({ TRUST_PROXY: 'true' })).trustProxy === true, 'not true');
check('config: TRUST_PROXY=false parses to false', loadConfig(env({ TRUST_PROXY: 'false' })).trustProxy === false, 'not false');
check('config: TRUST_PROXY=loopback passes through',
  loadConfig(env({ TRUST_PROXY: 'loopback' })).trustProxy === 'loopback', 'not loopback');

const defaultExts = [...loadConfig(env()).imageExtensions].sort().join(',');
check('config: default image set is the Safari 12 set',
  defaultExts === '.bmp,.gif,.jpeg,.jpg,.png', defaultExts);
check('config: default image set excludes .heic', !loadConfig(env()).imageExtensions.has('.heic'), 'heic present');
check('config: default image set excludes .heif', !loadConfig(env()).imageExtensions.has('.heif'), 'heif present');
check('config: default image set excludes .webp', !loadConfig(env()).imageExtensions.has('.webp'), 'webp present');

const widened = [...loadConfig(env({ IMAGE_EXTENSIONS: 'jpg, .webp' })).imageExtensions].join(',');
check('config: IMAGE_EXTENSIONS overrides the default set', widened === '.jpg,.webp', widened);
expectThrow('config: IMAGE_EXTENSIONS rejects nonsense entries',
  { IMAGE_EXTENSIONS: '.exe!' }, /IMAGE_EXTENSIONS entries must look like/);
expectThrow('config: IMAGE_EXTENSIONS rejects an empty list',
  { IMAGE_EXTENSIONS: ' , , ' }, /at least one extension/);

check('config: HA_POLL_MS=1000 clamps the timeout up to 2000',
  loadConfig(env({ HA_POLL_MS: '1000' })).haTimeoutMs === 2_000, 'bad clamp');
check('config: HA_POLL_MS=3600000 clamps the timeout down to 15000',
  loadConfig(env({ HA_POLL_MS: '3600000' })).haTimeoutMs === 15_000, 'bad clamp');

const dup = loadConfig(env({ HA_BASE_URL_FALLBACK: 'http://ha.internal:8123' }));
check('config: a duplicate fallback collapses to one route', dup.haRoutes.length === 1, String(dup.haRoutes.length));
const two = loadConfig(env({ HA_BASE_URL_FALLBACK: 'https://ha.example.net/' }));
check('config: a distinct fallback adds a second route',
  two.haRoutes.map((r) => r.name).join(',') === 'primary,fallback', 'bad route list');

try {
  loadConfig({});
  check('config: missing required variables are fatal', false, 'no error thrown');
} catch (error) {
  check('config: missing required variables are fatal',
    /missing required environment variable/.test(String(error.message)), String(error.message));
}

expectThrow('config: short FRAME_KEY rejected', { FRAME_KEY: 'short' }, /at least 16 characters/);
expectThrow('config: placeholder FRAME_KEY rejected', { FRAME_KEY: 'changemechangeme' }, /well-known placeholder/);
expectThrow('config: low-entropy FRAME_KEY rejected', { FRAME_KEY: 'a'.repeat(18) }, /distinct characters/);
expectThrow('config: FRAME_KEY with a space rejected', { FRAME_KEY: 'key with spaces abc' }, /printable ASCII/);
expectThrow('config: non-http HA_BASE_URL rejected', { HA_BASE_URL: 'ftp://ha.internal/' }, /http: or https:/);
expectThrow('config: HA_BASE_URL with credentials rejected',
  { HA_BASE_URL: 'http://user:pass@ha.internal/' }, /must not embed credentials/);
expectThrow('config: malformed HA_BASE_URL rejected', { HA_BASE_URL: 'not a url' }, /not a valid absolute URL/);
expectThrow('config: non-integer PORT rejected', { PORT: '80.5' }, /must be an integer/);
expectThrow('config: PORT below range rejected', { PORT: '0' }, /must be between 1 and 65535/);
expectThrow('config: PORT above range rejected', { PORT: '65536' }, /must be between 1 and 65535/);
expectThrow('config: HA_POLL_MS below range rejected', { HA_POLL_MS: '999' }, /between 1000 and 3600000/);
expectThrow('config: HA_POLL_MS above range rejected', { HA_POLL_MS: '3600001' }, /between 1000 and 3600000/);
expectThrow('config: SCAN_MS below range rejected', { SCAN_MS: '4999' }, /between 5000 and 86400000/);
expectThrow('config: SCAN_MS above range rejected', { SCAN_MS: '86400001' }, /between 5000 and 86400000/);
expectThrow('config: HA_REPROBE_EVERY below range rejected', { HA_REPROBE_EVERY: '0' }, /between 1 and 10000/);
expectThrow('config: HA_REPROBE_EVERY above range rejected', { HA_REPROBE_EVERY: '10001' }, /between 1 and 10000/);
expectThrow('config: MAX_PHOTOS_PER_ALBUM below range rejected',
  { MAX_PHOTOS_PER_ALBUM: '0' }, /between 1 and 200000/);
expectThrow('config: MAX_PHOTOS_PER_ALBUM above range rejected',
  { MAX_PHOTOS_PER_ALBUM: '200001' }, /between 1 and 200000/);
expectThrow('config: AUTH_MAX_FAILS below range rejected', { AUTH_MAX_FAILS: '0' }, /between 1 and 1000/);
expectThrow('config: AUTH_MAX_FAILS above range rejected', { AUTH_MAX_FAILS: '1001' }, /between 1 and 1000/);
expectThrow('config: AUTH_WINDOW_MS below range rejected', { AUTH_WINDOW_MS: '999' }, /between 1000 and 86400000/);
expectThrow('config: AUTH_WINDOW_MS above range rejected', { AUTH_WINDOW_MS: '86400001' }, /between 1000 and 86400000/);
expectThrow('config: ALLOW_QUERY_KEY rejects a non-boolean', { ALLOW_QUERY_KEY: 'yes' }, /must be true or false/);
expectThrow('config: ENTITY_ALBUM must look like an entity id',
  { ENTITY_ALBUM: 'not-an-entity' }, /domain\.object_id/);

// Documented current behaviour, unchanged by this run: only the first violation
// is reported, so a second bad value stays hidden behind it.
expectThrow('config: only the first range violation is reported',
  { PORT: '0', SCAN_MS: '1' }, /^PORT/);

process.stdout.write(`${lines.join('\n')}\n`);
CFG

cat > "$WORK/gate.mjs" <<'GATE'
import { pathToFileURL } from 'node:url';

const { AuthGate } = await import(pathToFileURL(process.env.SPF_SERVER).href);
const KEY = process.env.SPF_FRAME_KEY;
const TOKEN = 's'.repeat(64);
const lines = [];

function check(name, condition, detail = '') {
  lines.push(condition ? `ok ${name}` : `not ok ${name}: ${detail}`);
}

function fakeRes() {
  return {
    headers: Object.create(null),
    statusCode: 200,
    body: null,
    location: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
    redirect(code, target) { this.statusCode = code; this.location = target; return this; }
  };
}

function makeGate(extra = {}) {
  return new AuthGate({
    sessionToken: TOKEN,
    frameKey: KEY,
    maxFails: 2,
    windowMs: 60_000,
    openPaths: ['/healthz'],
    ...extra
  });
}

function call(gate, req) {
  const res = fakeRes();
  let nexted = false;
  gate.middleware(req, res, () => { nexted = true; });
  return { res, nexted };
}

const request = (path, query = {}, headers = {}, ip = '203.0.113.1') => ({ path, query, headers, ip });

{
  const gate = makeGate();
  const { res, nexted } = call(gate, request('/album', { k: KEY }, {}, '203.0.113.2'));
  check('gate: a valid key redirects 303', res.statusCode === 303, String(res.statusCode));
  check('gate: the redirect keeps the requested path', res.location === '/album', String(res.location));
  check('gate: a valid key does not fall through', nexted === false, 'next() ran');
  const cookie = String(res.headers['set-cookie']);
  check('gate: the cookie is __Host-spf', cookie.startsWith(`__Host-spf=${TOKEN};`), cookie);
  check('gate: the cookie is HttpOnly', /;\s*HttpOnly/.test(cookie), cookie);
  check('gate: the cookie is Secure', /;\s*Secure/.test(cookie), cookie);
  check('gate: the cookie is SameSite=Lax', /;\s*SameSite=Lax/.test(cookie), cookie);
  check('gate: the cookie is Path=/', /;\s*Path=\//.test(cookie), cookie);
}

{
  const gate = makeGate();
  const a = call(gate, request('//evil.example.com', { k: KEY }, {}, '203.0.113.3'));
  check('gate: a protocol-relative path collapses to /', a.res.location === '/', String(a.res.location));
  const b = call(gate, request('/\\evil.example.com', { k: KEY }, {}, '203.0.113.3'));
  check('gate: a backslash path collapses to /', b.res.location === '/', String(b.res.location));
}

{
  const gate = makeGate({ allowQueryKey: true });
  const { res, nexted } = call(gate, request('/api/state', { k: KEY }, {}, '203.0.113.4'));
  check('gate: ALLOW_QUERY_KEY serves the request directly', nexted === true, 'next() did not run');
  check('gate: ALLOW_QUERY_KEY does not redirect', res.statusCode === 200, String(res.statusCode));
  check('gate: ALLOW_QUERY_KEY still issues the cookie',
    String(res.headers['set-cookie']).includes(TOKEN), 'no cookie');
}

{
  const gate = makeGate({ maxFails: 1 });
  const first = call(gate, request('/', {}, {}, '203.0.113.5'));
  check('gate: no credential is 401', first.res.statusCode === 401, String(first.res.statusCode));
  const second = call(gate, request('/', {}, {}, '203.0.113.5'));
  check('gate: the next attempt from the same address is 429',
    second.res.statusCode === 429, String(second.res.statusCode));
  check('gate: a 429 carries Retry-After', Boolean(second.res.headers['retry-after']), 'missing header');
  const other = call(gate, request('/', {}, {}, '203.0.113.6'));
  check('gate: a different address is unaffected by the bucket',
    other.res.statusCode === 401, String(other.res.statusCode));
}

{
  const gate = makeGate({ maxFails: 1 });
  call(gate, request('/', {}, {}, '203.0.113.7'));
  const throttled = call(gate, request('/', { k: 'wrong-key-entirely' }, {}, '203.0.113.7'));
  check('gate: a wrong key from a throttled address is 429',
    throttled.res.statusCode === 429, String(throttled.res.statusCode));
  const correct = call(gate, request('/', { k: KEY }, {}, '203.0.113.7'));
  check('gate: the correct key is honoured from a throttled address',
    correct.res.statusCode === 303, String(correct.res.statusCode));
  const after = call(gate, request('/', {}, {}, '203.0.113.7'));
  check('gate: the correct key clears the failure bucket',
    after.res.statusCode === 401, String(after.res.statusCode));
}

{
  const gate = makeGate();
  const { res } = call(gate, request('/', {}, { cookie: '__Host-spf=%E0%A4%A' }, '203.0.113.8'));
  check('gate: a malformed cookie degrades to 401', res.statusCode === 401, String(res.statusCode));
}

{
  const gate = makeGate();
  const { nexted } = call(gate, request('/healthz', { k: 'wrong-but-long-enough' }, {}, '203.0.113.9'));
  check('gate: /healthz stays open even with a bad key', nexted === true, 'next() did not run');
}

{
  const gate = makeGate();
  const held = call(gate, request('/api/state', {}, { cookie: `__Host-spf=${TOKEN}` }, '203.0.113.10'));
  check('gate: a valid cookie passes through', held.nexted === true, 'next() did not run');
  const stripped = call(gate, request('/', { k: KEY }, { cookie: `__Host-spf=${TOKEN}` }, '203.0.113.10'));
  check('gate: a cookie holder still gets ?k= stripped',
    stripped.res.statusCode === 303, String(stripped.res.statusCode));
  const kept = makeGate({ allowQueryKey: true });
  const notStripped = call(kept, request('/', { k: KEY }, { cookie: `__Host-spf=${TOKEN}` }, '203.0.113.10'));
  check('gate: ALLOW_QUERY_KEY does not strip for a cookie holder',
    notStripped.nexted === true, 'next() did not run');
}

process.stdout.write(`${lines.join('\n')}\n`);
GATE

cat > "$WORK/library.mjs" <<'LIB'
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { PhotoLibrary } = await import(pathToFileURL(process.env.SPF_SERVER).href);
const lines = [];

function check(name, condition, detail = '') {
  lines.push(condition ? `ok ${name}` : `not ok ${name}: ${detail}`);
}

async function tempRoot(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `spf-lib-${tag}-`));
}

/**
 * Run a scan with process.stdout captured, so the scanner's own warning lines can
 * be asserted without racing the harness's own output.
 */
async function scanCapturing(library) {
  const captured = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    captured.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await library.scan();
  } finally {
    process.stdout.write = real;
  }
  return captured.join('');
}

{
  const root = await tempRoot('scan');
  await fs.mkdir(path.join(root, 'Trip 2020'));
  await fs.writeFile(path.join(root, 'Trip 2020', 'b2.jpg'), 'x');
  await fs.writeFile(path.join(root, 'Trip 2020', 'a1.JPG'), 'x');
  await fs.writeFile(path.join(root, 'Trip 2020', '.hidden.jpg'), 'x');
  await fs.writeFile(path.join(root, 'Trip 2020', 'notes.txt'), 'x');
  await fs.symlink('/etc/passwd', path.join(root, 'Trip 2020', 'escape.jpg'));
  await fs.mkdir(path.join(root, '.secret'));
  await fs.mkdir(path.join(root, '__proto__'));
  await fs.writeFile(path.join(root, 'loose.jpg'), 'x');

  const library = new PhotoLibrary({ root, maxPhotosPerAlbum: 100 });
  await library.scan();
  const snap = library.snapshot;

  check('library: a readable root scans ok', snap.ok === true, String(snap.error));
  check('library: only valid album directories are listed',
    Object.keys(snap.albums).join(',') === 'Trip 2020', Object.keys(snap.albums).join(','));
  check('library: dotfiles, non-images and symlinks are skipped',
    JSON.stringify(snap.albums['Trip 2020']) ===
      JSON.stringify(['photos/Trip%202020/a1.JPG', 'photos/Trip%202020/b2.jpg']),
    JSON.stringify(snap.albums['Trip 2020']));
  check('library: photoCount counts only served files', snap.photoCount === 2, String(snap.photoCount));
  check('library: __proto__ never becomes an album key',
    Object.prototype.hasOwnProperty.call(snap.albums, '__proto__') === false, 'present');
  await fs.rm(root, { recursive: true, force: true });
}

{
  const root = await tempRoot('cap');
  await fs.mkdir(path.join(root, 'Album'));
  for (const name of ['5.jpg', '3.jpg', '1.jpg', '4.jpg', '2.jpg']) {
    await fs.writeFile(path.join(root, 'Album', name), 'x');
  }
  const library = new PhotoLibrary({ root, maxPhotosPerAlbum: 2 });
  await library.scan();
  check('library: the per-album cap keeps a deterministic sorted subset',
    JSON.stringify(library.snapshot.albums.Album) ===
      JSON.stringify(['photos/Album/1.jpg', 'photos/Album/2.jpg']),
    JSON.stringify(library.snapshot.albums.Album));
  await fs.rm(root, { recursive: true, force: true });
}

{
  const missing = path.join(os.tmpdir(), `spf-missing-${process.pid}-${Date.now()}`);
  const library = new PhotoLibrary({ root: missing, maxPhotosPerAlbum: 10 });
  await library.scan();
  const snap = library.snapshot;
  check('library: an unreadable root reports unhealthy', snap.ok === false, 'reported ok');
  check('library: an unreadable root explains why',
    /cannot read PHOTOS_DIR/.test(String(snap.error)), String(snap.error));
  check('library: an unreadable root counts nothing', snap.albumCount === 0, String(snap.albumCount));
}

{
  const root = await tempRoot('heic');
  await fs.mkdir(path.join(root, 'Holiday'));
  await fs.writeFile(path.join(root, 'Holiday', 'real.jpg'), 'x');
  await fs.writeFile(path.join(root, 'Holiday', 'iphone.heic'), 'x');
  await fs.writeFile(path.join(root, 'Holiday', 'iphone2.HEIF'), 'x');
  await fs.writeFile(path.join(root, 'Holiday', 'modern.webp'), 'x');

  const library = new PhotoLibrary({ root, maxPhotosPerAlbum: 100 });
  const output = await scanCapturing(library);
  const snap = library.snapshot;

  check('library: .heic is not listed',
    JSON.stringify(snap.albums.Holiday) === JSON.stringify(['photos/Holiday/real.jpg']),
    JSON.stringify(snap.albums.Holiday));
  check('library: .heic/.heif/.webp are not counted', snap.photoCount === 1, String(snap.photoCount));
  check('library: the scanner warns about images it skipped',
    output.includes('"message":"skipping images the frame cannot display"'), output.slice(0, 200));
  check('library: the skip warning carries a count',
    output.includes('"skipped":3'), output.slice(0, 200));
  check('library: the skip warning is warning level',
    /"level":"warn"[^\n]*skipping images the frame cannot display/.test(output), 'not warn level');

  const widened = new PhotoLibrary({
    root,
    maxPhotosPerAlbum: 100,
    extensions: new Set(['.jpg', '.webp'])
  });
  await widened.scan();
  check('library: IMAGE_EXTENSIONS can widen the set back to .webp',
    JSON.stringify(widened.snapshot.albums.Holiday) ===
      JSON.stringify(['photos/Holiday/modern.webp', 'photos/Holiday/real.jpg']),
    JSON.stringify(widened.snapshot.albums.Holiday));
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write(`${lines.join('\n')}\n`);
LIB

# --------------------------------------------------------------------------- #
# Section 1 — source sanity
# --------------------------------------------------------------------------- #

printf -- '-- source --\n'

SERVER_SRC="$(cat "$SERVER")"
assert_not_contains "source: no console.log in the server" "$SERVER_SRC" "console.log"
assert_contains "source: /healthz body is liveness only" "$SERVER_SRC" 'res.status(lib.ok ? 200 : 503).json({ ok: lib.ok })'
assert_contains "source: the trust proxy warning exists" "$SERVER_SRC" "trust proxy disabled"
assert_contains "source: the default image set is defined once" "$SERVER_SRC" "DEFAULT_IMAGE_EXTENSIONS"
assert_contains "source: the iOS 12 reasoning is documented" "$SERVER_SRC" "iOS 14"

if "$NODE_BIN" -e '
  import(process.argv[1]).then((m) => {
    const required = ["loadConfig", "AuthGate", "HomeAssistantClient", "PhotoLibrary", "createApp", "createPhotoHandler"];
    const missing = required.filter((k) => typeof m[k] !== "function");
    if (missing.length > 0) { process.stderr.write(missing.join(",")); process.exit(1); }
  }).catch((e) => { process.stderr.write(String(e)); process.exit(1); });
' "$SERVER"; then
  ok "source: server.js imports cleanly and exports its public surface"
else
  fail "source: server.js imports cleanly and exports its public surface"
fi

# --------------------------------------------------------------------------- #
# Section 2-4 — unit assertions
# --------------------------------------------------------------------------- #

printf -- '\n-- configuration --\n'
run_unit "$WORK/cfg.mjs"

printf -- '\n-- auth gate --\n'
run_unit "$WORK/gate.mjs"

printf -- '\n-- photo library --\n'
run_unit "$WORK/library.mjs"

# --------------------------------------------------------------------------- #
# Section 5 — integration run A: TRUST_PROXY=1, real photos, stubbed HA
# --------------------------------------------------------------------------- #

printf -- '\n-- integration: main run --\n'

PHOTOS_A="$WORK/photos-a"
mkdir -p "$PHOTOS_A/Trip 2020" "$PHOTOS_A/Family" "$PHOTOS_A/.secret" "$PHOTOS_A/__proto__"
printf 'jpeg' > "$PHOTOS_A/Trip 2020/a1.jpg"
printf 'jpeg' > "$PHOTOS_A/Trip 2020/b2.JPG"
printf 'heic' > "$PHOTOS_A/Trip 2020/nope.heic"
printf 'text' > "$PHOTOS_A/Trip 2020/notes.txt"
printf 'jpeg' > "$PHOTOS_A/Trip 2020/.hidden.jpg"
printf 'png'  > "$PHOTOS_A/Family/one.png"
printf 'jpeg' > "$PHOTOS_A/.secret/x.jpg"
printf 'jpeg' > "$PHOTOS_A/__proto__/x.jpg"
printf 'jpeg' > "$PHOTOS_A/loose.jpg"

HA_PORT="$(free_port)"
write_ha_state '{"input_select.photo_frame_album":"unavailable","input_boolean.photo_frame_display":"unavailable","input_number.photo_frame_brightness":"unavailable","input_number.photo_frame_interval":"unavailable"}'

env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  FAKE_HA_PORT="$HA_PORT" FAKE_HA_STATE="$WORK/ha-state.json" FAKE_HA_TOKEN="$HA_TOKEN" \
  "$NODE_BIN" "$WORK/fake-ha.mjs" > "$WORK/fake-ha.log" 2>&1 &
HA_PID=$!
PIDS+=("$HA_PID")

ha_up=0
i=0
while [ "$i" -lt 100 ]; do
  if grep -q 'fake-ha listening' "$WORK/fake-ha.log" 2>/dev/null; then ha_up=1; break; fi
  sleep 0.1
  i=$((i + 1))
done
if [ "$ha_up" -eq 1 ]; then ok "harness: stub Home Assistant is listening"; else fail "harness: stub Home Assistant is listening"; fi

PORT_A="$(free_port)"
LOG_A="$WORK/server-a.log"
BASE="http://127.0.0.1:$PORT_A"

if start_server "$LOG_A" \
  PORT="$PORT_A" \
  HA_BASE_URL="http://127.0.0.1:$HA_PORT" \
  HA_TOKEN="$HA_TOKEN" \
  FRAME_KEY="$FRAME_KEY" \
  PHOTOS_DIR="$PHOTOS_A" \
  TRUST_PROXY=1 \
  HA_POLL_MS=1000 \
  SCAN_MS=5000 \
  AUTH_MAX_FAILS=3 \
  AUTH_WINDOW_MS=60000; then
  ok "boot: the service starts and logs listening"
  PID_A="$SERVER_PID"
else
  fail "boot: the service starts and logs listening" "$(tail -n 5 "$LOG_A" | tr '\n' ' ')"
  PID_A=""
fi

if [ -n "$PID_A" ]; then
  LOG_TEXT="$(cat "$LOG_A")"
  assert_contains "boot: the effective trust proxy value is logged" "$LOG_TEXT" '"trustProxy":"1"'
  assert_contains "boot: the effective ALLOW_QUERY_KEY is logged" "$LOG_TEXT" '"allowQueryKey":false'
  assert_contains "boot: the effective image set is logged" "$LOG_TEXT" '"imageExtensions":".jpg,.jpeg,.png,.gif,.bmp"'
  assert_not_contains "boot: no trust proxy warning when TRUST_PROXY=1" "$LOG_TEXT" '"message":"trust proxy disabled"'
  assert_not_contains "boot: the HA token never reaches the log" "$LOG_TEXT" "$HA_TOKEN"
  assert_not_contains "boot: the frame key never reaches the log" "$LOG_TEXT" "$FRAME_KEY"
  assert_contains "boot: logs are structured JSON lines" "$LOG_TEXT" '"level":"info","message":"listening"'

  # ---- /healthz: liveness only -------------------------------------------- #
  req /healthz
  assert_eq "healthz: 200 while the photo library is readable" "$CODE" "200"
  assert_eq "healthz: the body is exactly { ok }" "$BODY" '{"ok":true}'
  assert_eq "healthz: no other keys are exposed" "$(jkeys "$BODY")" "ok"
  assert_eq "healthz: ha is gone" "$(jfield ha "$BODY")" "<missing>"
  assert_eq "healthz: haVia is gone" "$(jfield haVia "$BODY")" "<missing>"
  assert_eq "healthz: haLastOk is gone" "$(jfield haLastOk "$BODY")" "<missing>"
  assert_eq "healthz: albums is gone" "$(jfield albums "$BODY")" "<missing>"
  assert_eq "healthz: photos is gone" "$(jfield photos "$BODY")" "<missing>"
  assert_matches "healthz: is never cached" "$HEADERS" '^cache-control: *no-store'
  assert_matches "healthz: carries the security headers" "$HEADERS" '^x-content-type-options: *nosniff'

  req /healthz -I
  assert_eq "healthz: HEAD is answered too" "$CODE" "200"

  # ---- auth gate over HTTP ------------------------------------------------- #
  req /
  assert_eq "auth: an unauthenticated page request is 401" "$CODE" "401"
  req /api/state
  assert_eq "auth: an unauthenticated api request is 401" "$CODE" "401"
  req "/?k=definitely-the-wrong-key"
  assert_eq "auth: a wrong key is 401" "$CODE" "401"

  req "/?k=$FRAME_KEY"
  assert_eq "auth: a valid key redirects 303" "$CODE" "303"
  assert_matches "auth: the redirect target is the bare path" "$HEADERS" '^location: */'
  assert_contains "auth: the session cookie is issued" "$HEADERS" "__Host-spf=$SESSION"
  assert_matches "auth: the cookie is HttpOnly, Secure and SameSite=Lax" "$HEADERS" 'httponly; *secure; *samesite=lax'

  req / -X POST
  assert_eq "method: POST is refused with 405" "$CODE" "405"
  assert_matches "method: the 405 advertises GET, HEAD" "$HEADERS" '^allow: *GET, HEAD'

  req /api/state -H "Cookie: __Host-spf=$SESSION"
  assert_eq "state: a cookie holder gets 200" "$CODE" "200"
  assert_ne "state: haOk is exposed behind the gate" "$(jfield haOk "$BODY")" "<missing>"
  assert_ne "state: haVia is exposed behind the gate" "$(jfield haVia "$BODY")" "<missing>"
  assert_ne "state: haLastOk is exposed behind the gate" "$(jfield haLastOk "$BODY")" "<missing>"
  assert_eq "state: haVia names the primary route" "$(jfield haVia "$BODY")" "primary"
  assert_ne "state: haError is exposed behind the gate" "$(jfield haError "$BODY")" "<missing>"
  assert_ne "state: the album catalogue is exposed behind the gate" "$(jfield albums "$BODY")" "<missing>"
  assert_matches "state: is never cached" "$HEADERS" '^cache-control: *no-store'
  assert_matches "state: varies on Cookie" "$HEADERS" '^vary: *cookie'

  # ---- catalogue and photo serving ---------------------------------------- #
  assert_eq "photos: the .heic file is not listed" \
    "$(jfield 'albums.Trip 2020' "$BODY")" \
    '["photos/Trip%202020/a1.jpg","photos/Trip%202020/b2.JPG"]'
  assert_eq "photos: a valid album is listed" "$(jfield 'albums.Family' "$BODY")" '["photos/Family/one.png"]'
  assert_eq "photos: a dot-prefixed album is not listed" "$(jfield 'albums..secret' "$BODY")" "<missing>"
  assert_eq "photos: an album named __proto__ is not listed" "$(jfield 'albums.__proto__' "$BODY")" "<missing>"

  req "/photos/Trip%202020/a1.jpg" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "photos: a supported photo is served" "$CODE" "200"
  assert_matches "photos: photos are privately cacheable" "$HEADERS" '^cache-control: *private, max-age=3600'
  req "/photos/Trip%202020/nope.heic" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "photos: a .heic file is not served" "$CODE" "404"
  req "/photos/Trip%202020/notes.txt" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "photos: a non-image file is not served" "$CODE" "404"
  req "/photos/Trip%202020/a1.jpg"
  assert_eq "photos: photos require authentication" "$CODE" "401"
  req "/photos/%2e%2e/%2e%2e/etc/passwd" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "photos: an encoded traversal is refused" "$CODE" "404"
  req "/photos/Trip%202020/%2e%2e%2fserver.js" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "photos: an encoded slash escape is refused" "$CODE" "404"
  req "/does-not-exist" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "routing: an unknown path is 404" "$CODE" "404"
  assert_eq "routing: the 404 body reveals nothing" "$BODY" "Not Found"

  if [ -f "$ROOT/public/index.html" ]; then
    req / -H "Cookie: __Host-spf=$SESSION"
    assert_eq "routing: the frame page is served to a cookie holder" "$CODE" "200"
  fi

  LOG_TEXT="$(cat "$LOG_A")"
  assert_contains "scan: the skip warning names the event" "$LOG_TEXT" '"message":"skipping images the frame cannot display"'
  assert_contains "scan: the skip warning carries a count" "$LOG_TEXT" '"skipped":1'
  assert_contains "scan: the skip warning is warning level" "$LOG_TEXT" '"level":"warn","message":"skipping images the frame cannot display"'
  assert_contains "scan: an unsupported album name is reported" "$LOG_TEXT" '"message":"skipping album with unsupported name"'

  # ---- change 1: HA health is what was accepted, not what answered --------- #
  if wait_state haError "no usable entity states" 40; then
    ok "ha: a poll of nothing but unavailable states is reported as unusable"
  else
    fail "ha: a poll of nothing but unavailable states is reported as unusable" "$(state_value haError)"
  fi
  req_ip /api/state "$PROBE_IP" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "ha: haOk stays false when every entity is unavailable" "$(jfield haOk "$BODY")" "false"
  assert_eq "ha: haLastOk does not advance on an all-unavailable poll" "$(jfield haLastOk "$BODY")" "null"
  assert_eq "ha: the last known good album survives the bad poll" "$(jfield album "$BODY")" "null"
  assert_eq "ha: the last known good brightness survives the bad poll" "$(jfield brightness "$BODY")" "100"
  assert_eq "ha: the last known good interval survives the bad poll" "$(jfield interval "$BODY")" "15"

  write_ha_state '{"input_select.photo_frame_album":"Trip 2020","input_boolean.photo_frame_display":"unavailable","input_number.photo_frame_brightness":"unavailable","input_number.photo_frame_interval":"unavailable"}'
  if wait_state haOk "true" 40; then
    ok "ha: a poll mixing usable and unavailable entities still succeeds"
  else
    fail "ha: a poll mixing usable and unavailable entities still succeeds" "$(state_value haError)"
  fi
  req_ip /api/state "$PROBE_IP" -H "Cookie: __Host-spf=$SESSION"
  assert_ne "ha: haLastOk advances once something was accepted" "$(jfield haLastOk "$BODY")" "null"
  assert_eq "ha: the accepted value is applied" "$(jfield album "$BODY")" "Trip 2020"
  assert_eq "ha: the rejected brightness keeps its previous value" "$(jfield brightness "$BODY")" "100"
  assert_eq "ha: the rejected display keeps its previous value" "$(jfield display "$BODY")" "true"

  write_ha_state '{"input_select.photo_frame_album":"Family","input_boolean.photo_frame_display":"off","input_number.photo_frame_brightness":"55","input_number.photo_frame_interval":"20"}'
  if wait_state album "Family" 40; then
    ok "ha: a fully usable poll applies every entity"
  else
    fail "ha: a fully usable poll applies every entity" "$(state_value album)"
  fi
  req_ip /api/state "$PROBE_IP" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "ha: display is applied" "$(jfield display "$BODY")" "false"
  assert_eq "ha: brightness is applied" "$(jfield brightness "$BODY")" "55"
  assert_eq "ha: interval is applied" "$(jfield interval "$BODY")" "20"
  assert_eq "ha: haError clears on a clean poll" "$(jfield haError "$BODY")" "null"

  # ---- change 3: per-client throttling when the proxy is trusted ----------- #
  ATTACKER="203.0.113.77"
  BYSTANDER="203.0.113.78"
  req_ip / "$ATTACKER"
  assert_eq "limiter: attacker failure 1 is 401" "$CODE" "401"
  req_ip / "$ATTACKER"
  assert_eq "limiter: attacker failure 2 is 401" "$CODE" "401"
  req_ip / "$ATTACKER"
  assert_eq "limiter: attacker failure 3 is 401" "$CODE" "401"
  req_ip / "$ATTACKER"
  assert_eq "limiter: the attacker is throttled with 429" "$CODE" "429"
  assert_matches "limiter: the 429 carries Retry-After" "$HEADERS" '^retry-after: *[0-9]+'
  req_ip / "$BYSTANDER"
  assert_eq "limiter: an unrelated client still gets 401, not 429" "$CODE" "401"
  req_ip /api/state "$ATTACKER" -H "Cookie: __Host-spf=$SESSION"
  assert_eq "limiter: a cookie holder on the attacker address is served" "$CODE" "200"
  req_ip /healthz "$ATTACKER"
  assert_eq "limiter: liveness stays reachable from a throttled address" "$CODE" "200"
  LOG_TEXT="$(cat "$LOG_A")"
  assert_contains "limiter: throttling is logged" "$LOG_TEXT" '"message":"auth throttled"'
fi

stop_server "${PID_A:-}"

# --------------------------------------------------------------------------- #
# Section 6 — integration run B: TRUST_PROXY unset, unreadable photo root
# --------------------------------------------------------------------------- #

printf -- '\n-- integration: trust proxy unset --\n'

PORT_B="$(free_port)"
LOG_B="$WORK/server-b.log"
BASE="http://127.0.0.1:$PORT_B"

if start_server "$LOG_B" \
  PORT="$PORT_B" \
  HA_BASE_URL="http://127.0.0.1:$HA_PORT" \
  HA_TOKEN="$HA_TOKEN" \
  FRAME_KEY="$FRAME_KEY" \
  PHOTOS_DIR="$WORK/no-such-photos-dir" \
  HA_POLL_MS=1000 \
  SCAN_MS=5000; then
  ok "boot: the service starts with TRUST_PROXY unset"
  PID_B="$SERVER_PID"
else
  fail "boot: the service starts with TRUST_PROXY unset" "$(tail -n 5 "$LOG_B" | tr '\n' ' ')"
  PID_B=""
fi

if [ -n "$PID_B" ]; then
  req /healthz
  req /healthz
  req /healthz
  assert_eq "healthz: 503 while the photo library is unreadable" "$CODE" "503"
  assert_eq "healthz: the 503 body is exactly { ok }" "$BODY" '{"ok":false}'
  assert_eq "healthz: the 503 exposes no extra keys" "$(jkeys "$BODY")" "ok"
  assert_eq "healthz: the 503 hides ha" "$(jfield ha "$BODY")" "<missing>"
  assert_eq "healthz: the 503 hides albums" "$(jfield albums "$BODY")" "<missing>"

  LOG_TEXT="$(cat "$LOG_B")"
  assert_contains "boot: the trust proxy warning is emitted" "$LOG_TEXT" '"message":"trust proxy disabled"'
  assert_contains "boot: the warning is warning level" "$LOG_TEXT" '"level":"warn","message":"trust proxy disabled"'
  assert_contains "boot: the warning names the reverse proxy case" "$LOG_TEXT" "reverse proxy"
  assert_contains "boot: the warning explains the global bucket" "$LOG_TEXT" "global bucket"
  assert_contains "boot: the warning states the fix" "$LOG_TEXT" "TRUST_PROXY=1"
  WARN_COUNT="$(grep -c '"message":"trust proxy disabled"' "$LOG_B" || true)"
  assert_eq "boot: the warning is emitted exactly once, not per request" "$WARN_COUNT" "1"
  assert_contains "boot: the effective trust proxy value is logged as false" "$LOG_TEXT" '"trustProxy":"false"'
fi

stop_server "${PID_B:-}"

# --------------------------------------------------------------------------- #
# Section 7 — integration run C: ALLOW_QUERY_KEY and a widened image set
# --------------------------------------------------------------------------- #

printf -- '\n-- integration: query key and widened image set --\n'

PHOTOS_C="$WORK/photos-c"
mkdir -p "$PHOTOS_C/Web"
printf 'webp' > "$PHOTOS_C/Web/one.webp"
printf 'jpeg' > "$PHOTOS_C/Web/two.jpg"
printf 'heic' > "$PHOTOS_C/Web/three.heic"

PORT_C="$(free_port)"
LOG_C="$WORK/server-c.log"
BASE="http://127.0.0.1:$PORT_C"

if start_server "$LOG_C" \
  PORT="$PORT_C" \
  HA_BASE_URL="http://127.0.0.1:$HA_PORT" \
  HA_TOKEN="$HA_TOKEN" \
  FRAME_KEY="$FRAME_KEY" \
  PHOTOS_DIR="$PHOTOS_C" \
  TRUST_PROXY=1 \
  ALLOW_QUERY_KEY=true \
  IMAGE_EXTENSIONS=".jpg,.webp" \
  HA_POLL_MS=1000 \
  SCAN_MS=5000; then
  ok "boot: the service starts with ALLOW_QUERY_KEY and a custom image set"
  PID_C="$SERVER_PID"
else
  fail "boot: the service starts with ALLOW_QUERY_KEY and a custom image set" "$(tail -n 5 "$LOG_C" | tr '\n' ' ')"
  PID_C=""
fi

if [ -n "$PID_C" ]; then
  LOG_TEXT="$(cat "$LOG_C")"
  assert_contains "boot: the widened image set is logged" "$LOG_TEXT" '"imageExtensions":".jpg,.webp"'
  assert_contains "boot: ALLOW_QUERY_KEY is logged as true" "$LOG_TEXT" '"allowQueryKey":true'

  req "/api/state?k=$FRAME_KEY"
  assert_eq "query key: a valid key is served directly, not redirected" "$CODE" "200"
  assert_contains "query key: the cookie is still issued" "$HEADERS" "__Host-spf=$SESSION"
  assert_eq "query key: the widened set lists .webp" "$(jfield 'albums.Web' "$BODY")" \
    '["photos/Web/one.webp","photos/Web/two.jpg"]'
  assert_not_contains "query key: .heic stays out even when the set is widened" "$BODY" "three.heic"

  req "/photos/Web/one.webp?k=$FRAME_KEY"
  assert_eq "photos: a .webp is served when the set allows it" "$CODE" "200"
  req "/photos/Web/three.heic?k=$FRAME_KEY"
  assert_eq "photos: a .heic is refused even with a widened set" "$CODE" "404"
  req "/api/state?k=wrong-key-here"
  assert_eq "query key: a wrong key is still 401" "$CODE" "401"

  LOG_TEXT="$(cat "$LOG_C")"
  assert_contains "scan: the widened run still warns about .heic" "$LOG_TEXT" '"message":"skipping images the frame cannot display"'
fi

stop_server "${PID_C:-}"

# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #

printf -- '\n----------------------------------------\n'
printf 'assertions: %d passed, %d failed\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf '\nlast lines of each server log:\n'
  for logfile in "$WORK"/server-*.log; do
    [ -f "$logfile" ] || continue
    printf -- '--- %s\n' "$(basename "$logfile")"
    tail -n 20 "$logfile"
  done
  exit 1
fi

exit 0
