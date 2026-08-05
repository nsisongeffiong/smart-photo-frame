#!/usr/bin/env bash
#
# verify.sh — regression harness for smart-photo-frame.
#
# Boots the real server.js against stub Home Assistant instances that this
# script creates itself, asserts the shipped contract, cleans up every child
# process and temp file on exit, and exits non-zero if any assertion failed.
#
# Requirements: bash, curl, node. No test framework.
# Run with:  bash verify.sh
#
# Harness notes (read before "fixing" a failure):
#
#  * The session cookie is Secure. curl only sends Secure cookies over a
#    secure context, so every request targets 127.0.0.1 — curl treats
#    localhost/127.0.0.1/::1 as secure. Do not switch this to a hostname.
#  * curl discards Set-Cookie when following a redirect without a jar, so the
#    303 follow-up is always exercised with -c/-b. A 401 there is a harness
#    bug, not a server defect.
#  * The main instance runs with TRUST_PROXY unset (the shipped default). In
#    that mode the auth limiter degrades to a single global bucket: failures
#    from any client throttle every other client. That is why the main
#    instance is started with a very high AUTH_MAX_FAILS — otherwise the
#    handful of deliberate 401s below drag unrelated assertions into 429.
#    The limiter itself is exercised on a dedicated TRUST_PROXY=1 instance,
#    where every request carries its own X-Forwarded-For address.
#  * public/index.html has a header comment listing forbidden syntax. HTML,
#    block and line comments are stripped before scanning for ?. and ?? —
#    the comment is documentation, not a defect.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FRAME_KEY="spf-harness-frame-key-0123456789abcdef0123456789"
HA_TOKEN="spf-harness-ha-token"
MAX_PHOTOS=4
RL_MAX_FAILS=5

ENTITY_ALBUM="input_select.frame_album"
ENTITY_DISPLAY="input_boolean.frame_display"
ENTITY_BRIGHTNESS="input_number.frame_brightness"
ENTITY_INTERVAL="input_number.frame_interval"

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
SKIP=0
FAILED=()

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_SKIP=$'\033[33m'; C_HDR=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_SKIP=""; C_HDR=""; C_OFF=""
fi

section() { printf '\n%s== %s ==%s\n' "$C_HDR" "$1" "$C_OFF"; }
pass()    { PASS=$((PASS + 1)); printf '  %sPASS%s %s\n' "$C_OK" "$C_OFF" "$1"; }
skip()    { SKIP=$((SKIP + 1)); printf '  %sSKIP%s %s (%s)\n' "$C_SKIP" "$C_OFF" "$1" "${2:-}"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED+=("$1")
  printf '  %sFAIL%s %s\n' "$C_BAD" "$C_OFF" "$1"
  [ $# -gt 1 ] && printf '       %s\n' "$2"
  return 0
}
fatal() { printf '\n%sFATAL%s %s\n' "$C_BAD" "$C_OFF" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Workspace and cleanup
# ---------------------------------------------------------------------------

command -v curl >/dev/null 2>&1 || fatal "curl is required"
command -v node >/dev/null 2>&1 || fatal "node is required"
[ -f server.js ] || fatal "server.js not found in $ROOT"
[ -f public/index.html ] || fatal "public/index.html not found in $ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/spf-verify.XXXXXX")" || fatal "cannot create temp dir"
PIDS=()

cleanup() {
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" >/dev/null 2>&1; done
  sleep 0.2
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" >/dev/null 2>&1; done
  chmod -R u+rwX "$TMP" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

PHOTOS="$TMP/photos"
JAR_MAIN="$TMP/jar-main"
JAR_RL="$TMP/jar-rl"
JAR_FO="$TMP/jar-fo"

# ---------------------------------------------------------------------------
# Node helpers
# ---------------------------------------------------------------------------

cat >"$TMP/jsonq.js" <<'JSONQ'
'use strict';
/**
 * Read JSON from stdin, print the value addressed by the argv key path.
 * Usage: jsonq.js [--count] [key ...]
 * Output: __INVALID_JSON__ | __MISSING__ | __VALID__ | scalar | __ARRAY__<n>
 *         | compact JSON. With --count: a cardinality, or __NA__.
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const wantCount = args[0] === '--count';
  const keys = wantCount ? args.slice(1) : args;
  let cur;
  try { cur = JSON.parse(raw); } catch (err) { console.log('__INVALID_JSON__'); return; }
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object' ||
        !Object.prototype.hasOwnProperty.call(cur, key)) {
      console.log('__MISSING__');
      return;
    }
    cur = cur[key];
  }
  if (wantCount) {
    if (typeof cur === 'number') console.log(String(cur));
    else if (Array.isArray(cur)) console.log(String(cur.length));
    else if (cur && typeof cur === 'object') console.log(String(Object.keys(cur).length));
    else console.log('__NA__');
    return;
  }
  if (!keys.length) { console.log('__VALID__'); return; }
  if (cur === null || typeof cur !== 'object') console.log(String(cur));
  else if (Array.isArray(cur)) console.log('__ARRAY__' + cur.length);
  else console.log(JSON.stringify(cur));
});
JSONQ

cat >"$TMP/strip-comments.js" <<'STRIP'
'use strict';
/** Print a file with HTML, block and line comments removed. */
const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');
src = src.replace(/<!--[\s\S]*?-->/g, '\n');
src = src.replace(/\/\*[\s\S]*?\*\//g, '\n');
src = src.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
process.stdout.write(src);
STRIP

cat >"$TMP/setent.js" <<'SETENT'
'use strict';
/** Mutate one entity state in a stub Home Assistant state file. */
const fs = require('fs');
const [file, entity, state] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
if (doc[entity] && typeof doc[entity] === 'object') doc[entity].state = state;
else doc[entity] = { state };
fs.writeFileSync(file, JSON.stringify(doc, null, 2));
SETENT

cat >"$TMP/ha-stub.js" <<'HASTUB'
'use strict';
/**
 * Minimal Home Assistant REST stub. Reads its state file on every request so
 * the harness can change entity states by rewriting the file.
 * Usage: ha-stub.js <port> <stateFile>
 */
const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2]);
const stateFile = process.argv[3];

function entities() {
  const doc = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const now = new Date().toISOString();
  return Object.keys(doc).map((entity_id) => {
    const raw = doc[entity_id];
    const value = raw && typeof raw === 'object' ? raw : { state: raw };
    return {
      entity_id,
      state: String(value.state),
      attributes: value.attributes || {},
      last_changed: now,
      last_updated: now,
      context: { id: 'harness', parent_id: null, user_id: null }
    };
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

http.createServer((req, res) => {
  const path = decodeURIComponent((req.url || '').split('?')[0]);
  try {
    if (path === '/api/' || path === '/api') return send(res, 200, { message: 'API running.' });
    if (path === '/api/config') return send(res, 200, { version: '2024.1.0', state: 'RUNNING' });
    if (path === '/api/states') return send(res, 200, entities());
    if (path.startsWith('/api/states/')) {
      const id = path.slice('/api/states/'.length);
      const hit = entities().find((e) => e.entity_id === id);
      return hit ? send(res, 200, hit) : send(res, 404, { message: 'Entity not found.' });
    }
    return send(res, 404, { message: 'Not found.' });
  } catch (err) {
    return send(res, 500, { message: String(err && err.message) });
  }
}).listen(port, '127.0.0.1');
HASTUB

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

mkimg() { printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' >"$1"; }

build_fixtures() {
  mkdir -p "$PHOTOS"
  printf 'traversal-canary-do-not-serve\n' >"$TMP/secret.txt"

  mkdir -p "$PHOTOS/family"
  mkimg "$PHOTOS/family/one.jpg"
  mkimg "$PHOTOS/family/two.png"
  mkimg "$PHOTOS/family/a photo with spaces.jpg"
  printf 'not an image\n' >"$PHOTOS/family/notes.txt"
  printf 'not an image\n' >"$PHOTOS/family/clip.mp4"

  mkdir -p "$PHOTOS/capped"
  for n in 1 2 3 4 5 6 7; do mkimg "$PHOTOS/capped/c$n.jpg"; done

  mkdir -p "$PHOTOS/dotty"
  mkimg "$PHOTOS/dotty/visible.jpg"
  mkimg "$PHOTOS/dotty/.secret.jpg"

  # Hostile album names: prototype keys and an XSS payload.
  for hostile in '__proto__' 'constructor' 'toString' '<img src=x onerror=alert(1)>'; do
    mkdir -p "$PHOTOS/$hostile"
    mkimg "$PHOTOS/$hostile/p.jpg"
  done

  mkdir -p "$PHOTOS/noperm"
  mkimg "$PHOTOS/noperm/n.jpg"
  chmod 000 "$PHOTOS/noperm"
}

write_state_file() { # <file> <album>
  cat >"$1" <<JSON
{
  "$ENTITY_ALBUM": { "state": "$2", "attributes": { "options": ["family", "capped", "dotty"] } },
  "$ENTITY_DISPLAY": { "state": "on" },
  "$ENTITY_BRIGHTNESS": { "state": "42", "attributes": { "min": 0, "max": 100, "step": 1 } },
  "$ENTITY_INTERVAL": { "state": "25", "attributes": { "min": 5, "max": 600, "step": 1 } }
}
JSON
}

set_entity() { node "$TMP/setent.js" "$1" "$2" "$3"; }

# ---------------------------------------------------------------------------
# Process control
# ---------------------------------------------------------------------------

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

start_stub() { # <name> <port> <stateFile> -> echoes pid
  local name="$1" port="$2" state="$3"
  node "$TMP/ha-stub.js" "$port" "$state" >"$TMP/$name.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  printf '%s' "$pid"
}

wait_http() { # <url> -> 0 when reachable
  local url="$1" i
  for i in $(seq 1 120); do
    curl -sS -o /dev/null --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

start_server() { # <name> <port> [EXTRA=env ...] -> echoes pid
  local name="$1" port="$2"
  shift 2
  env PORT="$port" \
      HA_TOKEN="$HA_TOKEN" \
      FRAME_KEY="$FRAME_KEY" \
      PHOTOS_DIR="$PHOTOS" \
      HA_POLL_MS=300 \
      SCAN_MS=800 \
      HA_REPROBE_EVERY=3 \
      MAX_PHOTOS_PER_ALBUM="$MAX_PHOTOS" \
      AUTH_WINDOW_MS=600000 \
      ENTITY_ALBUM="$ENTITY_ALBUM" \
      ENTITY_DISPLAY="$ENTITY_DISPLAY" \
      ENTITY_BRIGHTNESS="$ENTITY_BRIGHTNESS" \
      ENTITY_INTERVAL="$ENTITY_INTERVAL" \
      "$@" node server.js >"$TMP/$name.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  printf '%s' "$pid"
}

stop_pid() { kill "$1" >/dev/null 2>&1; sleep 0.3; kill -9 "$1" >/dev/null 2>&1; return 0; }

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

BASE=""
XFF_N=0
XFF_OVERRIDE=""
HTTP_STATUS=""
HTTP_BODY=""
HTTP_HEADERS=""

# A fresh forwarded-for address per request keeps unrelated assertions out of
# each other's rate-limit buckets.
next_ip() {
  XFF_N=$((XFF_N + 1))
  printf '198.51.%d.%d' "$(((XFF_N / 250) % 250))" "$((XFF_N % 250 + 1))"
}

http() { # <path> [curl args...]
  local path="$1"
  shift
  local ip="${XFF_OVERRIDE:-$(next_ip)}"
  : >"$TMP/body"
  : >"$TMP/hdrs"
  HTTP_STATUS="$(curl -sS --max-time 15 -o "$TMP/body" -D "$TMP/hdrs" -w '%{http_code}' \
    -H "X-Forwarded-For: $ip" "$@" "$BASE$path" 2>>"$TMP/curl.err")"
  [ -z "$HTTP_STATUS" ] && HTTP_STATUS="000"
  HTTP_BODY="$(tr -d '\000' <"$TMP/body")"
  HTTP_HEADERS="$(tr -d '\r' <"$TMP/hdrs")"
}

http_ip() { # <ip> <path> [curl args...]
  XFF_OVERRIDE="$1"
  shift
  http "$@"
  XFF_OVERRIDE=""
}

header_value() { printf '%s' "$HTTP_HEADERS" | awk -v k="$(printf '%s' "$1" | tr 'A-Z' 'a-z'):" 'tolower($1)==k{$1="";sub(/^ /,"");print;exit}'; }
jval() { printf '%s' "$HTTP_BODY" | node "$TMP/jsonq.js" "$@"; }

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

assert_status() { # <expected> <label> <path> [curl args...]
  local exp="$1" label="$2"
  shift 2
  http "$@"
  [ "$HTTP_STATUS" = "$exp" ] && { pass "$label"; return 0; }
  fail "$label" "expected $exp, got $HTTP_STATUS for $1"
}

assert_status_in() { # "<a b c>" <label> <path> [curl args...]
  local allowed="$1" label="$2"
  shift 2
  http "$@"
  case " $allowed " in
    *" $HTTP_STATUS "*) pass "$label" ;;
    *) fail "$label" "expected one of [$allowed], got $HTTP_STATUS for $1" ;;
  esac
}

check_eq() { # <expected> <actual> <label>
  [ "$1" = "$2" ] && { pass "$3"; return 0; }
  fail "$3" "expected '$1', got '$2'"
}

check_ge() { # <actual> <min> <label>
  if [ "$1" -ge "$2" ] 2>/dev/null; then pass "$3"; else fail "$3" "expected >= $2, got '$1'"; fi
}

check_contains() { # <needle> <label> [haystack]
  local hay="${3-$HTTP_BODY}"
  case "$hay" in *"$1"*) pass "$2" ;; *) fail "$2" "missing substring: $1" ;; esac
}

check_not_contains() { # <needle> <label> [haystack]
  local hay="${3-$HTTP_BODY}"
  case "$hay" in *"$1"*) fail "$2" "unexpected substring: $1" ;; *) pass "$2" ;; esac
}

check_matches() { # <extended regex> <label> [haystack]
  local hay="${3-$HTTP_BODY}"
  if printf '%s' "$hay" | grep -Eqi -- "$1"; then pass "$2"; else fail "$2" "no match for: $1"; fi
}

check_header() { # <extended regex> <label>
  if printf '%s' "$HTTP_HEADERS" | grep -Eqi -- "$1"; then pass "$2"; else fail "$2" "no header matching: $1"; fi
}

check_key() { # <label> <key...>
  local label="$1"
  shift
  local v
  v="$(jval "$@")"
  case "$v" in
    __MISSING__ | __INVALID_JSON__) fail "$label" "key path '$*' -> $v" ;;
    *) pass "$label" ;;
  esac
}

check_valid_json() { # <label>
  local v
  v="$(jval)"
  [ "$v" = "__VALID__" ] && { pass "$1"; return 0; }
  fail "$1" "response is not valid JSON"
}

# Poll /api/state until the addressed value falls in the allowed set.
wait_val() { # <"allowed values"> <timeout_s> <key...> -> echoes observed value
  local allowed="$1" secs="$2"
  shift 2
  local deadline=$((SECONDS + secs)) got=""
  while :; do
    http /api/state -b "$JAR"
    got="$(jval "$@")"
    case " $allowed " in *" $got "*) break ;; esac
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 0.25
  done
  printf '%s' "$got"
}

assert_val() { # <label> <"allowed values"> <key...>
  local label="$1" allowed="$2"
  shift 2
  local got
  got="$(wait_val "$allowed" 12 "$@")"
  case " $allowed " in
    *" $got "*) pass "$label" ;;
    *) fail "$label" "$* = '$got', wanted one of [$allowed]" ;;
  esac
}

# ---------------------------------------------------------------------------
# Section 1 — static analysis
# ---------------------------------------------------------------------------

static_checks() {
  section "Static analysis"

  if node --check server.js >"$TMP/node-check.log" 2>&1; then
    pass "server.js parses (node --check)"
  else
    fail "server.js parses (node --check)" "$(head -n 3 "$TMP/node-check.log" | tr '\n' ' ')"
  fi

  local client="public/index.html"
  local stripped="$TMP/client.stripped"
  if node "$TMP/strip-comments.js" "$client" >"$stripped" 2>"$TMP/strip.err"; then
    pass "client comment stripping succeeded"
  else
    fail "client comment stripping succeeded" "$(head -n 2 "$TMP/strip.err" | tr '\n' ' ')"
    cp "$client" "$stripped"
  fi

  # Credentials: scanned on the raw file, precise patterns only.
  if grep -Fq "$FRAME_KEY" "$client"; then
    fail "client holds no frame key"
  else
    pass "client holds no frame key"
  fi
  if grep -Eq 'eyJhbGciOi|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}' "$client"; then
    fail "client holds no bearer token"
  else
    pass "client holds no bearer token"
  fi

  # Host / API references: scanned post-strip, the header comment may name them.
  local pat label
  while IFS='|' read -r pat label; do
    [ -z "$pat" ] && continue
    if grep -Eq -- "$pat" "$stripped"; then
      fail "client never references $label"
    else
      pass "client never references $label"
    fi
  done <<'PATTERNS'
:8123|the HA port
/api/states/|the HA states API
nabu\.casa|a Nabu Casa host
\.ts\.net|a Tailscale host
HA_TOKEN|the HA token variable
Authorization|an Authorization header
PATTERNS

  if grep -q '?\.' "$stripped"; then
    fail "client is free of optional chaining" "found ?. outside comments"
  else
    pass "client is free of optional chaining"
  fi
  if grep -q '??' "$stripped"; then
    fail "client is free of nullish coalescing" "found ?? outside comments"
  else
    pass "client is free of nullish coalescing"
  fi

  if [ ! -f package.json ]; then
    skip "npm audit reports no high or critical findings" "no package.json"
  elif ! command -v npm >/dev/null 2>&1; then
    skip "npm audit reports no high or critical findings" "npm unavailable"
  else
    npm audit --json >"$TMP/audit.json" 2>"$TMP/audit.err"
    local counted
    counted="$(node -e '
      const fs = require("fs");
      try {
        const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const v = (doc.metadata && doc.metadata.vulnerabilities) || {};
        console.log(String((v.high || 0) + (v.critical || 0)));
      } catch (err) { console.log("__NA__"); }
    ' "$TMP/audit.json" 2>/dev/null)"
    if [ "$counted" = "__NA__" ] || [ -z "$counted" ]; then
      skip "npm audit reports no high or critical findings" "audit produced no parseable report"
    else
      check_eq "0" "$counted" "npm audit reports no high or critical findings"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Section 2 — auth and session
# ---------------------------------------------------------------------------

COOKIE_NAME=""

auth_checks() {
  section "Authentication and session"

  assert_status 200 "/healthz is reachable unauthenticated" /healthz
  assert_status 401 "/ is 401 without credentials" /
  assert_status 401 "/api/state is 401 without credentials" /api/state
  assert_status 401 "/photos/... is 401 without credentials" /photos/family/one.jpg
  assert_status_in "401 403" "a wrong ?k= is rejected" "/?k=definitely-not-the-frame-key-000000000000"

  rm -f "$JAR_MAIN"
  assert_status 303 "a correct ?k= returns 303" "/?k=$FRAME_KEY" -c "$JAR_MAIN"

  local loc
  loc="$(header_value Location)"
  case "$loc" in
    "") fail "the 303 carries a Location header" ;;
    *\?*) fail "the redirect Location carries no query string" "Location: $loc" ;;
    *) pass "the redirect Location carries no query string" ;;
  esac

  check_header 'set-cookie:.*httponly' "the session cookie is HttpOnly"
  check_header 'set-cookie:.*secure' "the session cookie is Secure"
  check_header 'set-cookie:.*samesite' "the session cookie sets SameSite"
  check_header 'set-cookie:.*path=/' "the session cookie is scoped to /"

  COOKIE_NAME="$(header_value Set-Cookie | cut -d= -f1 | tr -d ' ')"
  case "$COOKIE_NAME" in
    __Host-*) pass "the session cookie uses the __Host- prefix" ;;
    *) fail "the session cookie uses the __Host- prefix" "name was '$COOKIE_NAME'" ;;
  esac

  # A cookie jar is mandatory here: without one curl drops the Set-Cookie.
  assert_status 200 "following the redirect with a cookie jar yields 200" "${loc:-/}" -b "$JAR_MAIN"
  check_matches '<html' "the redirect target serves the frame page"

  JAR="$JAR_MAIN"
  assert_status 200 "the cookie authenticates /api/state" /api/state -b "$JAR_MAIN"
  assert_status 200 "the cookie authenticates /photos/..." /photos/family/one.jpg -b "$JAR_MAIN"

  local bogus="${COOKIE_NAME:-__Host-spf}=%E0%A4%A"
  assert_status 401 "a cookie with undecodable percent-encoding yields 401" /api/state -H "Cookie: $bogus"
}

# ---------------------------------------------------------------------------
# Section 3 — response contract
# ---------------------------------------------------------------------------

contract_checks() {
  section "Response contract"

  http /healthz
  check_valid_json "/healthz returns JSON"
  local key
  for key in ok ha haVia haLastOk albums photos; do
    check_key "/healthz exposes $key" "$key"
  done

  http /api/state -b "$JAR_MAIN"
  check_valid_json "/api/state returns JSON"
  for key in album display brightness interval haOk haError haVia haLastOk albums scannedAt; do
    check_key "/api/state exposes $key" "$key"
  done
}

# ---------------------------------------------------------------------------
# Section 4 — rate limiting and proxy trust
# ---------------------------------------------------------------------------

ratelimit_checks() { # <base url>
  section "Rate limiting and proxy trust (TRUST_PROXY=1)"

  local saved="$BASE"
  BASE="$1"

  local clean_ip="203.0.113.200"
  local bad_ip="203.0.113.7"
  local other_ip="203.0.113.99"

  rm -f "$JAR_RL"
  http_ip "$clean_ip" "/?k=$FRAME_KEY" -c "$JAR_RL"
  check_eq "303" "$HTTP_STATUS" "rate-limit instance issues a session cookie"

  local i unthrottled=0
  for i in $(seq 1 $((RL_MAX_FAILS + 3))); do
    http_ip "$bad_ip" /api/state
    [ "$HTTP_STATUS" = "401" ] && unthrottled=$((unthrottled + 1))
  done
  check_ge "$unthrottled" 1 "failed auth returns 401 before the limit"

  http_ip "$bad_ip" /api/state
  check_eq "429" "$HTTP_STATUS" "the offending forwarded address is throttled"

  http_ip "$other_ip" /api/state
  check_eq "401" "$HTTP_STATUS" "a different forwarded address still gets 401, not 429"

  http_ip "$bad_ip" /api/state -b "$JAR_RL"
  check_eq "200" "$HTTP_STATUS" "a cookie holder is served even from the throttled address"

  BASE="$saved"
}

# ---------------------------------------------------------------------------
# Section 5 — security headers
# ---------------------------------------------------------------------------

header_checks() {
  section "Security headers"

  http / -b "$JAR_MAIN"
  check_header '^x-content-type-options:[[:space:]]*nosniff' "X-Content-Type-Options: nosniff"
  check_header '^referrer-policy:[[:space:]]*no-referrer' "Referrer-Policy: no-referrer"
  check_header '^content-security-policy:' "Content-Security-Policy is present"
  check_header '^content-security-policy:.*frame-ancestors' "CSP includes frame-ancestors"
}

# ---------------------------------------------------------------------------
# Section 6 — path safety
# ---------------------------------------------------------------------------

path_checks() {
  section "Path safety"

  local blocked="400 403 404"

  assert_status_in "$blocked" "../ traversal is blocked" \
    /photos/../secret.txt -b "$JAR_MAIN" --path-as-is
  check_not_contains "traversal-canary-do-not-serve" "../ traversal leaks no bytes"

  assert_status_in "$blocked" "encoded %2e%2e traversal is blocked" \
    /photos/%2e%2e/secret.txt -b "$JAR_MAIN" --path-as-is
  check_not_contains "traversal-canary-do-not-serve" "encoded traversal leaks no bytes"

  assert_status_in "$blocked" "deep traversal is blocked" \
    /photos/family/../../../../etc/passwd -b "$JAR_MAIN" --path-as-is
  check_not_contains "root:" "deep traversal leaks no bytes"

  assert_status_in "$blocked" "dotfiles are not served" \
    /photos/dotty/.secret.jpg -b "$JAR_MAIN" --path-as-is

  assert_status 200 "filenames containing spaces are served" \
    "/photos/family/a%20photo%20with%20spaces.jpg" -b "$JAR_MAIN"
}

# ---------------------------------------------------------------------------
# Section 7 — hostile input
# ---------------------------------------------------------------------------

hostile_checks() {
  section "Hostile input"

  http /api/state -b "$JAR_MAIN"
  check_valid_json "/api/state stays valid JSON with hostile album names"
  check_eq "200" "$HTTP_STATUS" "/api/state answers 200 with hostile album names"

  local family_count
  family_count="$(jval --count albums family)"
  check_ge "$family_count" 1 "the scan survives __proto__/constructor/toString albums"
  check_eq "3" "$family_count" "non-image files are excluded from an album"

  local capped_count
  capped_count="$(jval --count albums capped)"
  check_eq "$MAX_PHOTOS" "$capped_count" "an oversized album is capped at MAX_PHOTOS_PER_ALBUM"

  local album
  album="$(jval album)"
  check_eq "family" "$album" "hostile album names do not corrupt the selected album"

  assert_status_in "200 400 403 404" "an XSS-shaped album name is handled without a 5xx" \
    "/photos/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/p.jpg" -b "$JAR_MAIN"

  if [ "$(id -u)" = "0" ]; then
    skip "an unreadable album does not abort the scan" "running as root, mode 000 is not enforced"
  else
    http /api/state -b "$JAR_MAIN"
    local still
    still="$(jval --count albums capped)"
    check_ge "$still" 1 "an unreadable album does not abort the scan"
  fi

  assert_status 200 "/healthz still healthy after hostile input" /healthz
  check_eq "true" "$(jval ok)" "/healthz reports ok after hostile input"
}

# ---------------------------------------------------------------------------
# Section 8 — Home Assistant propagation
# ---------------------------------------------------------------------------

behaviour_checks() { # <state file>
  section "Home Assistant propagation"

  local state="$1"
  JAR="$JAR_MAIN"

  set_entity "$state" "$ENTITY_ALBUM" "capped"
  assert_val "album propagates from Home Assistant" "capped" album

  set_entity "$state" "$ENTITY_DISPLAY" "off"
  assert_val "display off propagates" "off false" display

  set_entity "$state" "$ENTITY_DISPLAY" "on"
  assert_val "display on propagates" "on true" display

  # Tolerates a server that rescales 0-100 to 0-1.
  set_entity "$state" "$ENTITY_BRIGHTNESS" "42"
  assert_val "brightness propagates" "42 0.42" brightness

  # Tolerates a server that converts seconds to milliseconds.
  set_entity "$state" "$ENTITY_INTERVAL" "25"
  assert_val "interval propagates" "25 25000" interval

  set_entity "$state" "$ENTITY_ALBUM" "family"
  assert_val "album reverts on the next poll" "family" album
}

# ---------------------------------------------------------------------------
# Section 9 — failover and degradation
# ---------------------------------------------------------------------------

failover_checks() { # <base> <primary port> <primary state> <primary pid var name>
  section "Failover and degradation"

  local saved_base="$BASE" saved_jar="$JAR"
  BASE="$1"
  local pport="$2" pstate="$3" ppid="$4" cport="$5"
  JAR="$JAR_FO"

  rm -f "$JAR_FO"
  http "/?k=$FRAME_KEY" -c "$JAR_FO"
  check_eq "303" "$HTTP_STATUS" "failover instance issues a session cookie"

  assert_val "haVia reports primary while the primary is up" "primary" haVia
  assert_val "the primary album is in effect" "family" album

  stop_pid "$ppid"
  assert_val "haVia reports fallback when the primary dies" "fallback" haVia
  assert_val "the fallback album takes over" "capped" album
  assert_val "haOk stays true on the fallback" "true" haOk

  stop_pid "$CPID"
  assert_val "haOk goes false when both endpoints die" "false" haOk
  http /api/state -b "$JAR_FO"
  check_eq "capped" "$(jval album)" "the last known album is retained while HA is down"
  check_key "haError is populated while HA is down" haError
  assert_status 200 "photos keep being served while HA is down" \
    /photos/capped/c1.jpg -b "$JAR_FO"
  assert_status 200 "/healthz stays reachable while HA is down" /healthz
  check_eq "false" "$(jval ha)" "/healthz reports ha false while HA is down"

  PPID_NEW="$(start_stub ha-primary-restart "$pport" "$pstate")"
  wait_http "http://127.0.0.1:$pport/api/" || fail "the primary stub restarts"
  assert_val "haVia returns to primary once it recovers" "primary" haVia
  assert_val "the primary album is restored" "family" album

  BASE="$saved_base"
  JAR="$saved_jar"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

printf '%ssmart-photo-frame verification harness%s\n' "$C_HDR" "$C_OFF"
printf 'workspace: %s\n' "$TMP"

build_fixtures
static_checks

STATE_MAIN="$TMP/ha-main.json"
STATE_FALLBACK="$TMP/ha-fallback.json"
write_state_file "$STATE_MAIN" "family"
write_state_file "$STATE_FALLBACK" "capped"

HA_PORT="$(free_port)"
HA_FO_PRIMARY_PORT="$(free_port)"
HA_FO_FALLBACK_PORT="$(free_port)"
SRV_PORT="$(free_port)"
SRV_RL_PORT="$(free_port)"
SRV_FO_PORT="$(free_port)"

start_stub ha-main "$HA_PORT" "$STATE_MAIN" >/dev/null
wait_http "http://127.0.0.1:$HA_PORT/api/" || fatal "the main Home Assistant stub did not start"

# Main instance: TRUST_PROXY at its shipped default. In that mode the auth
# limiter shares one bucket across all clients, so the deliberate 401s in the
# auth section would otherwise throttle every later assertion — hence the
# deliberately high AUTH_MAX_FAILS here. The limiter is exercised properly on
# the TRUST_PROXY=1 instance below.
BASE="http://127.0.0.1:$SRV_PORT"
start_server srv-main "$SRV_PORT" \
  HA_BASE_URL="http://127.0.0.1:$HA_PORT" \
  AUTH_MAX_FAILS=1000 >/dev/null
wait_http "$BASE/healthz" || fatal "server.js did not start; log: $(tail -n 5 "$TMP/srv-main.log")"
JAR="$JAR_MAIN"

auth_checks
contract_checks
header_checks
path_checks
hostile_checks

start_server srv-rl "$SRV_RL_PORT" \
  HA_BASE_URL="http://127.0.0.1:$HA_PORT" \
  TRUST_PROXY=1 \
  AUTH_MAX_FAILS="$RL_MAX_FAILS" >/dev/null
if wait_http "http://127.0.0.1:$SRV_RL_PORT/healthz"; then
  ratelimit_checks "http://127.0.0.1:$SRV_RL_PORT"
else
  fail "the TRUST_PROXY=1 instance starts" "log: $(tail -n 3 "$TMP/srv-rl.log" | tr '\n' ' ')"
fi

behaviour_checks "$STATE_MAIN"

PPID="$(start_stub ha-fo-primary "$HA_FO_PRIMARY_PORT" "$STATE_MAIN")"
CPID="$(start_stub ha-fo-fallback "$HA_FO_FALLBACK_PORT" "$STATE_FALLBACK")"
wait_http "http://127.0.0.1:$HA_FO_PRIMARY_PORT/api/" || fatal "the failover primary stub did not start"
wait_http "http://127.0.0.1:$HA_FO_FALLBACK_PORT/api/" || fatal "the failover fallback stub did not start"

start_server srv-fo "$SRV_FO_PORT" \
  HA_BASE_URL="http://127.0.0.1:$HA_FO_PRIMARY_PORT" \
  HA_BASE_URL_FALLBACK="http://127.0.0.1:$HA_FO_FALLBACK_PORT" \
  AUTH_MAX_FAILS=1000 >/dev/null
if wait_http "http://127.0.0.1:$SRV_FO_PORT/healthz"; then
  failover_checks "http://127.0.0.1:$SRV_FO_PORT" \
    "$HA_FO_PRIMARY_PORT" "$STATE_MAIN" "$PPID" "$HA_FO_FALLBACK_PORT"
else
  fail "the failover instance starts" "log: $(tail -n 3 "$TMP/srv-fo.log" | tr '\n' ' ')"
fi

# Logs must be structured JSON lines, not plain text.
section "Logging"
LOG_LINE="$(grep -m1 '^{' "$TMP/srv-main.log" 2>/dev/null)"
if [ -n "$LOG_LINE" ]; then
  HTTP_BODY="$LOG_LINE"
  check_valid_json "server logs are JSON lines"
  check_key "log lines carry ts" ts
  check_key "log lines carry level" level
  check_key "log lines carry message" message
else
  fail "server logs are JSON lines" "no JSON object found in srv-main.log"
fi

section "Summary"
printf '  passed: %d   failed: %d   skipped: %d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\n%sfailures:%s\n' "$C_BAD" "$C_OFF"
  for label in "${FAILED[@]}"; do printf '  - %s\n' "$label"; done
  exit 1
fi
printf '%sall checks passed%s\n' "$C_OK" "$C_OFF"
exit 0
