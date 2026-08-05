## Verdict

Ship with fixes. Nothing found touches the HA token, the auth gate, or path containment — every real defect is a client-side availability or correctness bug on the iPad page, and four of them are one-line changes worth making before this goes on a wall.

## Findings

| # | Severity | File:line | Finding | Fix |
|---|----------|-----------|---------|-----|
| 1 | Medium | public/index.html `ensurePlaylist` (~917) | Signature ignores middle entries; a same-count, same-endpoints album edit is never picked up, so the frame shows deleted photos until the 4h reload | Hash **all** paths — but see Disputed: use a rolling numeric hash, not a concatenated string |
| 2 | Low-Med | public/index.html `resolveAlbum` (~906) | Album chosen on raw array length before `isSafeRelativePath` filtering; an all-invalid album wins and the frame sticks on "Waiting for photos…" | Gate all three branches on `albumPhotos(albums, name).length > 0` |
| 3 | Low | public/index.html `onState` (~779) | `cacheCurrentAlbum()` runs before `applySettings()`; first successful poll caches nothing, album changes cache the previous album for one cycle | Swap the two calls |
| 4 | Low | server.js `main` (~1054) | No `error` listener on `app.listen`; EADDRINUSE/EACCES is an uncaught emitter throw, bypassing the structured fatal path | Await `listening`/`error` as GPT wrote it — **out of scope this run, do not patch here** |
| 5 | Low | public/index.html `onTap` (~1166) | 80 ms guard is latent, not broken (see Refuted); if the compatibility click ever lands late, two physical taps open diagnostics | Pass the event, record `lastTouchAt` on `touchend`, drop `click` within ~600 ms |
| 6 | Low | public/index.html `advance`/settle (~971) | Display switched off mid-load: the settle callback still builds a layer and schedules one more `advance()` before self-terminating | In the settle callback, bail and `releaseImg` when `!app.displayOn` |
| 7 | Info | scripts/run.py:38 | Missing/non-executable venv python prints a traceback instead of the concise config error | Out of my control; operator's call |
| 8 | Info | server.js `#scanAlbum`, `scan` | 200k hard limit and 512-album cap applied in readdir order | Accepted, see below |
| 9 | Info | src/index.js | Inert scaffold placeholder, competes with `main: server.js` | Delete manually |

## Disputed

**Signature fix shape.** GPT wants length-prefixed parts, Gemini a plain `photos.join('|')`. GPT's ambiguity concern does not apply here — every path is `encodeURIComponent`d (`|` → `%7C`) and album names are allowlisted to `[A-Za-z0-9 ._-]`, so collisions are unreachable. Both are wrong on the constraint that matters: a 5,000-photo album means a ~200 KB string allocated on every 15 s poll, on a 1 GB device whose header comment is explicitly about not accumulating garbage. Iterate the array with a DJB2/FNV-style integer accumulator and store the number.

**Stale image behaviour.** GPT is wrong that a playlist change can display the previous album's photo; `app.loadToken` is incremented in `advance()` and the settle callback releases any superseded handle before it reaches `onPhotoReady`. GPT is right that two decoded bitmaps can be briefly alive at once, which is the actual (minor) memory concern, and right about the display-off case — that's finding 6.

**Tap severity.** Gemini asserts the double-count is deterministic ("2 physical touches trigger the 3-tap gesture"). It is not: `user-scalable=no, maximum-scale=1` removes the 300 ms click delay on iOS 9.3+, so the compatibility click normally arrives well inside 80 ms. GPT's framing (can, not will) is correct. Still worth the fix — the guard also swallows genuinely fast human taps.

## Refuted

- Gemini's chained attack path: the premise "unvalidated photo paths in bridge payload" is false. `albumPhotos` filters through `isSafeRelativePath`, and the server only emits `photos/<enc>/<enc>`. What remains is finding 2, a self-inflicted availability bug, not an attack.
- Gemini's "attack path" for the tap bug (an unauthorised person opening diagnostics) — anyone with physical access can tap three times regardless; the panel exposes no secret.
- Gemini's line numbers are unreliable (`onState` cited at 550, actually ~779). Navigate by GPT's ranges.
- GPT: "no material docstring gaps" — true for server.js, but it reviewed the client page without noting that `app.diagHideTimer` and `app.tickTimer` are never declared in the `app` literal. Cosmetic, not a defect; mentioned only so it isn't re-raised next run.

## Accepted risks

- **Album/photo cap ordering (8).** Requires >512 album directories or >200k files in one directory. A home photo library will not reach either, and the bounded-ordered-selection structure GPT wants is real code to maintain forever for zero benefit.
- **scripts/run.py traceback (7).** The operator sees a failure and a path either way; the only loss is tidiness, and the file is scaffold-owned.
- **src/index.js (9).** Two dead lines, never imported, `main` points elsewhere.
- **No automated client tests.** GPT's matrix needs a Safari-12-compatible DOM/XHR harness — ongoing maintenance an order of magnitude larger than the page. Verify the four fixes by hand on the device: boot cold, change album in HA, cover the tap gesture, leave it overnight.
- **CSP `'unsafe-inline'`.** Documented Safari-12 tradeoff; everything reachable is same-origin.

No files emitted: the only in-scope file is the 1,200-line `public/index.html`, and reproducing it would truncate this verdict. Fixes 1, 2, 3 and 5 are each a few lines within the functions named above.