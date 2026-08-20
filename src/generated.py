## Verdict

Ship with fixes. Nothing here reaches the crown jewel — `HA_TOKEN` stays server-side, the auth gate, path containment, and CSP hold up under both reviews and my own pass — but there are two cheap hardening changes in `server.js` and a Compose/env mismatch that will bite the operator on first deploy.

## Findings

| # | Severity | File:line | Finding | Fix |
|---|---|---|---|---|
| 1 | Medium | docker-compose.yaml (not in scope, unseen) | `PHOTOS_DIR` configurable but volume always mounted at `/photos`; a non-default value yields an unreadable root → `/healthz` 503 → container flagged unhealthy | Hard-code `PHOTOS_DIR: /photos` in Compose |
| 2 | Low | server.js:330–345 (`readImageExtensions`) | `EXTENSION_RE` is syntax-only, so `IMAGE_EXTENSIONS=.html,.svg` makes `/photos` serve active content same-origin under `script-src 'self' 'unsafe-inline'` | Intersect with a fixed passive-image allowlist; reject anything else at boot |
| 3 | Low | server.js:1265 (`main`, `app.listen`) | No `'error'` listener before the listen callback; `EADDRINUSE`/`EACCES` become an uncaught exception with a raw stack trace instead of the JSON `fatal` line | Await a promise resolving on `listening`, rejecting on `error`; move the info log after |
| 4 | Low | docker-compose.yaml (unseen) | `ALLOW_QUERY_KEY` and `IMAGE_EXTENSIONS` never passed into the container, so documented `.env` settings are silently inert | Add both with `${VAR:-default}` |
| 5 | Low | public/index.html `ensurePlaylist()` (unseen) | Album change does not bump `app.loadToken`; an in-flight image from the old album can paint and reschedule | Increment `loadToken` and clear `loading` on signature change |
| 6 | Low | public/index.html `poll()` (unseen) | Overlapping timer/`pageshow`/visibility polls can apply out of order; a stale timeout can drop the frame into fallback after a newer success | Sequence-number every completion, successes and failures alike |
| 7 | Low | README.md, .env.example (unseen) | Doc drift: `/healthz` payload, default extension list, `verify.sh` coverage matrix, Compose volume description | Bring docs to match code |
| 8 | Info | scripts/run.py:38 | `OSError` on a missing venv interpreter prints a traceback | Out of my control — do not touch this file |

No files emitted. Fixes 2 and 3 both live in `server.js`; reproducing a 1,100-line file to change nine lines would consume the entire budget. Both are described precisely enough to apply directly, and the reviewers' patch snippets for them are correct as written.

## Disputed

**IMAGE_EXTENSIONS as a security issue.** gpt-5.6-sol flags it; gemini's compliance checklist implicitly clears the input-validation boundary and its chained-attack section finds nothing. gpt is right that the hole is real — I confirmed `.html` matches `EXTENSION_RE`, passes `isValidPhotoName`, and `res.sendFile` will set `text/html` on a route that carries `script-src 'self' 'unsafe-inline'`. gemini is right that it is unreachable in the default configuration, which is why this is Low and not High: it requires the operator to deliberately widen the set *and* an attacker to have write access to `PHOTOS_DIR`.

**Severity of the `app.listen` gap.** gemini calls it a logging-correctness bug; gpt frames it as a broken promise contract. Both are correct but both overstate the operational impact: Node's default uncaught-exception handler still exits nonzero, so container restart policy behaves. The only real loss is that the failure reason arrives as a stack trace rather than a parseable `fatal` event. Fix it because it is four lines, not because it is dangerous.

**Compose coverage.** gemini found only `ALLOW_QUERY_KEY`; gpt found that plus `IMAGE_EXTENSIONS` and the `PHOTOS_DIR` mismatch. gpt's is the complete set, and the `PHOTOS_DIR` item is the one that actually breaks a deployment — the `ALLOW_QUERY_KEY` omission fails *closed*, which is the safer posture.

## Refuted

Nothing in either review is fabricated. Every claim I could check against the supplied `server.js` — the `readImageExtensions` regex, the `app.listen` callback shape, `/healthz` returning `{ok}` only, `DEFAULT_IMAGE_EXTENSIONS` excluding `.webp`/`.heic` — is accurate. Findings 1, 4, 5, 6, 7 and 8 reference files not included in this pass; I could not verify them, but both reviewers describe #5 and #6 with matching identifier names (`app.loadToken`, `app.playlistSig`, `onPhotoReady`), which is strong evidence they were reading the same real code rather than inventing it.

One correction to gpt's test-coverage list: it asks for a symlink-escape test against `createPhotoHandler()` as if none exists. `verify.sh` already covers the scanner side (`escape.jpg` → `/etc/passwd` in the library fixture) and encoded traversal over HTTP. Only the handler-level realpath check is untested. Smaller gap than stated.

## Accepted risks

- **Test-coverage backlog.** gpt lists roughly thirty proposed tests, including a full DOM/XHR harness for the browser client. On a home server that is a permanent maintenance obligation for bugs that self-correct within one slide interval. Add the two config tests (`IMAGE_EXTENSIONS=.html` rejected; `docker compose config` shows the env vars) and stop.
- **400-day session cookie with no revocation** except rotating `FRAME_KEY`. Correct for a kiosk; a session store would need pruning nobody will do.
- **`scripts/run.py` traceback.** Cosmetic, and the file is off-limits to this pipeline.
- **Auth-throttle self-DoS when `TRUST_PROXY` is unset behind a proxy.** Already mitigated by the boot warning, which is the right trade — the alternative is trusting `X-Forwarded-For` by default and losing per-IP throttling entirely.
- **Source-string grep assertions in `verify.sh`** (e.g. matching the literal `res.status(lib.ok ? 200 : 503)`). Brittle to reformatting, but they are cheap tripwires for exactly the regressions this run introduced. Leave them.