# Design mode (experimental): how it works, why it cannot write, and how to take it out

Design mode is the normal editor working on a sandbox: a private copy of the project in Stacki's own data folder.
Turning it on (the AI panel header's Design mode button) copies the project and opens the copy through the app's own project
switch, so the Navigator, the Style and Settings panels, Add elements, Components, Assets and the preview all work
on it for real. Over the preview sits Design mode's canvas of frames, which can be panned, zoomed, duplicated
(Option-drag, right-click or ⌘D), moved, renamed, removed (Delete) and sent to the AI. Nothing is saved to the
project.

## Frames

- **One site copy, one dev server, one live preview.** A frame is the set of files it changes in the copy. The
  editor's preview, hidden under the canvas, renders the shown frame; picking something in another frame rewrites
  the files the two differ in, and the real panels get the selection once the editor has read that frame's page
  (`src/app/designMode/designFrameOps.ts`).
- **What a frame draws** is a snapshot of that preview's document (`electron/preload/designMode/`): scripts out,
  stylesheets and fonts inlined, nested documents and media switched off, each element marked with the page node
  it stands for, so a click in a frame selects the same node a click on the preview would
  (`shared/ipc/designSnapshot.ts`). It is shown in a same-origin iframe with scripts off, in the app window's own
  process. The shown frame is snapshotted again after each change; the others keep theirs.
- **Entering** shows the canvas on the click itself, with the kept frames (or the page as the editor shows it),
  while the copy is made; the window then reloads into the copy, as for any project switch.
- **Showing a frame again** writes bytes the editor may have saved before, which the project watcher takes for the
  editor's own save, so main announces the rewritten files itself, and the canvas does not go on until the editor
  has read the frame's page.
- **Send to AI** pictures the top of each frame (as wide as the canvas, as tall as the window shows) and describes
  each frame's source changes as diffs.
- **Bounds:** 8 frames; 20,000 elements and 6,000,000 characters a snapshot; 32,000,000 characters of snapshots
  together.
- **Moving and resizing:** a drag in a frame moves the element there with the CSS `translate` property, snapping to
  its holder and siblings; the picked element's handles set `width` and `height`. Both are written as the element's
  inline style through the editor's own write (so ⌘Z takes them back), in rem.
- **Not yet:** unlinking a component and editing text inside a frame; opening a component from a frame; undo for a
  removed frame. Frames run no script, so script-driven layout shows as it was snapshotted.

## Switching it off without removing it

Set `DESIGN_MODE_ENABLED` to `false` in `shared/ipc/designSession.ts`. The header then has no Design mode button (comment pins keep theirs),
and main refuses to begin a session.

## Why it cannot write to the project

- **The copy is elsewhere.** `electron/handlers/designMode/designSandbox.ts` copies the project to
  `<user data>/design-sandboxes/<id>/` (on macOS `~/Library/Application Support/Stacki/`), folders mode 0700, with
  the top-level node_modules cloned copy-on-write in one call. Dependency, build, cache and worktree folders are skipped
  at every depth; a preflight with hard bounds refuses a project too large, naming its largest folder, before
  anything is copied; the walk and the copy are asynchronous and can be cancelled. The project itself is the
  original the frames are compared with (read only), so nothing is copied twice. A project that links outside itself is refused, because a write through such a
  link would leave the copy.
- **Requests are fenced.** Every invoke channel passes the IPC registrar, which calls `checkDesignFence`
  (`electron/lib/designMode/designFence.ts`). While the mode is on only the channels in `DESIGN_CHANNELS` run;
  everything else (git, publishing, the terminal, the AI agent, Stacki apps, secrets, MCP writes, remote content
  writes, app settings, recents, and any channel added later) is refused. git's branch question is answered
  "no repository", so the shell's polling never shows a refusal; the shell's read-only polls of apps, publishing
  state and secret names are answered from the copy for the same reason. A request that runs must name the copy
  as its project, may not name a path in the project, and may not climb out with `..`.
- **Writes are fenced.** `electron/lib/designMode/designWriteGuard.ts` wraps every Node file system call that
  creates, changes or removes a file. While the mode is on, a write outside the copy, Stacki's data folder and the
  temporary folder fails with EACCES before it runs, whatever code path made it.
- **The window shows what can work.** Features a copy cannot give (history and git, with the title
  bar's pull button and ⌥⇧G, publishing, apps, project
  secrets and MCP settings, roles, the command line) are hidden through the app's own "View as" preview
  (`src/app/designMode/designRole.ts`). The AI panel stays, for its mode buttons; sending a prompt is refused.
- **The copy does not outlive the session.** It is deleted, with its `.env`, when the window leaves it, when the app
  quits, and, for a copy a crash left behind, the next time the app starts.
- **Undo history from before is cleared**, on the way in and on the way out: the window reloads, as it does for any
  project switch. A toast says so each time.
- **Drafts** (each frame's changed files, its place and its snapshot, which is the page as rendered) are kept in
  `<user data>/design-drafts/<hash>/`, mode 0700, never in the project. Secret files (`.env*`, key files) are never
  kept in a draft.

`test/electron/handlers/designMode/designSession.test.ts` holds each of these properties with real folders;
`test/renderer/app/designMode/designModeSoak.test.js` runs them in the real app and checks the project folder is
byte-identical afterwards.

## Removing it

1. Delete these folders and files:
   - `src/app/designMode/`
   - `electron/handlers/designMode/`
   - `electron/lib/designMode/`
   - `shared/ipc/designSession.ts`
   - `shared/ipc/designSnapshot.ts`
   - `electron/preload/designMode/`
   - `src/features/style/model/inlineDefault.ts`
   - `src/features/ai/aiHold.ts`
   - `test/renderer/app/designMode/`
   - `test/electron/handlers/designMode/`
2. Revert these lines, each marked `Design mode (experimental)`:
   - `src/app/shell/AppShell.tsx`: the `import { DesignModeHost } …` line and the `<DesignModeHost app={app} />` line.
   - `electron/main.ts`: the two imports (`registerDesignModeHandlers`, `designFenceState`), the
     `registerDesignModeHandlers(…)` line, and in `relaunchApp` the two `fence` lines, back to
     `fs.writeFileSync(reopenFile(), JSON.stringify({ path: openProjectRoot }), 'utf8');`.
   - `electron/lib/ipcRegistrar.ts`: the `checkDesignFence` import, the `const fenced = …` line and the
     `if (fenced.kind === 'answer') { … }` block after it.
   - `electron/preload/preload.ts`: the `designSnapshotFrame` import, the `else if (… isDesignFrameDocument())` branch
     with its comment, and `listenForDesignSnapshots();`.
   - `electron/preload/preloadBridge.ts`: `designSession: invoke('design:session'),`.
   - `shared/ipc/ipcPayloads.ts`: the `DESIGN_SESSION_PAYLOADS` import and its spread.
   - `shared/ipc/ipcResults.ts`: the `DesignSessionResults` import, the comment line above `IpcResults`, and
     `, DesignSessionResults` in its `extends` list.
   - `shared/ipc/preloadApi.ts`: `readonly designSession: 'design:session';`.
   - `src/features/style/embed/useInlineTarget.ts`: the `inlineDefault` import, `|| startsInline(style, inline)` in
     `inlineTargetOf`, the `startsInline` function, the `style.kind === 'none'` branch in `useInlineCard`, the `useInlineByDefault(…)` call in `useInlineCard`, and the
     `useInlineByDefault` function at the end of the file.
   - `src/features/ai/AiPanel.tsx`: the `useAiHold` import, the `const hold = useAiHold();` line, and `hold` in
     `blocked`, the prewarm's `eligible`, the setup detection effect and the trust card's condition.
   - `studio/scripts/shared-source.json`: the `shared/ipc/designSession.ts`, `shared/ipc/designSnapshot.ts` and
     `src/features/style/model/inlineDefault.ts` entries.
   - `test/shared/ipc/ipcPayloads.test.ts`: the `'design:session'` sample.
   - `test/electron/app/mainBoundaries.test.ts`: the Design mode comment line, and the channel count back to 341.
   - `test/electron/documents/singleWriter.test.ts`: the comment and the four `electron/handlers/designMode/` entries.
3. Optionally delete `design-drafts/` (and `design-sandboxes/`, which is empty unless the app crashed during a
   session) from Stacki's user data folder: once the feature is gone nothing reads or sweeps them.

Kept on purpose: the mode buttons and their registry (`src/features/ai/panelModes.ts`, `sessions/ModeButtons.tsx`),
which belong to comment pins too. Nothing outside the lists above changes.

Left behind: the `brush` entry of `src/ui/central/centralGeometry.tsx` (Central's "brush, color"), which only
Design mode draws (its header button). Delete that entry too, unless another icon has come to use it.
