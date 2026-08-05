## Documentation Gaps

No public functions or classes lack adequate docstrings.

- `server.js` exports (`loadConfig`, `AuthGate`, `HomeAssistantClient`, `PhotoLibrary`, `createPhotoHandler`, and `createApp`) have adequate JSDoc.
- Client functions in `public/index.html` are private to the page and sufficiently documented with inline comments.
- `scripts/run.py` exposes no public API.

## Code Quality Issues

### Correctness

- [docker-compose.yaml:9] Compose specifies `dockerfile: Dockerfile`, but the repository contains only `Dockerfile.txt`. The supplied project cannot build without a manual rename. Suggested fix: commit the file as `Dockerfile`, or change the Compose setting to `Dockerfile.txt`.

- [Dockerfile.txt:22] The production build copies `package-lock.json` and runs `npm ci`, but no lockfile is present in the supplied repository. Docker builds will fail at `COPY`. Suggested fix: generate and commit `package-lock.json`; do not replace `npm ci` with an unreproducible install.

- [public/index.html:917-985] Changing playlists does not immediately invalidate an image already loading. `ensurePlaylist()` schedules a replacement after `wakeDelayMs`, but the old load retains the current `loadToken`; if it settles before the replacement `advance()` runs, a photo from the previous album is displayed. Suggested fix: increment `app.loadToken` immediately when the playlist changes, or retain and cancel the active load.

- [public/index.html:704-778] `poll()` allows concurrent XHRs, particularly when `pageshow` or `visibilitychange` overlaps the interval poll. A slower, older response can arrive last and overwrite newer state. Suggested fix: serialize polls with an in-flight flag or associate each request with a monotonically increasing sequence number and ignore stale responses.

- [server.js:580-625] `HomeAssistantClient.poll()` treats any successfully fetched state string as usable before semantic validation. Four responses containing `unknown`, `unavailable`, or invalid numeric values set `haOk=true` and advance `haLastOk`, even though `#applyValues()` updates nothing. Suggested fix: have state application report how many values were accepted and derive `haOk`/`haLastOk` from that result.

- [server.js:1054-1067] `main()` neither waits for the server to listen nor handles the server’s asynchronous `error` event. `EADDRINUSE` and `EACCES` bypass the structured fatal-error path. The JSDoc claiming that `main()` resolves once listening is also inaccurate. Suggested fix: await a promise that resolves on `listening` and rejects on `error`.

- [scripts/run.py:38] A missing or non-executable shared Python interpreter raises an uncaught `OSError` and prints a traceback. Suggested fix: catch `OSError`, emit the same concise configuration-style error used for a missing orchestrator, and exit nonzero.

### Maintainability

- [public/index.html:388-437] `app.diagHideTimer` and `app.tickTimer` are assigned later but omitted from the timer fields in the state declaration. This does not break JavaScript, but makes timer ownership incomplete and easier to overlook during cleanup. Suggested fix: declare both fields as `null` with the other timers.

## Test Coverage

### Deployment

Add a CI build test that:

- Runs `docker compose config`.
- Builds the production image from a clean checkout.
- Verifies that the configured Dockerfile and lockfile exist.
- Starts the image with minimal configuration and checks `/healthz`.

These tests would currently catch both packaging failures.

### Browser Client

There is no automated client coverage. Add focused tests for:

- An album change while the previous album’s image is loading; the old image must never reach `showLayer()`.
- Two overlapping polls where the older request resolves last; only the newest response should be applied.
- Display-off during image loading; the image is released and no subsequent photo is scheduled.
- Invalid-only requested album falling back to an album with valid paths.
- A middle-only playlist change being detected.
- Exactly three touch taps opening diagnostics while synthetic clicks are ignored.
- Schedule selection before the first daily entry wrapping to the previous day’s final entry.
- Malformed cache JSON, unavailable storage, quota failure, and unsafe cached paths.
- Image timeout, preload failure, consecutive-failure backoff, and playlist wrap.
- Rapid transitions never leaving more than two photo layers in the DOM.

### Home Assistant Client

Current tests only verify initial state. Add cases for:

- Four valid entities updating the snapshot and `haLastOk`.
- Four HTTP `401` responses leaving `haOk=false`.
- Four successful responses containing `unknown`/`unavailable`; `haOk` and `haLastOk` must not indicate a usable poll.
- Invalid brightness and interval strings preserving last-known-good values.
- One valid entity plus three invalid or timed-out entities, including degradation details.
- Primary transport failure activating fallback.
- Periodic primary reprobe switching back after recovery.
- Oversized declared and chunked response bodies.
- Redirect rejection without forwarding the bearer token.

### HTTP and Authentication

Add real-server tests for:

- `/healthz` returning `200` after a successful scan and `503` after scan failure.
- `/api/state`, static files, and photos requiring authentication.
- Valid-cookie bypass of throttling.
- Expired bucket cleanup and bucket-cap eviction.
- Duplicate and malformed cookies.
- `HEAD`, unsupported methods, security headers, cache headers, and generic error bodies.
- Photo traversal, encoded separators, extra path segments, missing files, and symlinks escaping the root.
- Occupied-port startup reaching the structured fatal path.

### Pipeline Runner

Add subprocess tests for:

- Missing and non-executable `VENV_PYTHON`.
- Missing orchestrator.
- Empty, populated, and absent `brand` directories.
- Failed submodule initialization continuing with a warning.
- Exact propagation of the orchestrator’s exit code.

## Suggested Improvements

### 1. Make the checked-in Docker filename match Compose

Before:

```yaml
services:
  smart-photo-frame:
    build:
      context: .
      dockerfile: Dockerfile
```

Repository file:

```text
Dockerfile.txt
```

After:

```text
Dockerfile
```

```yaml
services:
  smart-photo-frame:
    build:
      context: .
      dockerfile: Dockerfile
```

Also generate and commit the required lockfile:

```sh
npm install --package-lock-only
git add Dockerfile package-lock.json
```

### 2. Invalidate an active image load when the playlist changes

Before:

```js
if (sig === app.playlistSig) { return false; }

app.playlistSig = sig;
app.albumName = name || null;
app.playlist = photos.slice(0);
shuffle(app.playlist);
app.playIndex = -1;
app.failStreak = 0;
releasePreload();
return true;
```

After:

```js
if (sig === app.playlistSig) { return false; }

/* Prevent an old album's in-flight image from reaching onPhotoReady(). */
app.loadToken++;

app.playlistSig = sig;
app.albumName = name || null;
app.playlist = photos.slice(0);
shuffle(app.playlist);
app.playIndex = -1;
app.failStreak = 0;
releasePreload();
return true;
```

For clearer ownership, retain the active handle as well:

```js
/* Runtime state */
activeLoad: null,
```

```js
app.activeLoad = handle;
app.loading = true;

whenSettled(handle, function (h) {
  if (app.activeLoad === h) { app.activeLoad = null; }

  if (token !== app.loadToken) {
    releaseImg(h.img);
    return;
  }

  app.loading = false;
  /* ... */
});
```

### 3. Prevent stale bridge responses from winning

Before:

```js
function poll() {
  var settled = false;
  var xhr = new XMLHttpRequest();
  /* ... */
  xhr.send(null);
}
```

After, using request sequencing:

```js
var pollSequence = 0;
var appliedPollSequence = 0;

function poll() {
  var sequence = ++pollSequence;
  var settled = false;
  var xhr = new XMLHttpRequest();

  function acceptState(data) {
    if (sequence < appliedPollSequence) { return; }
    appliedPollSequence = sequence;
    onState(data);
  }

  /* ... */

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4 || settled) { return; }
    settled = true;

    if (xhr.status >= 200 && xhr.status < 300) {
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = null;
      }

      if (data && typeof data === 'object' && !isArray(data)) {
        acceptState(data);
      } else {
        onPollError('malformed JSON from bridge');
      }
    } else {
      onPollError('HTTP ' + (xhr.status || 0));
    }
  };

  xhr.send(null);
}
```

Alternatively, an in-flight guard is simpler if immediate visibility-triggered refreshes are not required.

### 4. Base HA health on accepted values

Before:

```js
const usable = Object.keys(outcome.values).length > 0;
this.#haOk = usable;

if (usable) {
  this.#lastOkAt = Date.now();
  this.#applyValues(outcome.values);
}
```

After:

```js
const accepted = this.#applyValues(outcome.values);
const usable = accepted > 0;
this.#haOk = usable;

if (usable) {
  this.#lastOkAt = Date.now();
}
```

Change `#applyValues()` to return the accepted count:

```js
#applyValues(values) {
  let accepted = 0;

  const album = typeof values.album === 'string' ? values.album.trim() : null;
  if (album !== null &&
      !UNAVAILABLE_STATES.has(album.toLowerCase()) &&
      isValidAlbumName(album)) {
    this.#values.album = album;
    accepted += 1;
  }

  if (typeof values.display === 'string') {
    const display = values.display.trim().toLowerCase();
    if (display === 'on' || display === 'off') {
      this.#values.display = display === 'on';
      accepted += 1;
    }
  }

  const brightness = parseFiniteState(values.brightness);
  if (brightness !== null) {
    this.#values.brightness = clamp(Math.round(brightness), 10, 100);
    accepted += 1;
  }

  const interval = parseFiniteState(values.interval);
  if (interval !== null) {
    this.#values.interval = clamp(Math.round(interval), 1, 3600);
    accepted += 1;
  }

  return accepted;
}
```

### 5. Await server startup errors

Before:

```js
const server = app.listen(config.port, () => {
  log('info', 'listening', {
    port: config.port
  });
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
  haRoutes: config.haRoutes.map((route) => route.name),
  haPollMs: config.haPollMs,
  scanMs: config.scanMs,
  trustProxy: String(config.trustProxy)
});
```

This makes `main()` satisfy its JSDoc and routes bind failures through the existing `main().catch(...)` handler.

### 6. Handle pipeline launch failures cleanly

Before:

```python
result = subprocess.run(
    [str(VENV_PYTHON), str(ORCHESTRATOR)] + sys.argv[1:],
    env=env,
    cwd=str(PROJECT_ROOT)
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