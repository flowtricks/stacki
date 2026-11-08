---
title: Install Stacki
description: Download a build for macOS, Windows, or Linux, or run it from source, and what your machine needs first.
group: start
order: 2
keywords:
  [
    "download",
    "requirements",
    "gatekeeper",
    "windows",
    "mac",
    "linux",
    "update",
  ]
---

Stacki is a desktop app. Download a build, or clone the repository and run it
yourself. The app is identical either way.

## Download

Choose the build for your computer:

- [Download for Mac (Apple Silicon)](/download/mac) — M1 or newer Apple chips.
- [Download for Mac (Intel)](/download/mac-intel) — Intel processors.
- [Download for Windows](/download/windows) — Windows installer.
- [Download for Linux](https://github.com/flowtricks/stacki-releases/releases/latest)
  — x86-64 Debian package or AppImage.

On a Mac, open **Apple menu → About This Mac**. **Chip** names your Apple Silicon
chip; **Processor** names an Intel processor. The website selects a build when
your browser provides its architecture; otherwise, it brings you here to choose.

These links use the latest published release. Until separate Mac builds are
available, both Mac links download the universal installer that supports both chips.
Existing installations continue updating from the same release feed; there is no
need to reinstall. The first update to a separate Mac build may download the full package.

## Installing on Linux

On Ubuntu or Debian, download the `.deb` file and install it with:

```bash
sudo apt install ./stacki_VERSION_amd64.deb
```

Replace `VERSION` with the downloaded version. Linux packages are tested on
Ubuntu 22.04 and 24.04.

For other compatible glibc-based distributions, download the AppImage, make it
executable, and launch it:

```bash
chmod +x Stacki-VERSION.AppImage
./Stacki-VERSION.AppImage
```

Keep the AppImage in a writable folder for automatic updates. It needs FUSE 2
and permission to create unprivileged user namespaces. Use the Debian package
where supported if your system restricts those namespaces. Both formats keep
Chromium's sandbox enabled. Linux desktops need X11 or XWayland; native Wayland
and ARM64 packages are not currently tested.

## What your machine needs

Stacki drives the tools your project already uses rather than bundling its own,
so those need to be installed:

| Tool                                        | Why it is needed                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Node.js 18+ and npm                         | The app shells out to `npm install` and `astro dev` for the project you open |
| `git`                                       | Branches, commits and the branch chip in the title bar                       |
| [GitHub CLI](https://cli.github.com) (`gh`) | Only for **Publish to GitHub**. Authenticate once with `gh auth login`       |

A project does not need anything added to it. There is no plugin, no config
file and no dependency for Stacki. If `npm run dev` works in your terminal, the
project opens.

## Running from source

```bash
git clone https://github.com/flowtricks/stacki.git
cd stacki
npm install
npm run dev
```

`npm run dev` starts Vite for the interface and launches Electron against it.
To run the production interface instead, use `npm start`.

## Building your own installers

An unsigned build needs no Apple Developer account and no certificates:

```bash
npm run dist:mac:unsigned   # .dmg + .zip, built on macOS
npm run dist:win            # NSIS installer, built on Windows
npm run dist:linux          # AppImage + .deb, built on Linux
```

Output lands in `release/`. macOS warns the first time an unsigned build is
opened. Right-click the app and choose **Open** to get past Gatekeeper.

> If you publish builds from a fork, change `build.appId` and `build.publish` in
> `package.json` to your own identifiers so your releases do not collide with the
> official update feed.
