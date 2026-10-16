## Verdict

Ship with fixes. #1 and #2 block release, the rest can follow. With those in, this is acceptable at home behind a generated password and a backup of `/srv/photos`. If anyone outside the household knows the hostname, put Cloudflare Access in front instead of relying on the password.

## Findings

| # | Severity | File:line | Finding | Fix |
|---|---|---|---|---|
| 1 | High | uploader/src/library.js:129–148 `deleteAlbum` | `withPhotos=1` unlinks every photo before `rmdir` hits a non-photo file. It then returns 409 "left in place". iPhone and rsync folders often carry `.MOV`/`.AAE` files, so this fires without an attacker. The existing test passes even with the bug. | Preflight all entries before the first unlink (Quality's snippet is correct). Extend the test to assert `a.jpg` survives the 409. |
| 2 | High | uploader/src/auth.js:35, 44–45 | `clear()` at 10,000 entries wipes active blocks. There is no global ceiling, so rotating addresses gives unlimited guesses at the only gate in front of delete-everything. | Evict the soonest-expiring entry instead (the frame's `AuthGate#recordFailure` already does). Add a global cap of about 5 × `AUTH_MAX_FAILS` per window, returning 429 to all logins. Existing sessions are unaffected, so lockout is cheap. |
| 3 | Medium | uploader/src/library.js:18–20 `validAlbumName` | Missed by both. The frame's `isValidAlbumName` rejects any name containing `..`; the uploader does not. It will create and list `Trip..2020`, which the frame silently skips. | Add `!name.includes('..')` and a test case. |
| 4 | Medium | uploader/src/library.js:290–300 `thumbnail` | Missed by both. Thumbnails share the upload semaphore (2 active, 4 queued, then 503). Over HTTP/2, Traefik's TLS default, opening an album with more than 6 uncached tiles gives broken thumbnails. A thumbnail burst can also bounce an upload with `busy`. Tests miss it because HTTP/1.1 caps at 6 connections. | Give thumbnails a separate semaphore that waits instead of rejecting. |
| 5 | Low | uploader/src/app.js:125–165; config.js:77, 82 | U4/U5: the body is buffered before the gate, so in-flight memory is connections × 40 MB. 128 MP × 2 is unmeasured for AVIF and interlaced PNG, which decode whole. This is post-auth availability only. | Count in-flight uploads before `req.pipe(bb)`; return the existing `busy` 503 above `concurrency + 2`. In code, default `MAX_PIXELS` to 50 M (covers 48 MP phone JPEGs) and `PROCESS_CONCURRENCY` to 1. Land #4 first, or concurrency 1 breaks thumbnails even on HTTP/1.1. |
| 6 | Low | uploader/src/library.js:250 `savePhoto` | `writeFile` sits outside `try/finally`, so ENOSPC leaves a partial `.upl-*.tmp`. Nothing sweeps these at boot (U6). | Move it inside the `try`. At startup, unlink `.upl-*.tmp` in each album; nothing is in flight then. |
| 7 | Low | uploader/public/app.js `renderAlbum` delete handler; `route` | Deleting an album with queued jobs races `savePhoto`, giving a misleading 409 or 500 and possibly a straggler photo. `onQueueIdle` is never cleared. | Disable "Delete album" while a job targets that album. Null `onQueueIdle` in `route()`. |
| 8 | Low | uploader/docker-compose.yaml | `MAX_PIXELS`, `PROCESS_CONCURRENCY`, `MIN_FREE_MB`, `AUTH_*`, `COOKIE_SECURE` and `LOG_LEVEL` are documented but not forwarded, so they do nothing under Compose. | Forward each with `${VAR:-default}`. |

No files emitted: `library.js` alone exceeds the budget. `SECURITY.md` is deferred to a run with room for it.

## Disputed

- **Throttle.** Security's High rating stands, but its mechanism is wrong (see Refuted). Quality's eviction fix alone is insufficient: without a global ceiling, a per-IP limit still falls to address rotation.
- **U4.** Quality is right that the bound is refuted. Security's "Confirmed" confirms only the buffering, not the claimed 3× bound.
- **U5.** Quality's "cannot establish" is the correct method. Security's arithmetic contradicts the brief's measurements for JPEG and flat PNG, though it is plausible for whole-decode formats. Lower the defaults anyway (#5).
- **U11.** Security is right. Only image extensions are servable, `nosniff` is set, and SVG is excluded. Quality is over-cautious.
- **Multi-page HEIF (Quality).** Real but harmless: an AVIF sequence is stored as its first frame. Do not just delete the exemption, or multi-image iPhone HEICs get "Animated images" instead of the HEIC guidance. Check `meta.compression === 'hevc'` first.
- **Trailing space/period (Quality).** This is the harmless direction, since the uploader is stricter than the frame. The real mismatch is #3.

## Refuted

- Security: "distinct X-Forwarded-For headers when TRUST_PROXY is enabled." With `trust proxy = 1`, Express takes the proxy-appended address, so client XFF cannot choose `req.ip`. It works only if `TRUST_PROXY` exceeds the real depth. The finding survives via real address rotation (cheap with IPv6 where exposed).
- Security: "128 MP requires 512 MB" as a general rule. libvips streams; the brief measured 140–185 MB.
- Security: U3 "Refuted / Vulnerable" conflates the proxy-depth item with the map wipe.
- Citations are off but the findings behind them are real; cite by function:
  - Security's auth.js:23–28 is `checkPassword`, and config.js:72 is `cookieSecure`.
  - Quality's library.js line numbers run 20–35 lines high.
  - `uploader/src/public/app.js` does not exist; the file is `uploader/public/app.js`.

## Accepted risks

- **U1/U2.** One password and stateless sessions are acceptable given #2, a generated password and a backup. The upgrade path is Cloudflare Access, not more code.
- **U3.** This is a deployment dependency. Compose hard-codes `TRUST_PROXY: "1"`, which is correct for the README's grey-cloud DNS. Enabling Cloudflare's proxy means editing it to 2.
- **U7.** The guard is scheme-blind and lets Origin-less requests through. It is unexploitable from a browser given SameSite=Strict, the Secure `__Host-` cookie and HSTS. A cross-origin `X-Forwarded-Host` needs a preflight, and the preflight fails.
- **U9/U10.** Accepted as declared.
- **Photo-cap race** (library.js:234–239). It needs concurrent multi-device uploads, and the UI already flags photos past the frame limit.
- **Config upper bounds.** They are reachable only by editing Compose.
- **Test backlog.** Add only the tests guarding #1–#3. Memory under the 768 MB cap is a one-off manual measurement, not a suite to maintain.