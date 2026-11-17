# Release runbook

```sh
npm run release:ship                 # where the release stands, and the next step; writes nothing
npm run release:ship -- --confirm    # every next step until live, or a stop with the reason
```

That is the whole process. Run it from any clone, any working tree state: it reads and writes
GitHub only. Stop it any time (Ctrl-C) and run it again; it resumes where the release is.
Why it is built this way, with measurements: [release-speed.md](./release-speed.md).
History: [releases.md](./releases.md). npm detail: [create-stacki.md](./create-stacki.md).

## 1. What it does

| Step | When | What | Time |
|---|---|---|---|
| bump | the version on `main` is public | A GitHub commit `chore(release): version X.Y.Z` (next patch) on top of `origin/main`, fast-forward only | 1 min |
| wait | Check or Candidate running | One line a minute; at minute 5 a forecast (a job without a runner is the risk) | 20 to 45 min |
| rerun | a job failed with a known infrastructure signature, first attempt | `gh run rerun --failed`, once | |
| tag | Check **and** Candidate green on the exact SHA | Creates `vX.Y.Z` on that SHA | seconds |
| promote | tag exists | release.yml proves the candidate, downloads its artifacts, checks them, uploads, publishes | 5 to 10 min |
| post | public | Release post: npm `create-stacki`, the site, verify | about 10 min |

Candidate builds start by themselves on every push to `main` while its version is unreleased, so
bumping early makes the release moment short: **green HEAD to live in under 15 minutes.**

## 2. When it stops

| It says | Do |
|---|---|
| `STOPPED: Check: ... failed` or `Candidate: ...` | Real failure. Give an agent the URL; it fixes it on `main` with a regression test. The version stays; run the command again. |
| `forecast: AT RISK, n job(s) still waiting for a GitHub runner` | Nothing; GitHub capacity. It keeps waiting; an unacquired job is rerun once. |
| `promoting vX.Y.Z failed twice` | Open the run; nothing was rebuilt, so it is an upload or a token. Fix, then `gh run rerun <id> --failed --repo flowtricks/stacki`. Never move the tag. |
| `release.yml did not start within 3 minutes of the tag` | Check Actions for a Release run on the tag; run the command again. |
| `main could not be fast-forwarded` | Someone pushed meanwhile; run again. |
| `Release post ended failure` | Desktop is live. The post summary names the stage (npm, site, verify) and its one step (section 4). |

## 3. Rehearse (nothing reaches users)

- Actions > **Candidate** > Run workflow, rehearsal ticked (the default): builds, signs, notarizes
  and smoke-tests any branch or commit. Its title says "(rehearsal)"; it is never promoted.
- Actions > **Release** > Run workflow with `tag` = the version that commit carries and `sha` = the
  commit: a dry run. It proves Check and the candidate, downloads and checks every file, and stops
  before any upload. Release post ignores it.

## 4. Rules

- **Patch versions only** (1.4.7 -> 1.4.8). A minor or major needs the maintainer.
- **Never** move, delete or recreate a tag; never force-push; never `--no-verify`.
- The tag exists only after Check and Candidate are green on its commit, so a test can no longer
  burn a version. A burned old-process tag (tagged, never public) is skipped, never reused.
- **Known flakes** (`scripts/release/knownFlakes.mts`): one rerun, first attempt only. Add one only
  with its regression row in `test/scripts/release/rerunPolicy.test.ts`.
- **Cross-platform test rules**: `path.join` and both separators in assertions; delete
  `ELECTRON_RUN_AS_NODE`, never set it to `''`; bounded retries on `EBUSY`/`EPERM`/`ENOTEMPTY`;
  wait for observable state with `pollUntil`/`waitFor` (`test/helpers/waitFor.js`), never a fixed
  sleep; no fonts, locale or timezone; pointer probes are macOS-only; no token-shaped literals.
- Credentials: nobody pastes tokens into chat or code; `gh` must be signed in as `flowtricks`.
- Release post failures: npm E404 is the trusted publisher (npmjs.com > create-stacki > Settings >
  Trusted Publisher: `flowtricks` / `stacki` / `publish-create-stacki.yml`), then Actions > Release
  post > Run workflow with the Release run id. npm lag after 30 minutes: run Release post again
  later, never republish. A failed site deploy leaves the old site up.

## 5. Manual fallback (only if the scripts are broken)

From a fresh clone, as `flowtricks`, with Check and Candidate green on the commit:

```sh
node --experimental-strip-types scripts/release/promote.mts --sha=<sha> --tag=vX.Y.Z --dry-run=true   # the proof
gh api --method POST repos/flowtricks/stacki/git/refs -f ref=refs/tags/vX.Y.Z -f sha=<sha>
node --experimental-strip-types scripts/release/verifyRelease.mts X.Y.Z --wait-minutes=15
```

The old local path (`releaseGo.mts`, `prepare.mts`) still works and still runs the pre-push gate.
