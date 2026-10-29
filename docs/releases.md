# Releasing Desktop, Studio, and create-stacki

These are separate publication paths. A successful `Check` run publishes nothing:

- A version tag starts `.github/workflows/release.yml`. Desktop installers, Linux install checks,
  and the Studio browser test must finish before the draft release becomes public.
- `.github/workflows/publish-create-stacki.yml` is manually dispatched from the same tested tag.
  See [create-stacki publication](./create-stacki.md) for authentication and registry verification.

Run the fast checks and complete regression suite locally before pushing. Also run Studio's
`npm run verify` and `npm run test:browser` against a disposable fixture workspace before tagging:
the Desktop regression gate does not run that separate Studio browser scenario.

Use an isolated checkout when other tasks are editing the working directory. Match the root,
Studio, Studio release manifest, and npm starter versions. Never move an existing release tag to
include later changes.

## 0.1.91 project settings

Opening a project without saved guide preferences now uses in-memory defaults without creating
`.stacki/guide.json`. The first guide edit still saves the file, and readable legacy preferences
still migrate. Missing, corrupt and inaccessible browser storage do not create a defaults file.

Settings saves remain independent: slot component defaults, publish destinations and scripts,
page order and component sources create their own `.stacki` files when first saved. Desktop and
Studio read and write `.stacki/publish.json`; credentials remain in host authentication storage.
Regression tests exercise first saves without a metadata directory, named-slot insertion,
stale-write protection and publish settings exchanged between the actual Desktop and Studio hosts.

PR 66's Windows failure was the creation-event watcher assertion already corrected in 0.1.89.
Updating the branch from main retains that regression fix and the removed variables-panel probe.
Desktop, Studio and the starter are aligned at 0.1.91.

## 0.1.90 release validation

At the user's request, remove the variables-panel layout probe because its visible Electron
window interrupts local work every time the full regression gate runs. Other variables-panel
unit and integration tests remain. The removed probe's row-alignment, scroll and hit-testing
measurements are no longer covered by that browser test; application behavior is unchanged.

The 0.1.89 release run was canceled before publication to include this removal. Its tag remains
unchanged. Desktop, Studio and the starter are aligned at 0.1.90.

## 0.1.89 release validation

The 0.1.88 Windows gate caught a watcher test that assumed creating a file only emits `add`.
Windows also emitted `change` before the file was removed. Replaying the recorded event trace
reproduced the assertion locally. The test now accepts creation writes only between the new
route's add and unlink events; fixtures reject missing, reordered, unrelated and staging events.
The real-watcher test still requires one atomic-save event and preserves project ignore rules.

A native Windows runner is unavailable locally; the hosted Windows gate remains required.
Release 0.1.88 stays an unpublished draft with its original tag. Version 0.1.89 aligns Desktop,
Studio and the starter and includes the Mac packaging changes below.

## Separate Mac architectures

Mac releases produce `Stacki-VERSION-arm64.dmg` and `Stacki-VERSION-x64.dmg`, plus
matching `.zip` archives and blockmaps. Architecture-specific Electron binaries avoid the
compressed universal binary's mid-file signature changes; download savings must be measured
between consecutive signed builds with the same Electron version, not promised in advance.

Keep the app ID, signing identity and GitHub feed unchanged. One `latest-mac.yml` lists both
architectures; the metadata step rejects a missing ZIP or DMG before the draft can publish.
The existing updater selects ARM on Apple Silicon (including Rosetta) and x64 on Intel.
The migration may fall back to a full download if the old archive or blockmap cannot be reused.

Local regressions exercise the installed updater's architecture filter, per-target terminal
binaries, and dual-architecture metadata. Before publishing the first split release, verify
signed universal-to-native installation on Intel and Apple Silicon, including a Rosetta launch.
Unsigned packaging cannot verify Squirrel.Mac signature acceptance or notarization.

The marketing site's `/download/mac` selects ARM and `/download/mac-intel` selects Intel.
Both can use an older universal DMG until split assets are published. Browser CPU hints select
the button automatically; browsers without them show a choice because `MacIntel` and Intel UA
strings also occur on Apple Silicon. The website never substitutes the opposite-CPU installer.

## 0.1.87 startup correction

The live 0.1.86 cold-start check found that Git restoration checked out the baseline a second
time, hydrating every blob in its partial clone. Bootstrap now retains the already-restored
files when the active Git target equals that baseline. Divergent branches and unpublished drafts
still restore before CRDT updates. A real Git regression checks both paths, including an absent
object store to prove the identical-baseline path cannot download repository blobs.

## 0.1.86 release validation

The 0.1.85 Windows gate caught a test that expected `chmod(0755)` to set an executable bit.
Windows does not expose that POSIX mode change, so the assertion failed even though source
comparison correctly retained the regular-file mode. The replacement test checks remote mode
changes on every platform and actual executable-bit changes on POSIX. All other new Git
workspace tests passed on Windows. A native Windows runner is unavailable locally; the hosted
Windows gate remains required before publication. The original 0.1.85 tag remains unchanged.

A live rollout check also exposed Git status hydrating partial-clone blobs for file sizes.
Status now reads only paths, modes and hashes; a real partial-clone test disconnects its remote
and verifies that status succeeds without downloading the missing repository blobs.

Version 0.1.86 retains the updates below and aligns Desktop, Studio and create-stacki.
The 0.1.85 npm workflow passed all tests and packaging but npm rejected its publishing
identity with E404; no 0.1.85 package was published. npm remains a separate authorization step.

## 0.1.85 updates

- Studio uses Desktop's Git controls for commits, partial commits, pulls, branches and merge
  review. One container keeps one shared checkout: changing branches affects every editor.
  Durable Git checkpoints preserve unpublished commits and parked drafts across restarts;
  replacement document namespaces reject stale edits from an older checkout.
- Panel loading uses compact skeletons without visible loader labels. Catalogs, Git history,
  component counts and font thumbnails reuse bounded caches and refresh in the background.
  Assets initially open images when available, then assets, and retain later navigation.
- Publishing exposes its progress, favicon activity and published-site link, improves status
  checks, and protects active operations from idle shutdown. Component focus, collection
  overlays, active-page styling and preview controls match the shared Desktop behavior.
- Desktop, the Studio source bundle and the npm installer share version 0.1.85.

## 0.1.84 release validation

This release retains the application updates below and corrects the Linux installation probe.
The 0.1.83 Linux regression suite passed, but its packaged-app smoke test still called
`terminal:start` without the dimensions required by the terminal startup update. Publication
stopped before the draft became public; the 0.1.83 tag remains unchanged.

A local regression executes the actual generated renderer probe against the shared IPC parser.
It reproduced the same `Expected number` error, then passed after the probe supplied an 80-column,
24-row startup grid. A typed fixture now checks required IPC fields during compilation, and the
runtime test checks startup, command output handling, and cleanup. Native packaged Linux terminal
verification remains required in the hosted installation checks.

Desktop, the Studio source bundle, and the npm installer are aligned at version 0.1.84.

## 0.1.83 release validation

This release contains the 0.1.82 updates below with corrected cross-platform test setup.
The 0.1.82 Desktop release remained unpublished after Linux failed three scrollbar assertions;
its npm installer had already published successfully. The existing tag remains unchanged.

The failure reproduced in a local Linux container with Electron's sandbox enabled. An unmapped,
hidden BrowserWindow delayed native scroll and ResizeObserver notifications. Disabling background
throttling alone did not fix it. The layout probe now maps its window without taking focus and
waits for bounded, measured synchronization instead of short sleeps. All 36 original assertions
pass on Linux and macOS. Application behavior is unchanged by this test correction.
Windows reported the same three failures. A local Windows runner is unavailable, so the hosted
Windows regression gate remains required to confirm the fix there before publication.

Versions were aligned at 0.1.83, but the packaged Linux check described above stopped publication.
The npm installer remained at 0.1.82.

## 0.1.82 updates

- Variables open in a dockable, resizable window. Group menus remain clickable above the window,
  and the shared horizontal scrollbar aligns with the values on Desktop and mobile Studio.
- Editor side panels resize and remember their bounded widths. Asset grids add thumbnail columns
  as the panel widens and keep sparse folders compact.
- Sibling placement works inside repeated markup containers while preserving source structure.
- Terminals start with their measured dimensions, avoiding an incorrectly sized first shell prompt.
- Preview element lookup targets matching paths, and attribute changes avoid unnecessary page
  reports while structural changes still refresh the page.
- The welcome background limits resolution and frame rate, pauses when inactive, and uses a
  static fallback for reduced motion or constrained devices.
- Desktop, the Studio source bundle, and the npm installer share version 0.1.82.

## 0.1.81 updates

- Collaborative edits continue reaching peers during slow saves. Source and draft writes are
  batched, while save confirmations and publishing still wait for persistence.
- Preview rendering avoids duplicate work, preserves newer text while older renders arrive,
  and recovers more reliably from disconnects and delayed startup.
- Desktop and Studio share source-preserving structural edits and faster component usage scans.
  Atomic staging files no longer trigger unnecessary Astro route rebuilds.
- Assets, CMS and Variables retain loaded content between visits and distinguish loading from
  empty results. Studio adds the shared Git history graph and file diffs.
- Collaboration locks appear in element settings with the editor's avatar. Connection status
  replaces the Draft badge; loading counts and sign-in rate limits provide clearer feedback.
- Cloud rendering remains dependent on project work and container capacity. These changes do
  not promise instant rendering on every project or add independent per-editor Git branches.

### 0.1.80 release validation

The 0.1.80 release stopped before publication when cross-platform checks exposed two races in
the new watcher regression. Vite can emit `ready` before `createServer` returns, and its watcher
coalesces rapid changes to the same file. Waiting for the missed event stalled Linux and one
macOS run; expecting a second immediate event failed Windows.

The stall reproduced in a local Linux container. The test now checks the public watched-file
inventory with a bounded wait and uses a separate existing file for the outside-edit case.
Canonical temporary paths also account for macOS symlinks. It still checks atomic rename,
staging-file ignores, project ignore rules, outside edits, and route addition/removal. The
replacement release is 0.1.81; the original tag remains unchanged for diagnosis.

## 0.1.79 updates

- New Astro and Lumos projects let you choose npm or pnpm. Stacki checks that the chosen
  manager is installed before creating the project and includes its lockfile in the first commit.
- Selected starter templates use a white background with dark text and preserve their spacing.
- Desktop, the Studio source bundle, and `npm create stacki@latest` share version 0.1.79,
  including the editable merge review and Windows merge fixes from 0.1.78.

### 0.1.79 browser failure investigation

The first hosted Studio browser run failed after leaving interactive preview: Astro's
`Unhandled rejection` overlay added another heading, so Playwright correctly refused the
ambiguous selector. The log captured the overlay title but omitted its error message and stack;
it does not establish the underlying cause. All Desktop platform gates and installers passed.

The exact release passed locally with the installed Chrome and with the same Chromium version
used by CI. Four additional runs, each with a new draft workspace and server, also passed.
This macOS reproduction cannot establish why the Linux runner showed the overlay. A rerun of
the unchanged tagged Studio job must still pass before the draft can become public.

Future browser failures now log bounded preview error messages and stacks alongside the editor
inspector and browser errors. The assertions, selectors, and timeouts remain unchanged; an error
overlay must not be hidden by narrowing the heading selector. These diagnostic-only test changes
do not change the tagged application or its published npm package.

## 0.1.78 updates

- Merge review now opens in a wider, editable final-code view. Branch-colored highlights show
  where each change came from, with independent choices for text and attributes, manual overrides,
  and undo/redo. Automatic merging still combines compatible edits; stale reviews are rejected
  before they can overwrite newer work.
- Branches have distinct colors throughout the branch list, commit destination, and history graph.
  Commit controls clearly identify the destination branch while the graph preserves real ancestry.
- Merge confirmation has cleaner spacing and shorter copy.
- Content fields preserve the caret when deleting spaces, so Backspace continues editing where
  expected instead of jumping to the beginning.

### 0.1.77 release validation

The 0.1.77 release was stopped before publication after Windows CI exposed CRLF conflict markers
being treated as ordinary source. A local reproduction with `core.autocrlf=true` failed the same
real-Git merge test. The parser now accepts CRLF marker endings while retaining source line endings;
regression checks cover both Git conversion modes, exact output, and unclosed markers.

An Ubuntu check also read a popup before its exit timer removed it. The browser probe now waits
for bounded popup presence/removal instead of assuming a fixed sleep is enough. This scheduler
race did not reproduce locally; the strengthened probe passes locally and still runs in CI.
The replacement is 0.1.78; the existing 0.1.77 tag and unpublished draft are retained for diagnosis.

## 0.1.76 updates

- Astro `.map()` callbacks recognize async, function, block, typed, destructured, and referenced
  forms while preserving source and exposing their markup as editable elements.
- Optional content fields use blue reset labels: Option-click to clear, or click and choose Reset.
- Project startup shows one loading indicator while dependencies and the preview are starting.
- [PR #54](https://github.com/flowtricks/stacki/pull/54): Project dependencies and Cloudflare's
  Wrangler install use the site's package manager, preferring `package.json` over its lockfile.
  Cancelling Cloudflare sign-in lets installation finish, and pnpm installs tolerate blocked
  dependency build scripts while keeping those scripts blocked. The sign-in dialog keeps one
  screen through installation, browser sign-in, and retry.
- [PR #55](https://github.com/flowtricks/stacki/pull/55): Start from Astro now asks where the site
  should go, then lets you name it and preview its folder, matching Start from Lumos. Both flows
  share name validation and improved label spacing. Failed Astro creation removes its new folder
  only when it is still empty, so retrying the same name works without deleting generated files.
- The welcome screen uses folder, GitHub, Lumos, and Astro icons with concise action labels.
  Dropdowns expand from their buttons as one white surface and animate closed before opening
  the next dialog, with reduced-motion support.

## Learn from publishing failures

Whenever a GitHub release or publishing workflow fails, inspect the failure before retrying.
Reproduce the cause locally whenever possible, then add or improve a local regression test that
fails for that cause and passes after the fix. Run the regression test and the required local
release checks before pushing again. Include the regression coverage in the fix so future releases
catch the same problem before reaching GitHub.

Match the conditions that caused the failure: a clean checkout, the Git hook environment, the
affected operating system, or the packaged installation. Prefer deterministic reproduction over
repeated retries, longer timeouts, or weakened assertions. For timing failures, synchronize on the
actual event or inject the failing condition instead of relying on a lucky test run.

Some failures depend on external services, signing, authentication, or hosted runner infrastructure.
When a local test cannot reasonably reproduce the cause, document why, record the verification
that is possible, and keep the required remote check. Never skip a gate to make publishing succeed.

## Browser tests and animated popups

Shared popups remain mounted while their close animation runs, and consume outside clicks during
that time. After closing a popup, wait for that popup to detach before clicking another control.
Do not use an arbitrary sleep or weaken the assertion.

In the 0.1.64 release, the Studio browser scenario closed the account menu and immediately clicked
`Expand all`. The closing popup consumed that click, leaving the navigator collapsed. The test
then timed out looking for Heading, even though the component existed. Waiting for
`.account-popover` to detach fixed the scenario.

## 0.1.64 recovery record

The tested release tag points to `6903fb2825006cd79eff99bfbacae2fd51a3b38c`. All three platform
builds, Linux installation checks, and Studio's compilation, lint, formatting, and unit tests passed
in GitHub Actions. The browser scenario reproduced locally against that exact source. After the
test-only popup wait was added, the complete browser scenario passed against the same release.

The existing Desktop installers were preserved. The Studio bundle built from the tested tag was
uploaded, all platform update metadata and installer assets were verified, and the draft was
published as the latest release. No application code or published version tag was changed.

The npm workflow separately failed authentication after passing its tests and building the package.
The maintainer authenticated a local publication of the exact-tag package after a fresh installation
smoke test. The registry's package checksum matched the tested tarball, and both `dist-tags.latest`
and the downloaded CLI reported 0.1.64.

The original failed workflow runs remain red; publishing manually does not rewrite their history.
Confirm live availability through the latest GitHub release and npm registry, rather than inferring
it from workflow badges. Do not bypass an unresolved application failure to publish a draft.
