## Documentation Gaps

- `uploader/src/app.js` — `createApp`: document its required dependencies and the routes it exposes without authentication.
- `uploader/src/auth.js` — `Auth`: document that logout does not revoke an issued cookie, and that `TRUST_PROXY` determines the address used for throttling.
- `uploader/src/library.js` — `Library`, `validAlbumName`, `sanitizeBaseName`: document the filesystem assumptions, naming rules, and upload limits callers can rely on.
- `uploader/src/config.js` — `loadConfig`: document the security-sensitive deployment defaults, particularly proxy trust and secure cookies.

## Code Quality Issues

By reading the source, the highest-priority issues are:

- `[uploader/src/library.js:151–162]` **Album deletion can erase photos and then return 409.** With `withPhotos=1`, it unlinks photos before discovering an unrelated file that prevents `rmdir`. Validate *all* entries before deleting any. The existing test checks that `notes.txt` survives, but not that the photo survives.
- `[uploader/src/library.js:260–313]` **The photo cap is check-then-save.** Concurrent uploads can each see space under the cap and collectively exceed it. Serialize the cap check through publication per album; test uploads starting at `limit − 1`.
- `[uploader/src/library.js:284–286]` **A failed or partial `writeFile` leaves a `.upl-*.tmp` file.** The cleanup `finally` starts only after `writeFile` succeeds. Put creation inside the cleanup scope and sweep abandoned upload temps at startup.
- `[uploader/src/app.js:125–169; uploader/src/library.js:275–281]` **The processing queue is not an in-flight upload limit.** Requests finish buffering their files before entering the semaphore. Many clients can therefore hold buffers concurrently despite its queue cap. Add an admission limit *before* multipart parsing; account for `Buffer.concat` and decoded/output images when setting limits against 768 MB.
- `[uploader/src/config.js:81–88; uploader/src/library.js:217–250]` **Allowed settings can exceed the container’s memory budget.** Configuration permits eight processors, 500 MB uploads, and one-billion-pixel inputs. Even the defaults do not establish a safe peak for two simultaneous 128 MP decodes. Bound the combined settings and measure difficult formats under the actual memory limit.
- `[uploader/src/library.js:233–236]` **Multi-page HEIF inputs bypass the multi-page rejection.** Remove the format exception unless handling of every page is intentional and tested.
- `[uploader/src/library.js:42–43]` **Album validation is stricter than the stated frame regex.** It rejects names ending in a space or period that the supplied frame contract allows. Either align validation or explicitly change and verify the contract.
- `[uploader/src/auth.js:43–46]` **Clearing the throttle map at 10,000 entries clears active blocks too.** Under address spoofing or a mistaken proxy-hop setting, this resets throttling for everyone. Evict expired or oldest entries instead of clearing the map.
- `[uploader/src/public/app.js:123–146,207–224]` **The module-level upload queue outlives the album view.** Deleting an album during an upload can race publication or leave later queued jobs targeting the deleted album; its idle callback can also refresh a detached view. Disable deletion while that album has jobs, or explicitly cancel and await them, and tie refreshes to the current route.
- `[uploader/src/app.js:42–52]` The Origin guard compares hosts but not schemes and permits an Origin-less state-changing request. `SameSite=Strict` provides the primary browser protection, but the guard should compare the expected full origin and define an explicit policy for missing Origin.

## Test Coverage

Add targeted tests for:

- An album containing both a photo and `notes.txt`: `DELETE ...?withPhotos=1` must leave **both** untouched on 409.
- Parallel uploads at `FRAME_MAX_PHOTOS_PER_ALBUM − 1`: assert the final count never exceeds the limit.
- A forced failure during temp-file writing, followed by a restart with an abandoned `.upl-*.tmp`.
- Many simultaneous, slow multipart requests: verify admission is rejected before all bodies are buffered, and measure peak memory under the 768 MB limit. Include interlaced PNG, TIFF, WebP, AVIF, and high-entropy output.
- Multi-page HEIF, where supported by the installed Sharp build.
- Deleting an album while an upload is processing; navigating or signing out with queued files.
- Throttle behavior at its map cap and with the deployed proxy-hop topology. The current tests establish behavior for supplied headers, not the production proxy chain.
- Frame compatibility for boundary album names and ordering at the 500-photo cutoff; the current frame integration test covers only four photos.

## Suggested Improvements

**Preflight album deletion so a rejected operation is non-destructive:**

```js
// Before: photos may be gone when rmdir discovers notes.txt.
for (const e of entries) {
  if (e.name.startsWith('.') || isPhotoName(e.name)) {
    await fs.unlink(path.join(dir, e.name));
  }
}
await fs.rmdir(dir);
```

```js
// After: refuse unsupported entries before the first unlink.
if (entries.some((e) => e.isDirectory())) {
  throw new HttpError(409, 'has_subfolders', 'This folder contains sub-folders.');
}
if (entries.some((e) => !e.name.startsWith('.') && !isPhotoName(e.name))) {
  throw new HttpError(409, 'has_other_files', 'This folder holds files that are not photos.');
}
if (entries.length && !withPhotos) {
  throw new HttpError(409, 'not_empty', 'This album is not empty.');
}
for (const e of entries) await fs.unlink(path.join(dir, e.name));
await fs.rmdir(dir);
```

**Cover temp creation with cleanup:**

```js
// Before
await fs.writeFile(tmp, out.data, { flag: 'wx', mode: 0o644 });
try {
  await fs.chmod(tmp, 0o644);
  // publish
} finally {
  await fs.unlink(tmp).catch(() => {});
}
```

```js
// After
try {
  await fs.writeFile(tmp, out.data, { flag: 'wx', mode: 0o644 });
  await fs.chmod(tmp, 0o644);
  // publish
} finally {
  await fs.unlink(tmp).catch(() => {});
}
```

That change handles write errors; a separate startup sweep is still needed for process crashes.

**U-item disposition, by reading:** U1 accepted household trade-off (`auth.js`); U2 confirmed (`auth.js`); U3 confirmed, deployment topology unverified (`app.js`, `config.js`); U4 refuted as a memory bound (`app.js`, `library.js`); U5 cannot be established from source and configuration permits unsafe combinations (`config.js`, `library.js`); U6 confirmed (`library.js`); U7 confirmed (`app.js`); U8 confirmed, with the additional partial-deletion bug above (`library.js`); U9 confirmed (`library.js`); U10 confirmed (`library.js`); U11 extension-based serving confirmed, but safety of externally placed files cannot be concluded from the supplied tests (`app.js`).