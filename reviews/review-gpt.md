## Documentation Gaps

No material docstring gaps were found in the public API. The exported `loadConfig`, `AuthGate`, `HomeAssistantClient`, `PhotoLibrary`, `createPhotoHandler`, and `createApp` APIs have adequate JSDoc.

## Code Quality Issues

### Correctness

- [public/index.html:779-788] `onState()` calls `cacheCurrentAlbum()` before `applySettings()`. On the first successful poll nothing is cached; after an album change, the previous album is cached until the next poll. Suggested fix: apply the new state first, then cache the resolved playlist.

- [public/index.html:906-914] `resolveAlbum()` considers an album usable based on the raw array length, before unsafe paths are filtered. An album containing only invalid paths is selected instead of falling back to another valid album. Suggested fix: select albums based on `albumPhotos(albums, name).length`.

- [public/index.html:917-932] The playlist signature only includes the album name, count, first path, and last path. Changes to middle entries are ignored, leaving the slideshow permanently stale when the count and endpoints remain unchanged. Suggested fix: compute the signature from every validated path.

- [public/index.html:971-985,1026-1056] A playlist change schedules another `advance()` even when an old image load is still running. Both loads can complete, briefly display a photo from the previous album, and violate the stated low-memory loading constraint. There is no retained handle for cancelling or invalidating the active load when settings change. Suggested fix: track the active load, invalidate it when the playlist/display state changes, and only start a replacement after the stale callback has released its image.

- [public/index.html:1166-1193] The synthetic-click suppression does not match its comment. Safari’s compatibility click typically arrives hundreds of milliseconds after `touchend`, so the 80 ms check can count one physical tap twice and open diagnostics after fewer than three taps. Suggested fix: pass the event to the handler and suppress `click` events for a short period after a touch event.

- [server.js:760-784] Album selection at the 512-album cap depends on filesystem `readdir()` order. Large libraries can expose a different set of albums after rescans. Suggested fix: filter and sort candidate album entries before applying the cap.

- [server.js:805-831] `HARD_ALBUM_SCAN_LIMIT` is applied before sorting. A directory exceeding 200,000 valid images still gets a nondeterministic subset, despite the surrounding determinism guarantees. Suggested fix: use a bounded ordered selection structure or explicitly reject/skip over-limit albums rather than selecting based on enumeration order.

- [server.js:1054-1067] `main()` does not handle the HTTP server’s asynchronous `error` event. An occupied port or permission failure produces an uncaught emitter error rather than the structured fatal log path. Suggested fix: attach an `error` listener and await either `listening` or `error`.

- [scripts/run.py:38] Starting a missing or non-executable `VENV_PYTHON` raises an uncaught `OSError`, producing a traceback instead of the runner’s concise configuration error. Suggested fix: validate the executable or catch `OSError` around `subprocess.run()`.

### Maintainability

- [src/index.js:1-2] This generated placeholder is an unused competing entry point; `package.json` correctly points to `server.js`. Suggested fix: remove `src/index.js`.

## Test Coverage

### Browser client

`public/index.html` currently has no automated coverage. Add tests using a Safari-12-compatible DOM/XHR harness for:

- First successful bridge response caches the newly resolved album immediately.
- Switching albums during an in-flight image load never displays the old album’s image.
- Turning the display off during a load releases the completed stale image and does not schedule another photo.
- An album containing only unsafe paths falls back to an album containing valid paths.
- A middle-only playlist change is detected when album name, length, first item, and last item remain unchanged.
- Exactly three physical touch taps open diagnostics; compatibility click events do not increment the count.
- Schedule selection before the first entry wraps to the prior day’s last entry.
- Malformed cached JSON, invalid paths, unavailable local storage, and storage quota failures degrade safely.
- Failed preloads, image timeouts, consecutive-failure backoff, and playlist wrap reshuffling.
- Layer cleanup under rapid successive transitions never leaves more than two layers.

### Server

Existing smoke tests do not exercise most network-facing behavior. Add cases for:

- All HA entities succeed and update the snapshot.
- Four `401` responses leave `haOk` false and do not advance `haLastOk`.
- One entity succeeds while three time out; last-known-good values and degradation details are correct.
- Primary failure, fallback activation, and scheduled primary reprobe.
- Oversized chunked bodies and oversized declared bodies are rejected.
- Redirect responses do not forward the bearer token.
- Strict numeric parsing for whitespace, `NaN`, infinity, and values such as `50abc`.
- `/healthz` returns `200` and `503` in the appropriate library states.
- Authentication, security headers, `HEAD`, `405`, static `404`, and `/api/state` cache headers through a real HTTP server.
- Photo traversal, encoded separators, extra segments, disappearing files, and symlinks escaping the root.
- More than 512 albums and more than 200,000 files produce deterministic behavior.
- An occupied port is reported through the intended fatal-error path.
- Expired auth buckets, valid-cookie bypass, duplicate cookies, and bucket-cap eviction.
- Repeated shutdown signals remain idempotent.

### Pipeline runner

Add Python subprocess tests for:

- Missing and non-executable virtual-environment interpreter.
- Missing orchestrator.
- Brand directory absent, populated, and empty.
- Failed `git submodule update` continues with a warning.
- Orchestrator exit status is propagated unchanged.

## Suggested Improvements

### 1. Resolve and cache the new playlist in the correct order

Before:

```js
function onState(raw) {
  app.bridgeOk = true;
  app.bridgeFailures = 0;
  app.lastPollError = '';
  app.lastStateAt = Date.now();
  app.state = normalizeState(raw);
  app.settingsSource = 'bridge';
  app.bootstrapped = true;
  cacheCurrentAlbum();
  applySettings();
}
```

After:

```js
function onState(raw) {
  app.bridgeOk = true;
  app.bridgeFailures = 0;
  app.lastPollError = '';
  app.lastStateAt = Date.now();
  app.state = normalizeState(raw);
  app.settingsSource = 'bridge';
  app.bootstrapped = true;

  applySettings();
  cacheCurrentAlbum();
}
```

### 2. Validate album contents while resolving the album

Before:

```js
function resolveAlbum(albums, wanted) {
  if (typeof wanted === 'string' && wanted &&
      hasOwn(albums, wanted) && isArray(albums[wanted]) && albums[wanted].length) {
    return wanted;
  }

  // Other candidates use the same raw-array check.
}
```

After:

```js
function hasUsablePhotos(albums, name) {
  return typeof name === 'string' &&
    hasOwn(albums, name) &&
    albumPhotos(albums, name).length > 0;
}

function resolveAlbum(albums, wanted) {
  if (hasUsablePhotos(albums, wanted)) {
    return wanted;
  }

  var fallback = CONFIG.fallbackSchedule.album;
  if (hasUsablePhotos(albums, fallback)) {
    return fallback;
  }

  var keys = ownKeys(albums);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (hasUsablePhotos(albums, keys[i])) {
      return keys[i];
    }
  }
  return null;
}
```

### 3. Detect all playlist changes

Before:

```js
var sig = String(name) + '|' + photos.length + '|' +
  (photos.length ? photos[0] : '') + '|' +
  (photos.length ? photos[photos.length - 1] : '');
```

After:

```js
function playlistSignature(name, photos) {
  var parts = [String(name), String(photos.length)];
  var i;

  for (i = 0; i < photos.length; i++) {
    parts.push(String(photos[i].length));
    parts.push(photos[i]);
  }
  return parts.join('|');
}

function ensurePlaylist(name, photos) {
  var sig = playlistSignature(name, photos);
  if (sig === app.playlistSig) { return false; }

  app.playlistSig = sig;
  app.albumName = name || null;
  app.playlist = photos.slice(0);
  shuffle(app.playlist);
  app.playIndex = -1;
  app.failStreak = 0;
  releasePreload();
  return true;
}
```

Length-prefixing avoids ambiguous signatures such as `["a|b", "c"]` versus `["a", "b|c"]`.

### 4. Report server startup failures predictably

Before:

```js
const server = app.listen(config.port, () => {
  log('info', 'listening', { port: config.port });
});
```

After:

```js
const server = await new Promise((resolve, reject) => {
  const candidate = app.listen(config.port);

  candidate.once('listening', () => resolve(candidate));
  candidate.once('error', reject);
});

log('info', 'listening', {
  port: config.port,
  photosDir: photosRoot,
  trustProxy: String(config.trustProxy)
});
```

This allows the existing `main().catch(...)` path to log `EADDRINUSE` and exit cleanly.

### 5. Handle pipeline launch failures without a traceback

Before:

```python
result = subprocess.run(
    [str(VENV_PYTHON), str(ORCHESTRATOR)] + sys.argv[1:],
    env=env,
    cwd=str(PROJECT_ROOT),
)
sys.exit(result.returncode)
```

After:

```python
try:
    result = subprocess.run(
        [str(VENV_PYTHON), str(ORCHESTRATOR), *sys.argv[1:]],
        env=env,
        cwd=str(PROJECT_ROOT),
    )
except OSError as exc:
    print(f"ERROR: Unable to launch shared Python at {VENV_PYTHON}: {exc}")
    sys.exit(1)

sys.exit(result.returncode)
```