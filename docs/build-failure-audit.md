# Desktop build failure audit — October 22, 2026

## Scope and method

Reviewed all 188 GitHub Actions runs returned for `flowtricks/stacki`, from April 6 through
October 22, 2026. Of 66 failed runs, 52 still supplied nonempty failed-job logs. Thirteen logs
were unavailable and one returned no failed-job output. Those runs are not assigned a cause.
Counts below are failed **runs**, not failed matrix jobs, distinct bugs, or release attempts.
Categories overlap; a Check and a Release run of the same revision count separately.

The ranking uses concrete error signatures in the available logs and the corresponding fixes.
It does not infer an application failure merely from a red workflow or a cancelled job.

## Recurring causes and local coverage

| Cause | Failed runs | Local coverage |
| --- | --- | --- |
| Linux Electron sandbox setup | 18 | New workflow setup/order checks |
| Windows paths and filesystem assumptions | At least 8 | Existing path and file protocol tests |
| Timing-dependent browser/retry assertions | 7 | Existing synchronized retry/browser tests |
| Incomplete dependency lockfiles | 5 | New dependency graph and clean-install checks |
| Signing configuration | 2 | Existing Mac signing test; new Windows config guard |
| Extracted AppImage launch environment | 1 | New APPDIR ordering check |
| Windows checkout line endings | 1 confirmed | New LF checkout rule check |

The Windows count covers path, cleanup, and image-conversion signatures. Additional older
filesystem tests also failed. The timing count covers terminal lifecycle, save recovery, and
Studio navigator timeouts. Actual NTFS behavior still needs Windows.

### Linux sandbox: the largest repeat failure

Electron aborted with `The SUID sandbox helper binary was found, but is not configured correctly`.
This caused many unrelated browser suites to fail together. The Linux jobs needed to assign
`chrome-sandbox` to root and set mode 4755 after `npm ci`, then run tests under Xvfb.
Examples: [October 4][sandbox-first] and [October 13][sandbox-last].

The new `workflow` suite reads both actual YAML workflows. It rejects removed setup, setup placed
after the test command, and setup guarded for the wrong operating system. It also checks the
virtual-display command. This catches configuration regression on a Mac without pretending to
exercise Linux's kernel sandbox. Existing `linuxInstaller` tests check the Debian installer.

### Windows: normalize paths and synchronize observable events

The [Worker configuration failure][worker] came from passing backslashes into TypeScript's JSON
diagnostics. The existing `publishWorkerConfig` test now passes Windows paths even on macOS.
Earlier [Studio failures][studio-windows] included project-path rejection; the subsequent
[cleanup failure][cleanup] exposed deleting a workspace before its content runner had exited.

The [save recovery failure][save] and [terminal lifecycle failure][terminal] relied on when a
slow runner completed work. Existing tests now hold the retry response explicitly and control
animation frames. The [Studio browser release failure][browser] similarly required waiting for
the account popup to detach before clicking the navigator. Keep the separate Studio browser
scenario in the release checklist in [releases.md](releases.md).

The local focused command below includes these existing tests. No new sleeps, retries, skipped
assertions, or relaxed timing thresholds were added by this audit.

### Lockfiles: a warm installation can hide a broken clean build

The [0.1.52 release][wasm] and [later dependency update][wasm-again] lacked native/WASM dependency
entries. The [0.1.61 publishing job][windows-sign] lacked `@electron/windows-sign` and its
dependencies. Different npm versions did not agree about accepting these incomplete locks.

The new `lockfileClosure` suite checks the root, Studio, and Studio browser-fixture lockfiles.
It follows dependencies, optional dependencies for foreign operating systems, and required peers,
using POSIX lockfile paths on every host. Optional peers may be absent. Peers must resolve beside
their consumer; ordinary dependencies may resolve in nested or hoisted locations.

Its negative cases remove the actual historical packages: `@emnapi/core`, `@emnapi/runtime`,
`@emnapi/wasi-threads`, `@electron/windows-sign`, `cross-dirname`, and `postject`.
The checker also rejected the actual pre-fix lockfiles from `a4525e56^` and `0c9bcc1c^` during
this audit. Local npm 11.5.2 accepted a dry run after deleting `@emnapi/core`, confirming why
the independent graph check is necessary.

The new `cleanInstall` suite additionally runs the active npm's `ci --dry-run` in a disposable
directory containing only each manifest/lockfile pair. It requests macOS arm64, macOS x64,
Windows x64, and Linux x64. Scripts, downloads, audit, and funding requests are disabled;
development and optional dependencies are explicitly included. This catches npm's own manifest
and version-resolution checks without altering the working installation or lockfiles.

These are dependency-plan checks, not native installations or execution on simulated operating
systems. The closure check verifies presence and resolution; npm checks version compatibility.

### Signing and packaging

The [Mac failure][mac-sign] passed a certificate password to keychain ACL configuration, which
needed the generated keychain password. Existing `builderSigning` tests execute the real
patched builder module against a fake security command and reject the original implementation.

The [Windows failure][win-sign] required signing credentials even though that release channel
supports unsigned installers. The new workflow suite pins optional Windows signing, required
Mac signing/notarization, and the absence of a mandatory Windows-secret preflight.

The [AppImage failure][appimage] launched extracted AppRun without FUSE's `APPDIR`; it tried to
execute `/stacki`. The new workflow test verifies the exported directory precedes the smoke
command. Native binary/header, executable-permission, unpacked-parser, and installer checks
already exist in `test/scripts/release/` and remain part of the normal gate.

## Run locally

The new suites are discovered automatically by `npm test` and therefore by the existing full
pre-push gate. No hook, workflow, compiler configuration, or protected policy file was changed.

For a focused audit regression pass:

```sh
env -u ELECTRON_RUN_AS_NODE npm test -- scripts/release/ scripts/install/ \
  platformWindows publishWorkerConfig saveRecovery terminalLifecycle
```

Before pushing, run the full gate and changed-file checks:

```sh
env -u ELECTRON_RUN_AS_NODE npm test
npm run check:changed
```

On Windows, clear `ELECTRON_RUN_AS_NODE` in the invoking shell and run `npm test`; `env -u` is
POSIX shell syntax. Run these through npm so the clean-install probes use that same npm CLI.

## What still requires the real environment

Native Windows sharing rules, Linux AppArmor/setuid behavior, installed .deb/AppImage execution,
macOS notarization, certificate validity, GitHub credentials, registry permissions, and network
availability cannot be established by these offline checks. Keep the three-platform CI matrix
and installer smoke jobs. Existing signing tests establish argument handling, not live credentials.

Five separate create-stacki publication failures reached npm authentication after building;
for example [0.1.65][npm-auth]. They are not Desktop compiler/installer failures and cannot be
fixed by a local unit test. See [create-stacki.md](create-stacki.md) for the authentication path.

[sandbox-first]: https://github.com/flowtricks/stacki/actions/runs/37197495625
[sandbox-last]: https://github.com/flowtricks/stacki/actions/runs/38410755516
[worker]: https://github.com/flowtricks/stacki/actions/runs/39771929447
[studio-windows]: https://github.com/flowtricks/stacki/actions/runs/39252086627
[cleanup]: https://github.com/flowtricks/stacki/actions/runs/39253227879
[save]: https://github.com/flowtricks/stacki/actions/runs/39774595929
[terminal]: https://github.com/flowtricks/stacki/actions/runs/39340179233
[browser]: https://github.com/flowtricks/stacki/actions/runs/39490521172
[wasm]: https://github.com/flowtricks/stacki/actions/runs/39262452196
[wasm-again]: https://github.com/flowtricks/stacki/actions/runs/39339028870
[windows-sign]: https://github.com/flowtricks/stacki/actions/runs/39432813944
[mac-sign]: https://github.com/flowtricks/stacki/actions/runs/34596247857
[win-sign]: https://github.com/flowtricks/stacki/actions/runs/35341234541
[appimage]: https://github.com/flowtricks/stacki/actions/runs/38919782379
[npm-auth]: https://github.com/flowtricks/stacki/actions/runs/39518762804
