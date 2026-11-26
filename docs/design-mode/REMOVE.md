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
- **Send to AI** sends one frame (the picked one, else the shown one): pictures of its whole page, top to bottom in
  at most six slices, and one sentence naming the page. Nothing else of the design goes (no source changes, styles or
  positions). It lands in the AI panel's message box and is never sent by itself.
- **The person's page** is noted before each reload and reopened once the editor has opened its own first page
  (`designReturn.ts`), then left alone. A component opened from a page enters on that page; a route a dependency adds,
  and a component opened on its own, are refused. A frame's picture of another page is never drawn.
- **Pictures in frames:** Astro's dev server refuses another origin's no-cors requests (its Sec-Fetch check), which is
  what a frame on the app's origin sends, so a snapshot carries its same-origin pictures, posters and fonts in
  itself (`designSnapshotAssets.ts`), within a budget; past it a picture shows broken in the frame only.
- **Live previews** (hovering a value, scrubbing) restyle the preview without saving; the preview reports what they
  change and the shown frame is restyled in place (`designLiveMirror.ts`, `designLiveApply.ts`).
- **Put away while the mode is on:** the top toolbar's size, guide and breakpoint controls (the pointer button stays
  and shows the shown frame live), their digit keys, and "Set component defaults"; main refuses project settings
  writes.
- **After a crash** the copy, its `.env` and its dev server stay until Stacki next starts, which stops the server and
  deletes the copy (`test/renderer/app/designMode/designModeCrashSoak.test.js`).
- **Bounds:** 8 frames; 20,000 elements and 6,000,000 characters a snapshot; 32,000,000 characters of snapshots
  together.
- **Moving and resizing:** a drag in a frame moves the element there with the CSS `translate` property, snapping to
  its holder and siblings; the picked element's handles set `width` and `height`. Both are written as the element's
  inline style through the editor's own write (so ⌘Z takes them back), in rem.
- **Unlinking a component** (right-click an instance in the shown frame, or its Navigator row: "Unlink component")
  replaces the instance, in the copy's page only, with the plain elements it renders (`designUnlink.ts`). It reads
  the page as the dev server renders it, markers and all (`stacki:design-page-html`, answered by the canvas frame's
  preload), and writes: the component's own elements with their classes and `data-astro-cid-*` scope attributes;
  conditions and loops as they rendered; a component the component places kept as that component when every prop
  and child it is given can be written in the page (`designUnlinkMarkup.ts`); the page's own slot content as its own
  source, without its `slot` attribute. The component's import stays while anything else names it, else becomes a
  bare `import "…";` (Astro gives a page the styles of what it imports, and drops an import nothing renders), and is
  removed only when the component can bring no style (`designUnlinkSource.ts`). The component file and every CSS
  rule are untouched. The write is one step of the editor's history (⌘Z, ⌘⇧Z). The page is then rendered again and
  compared with the rendering before, elements, attributes, text and stylesheets (`designUnlinkCheck.ts`); anything
  else is undone and dropped from redo. Refused with a toast, nothing written: a component that runs a script,
  writes a `<style>` or a framework island into the page, shows a picture at an address only the dev server answers
  (`/_image`, `/@fs/`, `/src/`), draws slot content twice, renders nothing, or is repeated by a page loop.
- **Not yet:** editing text inside a frame; opening a component from a frame; undo for a
  removed frame. Frames run no script, so script-driven layout shows as it was snapshotted.

## Where it is offered

macOS only, labelled experimental on its header button. `designModeAvailable` in `shared/ipc/designSession.ts` is the one
rule: off macOS the window draws no button and registers nothing, and main refuses every `design:session` request,
makes no copy and installs no write guard. The startup sweep still runs everywhere. Why: on Windows and Linux, stopping
a dev server a crash left running from a copy is unverified, so a copy, with the project's `.env`, could be left behind.
Studio and the demo never mount Design mode. To offer it on another platform, verify that cleanup there first, change
the rule, and let the suites in `test/electron/handlers/designMode/` and `test/renderer/app/designMode/` run there.

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
   - `src/features/structure/defaultsMenu.ts`
   - `src/features/structure/unlinkMenu.ts`
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
   - `src/features/structure/StructureContextMenu.tsx`: the `useDefaultsMenu` import and call, and
     `&& defaultsMenu === 'offered'` on the "Set component defaults" rows; the `useUnlinkMenu` import, `'unlink'` in
     `ContextAction`, `'canChange'` in `ComponentMenuHeader`'s props, its `useUnlinkMenu()` call and the row it shows.
   - `src/features/structure/ElementContextMenu.tsx`: the `currentUnlinkMenu` import and the `case 'unlink'` block.
   - `src/features/preview/PreviewToolbar.tsx`: the `is-interaction` class on the pointer button's group.
   - `src/features/ai/AiPanel.tsx`: the `useAiHold` import, the `const hold = useAiHold();` line, and `hold` in
     `blocked`, the prewarm's `eligible`, the setup detection effect and the trust card's condition.
   - `studio/scripts/shared-source.json`: the `shared/ipc/designSession.ts`, `shared/ipc/designSnapshot.ts`,
     `src/features/structure/unlinkMenu.ts` and `src/features/style/model/inlineDefault.ts` entries.
   - `test/shared/ipc/ipcPayloads.test.ts`: the `'design:session'` sample.
   - `test/electron/app/mainBoundaries.test.ts`: the Design mode comment line, and the channel count one lower (it counts `design:session`).
   - `test/electron/documents/singleWriter.test.ts`: the comment and the four `electron/handlers/designMode/` entries.
3. Optionally delete `design-drafts/` (and `design-sandboxes/`, which is empty unless the app crashed during a
   session) from Stacki's user data folder: once the feature is gone nothing reads or sweeps them.

Kept on purpose: the mode buttons and their registry (`src/features/ai/panelModes.ts`, `sessions/ModeButtons.tsx`),
which belong to comment pins too. Nothing outside the lists above changes.

Left behind: the `brush` entry of `src/ui/central/centralGeometry.tsx` (Central's "brush, color"), which only
Design mode draws (its header button). Delete that entry too, unless another icon has come to use it.
