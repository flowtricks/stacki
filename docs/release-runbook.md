# Release runbook

The procedure for releasing a new version of Stacki (Desktop, Studio bundle, `create-stacki`, and
the stacki.build demo). Follow it top to bottom. [releases.md](./releases.md) is the history and
the rules reference; [create-stacki.md](./create-stacki.md) is the npm detail.

Target: **about 65 minutes wall clock** for a typical patch release whose code already passed
`Check` on `main`, about **40** once Phase B (end of this page) lands. Most of that is two CI
waits that no local work can shorten, so the runbook's job is to overlap everything else with them.

## 0. Rules before anything starts

| Rule | Detail |
|---|---|
| **Patch versions only** | Next version = last released patch + 1: `1.4.3` -> `1.4.4`. The maintainer: "You should be releasing versions like 1.4.1, 1.4.2, and so on." Never a minor or major bump unless the user explicitly says so in chat. `npm run release` offers minor and major and runs `git add --all`: **do not use it**; use the steps below. |
| **Authorization** | A release is outward-facing. Start only when the user asked for one. Ask about the version only if it is ambiguous (for example the tree already holds a bump to something other than last released + 1). |
| **Accounts** | Push, tag, dispatch and `gh` on `flowtricks/*` run as `flowtricks`, leaving the active gh account alone (command in step 8). |
| **Never** | `--no-verify`; moving or deleting a pushed tag; force-pushing; deleting a release. A failed release is fixed forward: fix + regression test + the next patch. |
| **Credentials** | Never ask for, paste or handle tokens, passwords or one-time codes. |

See "What you may NOT do without asking" at the end.

## 1. The two helpers

Both are read-only and need no build (`.mts`, run by Node directly).

```sh
node --experimental-strip-types scripts/release/releaseStatus.mts [sha|HEAD]
node --experimental-strip-types scripts/release/verifyRelease.mts <version> [--only=release,npm,site] [--wait-minutes=15]
```

`releaseStatus` ends with `READY TO TAG: ...` or `NOT READY: <reason>` (exit 0 / 1; 2 = could not
read GitHub, also not ready). Real output, before a bump existed:

```
Release status for ad82816 (version 1.4.3, last released 1.4.2)
  versioning   patch bump OK
  tag          v1.4.3 not on origin (good)
  working tree 2 modified tracked file(s), 6 untracked
  unpushed     1 commit(s) not on origin/main
  check.yml    no run for this exact SHA
  green base   8f8eaa0, 32 commit(s) back: https://github.com/flowtricks/stacki/actions/runs/43466276815
  delta        160 file(s) since the base, 153 not version files
NOT READY: uncommitted changes to tracked files (...); the pre-push gate builds the working tree, not the commit.
```

`verifyRelease` prints one PASS/FAIL/WARN row per check and `VERIFY PASS` or `VERIFY FAIL: n`
(exit non-zero on any FAIL; WARN, such as missing optional demo assets, does not fail). Real
output for 1.4.2:

```
PASS  release tag                     release tag is v1.4.2
PASS  release published               public, not a draft
PASS  release required assets         all 16 present
PASS  release demo assets             9 present
PASS  release latest-mac.yml contents version 1.4.2, 4 file(s) match their asset sizes
PASS  npm     latest tag              create-stacki@latest is 1.4.2
PASS  npm     tarball dist/demo       9 file(s) under dist/demo/
PASS  site    /stacki-release.txt     built from 1.4.2
PASS  site    /marketplace/admin      302 to Cloudflare Access
VERIFY PASS
```

`--wait-minutes=N` (at most 30) retries failing groups every 30 seconds for registry and CDN lag.
Without it each check runs once.

## 2. What must be green on the tagged SHA (the rule)

The release tag points at commit **B**, the bump commit (version files + release notes).
`Check` on `main` only runs for the tip of each push, so "green" is judged like this:

| Case | Rule | Why it is sound |
|---|---|---|
| `Check` is green on B itself (all four jobs: `policy`, `test` on ubuntu, macos, windows) | Tag B. | The exact tree passed on every platform. |
| `Check` is green on an ancestor **X**, and `git diff --name-only X B` lists **only** the version files (`package.json`, `package-lock.json`, `packages/create-stacki/package.json`, `studio/package.json`, `studio/package-lock.json`, `studio/src/shared/release.json`) and `docs/releases.md` | Tag B. `releaseStatus` applies this test. | Nothing executable changed after X passed on all three platforms. And `release.yml` runs the **whole suite again on B** on macOS, Windows and Linux before it builds anything, so B cannot ship untested. The residual risk is a version-sensitive test failing in `release.yml` (burns a patch number), which step 5 closes locally in seconds. |
| Anything else changed since the last green run (runtime code, tests, configs, docs other than `releases.md`) | **Not ready.** Push, wait for `Check` on that SHA, and re-run `releaseStatus`. | Windows and macOS failures appear only there (1.4.0, 1.4.1, 1.4.2, 1.4.3), and each cost a respin when found after the tag. |
| `Check` failed or is missing a required job on the exact SHA | Not ready, even if an older run was green. | A finished red run on this SHA is real signal. |
| `Check` still running on B, green ancestor X with a version-only delta | Ready. | Same as row 2; B's own run is not required. |

When a **local full gate** is still required (`env -u ELECTRON_RUN_AS_NODE npm test`):

| Situation | Local run |
|---|---|
| Runtime code (anything not a test or doc) changed since the last green **local** full run and `Check` has not yet gone green on it | Full gate, once, when no other agent is editing. Otherwise let `Check` be the gate. |
| A gate-defining or config file changed (`eslint.config.mjs`, tsconfigs, `scripts/{eslintPlugin,policy,agent,gate}/`, hooks, workflows, `shared/core/limits.ts`) | Full gate. |
| Linux-only code (installer, `afterPack`, `linuxSmoke`, native bindings) | Full gate plus `npm run check:linux` (about 30 s of static checks, probes after a full run). |
| A fix after a failure touches **only tests** | Only the affected suites (`env -u ELECTRON_RUN_AS_NODE npm test -- <suite>`) plus `npm run check:changed`. Not a second full gate. |
| The release bump itself | `npm run check:changed` plus the version-sensitive suites in step 5. Not the full gate. |

The pre-push hook still runs the full gate on every push until Phase B lands; that is the one
unavoidable local full run, so step 8 pushes `main` and the tag **together** to pay it once.

## 3. The flow, in order

Times are budgets, not promises. **P** marks work that overlaps a CI wait.

| # | Step | Budget |
|---|---|---|
| 1 | Pre-flight | 3 min |
| 2 | CI-first gate: confirm `Check` green on the tip (or start it) | 0 to 30 min wait, overlapped with 3 |
| 3 | Release notes from the log | 5 min |
| 4 | Version bump (one commit) | 3 min |
| 5 | Local checks on the bump | 3 min |
| 6 | `releaseStatus` | 1 min |
| 7 | **P** create-stacki and site prechecks | 4 min (while 8 runs) |
| 8 | Push `main` and the tag together | 12 min (the pre-push gate) |
| 9 | Watch `release.yml` job by job | about 40 min |
| 10 | **P** Dispatch create-stacki publish | starts about minute 15 of step 9; about 20 min |
| 11 | Verify the GitHub release | 2 min |
| 12 | npm checks | 5 min |
| 13 | Marketing site deploy and live checks | 8 min |
| 14 | Cleanup and report | 3 min |

### 1. Pre-flight

```sh
cd /Users/timothyricks/Documents/Projects/stacki
git status --short                      # tracked changes by other agents? see section 6
git log --oneline origin/main..HEAD     # commits not yet pushed
git tag --sort=-v:refname | head -3     # last released version (also: git ls-remote --tags origin 'v*')
pgrep -fl "studio.*assemble"            # must print nothing (one Studio assemble at a time)
```

Decide the version: **last released tag + 1 patch**. Anything else needs the user.

Known flaky suites (a failure here is probably infrastructure, see section 5): `studio/test/sourceWatch`
(macOS replays events under load), `studio/test/demoAssetMap` (Windows `EBUSY` on folder removal),
`renderer/apps/appUiKitTooltip` (macOS Escape timing), the Debian install step on the Linux job
(`apt-get` fetching archive files that are gone).

### 2. CI-first gate

If earlier work already landed on `main` and was pushed, its `Check` result is the gate.

```sh
node --experimental-strip-types scripts/release/releaseStatus.mts HEAD
```

If the tip has no run yet, push it now (`git push` as in step 8's account form) and keep going with
3 to 5 while `Check` runs (about 30 minutes). Do not wait idle. If runtime code is still unpushed,
push it before drafting notes, so the wait starts as early as possible.

### 3. Release notes

Format: the newest-first sections in `docs/releases.md`. Derive them from the log, honestly and
for users:

```sh
git log --oneline v1.4.3..HEAD          # last released tag to HEAD
```

- Heading: `## 1.4.4 <short title>`.
- First bullet: `Desktop, the Studio source bundle and create-stacki are aligned at 1.4.4.`
- Then user-facing bullets (bold lead word: **Fixes**, **Style panel**, ...), then a **CI** or
  **Tests** bullet for flake fixes. Say what a person sees, not file names. If a fix was a
  regression found by the gate, say so.
- If the release only repairs an earlier one that never became public, say so (see the 1.4.1 and
  1.4.2 entries) and list what ships.
- Do not invent items, and do not drop a risky one.

### 4. Version bump

One commit, only these files, and only the version fields plus the notes:

| File | Change |
|---|---|
| `package.json` | `"version"` |
| `package-lock.json` | root `version` and `packages[""].version` |
| `packages/create-stacki/package.json` | `"version"` |
| `studio/package.json` | `"version"` |
| `studio/package-lock.json` | root `version` and `packages[""].version` |
| `studio/src/shared/release.json` | `{ "version": "1.4.4" }` |
| `docs/releases.md` | the new section from step 3 |

```sh
npm version 1.4.4 --no-git-tag-version                       # root package.json and lock
npm --prefix studio version 1.4.4 --no-git-tag-version
npm --prefix packages/create-stacki version 1.4.4 --no-git-tag-version
# then edit studio/src/shared/release.json and docs/releases.md
git diff --stat                                              # exactly the seven files above
git add package.json package-lock.json packages/create-stacki/package.json studio/package.json studio/package-lock.json studio/src/shared/release.json docs/releases.md
git commit -m "chore(release): version 1.4.4" -m "<one line: what ships>" -m "Co-Authored-By: ..."
```

`git diff --stat` must show only those files; an eighth file means stop and look. Never
`git add --all` or `-A`: other agents' work is in the tree. Do not touch the workflows or hooks.

### 5. Local checks on the bump (seconds, not a full gate)

```sh
npm run check:changed
env -u ELECTRON_RUN_AS_NODE npm test -- electron/project/studioSetup electron/project/studioLocal scripts/release/
npm --prefix studio test
```

These read the version files. All must pass. Expected: `check:changed: every changed file passes.`

### 6. Is it ready

```sh
node --experimental-strip-types scripts/release/releaseStatus.mts HEAD
```

| Verdict | Do |
|---|---|
| `READY TO TAG` | Continue. |
| `NOT READY: ... not version files ...` | Push, wait for `Check` on HEAD, re-run. |
| `NOT READY: uncommitted changes to tracked files` | The pre-push gate builds the working tree. Commit your own work; if the files belong to another agent, wait for them or ask the user. Never stash or discard theirs. |
| `NOT READY: ... check.yml failure ...` | Section 5. |
| `NOT READY: ... minor bump` / `already released` | Wrong version. Fix the bump (step 4). |
| `NOT READY: tag ... already exists` | Never move it. Next patch. |
| exit 2 | `gh` or `git` could not be read; run `gh auth status` and retry once; otherwise tell the user. |

### 7. Prechecks in parallel (while step 8 runs)

Run these in a second terminal as soon as the push starts.

```sh
export GH_TOKEN="$(gh auth token --user flowtricks)"
npm view create-stacki@1.4.4 version        # must fail E404: not published yet
gh run list --repo flowtricks/stacki --workflow publish-create-stacki.yml --limit 3 --json conclusion,createdAt
cd ../stacki-marketing-site && git status --short && git log --oneline origin/main..HEAD && npm run check
```

| Finding | Do |
|---|---|
| Last `Publish create-stacki` run succeeded | npm trusted publishing is configured. Good. |
| Last run failed | Read its log first (`gh run view <id> --log-failed`). An `E404` on PUT is the npm trusted-publisher setting; go to step 12 now, not later. |
| Marketing site has unpushed commits or tracked changes | Report it to the user. Do not push that repo. |
| `npm run check` fails there | Report; the deploy would fail the same way. |

### 8. Push `main` and the tag together

```sh
export GH_TOKEN="$(gh auth token --user flowtricks)"
git tag v1.4.4
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main v1.4.4
```

One push, so the pre-push hook runs its full gate **once** (and the Linux preflight, because the
push carries a `v<digit>` tag). Expect about 12 minutes of output. A failure stops the push and no
release starts; the tag exists only locally. Fix the finding, **delete the local tag**
(`git tag -d v1.4.4`, allowed because it was never pushed), and re-run from step 5. Never use
`--no-verify`.

Starts: `Check` on B and `release.yml` for the tag, in parallel.

### 9. Watch `release.yml`

```sh
gh run list --repo flowtricks/stacki --workflow release.yml --limit 1
gh run watch <id> --repo flowtricks/stacki --exit-status
gh run view <id> --repo flowtricks/stacki --json jobs --jq '.jobs[]|[.name,.status,.conclusion]|@tsv'
```

Jobs, in order: `draft`; then `build-mac`, `build-windows`, `build-linux` together (each runs the
whole suite, then builds and uploads to the draft); `test-linux-install` after `build-linux`;
`build-studio` after `build-linux`; `publish` last (checks every asset, then un-drafts and marks
latest, then asks the site to rebuild).

| Job | Budget |
|---|---|
| `build-linux` | 15 to 20 min |
| `build-studio` | 10 min after `build-linux` |
| `build-windows` | 25 to 35 min |
| `build-mac` | 30 to 40 min (signing, notarization) |
| `publish` | 1 min |

Check each job's result as it finishes; do not wait for the whole run to find a red one.

### 10. Dispatch create-stacki publication (parallel)

Dispatch **when `build-linux` and `build-studio` are green**, not before: they prove the Studio
bundle and the Linux tests for this tag, and the publish workflow then runs beside the slow macOS
and Windows jobs. The workflow starts with a seconds-long npm OIDC check that fails fast with
npm's own message, then runs the suite (about 15 minutes), builds and publishes.

```sh
export GH_TOKEN="$(gh auth token --user flowtricks)"
gh workflow run publish-create-stacki.yml --repo flowtricks/stacki --ref v1.4.4
gh run list --repo flowtricks/stacki --workflow publish-create-stacki.yml --limit 1
```

Trade-off, stated: if `build-mac` or `build-windows` then fail, npm holds 1.4.4 while the GitHub
release is not public (it happened with 1.4.0). That is accepted: the Studio source is the same,
npm versions cannot be republished, and the fix ships as 1.4.5. If you would rather not risk it,
dispatch after step 11 instead and accept the extra 15 minutes.

On `E404` for `PUT https://registry.npmjs.org/create-stacki`, the workflow built and tested fine
and npm refused authorization. Tell the user exactly:

> npm package settings for `create-stacki` -> Trusted Publisher -> GitHub Actions: organization or
> user `flowtricks`, repository `stacki`, workflow filename `publish-create-stacki.yml`, allowed
> action: direct publishing with `npm publish`. Save it, then say "retry" and I re-dispatch.

Do not weaken tests, bump versions to dodge it, or handle any token, password or one-time code.
The local-publish fallback in [create-stacki.md](./create-stacki.md) needs the maintainer at the
terminal for the passkey confirmation; offer it, do not run it unasked.

### 11. Verify the GitHub release

```sh
node --experimental-strip-types scripts/release/verifyRelease.mts 1.4.4 --only=release
```

Must print `VERIFY PASS`. It checks: published (not a draft), the 16 required assets (three
`latest*.yml`, mac dmg and zip for arm64 and x64 with blockmaps, the Windows exe and blockmap,
AppImage, deb, `stacki-studio-1.4.4.json`), each `latest*.yml` names 1.4.4, and every file a yml
lists exists with the same size (the sha512 values come from the same build; the helper does not
download the installers). WARN on demo assets is allowed: the demo upload is optional and the site
keeps its last copy.

### 12. npm

```sh
node --experimental-strip-types scripts/release/verifyRelease.mts 1.4.4 --only=npm --wait-minutes=15
npm view create-stacki version
```

Registry lag is normal: if npm says the package is being processed, keep the same version and
tarball, never republish, and let the helper retry (30 s steps, 15 min). If still missing after
15 minutes, inspect npm's package status and tell the user. It checks `create-stacki@latest` is
1.4.4, the tarball's version, `dist/cli.mjs` and files under `dist/demo/`.

### 13. Marketing site

stacki.build is built by `../stacki-marketing-site`'s own `deploy.yml` from **committed `main`**,
with the demo baked from the newest npm `create-stacki`. `release.yml`'s last step requests a
rebuild when the release goes public, which is usually **before npm shows 1.4.4**, so that build
may bake the old demo. Therefore, after step 12 passes:

```sh
export GH_TOKEN="$(gh auth token --user flowtricks)"
gh workflow run deploy.yml --repo flowtricks/stacki-marketing-site --ref main
gh run watch "$(gh run list --repo flowtricks/stacki-marketing-site --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --repo flowtricks/stacki-marketing-site --exit-status
node --experimental-strip-types scripts/release/verifyRelease.mts 1.4.4 --only=site --wait-minutes=5
```

Never deploy from an uncommitted working copy of that repo; never push it unasked. The live checks:
`/` is 200, `/demo/app/studio.js` is 200, `/stacki-release.txt` equals the version (the demo's
build record), and `/marketplace/admin` still answers **302 to Cloudflare Access** (a 200 there
means the admin page is public: stop and tell the user at once). A daily 06:17 UTC cron on the site
is the fallback if a deploy is missed.

### 14. Cleanup and report

- `git tag -l 'v1.4.4'` and `git status` are as expected; no stray files; no temp worktrees.
- **Tell the user to restart the dev app**: the gate's clean build deletes `dist/`, which breaks a
  running `npm run dev`.

Report format (short, bullets, the user reads only this):

```
**1.4.4 released.**
- Version: 1.4.4 (patch after 1.4.3)
- Release: https://github.com/flowtricks/stacki-releases/releases/tag/v1.4.4 (published)
- npm: create-stacki 1.4.4 (latest), dist/demo present
- Site: stacki.build built from 1.4.4; admin still 302
- Jobs: policy/ubuntu/macos/windows Check green on <sha>; release.yml all green
- Reruns: none | `build-windows` rerun once: <flake, why it is infrastructure>
- Notes: <one line on anything surprising>
- Next: restart your dev app (the clean build removed dist/).
```

## 4. Time budget

| Phase | Budget | Notes |
|---|---|---|
| Pre-flight, notes, bump, local checks, status (steps 1 to 6) | 15 min | Overlaps the `Check` wait if it was not already green. |
| Prechecks (7) | 0 extra | Run during the push. |
| Push with the pre-push full gate (8) | 12 min | One gate run, not two. Phase B can remove most of it. |
| `release.yml` (9) | 40 min | The long pole: each platform reruns the suite. Phase B removes 10 to 15 min. |
| create-stacki publish (10) | 0 extra | Runs inside step 9's tail. |
| Verify, npm, site, report (11 to 14) | 15 min | Site deploy after npm. |
| **Total, `Check` already green** | **about 65 min** | About 40 with Phase B. |
| Total if `Check` was not green when you start | add up to 30 min | Avoid by pushing `main` as work lands. |

Pushing continuously: push `main` at the end of each unit of work, not on release day. `Check`
runs only for the tip of each push, so batch the pushes sensibly. Until Phase B each push pays the
local full gate, which is why the unit of work, not each commit, is the push cadence.

## 5. If this fails, then

Decision rule first: **a clear infrastructure flake gets one `gh run rerun <id> --failed`
(`--repo flowtricks/stacki`). A real defect gets a fix, a regression test, and the next patch.**
A failure that repeats on the rerun is not a flake.

| Symptom | Likely cause | Do |
|---|---|---|
| `apt-get` cannot fetch archive files, DNS or timeout on the Linux install step | Runner image | One `--failed` rerun. |
| Runner lost, "The operation was canceled", checkout or `npm ci` network error | Infrastructure | One `--failed` rerun. |
| `studio/test/sourceWatch` once, with no code change near it | Load flake (1.2.2) | One rerun; if it repeats, real. |
| `demoAssetMap` fails with `EBUSY` on Windows | Folder removal race (1.4.2) | Already retried in the test; if it recurs, add or lengthen the bounded retry as a test fix. |
| `appUiKitTooltip` Escape check on macOS | Timing (1.4.2) | One rerun; a repeat means a bounded wait on observable state is missing. |
| A test fails only on Windows or macOS with a clear assertion | Real cross-platform bug | Section 7 rules; fix, regression test, next patch. |
| Same failure on the rerun | Real | Next patch. |
| `ELECTRON_RUN_AS_NODE`, `app` is undefined on Windows | Empty-string env (1.4.0) | `grep -rn "ELECTRON_RUN_AS_NODE: ''" test`; delete the key instead. |
| `publish` job: "missing latest-mac.yml ..." | A platform job failed or two drafts | Read the failed job; do not edit the draft by hand. |
| `Publish create-stacki`: `E404` on PUT | npm trusted publisher | Step 10's message to the user. |
| npm `latest` still old after the workflow succeeded | Registry lag | Step 12; never republish. |
| `deploy.yml` fails on type-check or build | Site bug | Report; the old site stays up. |
| `/marketplace/admin` is not 302 | Access misconfiguration | Stop; tell the user now. |
| Failure after the tag is pushed that needs a code change | Burned version | Do not move the tag. Fix, add a regression test (run only its suites plus `check:changed`), release the next patch from step 3, and say in the notes that the earlier version never became public. |
| Pre-push hook fails | Local gate found a defect | Fix it. Never `--no-verify`. Delete the unpushed local tag before retrying. |

## 6. Agents and concurrency

- One Studio assemble at a time: `pgrep -fl "studio.*assemble"` must be empty before any run that
  assembles Studio (the full gate, `release.yml` locally reproduced, `studio` verify).
- Never run the full gate while other agents edit the tree: it builds the working tree and the
  clean build deletes `dist/` under a running dev app and other agents' tests.
- Commit only your own paths with explicit `git add <paths>`. Never `-A`, `.`, `--all`, `git stash`,
  `git checkout -- <file>` or `git reset` over changes you did not make.
- Parallel subagents for independent steps (7 beside 8, 12 beside 13's prep) get disjoint files and
  the same read-only rule; gate once at the end.
- Another agent's uncommitted change makes `releaseStatus` say NOT READY on purpose. Wait or ask;
  do not clean their tree.

## 7. Cross-platform test rules (they prevent respins)

Every respin so far was a Windows or macOS assertion no Mac run could see.

| Rule | Why |
|---|---|
| Only dispatched events (`dispatchEvent`, `element.focus()`), never real pointer or hover input (`sendInputEvent`) in a test that runs everywhere. Pointer probes go in the macOS-only set. | xvfb and hidden Windows windows never deliver pointer input (1.4.1, 1.4.2). Search new tests for `sendInputEvent` before tagging. |
| Spawn Electron with `delete env.ELECTRON_RUN_AS_NODE`, never `ELECTRON_RUN_AS_NODE: ''`. | Windows counts an empty string as set; Electron runs as Node and `app` is undefined (1.4.0). |
| No POSIX-only paths: build with `path.join`, accept `\` and `/` in assertions, never hard-code `/tmp` or a `/`-only regex. | 1.2.2 failed on `src\bad.js`. After fixing a path assertion, search the whole test for the same pattern. |
| Temp-dir removal retries, bounded, on `EBUSY`, `EPERM`, `ENOTEMPTY`. | Windows holds handles briefly (1.4.2). |
| No wall-clock `sleep` before a measurement. Wait, with a stated bound, for observable state (an element, a computed style, an event). | Slow runners measure mid-motion; `npm run check:linux` warns about fixed sleeps. |
| No reliance on installed fonts, system locale or timezone. | Runners differ. |
| Every wait, retry and loop has a bound from `LIMITS` or next to the code. | AGENTS.md section 10; an unbounded wait hangs a 40-minute job. |

## 8. Lessons from past releases

| Version | What happened | Rule it made |
|---|---|---|
| 1.4.0 | Windows: two probes set `ELECTRON_RUN_AS_NODE` to `''`; the release never went public. | Delete the key. |
| 1.4.1 | Hover tooltip checks need pointer input that xvfb and Windows never deliver. | Pointer probes are macOS-only. |
| 1.4.2 | Windows `EBUSY` on `rmdir` in `demoAssetMap`; macOS Escape-hides-tooltip timing in `appUiKitTooltip`. | Bounded retries; bounded waits on state. |
| 1.4.3 | `Check` failed on Windows and macOS only after the work was done; and the gate caught a real preload bug (canvas classes listed as a declaring ancestor's project classes). | Push `main` as work lands; the gate is for real bugs, not for finding platform asserts on release day. |

## 9. What you may NOT do without asking the user

- Edit gate-defining files: `AGENTS.md`, `eslint.config.mjs`, Prettier or any `tsconfig*.json`,
  `scripts/{eslintPlugin,policy,agent}/`, `.githooks/`, `.github/workflows/`, agent configs,
  `shared/core/limits.ts`, `docs/enforcement.md`.
- Force-push, move or delete a pushed tag, delete or edit a published release, or hand-edit a draft.
- Bypass hooks (`--no-verify`, `STACKI_ALLOW_POLICY_EDITS`).
- Handle credentials: npm tokens, passwords, one-time codes, passkey prompts, signing secrets.
- Change the versioning scheme, or bump anything but the next patch.
- Push or deploy `../stacki-marketing-site` changes of your own, or deploy its uncommitted copy.
- Start a release nobody asked for.
- Publish `create-stacki` locally (the passkey step needs the maintainer).

## 10. Phase B: proposed tooling changes (not implemented)

These two change gate-defining and release-critical files (`.githooks/`, `scripts/policy/`,
`.github/workflows/release.yml`), which need the maintainer's approval, so they are designs for a
later task, not behavior today.

### B1. Skip the pre-push full gate when this exact tree already passed it

**Today:** every push runs the full clean-build gate (about 12 minutes). Pushing `main` and then
the tag, retrying a failed push, or pushing right after `npm test` runs the identical tree through
the gate again.

**Design:**

1. `npm test` (the full gate, `scripts/gate/runTests.ts`) writes a marker **only when every
   step passed**: `.git/stacki-gate-passed/<treeHash>.json` containing `{ treeHash, gateVersion,
   nodeVersion, finishedAt }`. `.git/` is untracked, per clone, and never pushed.
2. `treeHash` is the hash of the tree the gate **actually built**, not of `HEAD`: `git stash create`
   style (`git write-tree` on a temporary index built with `git add -A` of tracked and
   non-ignored files), so uncommitted edits change the hash. The gate computes it **before** it
   starts and again **after** it ends, and writes the marker only if the two are equal (a file
   changed mid-run means no marker).
3. `pre-push` computes the hash of the tree being pushed (`git rev-parse <localSha>^{tree}`)
   and **also** requires that the working tree is clean for tracked files (the gate tests the
   working tree). If `.git/stacki-gate-passed/<treeHash>.json` exists, `gateVersion` equals the
   hash of `scripts/gate/*` plus the `package-lock.json`, and the marker is newer than the lock
   and the Node version matches, it prints `pre-push: this tree passed the full gate at <time>`
   and skips the gate. Otherwise it runs the gate as today. A tag push still always runs the Linux
   preflight (about 30 seconds), because it is cheap and release-specific.
4. A missing, unreadable or malformed marker means run the gate. Fail closed.

**Why it is sound:** the gate is a pure function of the tree's contents, the lockfile, the gate's
own code and the toolchain; the marker is keyed on exactly those, so a hit means the same inputs
were already verified green by the same checks. Any edit, any rebase, any dependency or gate
change, or a different Node produces a different key and a full run. The marker is written only on
success and only after the post-run hash check, so a crash, an interrupted run, or an edit during
the run leaves nothing to match. It never crosses machines, so it cannot claim a green result that
this clone did not produce. It is not a way to skip the gate: it removes only repetition of an
identical, already-passed run.

**Not covered, by design:** the release bump commit B has a different tree than X, so it still pays
one gate run. Extending the marker to "X plus a version-only diff" is possible (the same allowlist
as `releaseStatus`) but is a weaker claim; leave it to the maintainer to decide.

**Tests:** hash stable for equal trees and different for a one-byte change; marker absent after a
failed gate; edit-during-run writes none; corrupt marker runs the gate; dirty tree runs the gate;
a tag push runs the preflight even on a marker hit.

### B2. `release.yml` skips redundant tests when `Check` already passed this SHA

**Today:** `build-mac`, `build-windows` and `build-linux` each run the full suite before building,
about 10 to 15 minutes each, repeating `Check`.

**Design:** add a first job `gate` (ubuntu, `permissions: actions: read`, uses `GITHUB_TOKEN`):

1. Query `GET /repos/flowtricks/stacki/actions/workflows/check.yml/runs?head_sha=${GITHUB_SHA}&status=completed`
   and list that run's jobs. Output `check_green=true` only if a run **for exactly this SHA** has
   `conclusion: success` **and** jobs `policy`, `test (ubuntu-latest)`, `test (macos-latest)`,
   `test (windows-latest)` are all `success` (the same required list as `releaseStatus.mts`,
   kept in one place). A missing run, a run in progress, a failure, an API error, a missing job,
   or any unexpected shape all output `check_green=false`.
2. Each build job gets `needs: [draft, gate]` and `if: needs.gate.outputs.check_green != 'true'`
   on its `npm test` step **only**. Dependency install, `npm run build`, signing, packaging,
   upload, the Linux deb and AppImage install smoke tests, `test-linux-install` and
   `build-studio`'s verify and browser test all still run.
3. The skipped steps print `Skipping the suite: Check run <url> passed this exact SHA.`

**Why it is sound:** the suite would run the identical commands on the identical commit on the same
three operating systems, so a green `Check` on that SHA is the same evidence; a lookup by
exact `head_sha` cannot be satisfied by a different commit. Everything that is specific to
releasing (the packaged app, installers, native modules, signing, installs) is not covered by
`Check`, so it is never skipped. Falling back to the tests on any doubt keeps today's behavior as
the default.

**The version bump gap:** `Check` on B only exists if B was pushed first or alone. With the single
push of step 8, B's `Check` runs concurrently with `release.yml`, so `gate` will usually see no
finished run and the tests run as today. To collect the saving, push B (and wait for `Check`)
before the tag; that costs the 30-minute `Check` wait up front. The maintainer should choose:
tag immediately and run the tests (today), or wait for B's `Check` and skip them (saves 10 to 15
minutes of a 40-minute run but costs the wait, so it wins only when `Check` on B can finish while
the notes and prechecks are being done). Cache reuse: also `actions/cache` the `npm ci` download
cache (already via `setup-node cache: npm`) and add `node_modules/.cache` for the TypeScript
incremental output keyed on `package-lock.json` and `tsconfig*.json`; it is safe because a
miss only costs time.

**Tests:** parse the workflow in `test/scripts/release/workflow.test.ts` to pin that the `gate`
job exists, that every build job still runs build, package and smoke steps, that only the
`npm test` steps are conditional, and that the condition falls back to running them.
