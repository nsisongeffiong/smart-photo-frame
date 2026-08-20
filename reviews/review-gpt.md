## Documentation Gaps

No exported function or class lacks an adequate docstring. `loadConfig`, `AuthGate`, `HomeAssistantClient`, `PhotoLibrary`, `createPhotoHandler`, and `createApp` document parameters, return values, and relevant behavior.

Non-API documentation gaps that affect operation:

- **`.env.example` / configuration reference** — `IMAGE_EXTENSIONS` is undocumented despite being read by `server.js`. This also makes the statement that every server variable is listed inaccurate.
- **`README.md` / `/healthz`** — documents a detailed health payload, while the implementation returns only `{"ok": boolean}`.
- **`README.md` / Photos** — says `.webp`, `.heic`, and `.heif` are accepted by default, but the server now excludes them unless `IMAGE_EXTENSIONS` is overridden.
- **`README.md` / `verify.sh`** — describes failover, browser compatibility, query-key, and other checks that the current harness does not perform.
- **`README.md` / Deployment** — describes a named `photos` volume, while Compose uses a host bind mount controlled by `PHOTOS_HOST_DIR`.

## Code Quality Issues

### Correctness and security

- [server.js:~330] `IMAGE_EXTENSIONS` accepts any alphanumeric extension, including `.html`, `.js`, or `.svg`. Such files can be served from the authenticated same-origin `/photos` route; an HTML file would receive an executable MIME type under a CSP that permits inline scripts. Suggested fix: restrict overrides to a defined set of passive image formats rather than validating syntax alone.

- [docker-compose.yaml:~29] Compose does not pass `ALLOW_QUERY_KEY` into the container. Setting it in `.env`, as instructed by `.env.example` and the README, has no effect in a Compose deployment. Suggested fix: add `ALLOW_QUERY_KEY: "${ALLOW_QUERY_KEY:-false}"`.

- [docker-compose.yaml:~29] Compose also omits `IMAGE_EXTENSIONS`, so the server’s documented override cannot be used through the normal deployment path. Suggested fix: pass `IMAGE_EXTENSIONS: "${IMAGE_EXTENSIONS:-}"`.

- [docker-compose.yaml:~25] `PHOTOS_DIR` is configurable, but the volume is always mounted at `/photos`. Setting `PHOTOS_DIR` to another path produces an unreadable or empty library. Suggested fix: hard-code `PHOTOS_DIR: /photos` in Compose, or mount the volume at the configured target consistently.

- [public/index.html:~917] `ensurePlaylist()` does not invalidate an image already loading from the previous playlist. Its callback can display an old-album image after the selected album changes. Suggested fix: increment `app.loadToken` whenever the playlist signature changes and reset the loading state before scheduling the replacement.

- [public/index.html:~704] Timer, `pageshow`, and visibility-triggered polls can overlap. A slower older response or error can overwrite a newer result, briefly applying stale settings or incorrectly entering fallback mode. Suggested fix: assign each poll a sequence number and ignore completions older than the latest completed request.

- [server.js:~1210] `main()` returns before the HTTP server has actually bound its socket. `EADDRINUSE` and `EACCES` are emitted asynchronously as unhandled server errors, bypassing the structured `fatal` log path and contradicting the function’s promise documentation. Suggested fix: await `listening` and reject on `error`.

- [scripts/run.py:38] Failure to execute the virtual-environment interpreter raises an uncaught `OSError` and prints a traceback. Suggested fix: catch `OSError`, print a concise error to stderr, and exit nonzero.

### Documentation correctness

- [README.md:~390] The documented `/healthz` payload and monitoring instructions no longer match the liveness-only implementation. Suggested fix: document `{"ok":true}` / `{"ok":false}` and direct authenticated HA monitoring to `/api/state`.

- [README.md:~225] The default accepted-extension list contradicts `DEFAULT_IMAGE_EXTENSIONS`. Suggested fix: list JPEG, PNG, GIF, and BMP as defaults and document `IMAGE_EXTENSIONS` separately.

- [README.md:~330] The verification matrix substantially overstates the current `verify.sh` coverage. Suggested fix: either restore those tests or reduce the table to checks the harness currently executes.

## Test Coverage

### Home Assistant client

The smoke suite only checks the initial snapshot. The shell harness covers all-unavailable, partially usable, and fully usable polls, but these behaviors should also have direct unit tests:

1. Strict numeric rejection for `"50abc"`, `"NaN"`, `"Infinity"`, and an empty string.
2. Primary transport failure followed by fallback success.
3. Sticky fallback routing and periodic primary recovery through `HA_REPROBE_EVERY`.
4. Mixed HTTP failures and valid states, verifying both applied values and `haError`.
5. Oversized, malformed, and missing-body HA responses.
6. Redirect responses, confirming the bearer token is not replayed.

### Browser client

There is no automated client-side coverage. Add a DOM/XHR test harness for:

1. Album change while an old image is loading; the old callback must not call `showLayer()`.
2. Playlist changing to empty during an image load.
3. Two overlapping polls where request 2 finishes before request 1:
   - stale success is ignored;
   - stale timeout/error is ignored.
4. Display switching off during a load.
5. Image timeout and consecutive-failure backoff.
6. Schedule selection before the first entry of the day.
7. Cache restoration with invalid, absolute, and protocol-relative paths.
8. Rapid transitions retaining no more than two photo layers.

### Configuration and deployment

Add tests for:

1. `IMAGE_EXTENSIONS=.html`, `.js`, and `.svg` being rejected.
2. Valid optional formats such as `.webp` being accepted only when explicitly enabled.
3. `docker compose config` confirming `ALLOW_QUERY_KEY` and `IMAGE_EXTENSIONS` reach the service.
4. A non-default `PHOTOS_DIR`, or preferably a test confirming Compose fixes it to `/photos`.
5. A clean image build and startup using minimal valid environment values.

### HTTP startup and file serving

Add tests for:

1. Starting on an occupied port:
   - process exits nonzero;
   - a structured JSON `fatal` event is logged.
2. A photo symlink resolving outside `PHOTOS_DIR`, tested directly against `createPhotoHandler()`.
3. Byte-range requests, including valid, unsatisfiable, and HEAD ranges.
4. Custom extension configuration producing the expected MIME type and serving policy.

### Pipeline runner

Add a subprocess test where `VENV_PYTHON` is absent or non-executable. Assert exit code 1, a concise error, and no traceback.

## Suggested Improvements

### 1. Restrict configurable image formats

Before:

```js
const ext = part.startsWith('.') ? part : `.${part}`;
if (!EXTENSION_RE.test(ext)) {
  throw new ConfigError(
    `${name} entries must look like ".jpg", got ${JSON.stringify(part)}`
  );
}
extensions.add(ext);
```

After:

```js
const CONFIGURABLE_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.webp', '.heic', '.heif', '.avif', '.jxl', '.tif', '.tiff'
]);

const ext = part.startsWith('.') ? part : `.${part}`;
if (!EXTENSION_RE.test(ext) || !CONFIGURABLE_IMAGE_EXTENSIONS.has(ext)) {
  throw new ConfigError(
    `${name} contains unsupported image extension ${JSON.stringify(part)}`
  );
}
extensions.add(ext);
```

This keeps active document formats out of the same-origin photo route.

### 2. Make Compose match the configuration contract

Before:

```yaml
PHOTOS_DIR: "${PHOTOS_DIR:-/photos}"

AUTH_MAX_FAILS: "${AUTH_MAX_FAILS:-10}"
AUTH_WINDOW_MS: "${AUTH_WINDOW_MS:-60000}"
```

After:

```yaml
# The volume below is mounted at this fixed container path.
PHOTOS_DIR: "/photos"

AUTH_MAX_FAILS: "${AUTH_MAX_FAILS:-10}"
AUTH_WINDOW_MS: "${AUTH_WINDOW_MS:-60000}"

ALLOW_QUERY_KEY: "${ALLOW_QUERY_KEY:-false}"
IMAGE_EXTENSIONS: "${IMAGE_EXTENSIONS:-}"
```

Also add both variables to `.env.example` and the README configuration table.

### 3. Invalidate old playlist loads

Before:

```js
if (sig === app.playlistSig) { return false; }

app.playlistSig = sig;
app.albumName = name || null;
```

After:

```js
if (sig === app.playlistSig) { return false; }

/* Prevent an old playlist's in-flight image from being displayed. */
app.loadToken++;
app.loading = false;

app.playlistSig = sig;
app.albumName = name || null;
```

For stronger cancellation, store the active load handle in `app` and release it when the playlist changes.

### 4. Sequence overlapping polls

Add state:

```js
pollSequence: 0,
completedPollSequence: 0,
```

Gate every completion:

```js
function poll() {
  var sequence = ++app.pollSequence;
  var settled = false;
  var xhr = new XMLHttpRequest();

  function complete(callback) {
    if (settled) { return; }
    settled = true;

    if (sequence < app.completedPollSequence) { return; }
    app.completedPollSequence = sequence;
    callback();
  }

  function fail(reason) {
    complete(function () {
      onPollError(reason);
    });
  }

  /* Use complete(...) for valid responses as well. */
}
```

Both successes and failures must be gated; otherwise an old timeout can mark the bridge unavailable after a newer success.

### 5. Await socket binding

Before:

```js
const server = app.listen(config.port, () => {
  log('info', 'listening', { port: config.port });
});
```

After:

```js
const server = app.listen(config.port);

await new Promise((resolve, reject) => {
  const onListening = () => {
    server.off('error', onError);
    resolve();
  };
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };

  server.once('listening', onListening);
  server.once('error', onError);
});

log('info', 'listening', {
  port: config.port,
  photosDir: photosRoot,
  haRoutes: config.haRoutes.map((route) => route.name),
  haPollMs: config.haPollMs,
  scanMs: config.scanMs,
  trustProxy: String(config.trustProxy),
  allowQueryKey: config.allowQueryKey,
  imageExtensions: [...config.imageExtensions].join(',')
});
```

### 6. Handle runner launch failures

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
    print(f"ERROR: Unable to launch {VENV_PYTHON}: {exc}", file=sys.stderr)
    sys.exit(1)

sys.exit(result.returncode)
```