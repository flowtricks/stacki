# Stacki

Visual Builder for Astro.

A Mac, Windows & Linux desktop app for editing [Astro](https://astro.build) projects visually.

MIT licensed — fork it, build on it, ship your own version.

## Features

- **Pages** — browse every page in `src/pages`, create new pages (including nested routes like `blog/post-1`), and delete pages.
- **Layouts** — choose which layout from `src/layouts` wraps each page, and edit the layout's props (e.g. `title`).
- **Components** — every component in `src/components` appears in the palette. Drag one into the page structure (or double-click to append), drag to reorder, click ✕ to remove.
- **Props** — the props panel reads each component's `interface Props` / `Astro.props` destructure and generates typed fields (text, number, checkbox). Defaults are shown as placeholders.
- **Live preview** — the app runs `astro dev` for the opened project and embeds it. Edits are auto-saved (300 ms debounce), so Astro's hot reload updates the preview as you type.
- **Git & GitHub** — the branch chip in the title bar shows the current branch and dirty state. From its dropdown you can switch branches, create branches, commit, push, or publish a brand-new repo to GitHub (via the `gh` CLI).
- **Code fallback** — pages with markup too complex for the visual model open in a code editor instead, still with live preview.
- **New project** — "New Project…" scaffolds a minimal Astro starter (layout + 5 components + home page) and runs `npm install` for you.

## Running in development

```bash
npm install
npm run dev
```

`npm run dev` starts Vite (renderer hot reload) and launches Electron against it.

To run against a production build of the UI:

```bash
npm start
```

## Packaging installers

If you're building for yourself or from a fork, use the unsigned build — it
needs no Apple Developer account and no certificates:

```bash
npm run dist:mac:unsigned   # .dmg + .zip, no signing (build on macOS)
npm run dist:win            # NSIS installer (build on Windows)
npm run dist:linux          # AppImage + .deb (build on Linux)
```

Output lands in `release/`. macOS will warn the first time you open an
unsigned build; right-click the app and choose Open to get past Gatekeeper.
On Ubuntu 24.04+ the AppImage needs libfuse2 to run
(`sudo apt install libfuse2t64`); the .deb does not.

The signed variants are for maintainers with the release certificates:

```bash
npm run dist:mac   # requires a Developer ID cert + notarization credentials
```

## Releases

Official builds are published by CI, not from anyone's laptop. Pushing a
`v*` tag runs `.github/workflows/release.yml`, which builds a signed and
notarized macOS universal build, a Windows installer, and Linux
AppImage/.deb packages, uploads them to the `stacki-releases` repo, and
only makes the release visible once all platforms have landed. Shipped
apps auto-update from that feed via `electron-updater` (on Linux
auto-update applies to the AppImage only, not the .deb).

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
