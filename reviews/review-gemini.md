## FINDINGS

**[SEVERITY: Medium] [CONFIDENCE: High]**  
**Category:** Logic Bug / Incorrect State & Health Reporting  
**Location:** `server.js`, `HomeAssistantClient.poll()` (~line 580) and `#applyValues()` (~line 625)  
**What:** `HomeAssistantClient.poll()` evaluates Home Assistant health by checking `usable = Object.keys(outcome.values).length > 0`. When Home Assistant is starting up or has entities in state `"unknown"` or `"unavailable"`, `#fetchState()` returns HTTP 200 with those state strings. Because `outcome.values` receives these keys, `poll()` sets `haOk = true` and updates `lastOkAt = Date.now()`. However, `#applyValues()` rejects `"unknown"` and `"unavailable"` states, so no state variables in `#values` are updated. As a result, `/healthz` and `/api/state` report Home Assistant as healthy (`haOk: true`) and advance the timestamp despite receiving no usable values.  
**Fix:** Modify `#applyValues()` to return the count of accepted valid values, and derive `haOk` / `usable` from whether at least one value was accepted:
```javascript
const accepted = this.#applyValues(outcome.values);
const usable = accepted > 0;
this.#haOk = usable;
if (usable) {
  this.#lastOkAt = Date.now();
}
```

---

**[SEVERITY: Medium] [CONFIDENCE: High]**  
**Category:** Logic Bug / Race Condition / Data Leakage  
**Location:** `public/index.html`, `ensurePlaylist()` (~line 917)  
**What:** When an album selection changes, `ensurePlaylist()` updates `app.playlist` and resets the playlist signature, but fails to increment `app.loadToken`. If an image request from the *previous* album was in-flight when the album changed, its `whenSettled` completion callback compares its captured token against `app.loadToken`. Because `app.loadToken` was not incremented, the check passes, and `onPhotoReady()` displays the old album's photo on screen despite the selection change.  
**Fix:** Increment `app.loadToken++` inside `ensurePlaylist()` whenever a new playlist signature is established:
```javascript
if (sig === app.playlistSig) { return false; }

app.loadToken++; // Invalidate in-flight loads from previous album
app.playlistSig = sig;
```

---

**[SEVERITY: Medium] [CONFIDENCE: High]**  
**Category:** Logic Bug / Bash Special Variable Violation & Process Leak  
**Location:** `verify.sh` (~line 700)  
**What:** `verify.sh` assigns command substitution output to `PPID` (`PPID="$(start_stub ...)"`). `PPID` is a readonly environment variable in Bash. Attempting to assign to `PPID` causes Bash to abort with `PPID: readonly variable`. Furthermore, invoking `start_stub` via command substitution runs it inside a subshell, losing array modifications to `PIDS+=("$pid")`. Consequently, background Home Assistant stub processes leak when the harness exits.  
**Fix:** Use explicit variable names (e.g. `HA_PRIMARY_PID`) and invoke `start_stub` directly without subshell command substitution:
```bash
LAST_PID=""
start_stub() {
  local name="$1" port="$2" state="$3"
  node "$TMP/ha-stub.js" "$port" "$state" >"$TMP/$name.log" 2>&1 &
  LAST_PID=$!
  PIDS+=("$LAST_PID")
}

start_stub ha-fo-primary "$HA_FO_PRIMARY_PORT" "$STATE_MAIN"
HA_PRIMARY_PID="$LAST_PID"
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**  
**Category:** Syntax Error / Build & Tooling Failure  
**Location:** `src/generated.py`  
**What:** `src/generated.py` contains raw Markdown text (`## Verdict...`) instead of valid Python code. Any build step, packaging tool, test runner, or linter that parses or compiles the `src/` directory (such as `python -m compileall src`) will fail with a `SyntaxError`.  
**Fix:** Delete `src/generated.py` or move it to a non-code documentation directory.

---

**[SEVERITY: Low] [CONFIDENCE: High]**  
**Category:** Error Handling / Correctness  
**Location:** `server.js`, `main()` (~line 1054)  
**What:** `main()` calls `app.listen(config.port)` asynchronously. If socket binding fails (e.g., `EADDRINUSE` or `EACCES`), Express emits an `'error'` event on the server object. Because `main()` neither awaits the listening state nor registers an `'error'` event listener on the server instance, the failure triggers an unhandled EventEmitter error, bypassing structured fatal logging (`log('error', 'fatal', ...)`).  
**Fix:** Await a Promise that listens for both `'listening'` and `'error'` events:
```javascript
const server = app.listen(config.port);
await new Promise((resolve, reject) => {
  const onListening = () => { server.off('error', onError); resolve(); };
  const onError = (err) => { server.off('listening', onListening); reject(err); };
  server.once('listening', onListening);
  server.once('error', onError);
});
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**  
**Category:** Race Condition / Out-of-Order State Synchronization  
**Location:** `public/index.html`, `poll()` (~line 704)  
**What:** `poll()` issues `XMLHttpRequest` calls without sequence tracking. If a poll triggered by `visibilitychange` or `pageshow` resolves faster than an earlier scheduled poll, the older request resolving later will overwrite `app.state` with stale state data.  
**Fix:** Assign a monotonic sequence ID to each poll request and ignore responses arriving out of order:
```javascript
var pollSeq = 0;
var lastAppliedSeq = 0;

function poll() {
  var seq = ++pollSeq;
  // ...
  if (xhr.status >= 200 && xhr.status < 300) {
    if (seq < lastAppliedSeq) { return; }
    lastAppliedSeq = seq;
    onState(data);
  }
}
```

---

## CHAINED ATTACK PATHS

No multi-step attack chains identified. Individual security controls (auth cookie verification with `__Host-` prefix, constant-time token comparison via `crypto.timingSafeEqual`, open-redirect sanitization in `safeRedirectTarget`, symlink containment via `fs.realpath` and `isInside`, strict object key validation avoiding prototype pollution, and per-IP auth rate limiting) are robustly implemented.

---

## COMPLIANCE CHECKLIST

- [x] No hardcoded secrets or credentials
- [x] Input validation present at trust boundaries
- [x] Error responses do not leak stack traces or internal paths
- [x] Logging does not capture or expose PII
- [x] No SQL / command / template injection vectors
- [x] Auth checks present on all protected routes/operations

---

## CORRECTNESS ISSUES

1. **Location:** `scripts/run.py` (line 38)  
   **What:** Executing `subprocess.run` with `VENV_PYTHON` will raise an unhandled `OSError` (e.g. `FileNotFoundError`) if the virtual environment binary is missing or non-executable, printing an unhandled Python traceback.  
   **Fix:** Wrap the `subprocess.run` invocation in a `try...except OSError` block and exit gracefully with a clear error message.