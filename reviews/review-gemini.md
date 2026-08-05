## FINDINGS

**[SEVERITY: Medium] [CONFIDENCE: High]**
**Category:** Logic Bug / Incorrect State Reporting
**Location:** `server.js`, `HomeAssistantClient.poll()` (~line 580) and `#applyValues()` (~line 625)
**What:** `HomeAssistantClient.poll()` determines HA health by checking if `Object.keys(outcome.values).length > 0`. When Home Assistant is starting up or has uninitialized entities, `#fetchState()` returns HTTP 200 with state strings like `"unknown"` or `"unavailable"`. Because `outcome.values` contains keys for all entities, `poll()` sets `haOk = true` and updates `lastOkAt`. However, `#applyValues()` explicitly filters out `"unknown"` and `"unavailable"` states, so no values in `#values` are actually updated. As a result, the bridge reports HA as healthy (`haOk: true`, `haError: null`) despite receiving no usable state.
**Fix:** Update `#applyValues()` to return the count of accepted valid values, and set `haOk` based on whether at least one value was accepted:
```javascript
const accepted = this.#applyValues(outcome.values);
const usable = accepted > 0;
this.#haOk = usable;
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**
**Category:** Logic Bug / Race Condition
**Location:** `public/index.html`, `ensurePlaylist()` (~line 917)
**What:** When an album selection changes, `ensurePlaylist()` updates `app.playlist` and resets the playlist signature, but does not increment `app.loadToken`. If a photo from the *previous* album was currently in-flight when the album changed, its load callback (`whenSettled`) compares its captured token against `app.loadToken`. Because the token was not incremented, the check passes, and `onPhotoReady()` briefly displays the old album's photo on screen before the new album's photo finishes loading.
**Fix:** Increment `app.loadToken++` inside `ensurePlaylist()` whenever a new playlist signature is set to invalidate any in-flight image loads from previous albums:
```javascript
if (sig === app.playlistSig) { return false; }

app.loadToken++; // Invalidate pending loads from previous album
app.playlistSig = sig;
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**
**Category:** Race Condition / State Synchronization
**Location:** `public/index.html`, `poll()` (~line 704)
**What:** `poll()` executes `XMLHttpRequest` calls without tracking request sequence numbers or checking for in-flight requests. If a poll triggered by `visibilitychange` or `pageshow` completes faster than an earlier scheduled interval poll, the earlier poll's response will resolve second and overwrite `app.state` with stale state data.
**Fix:** Maintain a monotonically increasing request sequence ID and discard responses that arrive out of order:
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

**[SEVERITY: Low] [CONFIDENCE: High]**
**Category:** Error Handling / Correctness
**Location:** `server.js`, `main()` (~line 1054)
**What:** `app.listen(config.port)` starts the HTTP server asynchronously. If binding fails (e.g., `EADDRINUSE` or `EACCES`), the server emits an `'error'` event. Because `main()` does not attach an error listener to the server instance or await listening completion, the error is thrown as an uncaught EventEmitter error rather than being caught by `main().catch()` and logged via structured logging.
**Fix:** Wrap server startup in a Promise that resolves on `'listening'` and rejects on `'error'`:
```javascript
const server = await new Promise((resolve, reject) => {
  const s = app.listen(config.port);
  s.once('listening', () => resolve(s));
  s.once('error', reject);
});
```

---

## CHAINED ATTACK PATHS

No multi-step attack chains identified. All individual security boundaries (authentication gate, rate-limiting, timing-safe key comparisons, cookie scope, open redirect prevention, path traversal containment via `fs.realpath` and `isInside`) are properly enforced.

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
   **What:** `subprocess.run` with `VENV_PYTHON` will raise an unhandled `OSError` (e.g. `FileNotFoundError`) and print a Python traceback if the virtual environment binary is missing or non-executable.
   **Fix:** Wrap the execution in a `try...except OSError` block and exit gracefully with a clear error message.