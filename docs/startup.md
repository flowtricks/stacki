# Startup: what a cold start does, and what it must not

**The rule.** The first frame is the app's own shape, never an empty or black window
(docs/ui-loading.md). Everything a cold start does not need waits until after that frame.

## The path, in order

| Step | Where | Held by |
| --- | --- | --- |
| Compile cache on, so main-process modules load from disk | `electron/lib/compileCache.ts` (first import of `main.ts`) | `test/electron/app/windowStartup.test.ts` |
| Window created before language, icon and menu | `app.whenReady` in `electron/main.ts` | same |
| Window is hidden, `backgroundColor` is `--bg-panel`, shown on `ready-to-show` (2 s fallback) | `electron/app/windowReveal.ts` | same |
| Spinner on the dark surface paints before any script, fades once the app has a frame | `index.html`, `startupMarks.ts` | `test/renderer/app/startupCriticalPath.test.js` |
| App script starts one frame later | `index.html` | same |
| Start screen is the first bundle; the editor shell and Settings are dynamic imports | `src/app/shell/lazyShell.ts`, `src/app/settings/LazySettings.tsx` | same (static import closure of `src/main.tsx`) |
| Shell and Settings chunks fetched when idle | `src/app/startupMarks.ts` | |
| Update check 5 s after the window is shown; usage notice after it is shown | `afterWindowShown` in `electron/main.ts` | |

## Measuring

- Main process: one debug line, `[startup] appReady=… windowCreated=… windowShown=… rendererLoaded=…`
  (milliseconds since the process began, durations only).
- Renderer: `performance.mark` names `stacki:html-parsed`, `stacki:shell-painted`, `stacki:interactive`,
  `stacki:project-ready`, and a `[startup] renderer …` debug line. Read them in the Performance panel's
  Timings track.
- Bundle: the entry chunk is `assets/main-*.js`; `index-*.js` is a 2 KB stub that imports it after the first frame.

## Keep out of the first bundle

`AppShell`, `Settings`, every panel in `src/app/appPanels.ts`, the terminal and the marketplace. What is still
in it and could move: the English catalog (about 320 KB), the code highlighter and CodeMirror (reached through
`CodeBlock`, `codeEditorIndent` and the state layer), and the icon set (`src/ui/central`, about 300 KB).
