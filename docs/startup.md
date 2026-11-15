# Startup: what a cold start does, and what it must not

**The rule.** The first frame the person sees is the real app: the real shell with real content, or the real
start screen. Never a splash, spinner, skeleton shell, placeholder, animated intro or fade that delays content.
The window stays hidden until that frame exists, so nothing is ever drawn in front of it.
(Skeleton loaders for genuinely slow work inside the app are a separate matter: docs/ui-loading.md. None is used at boot.)

## The path, in order

| Step | Where | Held by |
| --- | --- | --- |
| Compile cache on, so main-process modules load from disk | `electron/lib/compileCache.ts` | `test/electron/app/windowStartup.test.js` |
| Boot snapshot read (sync, tiny file) and boot channels registered before the window | `electron/boot/*`, `app.whenReady` in `electron/main.ts` | `test/electron/boot/bootStore.test.js` |
| For a project the window will open: its root is allowed and its Astro dev server starts now, before the renderer loads | `startProjectPreview` (`electron/handlers/devServers.ts`), `earlyProject` in `main.ts` | joined by the renderer's own `dev:start` (one start per project) |
| Window created hidden at its last bounds (`electron/app/windowState.ts`), `backgroundColor` is `--bg-panel` | `createWindow` | `windowState.test.js`, `windowStartup.test.js` |
| Preload reads the seed synchronously (`boot:read`) and exposes `window.stackiBoot` | `electron/preload/preloadBridge.ts` | `bootStore.test.js` (channels) |
| `index.html` is only the surface colour and `#root`; the app script starts at once | `index.html` | `startupCriticalPath.test.js` |
| A window opening a project awaits the shell chunk, then renders: first commit is the real shell with the snapshot's page list, the last open page's panel and the branch chip | `src/main.tsx`, `src/lib/bootSeed.ts`, `src/app/shell/lazyShell.ts` | `test/renderer/app/bootFirstRender.test.js` (no IPC answers; no skeleton/spinner markup) |
| After two animation frames the renderer sends `boot:first-frame`; main shows the window | `src/app/startupMarks.ts`, `electron/app/windowReveal.ts` | `windowStartup.test.js` (not shown before the frame; 5 s safety fallback only for a page that never reports) |
| Fresh scan replaces the snapshot's list in place; open page, selection and scroll are not reset | `loadProject` in `src/app/state/appNavigation.ts` | |
| Snapshot kept current: page list, open page, left panel, branch | `src/app/boot/useBootSnapshotWriter.ts` | `bootSnapshot.test.js` |
| Update check 5 s after the window is shown; usage notice after it is shown | `afterWindowShown` in `main.ts` | |

A cold start with no project owed (a packaged launch) lands on the start screen, as before: reopening the last project
on a cold launch is a product decision, not a startup one. The snapshot serves every project open after that: a reload,
a project picked from the menu, a recent project.

## Snapshot contract

`boot-snapshot.json` in the app data folder (next to `settings.json`); parser `shared/properties/bootSnapshot.ts`.

- `{ version: 1, projects: BootSnapshot[] }`, at most 4 projects, most recent first, 1 MB file, 256 KB per project.
- A snapshot holds: project path, the page scan (pages, folders, layouts, components), open page name, left panel id,
  last branch chip state. **No page source, no file contents, no secrets, no screenshots.**
- Read through a hand-rolled parser (`unknown` to `Result`); anything invalid drops the whole snapshot and the project
  opens as it did before the cache existed. A snapshot whose project folder is gone is not handed to the renderer.
- Never written to the project. Written debounced (1 s quiet, 10 s ceiling), atomically, flushed on close.
- Stale while revalidate: the snapshot is what the first frame shows; the fresh scan replaces it in place.

## Budgets (opt-in, never asserted in CI)

Measure with `node test/integration/startupTimeline.js --dist <root> --label <name> [--mode project|welcome] [--runs N]`
(a copy of the fixture site, an isolated user-data folder, the bundled renderer loaded from disk; `<root>` holds
`dist/{electron,shared,resources,renderer}` and `node_modules`). Numbers are milliseconds since the process began.

| Milestone | Budget (dev machine) |
| --- | --- |
| Window shown, real start screen or real shell on it | under 900 ms |
| Real shell with page list in the first frame (project open) | same frame as window shown |
| Canvas first frame | bounded by Astro's own start (about 3.5 s for the fixture), started as early as main can |

## Measuring

- Main: `[startup] appReady=… windowCreated=… windowShown=… rendererLoaded=…` (debug line).
- Renderer: marks `stacki:html-parsed`, `stacki:shell-painted`, `stacki:interactive`, `stacki:project-ready`.
- `startupTimeline.js` adds every IPC handler's start and end, the slowest `require`s, resource sizes, long tasks, and
  the moments the canvas frame loaded.

## Not done yet

- The first bundle is still one 2.4 MB chunk (English catalog, CodeMirror, icon set, highlighter). Splitting them is the
  next saving for the start screen.
- The open page's tree (Navigator rows) is not in the snapshot: it needs the page source, which the snapshot must not
  hold; the Navigator fills when the page is read.
- Studio's boot screen is a separate surface (`studio/src/app/BootScreen.tsx`) and was not changed here.
