## Documentation Gaps

No exported functions or classes lack adequate API documentation.

- `loadConfig`, `AuthGate`, `HomeAssistantClient`, `PhotoLibrary`, `createPhotoHandler`, and `createApp` have adequate JSDoc.
- `scripts/run.py` exposes no reusable public API.

The top-level `README.md` is operationally incomplete—it omits configuration, authentication bootstrap, album layout, and deployment instructions—but this is not a public API docstring gap.

## Code Quality Issues

### Correctness

- [server.js:~580] `HomeAssistantClient.poll()` treats every successfully fetched state string as usable. Values such as `unknown`, `unavailable`, or invalid numbers populate `outcome.values`, causing `haOk=true` and advancing `haLastOk` even though `#applyValues()` accepts nothing. Suggested fix: make `#applyValues()` return an accepted-value count and derive health from that count.

- [public/index.html:~917] `ensurePlaylist()` does not invalidate a photo already loading from the previous album. Its callback can pass the `loadToken` check and display an old-album photo after the selection changes. Suggested fix: increment `app.loadToken` immediately when the playlist signature changes.

- [public/index.html:~704] Scheduled, `pageshow`, and visibility-triggered polls can overlap. A slower older response—or error—can overwrite the result of a newer poll. Suggested fix: sequence requests and ignore all stale completions, including errors.

- [server.js:~1054] `main()` does not await the server’s `listening` event or handle its asynchronous `error` event. Bind failures such as `EADDRINUSE` bypass the structured fatal-error path, and the JSDoc promise contract is inaccurate. Suggested fix: await a Promise wired to `listening` and `error`.

- [verify.sh:~700] The harness assigns to `PPID`, a readonly Bash special variable. This can terminate the script before failover tests run; if execution continued, `$PPID` would identify the harness’s parent rather than the HA stub. Suggested fix: rename it to `HA_PRIMARY_PID`.

- [verify.sh:~700] HA stubs started through command substitution, such as `PID="$(start_stub ...)"`, run `start_stub` in a subshell. Updates to the `PIDS` cleanup array are lost, so restarted stubs can leak after the harness exits. Suggested fix: have `start_stub` set a global `LAST_PID` and invoke it without command substitution.

- [src/generated.py:3] The file contains unquoted Markdown rather than Python and fails to parse. Any syntax-check, import discovery, or packaging step that scans `src/` will fail. Suggested fix: delete it if it is an artifact or rename it to `reviews/generated.md`.

- [docker-compose.yaml:9] Compose requires a file named `Dockerfile`, but no such file is present in the supplied repository. A clean `docker compose build` cannot start. Suggested fix: commit the production file under the configured name and add a clean-checkout build test.

- [scripts/run.py:38] Failure to execute `VENV_PYTHON` raises an uncaught `OSError` and prints a traceback instead of the runner’s concise error format. Suggested fix: catch `OSError`, print a clear message, and exit nonzero.

### Build and Maintainability

- [package.json:1] A production dependency is declared without a supplied `package-lock.json`. Install resolution is not reproducible, and the verification script can only skip rather than perform a meaningful audit when lockfile metadata is unavailable. Suggested fix: generate and commit the lockfile.

- [README.md:1] The README does not document required environment variables, the `?k=` authentication bootstrap, photo directory structure, health semantics, or local/deployment commands. Suggested fix: add a concise setup and operations section based on the existing Compose configuration.

## Test Coverage

### Home Assistant State Validation

Current unit coverage only checks the initial `HomeAssistantClient` snapshot. Add tests that stub `fetch` for:

1. All four entities returning valid values:
   - Values are updated.
   - `haOk` is `true`.
   - `haLastOk` is populated.

2. All entities returning `unknown` or `unavailable` with HTTP 200:
   - Last-known-good values remain unchanged.
   - `haOk` is `false`.
   - `haLastOk` is not advanced.
   - `haError` reports no usable states.

3. One valid entity and three invalid entities:
   - The valid value is applied.
   - `haOk` is `true`.
   - Degradation details remain in `haError`.

4. Invalid numeric values such as `"50abc"`, `"NaN"`, and `"Infinity"`:
   - Brightness and interval retain their previous valid values.

5. Primary transport failure followed by fallback success, then periodic recovery of the primary.

### Browser Client

There is no automated browser-client coverage. Add a small DOM/XHR harness for:

1. Album changes while an old image is loading; the old callback must never reach `showLayer()`.
2. Two overlapping polls where request 2 resolves before request 1; request 1’s success or failure must be ignored.
3. Display switching off during image loading; no layer is created or next photo scheduled.
4. Schedule selection before the first daily entry; the final entry from the previous day is selected.
5. Invalid-only albums falling back to the first album containing safe paths.
6. Image timeout and consecutive-failure backoff.
7. Rapid transitions retaining no more than two photo layers.

### Startup and Pipeline

Add tests for:

1. Starting the server on an occupied port:
   - Process exits nonzero.
   - A structured JSON `fatal` log is emitted.

2. Missing or non-executable `VENV_PYTHON`:
   - Runner exits nonzero.
   - No traceback is printed.

3. Running `bash -n verify.sh` and ShellCheck:
   - The readonly `PPID` assignment should be caught by review or a dedicated harness self-test.

4. Running the complete verification harness and asserting no child HA stub remains afterward.

5. Running `python -m compileall scripts src`:
   - This currently catches `src/generated.py`.

### Packaging

Add CI steps that:

```sh
test -f Dockerfile
test -f package-lock.json
npm ci
npm test
docker compose config
docker compose build
```

Also start the image with minimal valid configuration and check `/healthz`.

### Filesystem Safety

Add a direct test for a photo symlink resolving outside `PHOTOS_DIR`; `createPhotoHandler()` must return 404 without serving bytes from the target.

## Suggested Improvements

### 1. Base HA Health on Accepted Values

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

Return the count from `#applyValues()`:

```js
#applyValues(values) {
  let accepted = 0;

  const album = typeof values.album === 'string'
    ? values.album.trim()
    : null;

  if (
    album !== null &&
    !UNAVAILABLE_STATES.has(album.toLowerCase()) &&
    isValidAlbumName(album)
  ) {
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

Update its JSDoc to `@returns {number} Number of accepted values`.

### 2. Invalidate Old-Album Image Loads Immediately

Before:

```js
if (sig === app.playlistSig) { return false; }

app.playlistSig = sig;
app.albumName = name || null;
```

After:

```js
if (sig === app.playlistSig) { return false; }

/* Prevent an in-flight image from the old playlist being displayed. */
app.loadToken++;

app.playlistSig = sig;
app.albumName = name || null;
```

### 3. Ignore Stale Poll Successes and Failures

Add client state:

```js
pollSequence: 0,
handledPollSequence: 0,
```

Then gate every completion:

```js
function poll() {
  var sequence = ++app.pollSequence;
  var settled = false;
  var xhr = new XMLHttpRequest();

  function complete(callback) {
    if (settled) { return; }
    settled = true;

    if (sequence < app.handledPollSequence) { return; }
    app.handledPollSequence = sequence;
    callback();
  }

  function fail(reason) {
    complete(function () {
      onPollError(reason);
    });
  }

  /* ... */

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4 || settled) { return; }

    if (xhr.status >= 200 && xhr.status < 300) {
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = null;
      }

      if (data && typeof data === 'object' && !isArray(data)) {
        complete(function () {
          onState(data);
        });
      } else {
        fail('malformed JSON from bridge');
      }
    } else {
      fail('HTTP ' + (xhr.status || 0));
    }
  };
}
```

Sequencing errors as well as successes prevents an old timeout from marking the bridge unavailable after a newer successful response.

### 4. Await HTTP Server Startup

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
  trustProxy: String(config.trustProxy)
});
```

### 5. Fix Harness PID Ownership

Before:

```bash
start_stub() {
  # ...
  node "$TMP/ha-stub.js" "$port" "$state" >"$TMP/$name.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  printf '%s' "$pid"
}

PPID="$(start_stub ha-fo-primary "$HA_FO_PRIMARY_PORT" "$STATE_MAIN")"
CPID="$(start_stub ha-fo-fallback "$HA_FO_FALLBACK_PORT" "$STATE_FALLBACK")"
```

After:

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

start_stub ha-fo-fallback "$HA_FO_FALLBACK_PORT" "$STATE_FALLBACK"
HA_FALLBACK_PID="$LAST_PID"
```

Use those names throughout:

```bash
stop_pid "$HA_PRIMARY_PID"
stop_pid "$HA_FALLBACK_PID"

start_stub ha-primary-restart "$pport" "$pstate"
HA_PRIMARY_RESTART_PID="$LAST_PID"
```

This avoids the readonly special variable and preserves cleanup-array changes in the parent shell.

### 6. Handle Runner Launch Errors

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

Also split the imports for readability:

```python
import os
import subprocess
import sys
```