## FINDINGS

**[SEVERITY: Medium] [CONFIDENCE: High]**
**Category:** Logic Bug / Race Condition / UI State Corruption  
**Location:** `public/index.html`, `ensurePlaylist()` (~line 917)  
**What:** Changing albums does not invalidate in-flight image requests. When Home Assistant changes the selected album, `applySettings()` calls `ensurePlaylist()` to switch playlists. `ensurePlaylist()` resets `app.playlist` and `app.playIndex`, but fails to increment `app.loadToken`. If an image request from the *previous* album was in-flight when the selection changed, its completion callback compares its captured `token` against `app.loadToken`. Because `app.loadToken` was not incremented, `token === app.loadToken` evaluates to `true`. When the old image finishes loading, `onPhotoReady()` renders the photo from the old album on screen and reschedules the photo timer, cancelling the pending transition to the newly selected album.  
**Attack path:** An operator changes the active album in Home Assistant while a photo from the old album is loading over a slow connection. The frame displays the old album's photo and stays stuck on it for the full slide interval (e.g. 45 seconds).  
**Fix:** Increment `app.loadToken++` inside `ensurePlaylist()` whenever the playlist signature changes:
```javascript
if (sig === app.playlistSig) { return false; }

app.loadToken++; // Invalidate in-flight loads from previous album
app.playlistSig = sig;
```

---

**[SEVERITY: Medium] [CONFIDENCE: High]**  
**Category:** Deployment Logic / Configuration Bypassed  
**Location:** `docker-compose.yaml`, `environment` block (~line 14)  
**What:** `docker-compose.yaml` omits `ALLOW_QUERY_KEY` from the service environment block. Under Docker Compose, environment variables defined in `.env` are only passed into the container if explicitly declared in `docker-compose.yaml`'s `environment:` section (or imported via `env_file:`). Consequently, setting `ALLOW_QUERY_KEY=true` in `.env` as documented in `.env.example` and `README.md` is silently ignored during Compose deployments, leaving `ALLOW_QUERY_KEY=false` inside the container.  
**Attack path:** An operator follows the README to configure an iOS Home Screen web app by setting `ALLOW_QUERY_KEY=true` in `.env` and deploying via Docker Compose. Compose drops the variable, so `server.js` redirects the web app to a bare path without the key, causing 401 failures on launch.  
**Fix:** Pass `ALLOW_QUERY_KEY` in `docker-compose.yaml`:
```yaml
      AUTH_MAX_FAILS: "${AUTH_MAX_FAILS:-10}"
      AUTH_WINDOW_MS: "${AUTH_WINDOW_MS:-60000}"
      ALLOW_QUERY_KEY: "${ALLOW_QUERY_KEY:-false}"
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**  
**Category:** Race Condition / Out-of-Order State Synchronization  
**Location:** `public/index.html`, `poll()` (~line 704)  
**What:** `poll()` issues `XMLHttpRequest` state checks to `/api/state` without request sequence tracking. Polls are triggered both periodically (every 15s) and on page visibility events (`visibilitychange`, `pageshow`). If a visibility-triggered poll completes faster than a delayed background poll, the older request resolving later overwrites `app.state` with stale data. Furthermore, an expired/timed-out earlier poll will invoke `onPollError()`, artificially incrementing `app.bridgeFailures` and potentially triggering fallback schedule mode even though a more recent poll succeeded.  
**Fix:** Track poll request sequence numbers and ignore completions or errors from requests older than the latest completed request:
```javascript
var pollSeq = 0;
var lastCompletedPollSeq = 0;

function poll() {
  var seq = ++pollSeq;
  var settled = false;
  var xhr = new XMLHttpRequest();
  // ...
  function complete(cb) {
    if (settled) { return; }
    settled = true;
    if (seq < lastCompletedPollSeq) { return; }
    lastCompletedPollSeq = seq;
    cb();
  }
  // Use complete() in onreadystatechange, ontimeout, and onerror handlers
}
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**  
**Category:** Error Handling / Logging Correctness  
**Location:** `server.js`, `main()` (~line 1054)  
**What:** `main()` calls `app.listen(config.port)` asynchronously without awaiting server socket binding or listening for `'error'` events on the returned `http.Server` instance. If port binding fails (e.g. `EADDRINUSE` or `EACCES`), Express emits an `'error'` event asynchronously. Because `main()` resolves immediately after `app.listen()` returns, the error is not caught by `main().catch()`. Instead, Node.js treats the unhandled `'error'` event as an unhandled exception, dumping a raw stack trace to stderr and bypassing structured JSON fatal logging (`log('error', 'fatal', ...)`).  
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

## CHAINED ATTACK PATHS

No multi-step attack chains identified. Security controls (auth cookie validation with `__Host-` prefix, timing-safe key comparisons, path traversal checks via `realpath` and `isInside()`, Strict CSP without unsafe-eval, strict null-prototype object maps for filesystem keys, and per-IP auth rate limiting) are effectively implemented.

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
   **What:** Executing `subprocess.run` with `VENV_PYTHON` raises an unhandled `OSError` (e.g. `FileNotFoundError`) if the virtual environment binary is missing or non-executable, printing a raw Python traceback.  
   **Fix:** Wrap the `subprocess.run` call in a `try...except OSError:` block, print a clean error message to stderr, and exit with status 1.