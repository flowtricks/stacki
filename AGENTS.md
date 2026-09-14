# AGENTS.md — Stacki

Electron + React 18 + Vite 6 desktop app: visual builder for Astro projects.
`electron/` = main process (IPC, parsing, git, preview). `src/` = renderer.
Parser core is `electron/astroParser.js`; shared frontmatter module is
`electron/frontmatter.js` (imported as `stacki/frontmatter` in renderer/tests).

## Commands

- `npm install` then `npm run dev` (Vite on strict port 5173 + Electron via
  `scripts/dev-electron.mjs` supervisor). `npm start` runs against a prod build.
- `npm test` — the gate, must pass before every commit. `scripts/run-tests.js`
  discovers every `test:*` script in `package.json` and runs each verbatim.
- Focused: `node scripts/run-tests.js <name>` (e.g. `querycache`, `roundtrip`)
  or `npm run test:<name>` for one file.
- `npm run build` — verifies production bundling.
- `npm run integration:dev` — real Electron/Astro lifecycle smoke test in a tmp
  project. Needs network (installs pinned Astro); the ordinary gate is offline.
- `npm run roundtrip:report`, `npm run performance:report -- <commit>`.

Test quirks: most tests are plain `node test/<file>.js`. Only `*.test.js` files
use `node --test`. `test:thumbs` runs under `electron` (needs a display).
`test:fields` / `test:fluid` need `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`
— copy the exact script, don't simplify. Old content tests skip when the
optional external project is absent; `STACKI_CORPUS=~/a-site npm test`
crash-sweeps a real project.

## Adding a test

One `test:*` entry in `package.json` is the only registration — there is no
second list. New parser fixtures go in `test/corpus/` as minimal,
single-purpose `.astro` files (one shape per file, named for the shape).

## Round-trip contract (parser work)

Parsing a page and serializing it back must return the **original bytes**.
`test/expectations.json` lists fixtures that currently fail with root cause +
`severity` (`corruption` = changes meaning, `formatting` = same meaning,
reformatted). The gate asserts a known failure **still fails**: when a fix
lands, delete its entry — the file then becomes a permanent regression test.
Never "fix" the test by keeping a stale entry. Goal is `{}`.

## Architecture notes

- `src/App.jsx` is a ~4500-line god component; pure logic lives in sibling
  `src/*.js` modules (`editorTree.js`, `loopBindings.js`, `pagePersistence.js`,
  …) — put new logic there so tests can import it without React.
- Renderer panels: `src/panels/`; reusable UI: `src/ui/`; style editor:
  `src/style-panel/`.
- Main-process services (`projectWatcher.js`, `serialQueue.js`, terminal,
  content workers) must release watchers/timers/processes on project close —
  see `stopAllServices` / `cleanupTerminals` patterns.
- `electron/main.js` + `astroParser.js` are bound at require time: they do **not**
  hot-reload. Use in-app "Reload All Code" (relaunch, exit code 42), not window
  reload, when touching main-process code.
- Packaged build: `electron-builder` `files`/`asarUnpack` in `package.json`
  must include any new main-process module loaded from unpacked code
  (`node-pty`, parser helpers). `postinstall` patches perms/signing — don't
  remove.

## Releases / constraints

- Requirements: Node 18+ (CI uses 22), `git`, `gh` CLI authed (Publish to GitHub).
- Releases publish from CI on `v*` tags to the `stacki-releases` repo
  (draft until mac + win + linux assets land). Forks build locally with
  `npm run dist:mac:unsigned` / `npm run dist:win` / `npm run dist:linux`
  (AppImage, the only Linux format with auto-update) and must change
  `build.appId` + `build.publish` to avoid colliding with the official feed.
- Never commit `.env`, `*.p12/.pfx/.pem/.key/.mobileprovision`. Never add
  `pull_request_target` workflows or workflows exposing secrets to forks.
- No linter / formatter / typechecker configured — match surrounding style.
