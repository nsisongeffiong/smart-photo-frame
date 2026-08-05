## Verdict

Do not run `verify.sh` in its current form; the `PPID` defect can SIGKILL the shell that invoked the harness, and the entire failover section is testing nothing. Everything else in both reviews is either a real but lower-value bug or unverifiable from the material supplied to this stage — only `verify.sh` was in scope here, so the `server.js` / `public/index.html` / `scripts/run.py` findings are adjudicated on reviewer concurrence, not on inspection.

## Findings

| # | Severity | File:line | Finding | Fix |
|---|---|---|---|---|
| 1 | **High** | verify.sh:703 (`PPID="$(start_stub …)"`) → verify.sh:~470 (`stop_pid "$ppid"`) | Assignment to readonly `PPID` fails; bash **continues**, so `PPID` still holds the harness's parent PID. `failover_checks` then `kill`s and `kill -9`s the invoking shell. Failover primary stub is never stopped, so every downstream failover assertion is meaningless. | Rename to `HA_FO_PRIMARY_PID`; have `start_stub` set a global `LAST_PID` and call it without command substitution. Additionally guard `stop_pid` with a numeric check (`[[ $1 =~ ^[0-9]+$ ]] \|\| return 0`) so a mis-wired PID can never target an arbitrary process again. |
| 2 | Medium | verify.sh:703–704, 481 | `PID="$(start_stub …)"` runs `start_stub` in a subshell, so `PIDS+=(…)` is lost. Three stubs (fo-primary, fo-fallback, primary-restart) survive `cleanup` and hold their ports. Note `start_stub ha-main … >/dev/null` at line ~640 uses the correct pattern — the fix already exists in the file. | Same as #1. |
| 3 | Medium | server.js `poll()`/`#applyValues()` | HA reported healthy on all-`unknown`/`unavailable` states; `haLastOk` advances while nothing is applied. Both reviewers concur, fix is identical and correct. | Return accepted count from `#applyValues()`, derive `haOk` from it. |
| 4 | Medium | public/index.html `ensurePlaylist()` | Album change does not invalidate an in-flight image load; previous album's photo can render after selection changes. Both concur. | `app.loadToken++` on signature change. |
| 5 | Low | server.js `main()` | `EADDRINUSE`/`EACCES` bypasses structured fatal logging. Both concur. Low because the failure mode is a noisy crash, not a wrong-but-running server. | Await a promise wired to `listening`/`error`. |
| 6 | Low | public/index.html `poll()` | Overlapping polls can apply stale state. Real but self-correcting on the next tick. | Monotonic sequence gate; gate errors as well as successes (gpt's version is the better of the two — see Disputed). |
| 7 | Low | src/generated.py | Markdown in a `.py` file; breaks `compileall`/import discovery. | Delete or move to a docs path. |
| 8 | Low | scripts/run.py:38 | Uncaught `OSError` traceback on missing venv interpreter. **Out of scope — do not edit.** Reported only. | `try/except OSError`, exit 1. |
| 9 | Low | verify.sh:~466, ~482 | `failover_checks` documents 4 params but takes 5; `cport` is unused, and `stop_pid "$CPID"` reaches for a global instead of a parameter — the same wiring sloppiness that produced #1. | Pass and use the fallback PID as a parameter; drop or use `cport`. |

## Disputed

- **Does bash abort on the `PPID` assignment?** gpt-5.6 is correct to hedge; gemini is wrong. Outside POSIX mode bash prints `PPID: readonly variable` and keeps going, which is the *worse* outcome — the script proceeds to kill its own parent. Gemini's "aborts before the failover tests" reading would actually be the benign case.
- **Severity of the `PPID` issue.** Both rated it Medium. Rejected: a test harness that SIGKILLs the terminal or CI step that launched it is a High, and it silently voids the failover suite on top of that.
- **Poll-sequencing fix.** gemini gates only the success path; gpt gates errors too. gpt is right — an old timeout marking the bridge unavailable after a newer success is the more visible symptom.

## Refuted

- gemini: `PPID` is "a readonly **environment** variable" — it is a readonly shell variable and is not exported. Immaterial to the fix, but the reasoning is off.
- gpt: "no `Dockerfile` present in the supplied repository" and "no `package-lock.json` supplied" — this stage received only `verify.sh`. These are claims about the review bundle, not established facts about the repo. Confirm by `ls` before acting; do not treat as findings yet.
- gpt: "the verification script can only skip rather than perform a meaningful audit when lockfile metadata is unavailable" — *confirmed* against verify.sh:~380; the audit block does degrade to `skip`. Listed here only because it was framed as a consequence of an unverified premise.
- gemini's compliance checklist and "no chained attack paths" are assertions about files not provided here. Nothing in `verify.sh` contradicts them; nothing in `verify.sh` supports them either.

## Accepted risks

- **Hardcoded `FRAME_KEY`/`HA_TOKEN` in verify.sh.** Harness-only fixtures for stub servers on 127.0.0.1. Neither reviewer flagged them; correctly so. Leave them.
- **`set -uo pipefail` without `-e`.** Deliberate for a harness that must report all failures rather than stop at the first. Do not "fix".
- **Poll ordering (#6) and listen-error handling (#5)** are fine to defer on a home server. A stale poll corrects within one interval; a bind failure is visible in the console regardless of whether the log line is JSON.
- **README and lockfile gaps.** Real, but they cost the operator ongoing maintenance for a single-user deployment. Generate the lockfile if `npm ci` is ever wanted in CI; otherwise skip.

No corrected file emitted: `verify.sh` is ~700 lines and reproducing it would truncate this verdict. Findings #1, #2 and #9 are three localised edits in `start_stub`, the two call sites at lines 703–704, the restart call site inside `failover_checks`, and `stop_pid`.