# Design mode (experimental): how it fits in, and how to take it out

Design mode turns the open page into frames on a pan and zoom canvas: sandboxed copies of the rendered page
that can be dragged, restyled, re-propped, unlinked, duplicated and handed to the AI. It never writes to the
project.

## Switching it off without removing it

Set `DESIGN_MODE_ENABLED` to `false` in `shared/designMode/designModeContract.ts`. The AI composer's
canvas modes menu then has no Design mode row (and hides itself if no other mode is registered), the canvas
frame installs no listener, and the dev server plugin has no hooks.

## Why it cannot write

- Its frames are copies of the page the canvas hands over (`electron/preload/designMode/designModeFrame.ts`),
  loaded into `sandbox="allow-same-origin"` iframes that run no script. Every gesture edits those documents
  only (`model/designDom.ts`).
- The app hands it a read-only view (`DesignHostSource` in `DesignModeHost.tsx`); it never receives the
  editor's edit queue, gestures, saves or write IPC. `test/renderer/app/designMode/designModeBoundary.test.ts`
  holds its imports to a sandbox-safe list and allows no preload call but the menu listener.
- Prop changes render through `POST /__avb/design-render` (`electron/previewServer/designMode/designRender.ts`),
  Astro's container API inside the running dev server: nothing is written, not even a temporary file.
- While it is on, the window is held (`src/ui/busyLock.ts`), so the menu's Undo, Redo, Paste, Insert and
  Reload do nothing to the project, and the editor's selection is cleared, so its shortcuts have no target.
- Drafts are kept in the app's own IndexedDB (database `stacki-design-mode`, in Stacki's user data folder,
  on macOS `~/Library/Application Support/Stacki/IndexedDB/`), never in the project.

## Removing it

1. Delete these folders:
   - `src/app/designMode/`
   - `electron/preload/designMode/`
   - `electron/previewServer/designMode/`
   - `shared/designMode/`
   - `test/renderer/app/designMode/`
   - `test/electron/preload/designMode/`
   - `test/electron/previewServer/designMode/`
   - `test/shared/designMode/`
2. Revert these lines, each marked `Design mode (experimental)`:
   - `src/app/shell/AppShell.tsx`: the `import { DesignModeHost } …` line and the `<DesignModeHost app={app} />` line.
   - `electron/preload/preload.ts`: the `import { isDesignModeSandbox, listenForDesignModeRequests } …` line,
     the `} else if (isDesignModeSandbox()) {` branch with its comment line, and the `listenForDesignModeRequests();` line.
   - `electron/preview/markerConfig.ts`: the comment and `const { designModeRenderPlugin } = require(…)` lines,
     and the `designModeRenderPlugin(PROJECT_DIRS),` entry of the plugin list.
3. Run `npm run build:runtime` (the dev server's generated config is written again at its next start).

Kept on purpose (shared with other canvas modes, such as comment pins): `src/lib/canvasModes.ts`,
`src/features/ai/composer/CanvasModesMenu.tsx`, its two lines in `ComposerStatusLine.tsx` and the three
`ai.composer.canvasModes*` keys in every `shared/properties/i18n/messages/*/ai.ts`. The menu hides itself
when no mode is registered; delete them too only if no canvas mode is left.

Drafts already saved stay in the app's IndexedDB until its data is cleared; nothing reads them.
