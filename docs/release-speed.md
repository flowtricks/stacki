# Release speed: build once, test once, promote

## One screen

| | Before (measured, Nov 11 to 17) | After (this design) |
|---|---|---|
| Push to live, today (1.4.6 and 1.4.7) | **about 6 h**: 1.4.6 tag 19:39 UTC, failed after the tag; 1.4.7 public 22:37 | |
| Tag to public, 1.4.7 | **63 min** (39 of them re-running the suite Check had already run) | **5 to 10 min** (promotion only) |
| Release command to live, candidate already green on HEAD | n/a | **under 15 min** |
| Release command to live, cold HEAD | 31 min p50, 54 min p95 per release.yml run, then reruns | **about 30 min p50, under 60 min p95** |
| Versions burned this week (tagged, never public) | **11** (1.1.2, 1.1.4, 1.1.5, 1.1.7, 1.1.9, 1.2.0, 1.2.1, 1.4.0, 1.4.1, 1.4.4, 1.4.6) | **0 by construction**: the tag comes only after everything is green |
| Local gate runs per release | 3 to 6 pre-push gates (about 7 min each) | **0**: the bump is a GitHub commit; CI gates the exact SHA |

**The guarantee.** If `Check` and `Candidate` are green on HEAD, `npm run release:ship -- --confirm`
makes the version live in under 15 minutes. From a HEAD that has not run yet, under 60 minutes at
p95, and the command says at minute 5 whether a GitHub runner queue puts that at risk.

**Its conditions (honest).**

- `Check` must be green on the release SHA. It was green on **16 of 56** runs this week (2 of 12
  today). Flaky suites, not the pipeline, are now the critical path: see "What still goes wrong".
- GitHub must hand out macOS runners: p95 queue 14 min this week, and 11 runs had a job never
  acquire one. The rerun policy now retries those once, automatically.
- Apple notarization: inside `build-mac` (17 min p50, 36 min p95). It now runs in parallel with
  `Check`, before the tag, instead of after it.

**The three changes that save the most, with the least risk.**

1. **Promote, don't rebuild** (`candidate.yml` + `release.yml` + `promote.mts`): saves 30 to 40 min a
   release and ends burned versions. Risk: artifacts flow between workflows; proven in a dry run
   before the first real use.
2. **One command from GitHub state** (`releaseShip.mts`): no local gate, no clone, no working tree;
   saves 10 to 40 min and removes the "green here, red in CI" class.
3. **Cancel superseded Check runs + automatic infra reruns**: frees macOS runners, and the 11
   "not acquired" runs need no person.

## Measurements

Source: `gh run list/view` JSON per job, Nov 11 to 17 (59 Check attempts, 23 Release attempts), the
local pre-push logs of today, and the 1.4.7 runs. Minutes.

| Stage | p50 | p95 | Blocks | Failed this week | Causes |
|---|---|---|---|---|---|
| Local pre-push gate (`npm test`, working tree) | 6.4 | 7 | every push | 2 of 3 runs today (one push = 20 min) | `appUiKit` suite; Studio verify: 1,094 "type that cannot be resolved" ESLint errors from a concurrent vendor assemble |
| GitHub `Check`, whole run | 20 | 66 | tag (via release.yml `plan`) | 35 red, 5 cancelled of 56 runs | real test failures 21 attempts (macOS 12, Windows 12, Linux 11; 10 of them Windows/macOS only); runner never acquired 11 attempts |
| Check job: shard macOS | 7.0 (queue p95 13.6) | 11.8 | Check | 12 red, 14 cancelled | test failures; capacity |
| Check job: shard Windows / Linux | 8.3 / 5.5 | 13.7 / 7.9 | Check | 18 / 14 red | path separators, CRLF, timing; flaky suites |
| Check job: static macOS (ESLint inside) | 9.8 (queue p95 15) | 12.1 | Check | ESLint killed at 600 s once | slow runner |
| Check job: studio verify | 8.4 to 9.5 | 9.7 to 12.5 | Check | 4 | assemble race, platform |
| release.yml whole run | 31 | 54 | going public | 11 red, 5 cancelled of 23 | suite re-run on built apps, Windows/macOS-only tests, soak driver |
| release.yml build-mac (sign + notarize) | 17 | 36 | publish | 8 (old layout ran tests here) | tests |
| release.yml build-windows / linux / studio | 22 / 17 / 5 | 28 / 21 / 6 | publish | 11 / 4 / 2 | tests; deb install |
| release.yml tests job (suite again) | 32 (macOS), 33 (Windows) | 41 | publish | 9 of 15 | the same flakes Check had |
| 1.4.7: tag to public | 63 | | users | | 39 min spent re-running the suite |

Failure classes, counted:

| Class | Hits this week | Today |
|---|---|---|
| Real test failure in Check | 21 attempts | 10 of 12 runs |
| Windows/macOS-only failure | 10 attempts | 7 runs; Windows path tests 3 times |
| Runner not acquired (macOS) | 11 attempts | 9 runs |
| Post-tag failure burning a version | 11 versions | 1 (1.4.6) |
| Vendor assemble race | | 1 pre-push gate (push2.log) |
| Lost gate output | | 1 (Studio verify) |
| Wall-clock bound flake | | 1 (astroEditorScale 278 ms > 250 ms, 1.4.7 bump) |
| `release-go.yml` unusable | always | no `release` environment (404), no `RELEASE_PUSH_TOKEN` |

## The design

```
npm run release:ship -- --confirm
  1. bump      GitHub commit "chore(release): version X.Y.Z" on origin/main (fast-forward only)
  2. parallel  check.yml (full suite, 3 OS)  ||  candidate.yml (build, sign, notarize, smoke-test, keep artifacts)
  3. tag       only when both are green on that exact SHA
  4. promote   release.yml: prove, download that run's artifacts, check them, upload, publish
  5. post      release-post.yml: npm create-stacki, site, verify (unchanged)
```

- Fix forward without burning: a red Check or Candidate leaves the version untagged. Fix on main;
  Candidate rebuilds on the new HEAD with the same version; `release:ship` resumes.
- A promotion failure (download, upload) is re-run on the same tag: nothing is rebuilt, so the
  re-run cannot pick up different code.
- Prebuilt candidates: while the version on main is unreleased, every push builds a candidate.
  Bump early (start the day with `release:ship -- --confirm` and let it wait), and the release
  moment is only steps 3 to 5.

## Failure to control

| Failure | Control | Where | Cost |
|---|---|---|---|
| Working tree hides missing files or manifest entries | Nothing in the release path reads the working tree: the bump is made from origin's blobs; Check and Candidate run on the exact SHA | `releaseBump.mts`, CI | 0 |
| Studio manifest or import missing | Studio verify in Check and `build-studio` in Candidate, both on the clean SHA | CI | already paid |
| Windows/macOS-only test failure | Found before the tag (Check on all 3 OS); fix forward, same version | CI | 0 extra |
| Vendor assemble race | Locked (mkdir lock, stale takeover at 10 min), incremental, rename-per-file sync | `studio/scripts/vendorSync.ts` | faster: unchanged files untouched |
| Runner not acquired, runner lost, npm/apt/5xx | One automatic rerun of the failed jobs, first attempt only, known signature only | `knownFlakes.mts`, `releaseShip.mts` | 0 person-minutes |
| Wall-clock bound missed on a loaded runner | One automatic rerun; a second miss stops | `knownFlakes.mts` (`wall-clock-bound`) | interim |
| Superseded Check holding macOS runners | `concurrency: cancel-in-progress` on Check and Candidate | workflows | frees runners |
| Failure after the tag | The tag needs both green; promotion re-runs on the same tag | `promote.mts`, `releaseShip.mts` | 0 |
| Signing/notarization delay | Runs in Candidate, in parallel with Check, before the tag | `candidate.yml` | hidden behind Check |
| Stale or mixed update feed | Every feed must name this version and only present files at their real sizes; checked in Candidate and again after download | `candidate.mts --stage=assets` | seconds |
| Lost gate output | Gate failure exits drain stdout and stderr first (bounded 10 s) | `scripts/gate/flushExit.ts` | 0 |
| `release-go.yml` unusable | Removed; `release:ship` needs no environment and no extra secret | | |
| A rehearsal reaching users | Rehearsal candidates are titled "(rehearsal)" and never promoted; a dispatched release.yml is always a dry run; drafts and artifacts are invisible to the updater | workflows | |

## What still goes wrong (honest)

- **Flaky and platform-bound tests are the real critical path.** 1.4.7's bump commit was red on
  `renderer/apps/appUiKitElements` (Linux) and `astroEditorScale` (macOS); the old release went out
  only because release.yml ran the suite again. The new path will stop there instead. Fix: make
  wall-clock bounds relative to a baseline measured in the same run, or move timing suites to a
  non-blocking nightly job; quarantine a suite after two flaky reds (owner decision).
- **Untested until rehearsed:** cross-workflow artifact download (`run-id`), that a tag created
  through the API starts release.yml (it should with a personal token; `release:ship` stops
  after 3 minutes if not), and the size of the promotion upload (about 1.4 GB).
- **macOS capacity** can still push a cold release past 60 minutes; the minute-5 forecast says so.
- **The remote bump skips the local hooks.** The pre-commit format check holds by construction
  (version lines only, proven by read-back); the pre-push gate moves to Check on the exact SHA,
  which promotion requires. Owner, please confirm this move.
- The local `main` checkout must be rebased onto origin before these commits are pushed (origin
  has the 1.4.7 bump; local main does not).

## Owner decisions (approved Nov 17)

1. **Remote bump: yes**, only because the code is proven: `release:ship` bumps only on a green
   Check of the exact base SHA, and tags only when Check and Candidate are green on the bump SHA.
2. **Timing bounds: relative.** `lagMsBound()` is 250 ms times the speed factor of a fixed
   calibration workload measured in the same process (clamped to 1x to 4x; `test/helpers/scaleFixtures.ts`).
   **Quarantine: only after two flaky reds**, in `scripts/gate/quarantine.json` with an owner, a reason, the
   red run URLs and an expiry of at most 7 days; an expired entry fails Check. Never for
   correctness, safety or data-write suites (`scripts/gate/quarantine.ts`, `PROTECTED_SUITE_PATTERN`).
   `appUiKitElements` (Linux) is fixed, not quarantined (see below).
3. **Static checks on Linux only** (`static` job matrix); builds and every suite still run on all
   three platforms in the shards and in Studio's verify.
4. Larger macOS runners: **not approved**. Mitigation: bump early so Candidate overlaps the queue;
   one automatic rerun for "not acquired".

`appUiKitElements` on Linux (1.4.7 bump): the Escape that clears the search was never delivered
(events stopped at `change:pin`). Not reproduced on macOS, even with a second window taking focus.
The fix re-focuses the page and the field right before each press and repeats an unheard press, at
most 5 times; a repeat on a cleared field adds no events. Unproven on Linux until the rehearsal.

## Ranked plan (beyond what is implemented)

| # | Change | Saves | Risk | Effort | Approval |
|---|---|---|---|---|---|
| 1 | Relative timing bounds (done for lagMsBound) and the expiring quarantine (done); fix the remaining flaky suites | most reds this week | low | days | approved |
| 2 | Static checks on Linux only; builds on all OS | 8 macOS min per Check, the ESLint kill | low | done | approved |
| 3 | Bump at the start of a release day | the whole 30 min at release time | none | 0 | no |
| 4 | Larger macOS runners | queue p95 14 min | cost | minutes | declined |
| 5 | Pre-push gate on `git archive HEAD` for everyday pushes | the working-tree class for non-release pushes | low | hours | yes (`scripts/policy`) |
| 6 | Windows portability lint (path separators in assertions, quoted Windows paths in generated scripts) | 3 respins today | low | hours | yes (`scripts/eslintPlugin`) |
