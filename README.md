# Stacki

Visual Builder for Astro.

A shared visual editor for [Astro](https://astro.build): desktop apps for Mac, Windows, and Linux, and a project-owned Studio hosted on Cloudflare.

MIT licensed — fork it, build on it, ship your own version.

## Features

- **Pages** — browse every page in `src/pages`, create new pages (including nested routes like `blog/post-1`), and delete pages.
- **Layouts** — choose which layout from `src/layouts` wraps each page, and edit the layout's props (e.g. `title`).
- **Components** — every component in `src/components` appears in the palette. Drag one into the page structure (or double-click to append), drag to reorder, click ✕ to remove.
- **Props** — the props panel reads each component's `interface Props` / `Astro.props` destructure and generates typed fields (text, number, checkbox). Defaults are shown as placeholders.
- **Live preview** — the app runs `astro dev` for the opened project and embeds it. Edits are auto-saved (300 ms debounce), so Astro's hot reload updates the preview as you type.
- **Git & GitHub** — the branch chip in the title bar shows the current branch and dirty state. From its dropdown you can switch branches, create branches, commit, push, or publish a brand-new repo to GitHub (via the `gh` CLI).
- **Tell an AI what's selected** — **⇧⌘C** copies whatever the canvas has selected as the trail of `file:line-range` pointers that leads to it: the page, each component drilled into on the way down, then the node itself. Paste that into Claude Code or any AI chat that can read the project and it knows exactly which markup you mean.
- **Code fallback** — pages with markup too complex for the visual model open in a code editor instead, still with live preview.
- **New project** — "Start from Lumos" or "Start from Astro" creates a named site with the framework's own scaffolder and installs its dependencies for you.

## Running in development

```bash
npm ci
npm --prefix studio ci
npm run dev
```

`npm run dev` starts Vite (renderer hot reload) and launches Electron against it.

To run against a production build of the UI:

```bash
npm start
```

## Shared Studio source

The root `src`, `shared`, and `electron` directories are the canonical editor.
`studio/` contains collaboration, Cloudflare hosting, and browser transport adapters.
`npm run studio:build` assembles the shared editor into `studio/vendor/stacki` before
building; never maintain that generated copy by hand. Native filesystem writes stay
in Electron. Hosted writes go through the authenticated Cloudflare Container draft.

The desktop installation uses its own editor version for every project it opens.
Each website can separately pin and customize its hosted Studio source. Releases
are opt-in per website and replace all Studio customizations while retaining the
website, deployment configuration, secrets, and drafts. See
[Studio releases and updates](studio/docs/releases.md).

```sh
npm run studio:install
npm --prefix studio/test/fixtures/site ci --ignore-scripts
npm run studio:dev
npm test                   # both packages' strict checks and test suites
npm run check:changed      # routes changed files to their package checks
npm run studio:release     # versioned source bundle
```

Studio uses its own dependency lockfile so native modules never enter its cloud
installation. Both artifacts use the root Stacki version and the same release feed.

## Packaging installers

If you're building for yourself or from a fork, use the unsigned build — it
needs no Apple Developer account and no certificates:

```bash
npm run dist:mac:unsigned   # .dmg + .zip, no signing (build on macOS)
npm run dist:win            # NSIS installer (build on Windows)
npm run dist:linux          # x64 .AppImage + .deb (build on Linux)
```

Output lands in `release/`. macOS will warn the first time you open an
unsigned build; right-click the app and choose Open to get past Gatekeeper.

The signed variants are for maintainers with the release certificates:

```bash
npm run dist:mac   # requires a Developer ID cert + notarization credentials
```

## Releases

Official builds are published by CI, not from anyone's laptop. Pushing a
`v*` tag runs `.github/workflows/release.yml`, which builds a signed and
notarized macOS builds for Apple Silicon and Intel, a Windows installer, and Linux x64
AppImage and Debian packages, plus a versioned Studio source bundle. It uploads them to the
`stacki-releases` repo and only
makes the release visible once every platform has landed and the Linux
packages pass installed-app smoke tests. Shipped apps auto-update from that feed via
`electron-updater`.

## Linux installation

Download the `.deb` or `.AppImage` from the
[latest release](https://github.com/flowtricks/stacki-releases/releases/latest).
Official Linux builds support x86-64 desktops. The native terminal is built on
Ubuntu 22.04; installed packages are tested on Ubuntu 22.04 and 24.04.

On Ubuntu or Debian, install the `.deb` with your package manager:

```bash
sudo apt install ./stacki_VERSION_amd64.deb
```

Replace `VERSION` with the downloaded version. Open Stacki from the application
menu or run `stacki`. The installer configures Chromium's sandbox helper, including
on Ubuntu 24.04. Updates use the same in-app update menu and may request your
administrator password to replace the installed package.

For other compatible glibc-based distributions, make the AppImage executable
and launch it:

```bash
chmod +x Stacki-VERSION.AppImage
./Stacki-VERSION.AppImage
```

Keep it in a writable folder so automatic updates can replace it. AppImages
need FUSE 2 and permission to create unprivileged user namespaces. On systems
that restrict those namespaces, use the Debian package where supported.
Chromium's sandbox remains enabled in both formats. Linux desktops need X11
or XWayland; native Wayland and ARM64 packages are not currently tested.

Building from source on Linux additionally needs Python 3, make, and a C++
compiler for `node-pty` (`sudo apt install build-essential python3` on Ubuntu).
Use Node.js 22.18 or newer to build Stacki. Build installers on Linux itself so
the terminal contains a Linux native module, rather than a Mac or Windows binary.

The install script backports the temporary-keychain password fix from
[electron-builder #10172](https://github.com/electron-userland/electron-builder/pull/10172)
to the locked builder version. This keeps signing working on current macOS
runners without changing the certificate credentials. Remove the backport when
upgrading to a builder version that includes the fix.

Signing and notarization credentials live in GitHub Actions secrets. They
are never in this repository, and GitHub does not expose them to workflows
triggered from forks — so a fork can build and run everything here, but
cannot produce a build signed with the official identity. That's intended.

If you fork this and publish your own builds, change `build.appId` and
`build.publish` in `package.json` to your own identifiers so your releases
don't collide with the official update feed.

## Contributing

Issues and pull requests are welcome. A few notes:

- `npm run dev` is all you need for day-to-day work — no credentials required.
- Please don't add workflows that use `pull_request_target`, or any workflow
  that exposes secrets to code from a fork.
- Report security issues privately to the maintainer rather than opening a
  public issue.

## Requirements

- Node.js 18+ and npm (the app shells out to `npm install` / `astro dev` for opened projects)
- `git` for version control features
- [GitHub CLI](https://cli.github.com) (`gh`), authenticated via `gh auth login`, for "Publish to GitHub"

## How editing works

Pages are parsed into a simple model: optional layout wrapper + a flat list of
self-closing component instances with props. The editor writes that model back
as clean `.astro` source. Pages containing arbitrary HTML, expressions, or
nested children fall back to the built-in code editor — nothing is ever
rewritten destructively.

## Repository layout

`src/` is the renderer: layers (`lib`, `ipc`, `editor`, `ui`, `app`) and one
folder per feature in `src/features/`. `electron/` is the main process in
areas (`parse`, `documents`, `content`, …), `shared/` the contracts between
them, `scripts/` the tooling, and `test/` mirrors all four. The map and the
rules that hold it are in `docs/codebase.md` ("Directory map").

## Build output

`npm run build` starts from a clean `dist/` directory and writes the Electron
CommonJS runtime to `dist/electron/`, shared contracts to `dist/shared/`, and
the Vite renderer to `dist/renderer/`. Content workers and runtime icons are
copied under `dist/` too. `npm run dev` rebuilds the runtime and serves the
renderer through Vite. Only `dist/` needs ignoring for compiler output;
JavaScript files elsewhere in the repository are authored source.

Use `npm run build:clean` to remove generated output. Build before running an
individual runtime test; `npm test` performs the clean build automatically.
