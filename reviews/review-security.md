## EXECUTIVE SUMMARY

A security and correctness audit was performed on the `smart-photo-frame` / `uploader` application codebase. The review evaluated business logic, authentication and session safety, path handling, upload stream lifecycle, memory constraints, and static asset handling.

---

## FINDINGS

### [SEVERITY: High] [CONFIDENCE: High]
**Category:** Broken Auth / Rate Limit Bypass  
**Location:** `uploader/src/auth.js`, lines 23–28 (`Auth.prototype.sweep`)  
**What:** The brute-force login failure tracking map (`this.fails`) is cleared entirely (`this.fails.clear()`) whenever its size exceeds 10,000 entries.  
**Attack path:**  
1. An attacker attempts to brute-force `POST /api/login`.
2. When close to reaching `AUTH_MAX_FAILS` (10 failed attempts) on their IP, the attacker sends requests using 10,000 distinct IP addresses (or distinct `X-Forwarded-For` headers when `TRUST_PROXY` is enabled).
3. `recordFailure()` calls `sweep()`, which detects `this.fails.size > 10_000` and executes `this.fails.clear()`.
4. This wipes all tracked failures, resetting the failure count for all IP addresses (including the attacker's) to 0 and bypassing the brute-force throttle indefinitely.  
**Fix:** Instead of calling `this.fails.clear()`, do not record new IP entries when `this.fails.size >= 10_000`, or evict only the oldest/expired entry (LRU/FIFO strategy).

---

### [SEVERITY: Medium] [CONFIDENCE: High]
**Category:** Denial of Service / Memory Exhaustion (OOM Crash)  
**Location:** `uploader/src/config.js` (lines 72, 77) & `uploader/src/library.js` (lines 40, 168)  
**What:** `MAX_PIXELS` defaults to 128,000,000 (128 MP) and `PROCESS_CONCURRENCY` defaults to 2, while the container memory limit is capped at 768 MB in `docker-compose.yaml`.  
**Attack path:**  
1. An authenticated user or attacker uploads two 120+ MP images in parallel.
2. In Sharp/libvips, an uncompressed 128 MP image buffer requires $128,000,000 \times 4 \text{ bytes} \approx 512 \text{ MB}$ of memory during transformation.
3. With `PROCESS_CONCURRENCY = 2`, two concurrent image decodes require over 1,000 MB of RAM.
4. Combined with Node.js heap usage and buffered uploads, process memory exceeds the 768 MB Docker limit, causing the Linux kernel OOM killer to send `SIGKILL` to the process, crashing the service.  
**Fix:** Reduce `MAX_PIXELS` to a safe limit for a 768 MB container (e.g. `32_000_000` or `40_000_000` pixels, requiring ~160 MB RAM per image) or set default `PROCESS_CONCURRENCY` to `1`.

---

### [SEVERITY: Medium] [CONFIDENCE: High]
**Category:** Data Integrity / Non-atomic Operation Failure  
**Location:** `uploader/src/library.js`, lines 121–137 (`Library.prototype.deleteAlbum`)  
**What:** `deleteAlbum(name, { withPhotos: true })` iterates over directory contents and unlinks all photo files and dotfiles before attempting `fs.rmdir(dir)`. If the directory contains any non-photo file (e.g. `notes.txt` or a video file), `fs.rmdir(dir)` fails with `ENOTEMPTY` and returns an HTTP 409 error, but all photo files in the album have already been permanently unlinked.  
**Attack path:**  
1. An album contains 100 photos and 1 non-photo file (e.g. `document.pdf`).
2. A user requests album deletion (`DELETE /api/albums/AlbumName?withPhotos=1`).
3. The server deletes all 100 photo files, fails at `fs.rmdir(dir)`, and returns HTTP 409 (`has_other_files`).
4. The user receives an error indicating the album was not deleted, but all 100 photos in the album have been irrevocably deleted.  
**Fix:** Validate the directory contents before unlinking any files. If any non-deletable/non-photo file exists in the directory, throw the HTTP 409 error up front without unlinking any photos.

---

### [SEVERITY: Low] [CONFIDENCE: Medium]
**Category:** Incorrect State Handling / Dangling Callback  
**Location:** `uploader/public/app.js`, lines 105–117 & 176–178  
**What:** `onQueueIdle` is defined at module scope and set when viewing an album page, but is not cleared when navigating back to the main album list.  
**Fix:** Reset `onQueueIdle = null` inside `route()` whenever switching active views.

---

## CHAINED ATTACK PATHS

**Chain:** [Finding 1: Brute-force Throttle Bypass] + [Single Shared Password] → An attacker targeting the public service URL can flood `POST /api/login` with candidate passwords while periodically flushing the failure map using 10,000 synthetic IP addresses. This completely circumvents rate limiting, allowing automated dictionary/brute-force attacks against the single household password until gaining complete write access to the photo library.

---

## COMPLIANCE CHECKLIST

- [x] **No hardcoded secrets or credentials:** Secrets are read from environment variables.
- [x] **Input validation present at trust boundaries:** Album names and filenames are restricted via strict regexes and sanitization (`ALBUM_RE`, `sanitizeBaseName`).
- [x] **Error responses do not leak stack traces or internal paths:** `HttpError` returns standard JSON objects (`error`, `message`).
- [x] **Logging does not capture or expose PII:** Structured JSON logger omits sensitive request headers.
- [x] **No SQL / command / template injection vectors:** No shell processes or database engines are used.
- [x] **Auth checks present on all protected routes/operations:** Protected API and thumbnail/photo endpoints enforce `auth.require`.

---

## AUDIT BRIEF DISPOSITION SUMMARY (U1–U11)

| Item | Status | Reasoning / Refutation |
|---|---|---|
| **U1** | **Confirmed / Accepted** | Single password design accepted for single-household scope. |
| **U2** | **Confirmed / Accepted** | Stateless HMAC cookie model accepted. |
| **U3** | **Refuted / Vulnerable** | Flushing `this.fails` on size > 10,000 enables throttle bypass (Finding 1). |
| **U4** | **Confirmed** | Whole upload buffered up to `MAX_UPLOAD_MB` before processing. |
| **U5** | **Refuted / Vulnerable** | 128 MP decoding with concurrency 2 exceeds 768 MB RAM cap (Finding 2). |
| **U6** | **Confirmed** | Leftover temp files ignored by frame, but no sweep at boot. |
| **U7** | **Confirmed / Mitigated** | Mitigated by `SameSite=Strict` cookie attribute. |
| **U8** | **Confirmed** | Non-atomic partial deletion bug present if non-photo files exist (Finding 3). |
| **U9** | **Confirmed / Accepted** | Check-then-write disk check accepted. |
| **U10** | **Confirmed / Accepted** | Fallback check-then-rename on non-hardlink filesystems accepted. |
| **U11** | **Confirmed / Mitigated** | Served via `sendFile` with `nosniff` and CSP policy. |