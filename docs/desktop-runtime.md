# Desktop browser runtime

Stacki pins Electron 44.11.6, including Chromium 152. This enables modern CSS
such as `text-box`, `text-box-trim`, and `text-box-edge` inside the preview.
The authored-style regression test verifies both computed values and actual
line-box trimming in Electron, so a browser downgrade cannot silently remove it.

Electron now downloads its executable on demand. `fix:install` explicitly runs
`install-electron` during `npm ci` because Linux CI must configure Chromium's
sandbox helper before running any browser tests.

## macOS compatibility

Electron 44 requires macOS 13 or newer. The packaged application's
`minimumSystemVersion` declares `13.0.0`. Before publishing, the release workflow
adds `minimumSystemVersion: 22.0.0` to `latest-mac.yml` because electron-updater
compares Darwin kernel versions, not macOS marketing versions. Existing clients
already honor this field and keep their working installation on older systems.

The release remains a draft until this metadata upload and every platform's
build and installation checks succeed. When upgrading Electron again, review
both the macOS requirement and its matching Darwin version together.

## Fuses

`build.electronFuses` in `package.json` sets what the packaged binary will do, and electron-builder
flips the fuses and stores `app.asar`'s hash as it packages:

- **On:** loading the app only from `app.asar`, and checking that archive against the stored hash
  (macOS and Windows; Electron does not check it on Linux).
- **Off:** `--inspect` and its kin for the app's own process. A script run on Stacki's binary as Node
  still accepts them.
- **Kept on:** `RunAsNode`, which runs the AI adapters, content configs and app commands, and
  `NODE_OPTIONS`. Turning the latter off also removes `NODE_EXTRA_CA_CERTS` from Stacki and every
  program it starts, which cuts off an AI CLI behind a company's TLS proxy.

`dist:mac:unsigned` makes the ad hoc signature again after the fuses, because an Apple silicon Mac
will not start a changed binary without it. A signed release is signed after the fuses.

## Permissions and messages

A page is granted a permission only when `electron/app/windowSecurity.ts` allows it by name, in
every session and nested frame. An embedded page may pass only `mailto:`, `tel:` and `sms:` links
to another app. IPC channels answer only the app window's top frame (`electron/lib/ipcSenders.ts`);
register new ones on the guarded `ipcMain` that `main.ts` hands out.
