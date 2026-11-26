# Design mode (experimental): how it fits in, and how to take it out

Design mode turns the open page into frames on a pan and zoom canvas: sandboxed copies of the rendered page
that can be dragged, restyled, re-propped, unlinked, duplicated and handed to the AI. It never writes to the
project.

## Switching it off without removing it

Set `DESIGN_MODE_ENABLED` to `false` in `shared/designMode/designModeContract.ts`. The AI panel header's
Modes menu then has no Design mode row (comment pins stay; with no mode registered the button is not drawn),
the canvas frame installs no listener, and the dev server plugin has no hooks.

## The Modes menu

Design mode shares the header's one Modes menu with comment pins. It registers its row from its own host
(`src/app/designMode/DesignModeHost.tsx`, with `registerPanelMode` from `src/features/ai/panelModes.ts`), and
the menu, its registry and comment pins know nothing of it (the boundary test holds that). The registry keeps
one mode on at a time: turning Design mode on ends comment mode (an open pin is kept, saved when it has
content), and turning comment pins on leaves Design mode (its frames are saved as a draft first).

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
- The editor's chords that need no selection are taken before it hears them (`model/designCoveredKeys.ts`):
  the insert palette (⌘F, ⌘E, ⌘K, outside code editors), the left rail's ⌥ chords except the AI panel's, and
  the preview chord (⌥⇧P) and the pull chord (⌥⇧G). Not covered: a Stacki app's own ⌘⌥⇧ number command, which stays the app's.
- It does not start over the component defaults editor or an open component (there is no page to copy).
- Comment pins cannot be on at the same time (above), and write only to Stacki's own data folder either way.
  The Files panel's reader (`FilesKeeper`) only reads.
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
   - `test/scripts/release/unpackedParser.test.js`: the `designMode/designRender.js` entry of `ENTRIES`.
   - `test/shared/properties/appShortcuts.test.ts`: `'src/app/designMode/DesignModeHost.tsx'` in the digit-shortcut list,
     and the comment line above it.
3. Run `npm run build:runtime` (the dev server's generated config is written again at its next start).

Kept: the Modes menu and its registry (`src/features/ai/panelModes.ts`, `sessions/ModesMenu.tsx`), which
belong to comment pins too. Nothing outside the list above changes.

Drafts already saved stay in the app's IndexedDB until its data is cleared; nothing reads them.
