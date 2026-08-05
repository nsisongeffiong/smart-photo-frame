## Documentation Gaps

No material docstring gaps were found among the exported functions and classes in `server.js`. `loadConfig`, `AuthGate`, `HomeAssistantClient`, `PhotoLibrary`, `createPhotoHandler`, and `createApp` all document parameters and return values adequately.

`scripts/run.py` and `src/index.js` expose no public functions or classes.

## Code Quality Issues

### Correctness

- [server.js:583-633] `HomeAssistantClient.poll()` treats a route as healthy when every entity request returns an unusable HTTP response, such as four `401` responses. It sets `haOk = true`, updates `haLastOk`, and may switch the active route despite receiving no valid state. Suggested fix: distinguish route reachability from successful state retrieval; only update `haOk` and `haLastOk` when at least one entity state is successfully parsed.

- [server.js:615-629] Partial transport failures are discarded whenever another entity request succeeds. `haError` therefore reports no problem if one request succeeds and three time out. Suggested fix: add transport failures to `problems`, including the affected entity ID.

- [server.js:687-697] `Number.parseFloat()` accepts malformed states such as `"50abc"` and `"15 seconds"`, causing invalid HA data to overwrite last-known-good values. Suggested fix: trim the entire value and parse it with `Number()`, rejecting empty or non-finite values.

- [server.js:783-806] The per-album cap is applied before sorting, so the selected photos depend on filesystem enumeration order. Albums exceeding the cap can expose a different subset after rescans or filesystem changes. Suggested fix: collect valid names, sort deterministically, then slice to the configured limit.

- [server.js:962-971] The error handler returns `"Internal Server Error"` for non-400 client errors while preserving their 4xx status. A `404` from `sendFile`, for example, gets a misleading body. Suggested fix: map common 4xx statuses to an appropriate generic body and reserve `"Internal Server Error"` for 5xx responses.

- [scripts/run.py:39] Launching a missing or non-executable shared virtual-environment Python raises an uncaught `OSError` and prints a traceback. Suggested fix: validate `VENV_PYTHON` before launching or catch `OSError` and emit the same concise configuration error style used for a missing orchestrator.

### Security and resilience

- [server.js:238-244] `TRUST_PROXY` defaults to `1`. If the service is ever exposed directly rather than through exactly one proxy, clients can influence `req.ip` through `X-Forwarded-For` and bypass per-IP throttling. Suggested fix: default to `false` and require deployments behind a proxy to configure `TRUST_PROXY` explicitly.

- [server.js:643-662] The 1 MiB HA response limit only checks `Content-Length`. A chunked response or a response without that header is read without a bound by `response.json()`, allowing a faulty or compromised endpoint to consume excessive memory. Suggested fix: stream and count response bytes before parsing JSON.

- [server.js:602] The JSDoc type references `this.entities`, which does not exist; the actual field is `#entities`. This will fail or degrade `checkJs` type analysis. Suggested fix: define an explicit entity-role typedef instead of referencing an inaccessible/nonexistent property.

### Maintainability

- [package.json:11-13] There is no test script or lint/type-check script, despite substantial security-sensitive logic. Suggested fix: add at least `node --test`, plus ESLint or `tsc --checkJs` validation.

- [src/index.js:1-2] This generated placeholder is unused because `package.json` points to `server.js`. Suggested fix: remove it or make it the real entry point; retaining an inert entry point creates ambiguity.

## Test Coverage

No tests are present, and `package.json` provides no test command. The following paths need coverage.

### Configuration

- Missing each required variable and multiple variables together.
- Weak, short, non-ASCII, whitespace-containing, repetitive, and oversized `FRAME_KEY` values.
- Valid and invalid integer forms, including bounds, leading zeroes, decimals, signs, and empty values.
- HA URLs with unsupported schemes, embedded credentials, trailing slashes, paths, queries, and fragments.
- Duplicate primary/fallback URLs.
- Invalid entity IDs.
- Every supported `TRUST_PROXY` form and the secure default.

### Authentication

- Valid `?k=` sets the cookie and redirects without retaining any query string secret.
- Valid cookie authenticates without incrementing failure counters.
- Malformed and oversized Cookie headers return `401`, not `500`.
- Duplicate cookie names use the documented first value.
- Failure count reaches the threshold exactly, then returns `429`.
- Expired buckets are reset and removed by `sweep()`.
- Bucket-cap eviction does not grow beyond 10,000 entries.
- `/healthz` remains open, including with a malformed or invalid key.
- Direct requests with spoofed `X-Forwarded-For` cannot evade throttling under the default configuration.
- Non-GET/HEAD methods return `405` before authentication.

### Home Assistant polling

- All four requests succeed.
- Primary transport failure causes fallback use.
- Primary recovery is detected on the configured reprobe cycle.
- All requests time out while last-known-good values remain intact.
- One request succeeds while the others time out; degraded status is reported.
- All requests return `401`, `404`, malformed JSON, missing state fields, and oversized bodies.
- Chunked bodies larger than the response limit are rejected.
- Redirect responses never forward the bearer token.
- Invalid numeric states such as `"50abc"`, whitespace-only strings, `NaN`, and infinity preserve previous values.
- Brightness and interval values are rounded and clamped correctly.
- Invalid and unavailable album names preserve the previous album.
- `haLastOk` changes only after usable state data is received.

### Photo library and serving

- Missing or unreadable photo root retains the prior catalogue.
- Hidden albums, symlinked albums, invalid names, and non-directories are skipped.
- Hidden files, unsupported extensions, control characters, nested paths, and symlinks are skipped.
- Case-insensitive supported extensions are accepted.
- Natural sorting is deterministic.
- Album and photo caps select a deterministic sorted subset.
- One unreadable album does not abort other album scans.
- Encoded traversal attempts, encoded slashes, extra path segments, and backslashes return `404`.
- Symlinks resolving outside the photo root are rejected.
- A file disappearing between `realpath` and `sendFile` returns a correct 4xx response without exposing internal paths.
- Authenticated `HEAD` requests work for photos and static files.

### HTTP application and lifecycle

- Security headers appear on success, authentication failures, health checks, and error responses.
- `/healthz` returns `503` only when the library is unhealthy.
- `/api/state` includes `Vary: Cookie` and `Cache-Control: no-store`.
- Missing static files return `404`.
- Startup with an occupied port is handled predictably.
- Repeated or closely spaced shutdown signals do not execute shutdown twice.
- Scheduled tasks never overlap and stop scheduling after their stop function is called.

### Pipeline runner

- Missing orchestrator.
- Missing virtual-environment interpreter.
- Brand directory absent, non-empty, and empty with successful/failed submodule initialization.
- Orchestrator exit status is propagated.

## Suggested Improvements

### 1. Separate HA reachability from usable polling results

Before:

```js
if (outcome.reachable) {
  this.#haOk = true;
  this.#lastOkAt = Date.now();
  this.#haError = outcome.problems.length > 0
    ? outcome.problems.join('; ')
    : null;
  this.#applyValues(outcome.values);
  return;
}
```

After:

```js
if (outcome.reachable) {
  if (index !== this.#activeIndex) {
    log('info', 'ha route changed', {
      from: this.#routes[this.#activeIndex].name,
      to: route.name
    });
    this.#activeIndex = index;
  }

  const usable = Object.keys(outcome.values).length > 0;
  this.#haOk = usable;
  this.#haError = outcome.problems.length > 0
    ? outcome.problems.join('; ')
    : usable
      ? null
      : 'no usable entity states';

  if (usable) {
    this.#lastOkAt = Date.now();
    this.#applyValues(outcome.values);
  }
  return;
}
```

Record transport failures per entity:

```js
settled.forEach((result, index) => {
  const key = keys[index];

  if (result.status === 'fulfilled') {
    reachable = true;
    values[key] = result.value;
    return;
  }

  const error = result.reason;
  if (error && typeof error === 'object' && error.reachable === true) {
    reachable = true;
  }

  problems.push(`${this.#entities[key]}: ${describeError(error)}`);
});
```

### 2. Parse numeric HA states strictly

Before:

```js
const brightness = Number.parseFloat(values.brightness);
if (Number.isFinite(brightness)) {
  this.#values.brightness = clamp(Math.round(brightness), 10, 100);
}
```

After:

```js
function parseFiniteState(value) {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '') return null;

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

const brightness = parseFiniteState(values.brightness);
if (brightness !== null) {
  this.#values.brightness = clamp(Math.round(brightness), 10, 100);
}

const interval = parseFiniteState(values.interval);
if (interval !== null) {
  this.#values.interval = clamp(Math.round(interval), 1, 3600);
}
```

### 3. Enforce the HA body limit while reading

Before:

```js
const declaredLength = Number.parseInt(
  response.headers.get('content-length') ?? '',
  10
);

if (Number.isFinite(declaredLength) && declaredLength > 1_048_576) {
  throw new HaResponseError('response too large');
}

const body = await response.json();
```

After:

```js
async function readJsonLimited(response, maxBytes) {
  if (!response.body) {
    throw new HaResponseError('missing response body');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HaResponseError('response too large');
    }
    chunks.push(value);
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HaResponseError('malformed JSON');
  }
}

const body = await readJsonLimited(response, 1_048_576);
```

The `Content-Length` check can remain as an early rejection, but it must not be the only enforcement.

### 4. Make photo-cap selection deterministic

Before:

```js
for (const entry of entries) {
  if (names.length >= this.#maxPerAlbum) {
    capped = true;
    break;
  }

  if (!isValidPhotoName(entry.name)) continue;
  names.push(entry.name);
}

names.sort(compareNames);
```

After:

```js
for (const entry of entries) {
  if (entry.name.startsWith('.')) continue;
  if (entry.isSymbolicLink() || !entry.isFile()) continue;
  if (!isValidPhotoName(entry.name)) continue;
  if (!isInside(this.#root, path.join(dir, entry.name))) continue;

  names.push(entry.name);
}

names.sort((a, b) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
);

const capped = names.length > this.#maxPerAlbum;
const selected = names.slice(0, this.#maxPerAlbum);

if (capped) {
  log('warn', 'album photo cap reached', {
    album,
    max: this.#maxPerAlbum
  });
}

return selected.map(
  (name) => `photos/${encodeURIComponent(album)}/${encodeURIComponent(name)}`
);
```

### 5. Default proxy trust to a safe value

Before:

```js
if (raw === undefined || String(raw).trim() === '') return 1;
```

After:

```js
if (raw === undefined || String(raw).trim() === '') return false;
```

Then configure the intended deployment explicitly:

```env
TRUST_PROXY=1
```

This prevents an accidental direct deployment from making `X-Forwarded-For` part of the authentication throttling trust boundary.