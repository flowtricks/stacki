# Release runbook

Releasing Stacki (Desktop, the Studio bundle, `create-stacki`, the stacki.build demo) is a button.
Every step after the click is a tested script (`scripts/release/`); the workflows only order them.
No agent and no tokens are needed unless a release fails for a real reason (section 3).
[releases.md](./releases.md) is the history; [create-stacki.md](./create-stacki.md) is the npm detail.

**Target: about 30 minutes from the click to live**, when `Check` is already green on `main`.

## 1. One-time setup (the maintainer, once)

The controller checks each item itself and refuses a real run, with the exact fix, until it holds.
A dry run works without any of them and lists what is missing as warnings.

| # | Set up | Click path | How the controller checks it |
|---|---|---|---|
| 1 | Environment **`release`** with **you as required reviewer** | github.com/flowtricks/stacki > Settings > Environments > New environment > `release` > tick **Required reviewers** > add yourself > leave **Prevent self-review** unticked > Deployment branches: **No restriction** (or Selected: `main`) > Save protection rules | Preflight, approve and tag stages read `GET /repos/flowtricks/stacki/environments/release`. Missing, or no reviewer: `environment-missing` / `environment-unprotected`. GitHub would otherwise create an unprotected `release` environment on first use, which stops nothing. |
| 2 | Secret **`RELEASE_PUSH_TOKEN`** | github.com/settings/personal-access-tokens > Fine-grained token > Resource owner `flowtricks` > Only select repositories: `flowtricks/stacki` > Repository permissions: **Contents: Read and write** (Metadata: read is added for you) > Generate. Then the repo > Settings > Secrets and variables > Actions > New repository secret > `RELEASE_PUSH_TOKEN` | Preflight sees only whether it is set (`secrets.RELEASE_PUSH_TOKEN != ''`), never its value: `push-token-missing`. Needed because pushes with `GITHUB_TOKEN` do not start `release.yml`. |
| 3 | Secret **`RELEASE_DISPATCH_TOKEN`** (optional) | Same token page > only `flowtricks/stacki-marketing-site` > **Actions: Read and write** > Generate > save as repository secret `RELEASE_DISPATCH_TOKEN` in `flowtricks/stacki` | Release post's `deploy-site` stage. Absent: a warning, the site updates by itself (release.yml's rebuild request and the site's daily 06:17 UTC check), and the final verify leaves out the site rows. |
| 4 | npm trusted publisher stays registered | npmjs.com > create-stacki > Settings > Trusted Publisher > GitHub Actions: `flowtricks` / `stacki` / `publish-create-stacki.yml`, direct publishing allowed | The publish workflow's first step exchanges its OIDC token in seconds; a refusal fails with npm's message, and Release post's summary says so. |
| 5 | `main` accepts the release push | Today `main` has no branch protection or rulesets, so nothing to do. If you add protection later, add the token's owner to the bypass list for "Restrict pushes" and keep "Require status checks" off for direct pushes | The tag stage reads `main` and the tag back from origin after its push (`push-readback`). |

## 2. The daily flow

Pick one:

- **GitHub:** Actions > **Release button** > Run workflow. Untick **Dry run** for a real release. Leave **Version** empty (the next patch is computed).
- **gh:** `gh workflow run release-go.yml --repo flowtricks/stacki -f dry_run=false`
- **Local:** `node --experimental-strip-types scripts/release/releaseGo.mts` (dry run), then `... --confirm 1.4.4` (the version it printed). This pushes from your clone, so the pre-push hook runs; it is the slower path (section 5).

Run a dry run first whenever something changed in the tooling: it prints the exact files, notes and commit.

| Stage | What it does | Time |
|---|---|---|
| `preflight` | Tip of `main` is green (`Check` on it, or on an ancestor with only version files and `docs/releases.md` changed since); next version = last tag + 1 patch; tag absent; environment and token present. Summary table, or **NOT READY** with one next step. | 1 min |
| `approve` | Waits for your click: the run's page shows **Review deployments** > tick `release` > **Approve and deploy**. | your click |
| `prepare-and-tag` | Refuses if `main` moved since preflight; writes the version into the six files, reads each back, adds the generated notes, commits `chore(release): version X.Y.Z`, tags it, pushes `main` and the tag in **one atomic push**, reads both back. Dry run: prints the plan and stops. | 1 min |
| `release.yml` | `plan` waits (at most 45 min) for `Check` on the bump commit; builds, signing, packaging and install tests run beside it. Green `Check` on that exact commit: the suite is not run again. Anything else: the `tests` job runs it on all three platforms, as before. `publish` needs both. | about 15 min (Check sharded ~12, mac signing ~11) |
| `Release post` | Dispatches `publish-create-stacki.yml` (which also skips the suite on the same proof), waits for npm (30 s retries, 30 min max), dispatches the site deploy, then runs `verifyRelease`: the PASS/FAIL table is the job summary. | about 10 min |
| **Total** | | **about 30 min** (25 to 35) |

Reading the result: the last job of **Release post** (`summary`) lists every stage with links to the
release, npm and the site. Green everywhere means live. `Check` itself is faster now too: four shards
per platform (`npm test -- --shard=k/4`) plus a desktop static-checks job (`--checks=desktop`) and a Studio verify job (`--checks=studio`) per platform,
aggregated into the same `test (<os>)` job names.

## 3. If it fails

Failures in `release.yml` go to **Release post > rerun-policy**, which decides by rule:
every failed job matches a known infrastructure flake (`scripts/release/knownFlakes.mts`) on the
first attempt: **one** rerun of the failed jobs, then the chain continues by itself. Anything else
stops with the reason and the next step. Tags are never moved, deleted or recreated by any script.

| Symptom (where you see it) | Single next step |
|---|---|
| Preflight `not-green` | Wait for `Check` on that commit to finish green, or fix the red run; click again. |
| Preflight `environment-*` / `push-token-missing` | Section 1, items 1 and 2. |
| Preflight `tag-exists` / `bump-*` | Leave Version empty; never move a tag. |
| Tag stage `main-moved` | Someone pushed meanwhile. Click again. |
| `plan` says "running the suite" | Not a failure: `Check` was not green on the exact commit in time; the release just takes longer. |
| Release post: "rerun passed" | Nothing: the chain restarted for the green run. |
| Release post: "stopped" with a failed job | **The one place an agent helps:** give it the failing run URL and this runbook. It fixes the cause with a regression test (AGENTS.md), and you release the next patch with the button. |
| Release post: `publish-failed` with E404 | npm trusted publisher (section 1, item 4), then Actions > Release post > Run workflow with `release_run_id` = the Release run id. |
| npm still old after 30 min | Registry lag; do not republish. Run Release post again with the same run id later. |
| Site deploy failed / site rows FAIL | The old site stays up. Fix the site repo; its daily build or a manual `deploy.yml` run picks the version up. A `/marketplace/admin` that is not 302: tell the maintainer at once. |
| Pre-push hook fails (local path) | Fix the finding. Never `--no-verify`. Delete the never-pushed local tag (`git tag -d vX.Y.Z`). |

A failure after the tag that needs a code change burns that version: fix forward, next patch, and
say in the notes that the earlier version never became public.

## 4. Manual fallback (only if the scripts themselves are broken)

From a **fresh clean clone** of `flowtricks/stacki` (never the shared working copy), as `flowtricks`:

```sh
node --experimental-strip-types scripts/release/releaseStatus.mts HEAD     # READY TO TAG, or why not
node --experimental-strip-types scripts/release/prepare.mts --dry-run       # the plan; then without --dry-run
git tag vX.Y.Z HEAD
GH_TOKEN="$(gh auth token --user flowtricks)" git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --atomic origin HEAD:refs/heads/main refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
# release.yml starts; when it is green, Release post starts. If it does not:
gh workflow run release-post.yml --repo flowtricks/stacki -f release_run_id=<Release run id>
node --experimental-strip-types scripts/release/verifyRelease.mts X.Y.Z --wait-minutes=15
```

If even `prepare.mts` is unusable: bump the six files of `scripts/release/versionManifest.mts` by
hand, add the `docs/releases.md` entry, commit `chore(release): version X.Y.Z` with only those seven
paths, then continue from `git tag`.

## 5. The pre-push marker

`npm test` (full, unsharded) writes `.git/stacki-gate/<tree>.json` after it passes, keyed by the git
tree hash of the working tree it built (tracked files plus untracked, non-ignored files), taken
before and after the run. `git push` skips the full gate when **every** pushed commit's tree has a
marker from the same gate version, or when the push is only a tag on a commit that `origin/main`
already holds and `Check` passed (checked through `gh`). The static checks (`npm run check:local`:
types, ESLint, Prettier, policy scan, Studio) always run, and a release tag runs the static Linux
preflight. Otherwise the full gate runs as before.

| Invalidates the marker | Why |
|---|---|
| Any change to a tracked or untracked, non-ignored file | Different tree hash. |
| A file edited while the gate ran | Start and end hashes differ: no marker is written. |
| Another Node version, OS or CPU, or a new marker format | The gate version string (`stacki-gate-marker/1 node-vX darwin-arm64`) differs. |
| A failed, sharded or named-suite run | Only a passing full run writes one. |
| A missing, unreadable or malformed file | Fails closed: the gate runs. |

The bump commit always has a new tree, so the **local** button still pays one full gate on its push;
the GitHub button pushes from CI, where no hook runs and `Check` is the gate.

## 6. Rules that remain

- **Patch versions only**: 1.4.3 -> 1.4.4. A minor or major needs the maintainer to say so; the
  workflow's `allow_minor` input exists only for that, and it still refuses a skipped number.
- **Never** move, delete or recreate a pushed tag; never force-push; never `--no-verify`.
- **Release freeze**: no other agent working and no uncommitted files in the repository while a
  local release runs (preflight refuses tracked changes). The GitHub button is immune: it releases
  the exact pushed tip.
- **Cross-platform test rules** (every respin so far was a Windows or macOS-only assertion):
  dispatched events only (pointer probes are macOS-only); delete `ELECTRON_RUN_AS_NODE`, never set
  it to `''`; `path.join` and both separators in assertions; bounded retries on `EBUSY`/`EPERM`/
  `ENOTEMPTY`; wait for observable state with a bound, never a fixed sleep; no reliance on fonts,
  locale or timezone; every wait and loop bounded.
- **Rules for new tests** (each one is a CI failure that passed locally): never read the DOM
  straight after an action; wait for the state the check is about with `pollUntil`/`waitFor` from
  `test/helpers/waitFor.js` (bounded, 50 ms polls, a message with the last value seen), never a
  fixed sleep. Syntax highlighting and CodeMirror's syntax tree can finish after a mount or an edit
  (a per-update parse budget, then an idle callback): wait for the token marks or for
  `syntaxTreeAvailable` before checking colours or anything built from the tree. Popups scale open
  and fade out: wait for `MOTION_SETTLED_EXPRESSION` before measuring one, and for it to be gone
  before the next step. A resize, scroll or wheel event can land frames after the call that caused
  it and close a popover: wait for the event itself (or the scroll position to hold still), not
  just the new size. Keys go to the focused page: call `webContents.focus()` before sending them,
  since a hidden window is not focused by itself. Wait for `:hover` to arrive after a pointer move
  before the next move. A probe whose page script throws must exit with the error
  (`unhandledRejection` → `app.exit(1)`), not hang until the spawn bound. Under load,
  `npm run check:linux -- --only=<suite>` replays a probe with Linux-runner frame delays.
- **No token-shaped literals in tests**: never write a complete token-shaped literal in a test
  (GitHub push protection blocks the push); assemble fake tokens at run time.
- **Known flakes**: add a signature to `knownFlakes.mts` only with its own regression test in
  `test/scripts/release/rerunPolicy.test.ts` (a matching excerpt and a near miss).
- **Credentials**: nobody pastes tokens into chat or code; the scripts only test that secrets exist.
- One Studio assemble at a time locally (`pgrep -fl "studio.*assemble"` empty before a full gate).

## 7. Lessons that shaped this

| Version | What happened | Rule |
|---|---|---|
| 1.4.0 | Windows: `ELECTRON_RUN_AS_NODE: ''` made Electron run as Node. | Delete the key. |
| 1.4.1 | Hover tooltip checks need pointer input xvfb and Windows never deliver. | Pointer probes are macOS-only. |
| 1.4.2 | Windows `EBUSY` on `rmdir`; macOS Escape timing in `appUiKitTooltip`. | Bounded retries; both are known flakes now. |
| 1.4.3 | Three hours of agent-driven steps; `Check` failed on two platforms after the work was done. | The button: tested scripts, one approval, `Check` as the gate. |
