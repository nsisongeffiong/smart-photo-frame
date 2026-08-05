## FINDINGS

**[SEVERITY: Medium] [CONFIDENCE: High]**
**Category:** Logic Bug / Incorrect State Caching
**Location:** `public/index.html`, `onState()` (line 550)
**What:** `onState()` calls `cacheCurrentAlbum()` *before* `applySettings()`. On initial boot or when the bridge updates the active album, `app.albumName` and `app.playlist` still reflect the old state when `cacheCurrentAlbum()` executes. The local storage cache receives stale or empty data rather than the newly fetched album details.
**Fix:** Call `applySettings()` before `cacheCurrentAlbum()` in `onState()` so `app.albumName` and `app.playlist` are updated prior to being cached:
```javascript
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

---

**[SEVERITY: Medium] [CONFIDENCE: High]**
**Category:** Logic Bug / Unsafe Album Selection & Stale Playlist Signatures
**Location:** `public/index.html`, `resolveAlbum()` (line 906) and `ensurePlaylist()` (line 917)
**What:**
1. `resolveAlbum()` checks candidate album viability using `isArray(albums[wanted]) && albums[wanted].length`. If an album contains non-relative or malformed photo entries, `resolveAlbum()` selects it anyway, but `albumPhotos()` subsequently filters all entries out, leaving an empty playlist (`[]`) and halting playback instead of selecting a valid fallback album.
2. `ensurePlaylist()` generates a playlist signature using only `photos.length`, `photos[0]`, and `photos[photos.length - 1]`. Modifying or swapping intermediate photos without changing the total count or boundary elements causes `ensurePlaylist()` to ignore playlist updates.
**Fix:**
1. Update `resolveAlbum()` to verify usable photos using `albumPhotos(albums, name).length > 0`:
```javascript
function resolveAlbum(albums, wanted) {
  if (typeof wanted === 'string' && wanted && albumPhotos(albums, wanted).length > 0) {
    return wanted;
  }
  var fb = CONFIG.fallbackSchedule.album;
  if (typeof fb === 'string' && albumPhotos(albums, fb).length > 0) {
    return fb;
  }
  var keys = ownKeys(albums);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (albumPhotos(albums, keys[i]).length > 0) { return keys[i]; }
  }
  return null;
}
```
2. Update signature calculation in `ensurePlaylist()` to incorporate all photo paths: `var sig = String(name) + '|' + photos.join('|');`.

---

**[SEVERITY: Low] [CONFIDENCE: High]**
**Category:** Event Handling / Input Bug
**Location:** `public/index.html`, `onTap()` (line 1166)
**What:** Mobile Safari fires a synthetic `click` event ~300ms after a `touchend` event. `onTap()` checks `now - lastTapAt < 80` to suppress duplicate events. Because 300ms exceeds 80ms, a single physical touch registers both `touchend` and `click`, incrementing `tapCount` twice. As a result, 2 physical touches trigger the 3-tap gesture to open the diagnostics panel.
**Attack path:** An unauthorized person physically tapping the photo frame twice can accidentally open the diagnostics overlay.
**Fix:** Track touch activity explicitly and ignore click events that occur shortly after touch events:
```javascript
var lastTouchAt = 0;
function onTap(e) {
  var now = Date.now();
  if (e.type === 'touchend') {
    lastTouchAt = now;
  } else if (e.type === 'click' && (now - lastTouchAt < 600)) {
    return;
  }
  // rest of onTap logic...
}
```

---

**[SEVERITY: Low] [CONFIDENCE: High]**
**Category:** Error Handling / Correctness
**Location:** `scripts/run.py`, line 38
**What:** Invoking `subprocess.run` with `VENV_PYTHON` without verifying file existence or catching `OSError` causes Python to output an unhandled traceback if the virtual environment binary is missing or non-executable.
**Fix:** Wrap the execution block in `try...except OSError`:
```python
try:
    result = subprocess.run([str(VENV_PYTHON), str(ORCHESTRATOR)] + sys.argv[1:], env=env, cwd=str(PROJECT_ROOT))
    sys.exit(result.returncode)
except OSError as err:
    print(f"ERROR: Failed to launch virtual environment Python ({VENV_PYTHON}): {err}")
    sys.exit(1)
```

---

## CHAINED ATTACK PATHS

Chain: **[Unvalidated photo paths in bridge payload] + [Overly permissive `resolveAlbum()` check]** → A payload from Home Assistant specifying an album containing invalid URLs (e.g., protocol-relative or absolute links) causes `resolveAlbum()` to commit to that album without falling back to valid alternatives. `albumPhotos()` then strips all invalid URLs, leaving the photo frame stuck displaying "Waiting for photos..." permanently instead of falling back to the scheduled local album.

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

1. **Location:** `src/index.js`
   **What:** Unused generated placeholder entry point that conflicts with `package.json` (`"main": "server.js"`).
   **Fix:** Remove `src/index.js` to prevent accidental inclusion or import.