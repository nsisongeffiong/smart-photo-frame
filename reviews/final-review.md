## Verdict

Ship with fixes. Nothing found by either reviewer is a security defect — the security review came back clean and I agree with that conclusion — but finding #1 makes the health endpoint lie during a Home Assistant restart, which is worth fixing before deploy since README §3 tells the operator to alert on exactly that field.

**Caveat on scope:** the source I was given contains only `verify.sh`, `Dockerfile.txt`, `docker-compose.yaml`, `example.env`, `README.md`. Both reviewers make claims about `server.js`, `public/index.html`, `package.json` and `scripts/run.py`, none of which I can see. Findings 1–4 and 6 below are ruled on the strength of two independent reviewers describing the same code the same way, not on my own reading. Findings 5 and 7 I verified directly.

## Findings

| # | Severity | File:line | Finding | Fix |
|---|---|---|---|---|
| 1 | Medium | server.js ~580–625 | `haOk`/`haLastOk` go true on a 200 that carries only `unknown`/`unavailable`; `/healthz` reports healthy while no value was applied, defeating external alerting | Make `#applyValues()` return an accepted count; set `haOk`/`lastOkAt` from that count, not from key presence |
| 2 | Low-Med | public/index.html ~917 (`ensurePlaylist`) | Album change does not invalidate the in-flight load; the previous album's photo can reach `showLayer()` | `app.loadToken++` on playlist-signature change |
| 3 | Low | public/index.html ~704 (`poll`) | Concurrent polls; a slower older response can overwrite newer state | Monotonic sequence number, discard stale; self-corrects next poll either way |
| 4 | Low | server.js ~1054 (`main`) | `EADDRINUSE`/`EACCES` bypass the structured fatal path; JSDoc claims `main()` resolves on listening | `await` a promise resolving on `listening`, rejecting on `error` |
| 5 | Low | docker-compose.yaml:9 | Compose names `Dockerfile`; repo ships `Dockerfile.txt`. Documented rename in README §6 and in the Dockerfile header, but nothing enforces it and a clean `docker compose build` fails | Add a build smoke step to CI, or a `Dockerfile` symlink. Do **not** change compose to `Dockerfile.txt` |
| 6 | Info | scripts/run.py:38 | Missing/non-executable interpreter prints a traceback | Out of my scope to rewrite. One `except OSError` → message + `sys.exit(1)` |
| 7 | Info | verify.sh | The harness covers auth, traversal, failover and outage well, but has no assertion for #1 (HA returning `unknown`) or #4 (occupied port). Those are the two findings a regression test would actually catch | Add two cases: stub returning `unknown` for all four entities must leave `haOk=false`; startup on a bound port must exit non-zero with a JSON log line |

## Disputed

**Docker packaging severity.** gpt-5.6-sol treats the `Dockerfile.txt` name and the lockfile as build-blocking correctness bugs; gemini-3.6-flash is silent. gpt is factually right that a clean checkout does not build, but wrong on framing: `Dockerfile.txt`'s own header states the `.txt` extension is imposed by the release extractor, and README §6 step 2 makes the rename a deploy step. This is a documented packaging convention, not a defect — worth a CI guard, not a ship block.

**gpt's alternative fix for #5.** Changing compose to `dockerfile: Dockerfile.txt` is the wrong branch of its own suggestion and would break the documented Coolify flow. Reject that half; keep the rename.

**Missing `package-lock.json`.** Unverifiable from the excerpt, and self-gating regardless: `check_static` in verify.sh already fails the run if the lockfile is absent, with the reason attached. If `verify.sh` passes, the lockfile is there. No action.

**Playlist race severity (#2).** gemini rates Low, gpt implies higher. gemini is a shade low — on a frame where albums separate what different visitors should see, a stale-album frame is a small privacy leak, not just a flicker — but it lasts one frame and gpt's own fix is one line. Low-Medium as ranked.

## Refuted

- Nothing in either review describes code that does not exist, as far as I can check. Both reviews converge on the same four bugs with the same fixes, which is the strongest signal in the pair.
- gpt's maintainability item (`diagHideTimer`/`tickTimer` absent from the state declaration) is a style preference, not a finding. It explicitly notes it does not break anything. Drop it.
- gpt's "Documentation Gaps: none" and gemini's compliance checklist are assertions about files not present in this excerpt. Treat both as unaudited by me, not as confirmed.
- The two test-coverage lists (roughly 40 suggested cases) are aspirational for a single-user home frame. Take rows 7's two cases and the album-change case from #2; ignore the rest.

## Accepted risks

- **`FRAME_KEY` as a URL bearer secret.** No accounts, no revocation, no audit trail. README §9 states this plainly and correctly. Fixing it means an authenticating proxy, which is ongoing maintenance for a photo frame. Accept.
- **`node:20-alpine` unpinned, `npm ci` without `--ignore-scripts`.** Digest pinning means manual bumps forever on a home server; the alternative is silent staleness. Accept the tag.
- **Named volume mounted `:ro`.** Photos must be loaded out of band. Deliberate, documented, and the right trade — a compromised process cannot delete the album tree.
- **The `Dockerfile.txt` rename step.** Externally imposed; documented twice. Accept, with the CI guard in #5 if you ever automate the deploy.
- **#3, #4, #6.** All three are cosmetic in operation: a stale state that corrects itself in one poll cycle, a traceback instead of a JSON line on a bind failure that still exits non-zero, and a traceback on a missing interpreter. Fix them if you are already in the file; do not schedule work for them.

No corrected files emitted: every finding above severity Info lives in `server.js` or `public/index.html`, neither of which is in scope here.