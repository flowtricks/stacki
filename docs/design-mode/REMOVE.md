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
- **A frame is the page as scrolled through** (`designSettle.ts`). The covered live canvas has never been
  scrolled, so before it is copied it is walked top to bottom: once when it is a new document, is drawn at another
  size, or holds elements the last walk never saw. Finite CSS and Web animations are finished at once; script
  animations are waited for until the page stops writing (400 ms quiet, 1.4 s while something the script hid is
  still hidden; an element written for 3 s without a pause is a loop). A walk takes at most 12 s. A second walk
  reads what only holds on screen (a scrubbed value, a reversing reveal, a view timeline, a canvas or video's
  picture) while each element is nearest the middle, and writes it on the copy only, never over a value changed
  since. Every copy is taken with the page at its top, and the canvas is put back where it was scrolled. The
  canvas is never walked while the pointer button shows it, nor is the person's own preview before the copy opens
  (a new session's first frame is a skeleton until the copy's own picture arrives).
  What a still frame shows instead of motion: a pinned sequence (`.pin-spacer`) appears once, as it starts,
  without its scroll room; an endless animation or marquee at a still point; a canvas or video as one picture
  (an `<img>` stands for a canvas, which Chromium collapses where scripts are off, so a rule that names the
  `canvas` tag does not reach it). A canvas that reads blank leaves what lies under it showing. Not reached:
  closed shadow roots, other origins' frames and pixels, content inside the page's own scrolling boxes, and an
  entrance that starts more than 1.4 s after the page has otherwise stopped.
- **Pictures in frames:** Astro's dev server refuses another origin's no-cors requests (its Sec-Fetch check), which is
  what a frame on the app's origin sends, so a snapshot carries its same-origin pictures, posters and fonts in
  itself (`designSnapshotAssets.ts`), within a budget; past it a picture shows broken in the frame only.
- **Live previews** (hovering a value, scrubbing) restyle the preview without saving; the preview reports what they
  change and the shown frame is restyled in place (`designLiveMirror.ts`, `designLiveApply.ts`).
- **Put away while the mode is on:** the top toolbar's size, guide and breakpoint controls (the pointer button stays
  and shows the shown frame live), their digit keys, and "Set component defaults"; main refuses project settings
  writes.
- **After a crash** the copy, its `.env` and its dev server stay until Stacki next starts, which stops the server and
  deletes the copy (see "Stopping what a crash left running").
- **Bounds:** 8 frames; 20,000 elements and 6,000,000 characters a snapshot; 32,000,000 characters of snapshots
  together.
- **Moving and resizing:** a drag in a frame moves the element there with the CSS `translate` property, snapping to
  its holder and siblings; the picked element's handles set `width` and `height`. Both are written as the element's
  inline style through the editor's own write (so ⌘Z takes them back), in rem.
- **Frame widths** (`designFrameWidth.ts`): a drag of either side of a frame, as of an artboard (the other side stays;
  Escape puts it back), or the number beside the picked frame's name, sets that frame's width, 280 to 7680 px (the
  editor's canvas limits). During a drag only the frame's own document is resized, so its media queries answer with
  no new picture. On release the editor's canvas under Design mode takes the width (`useFrameWidthSync.ts`), so the
  frame is pictured again there and the style panel's breakpoint follows. A width the canvas gets from anything else
  (a breakpoint or Base picked in the style panel's dropdown) becomes the shown frame's; picking "Inline styles"
  never gives it one. The first resize gives every frame a
  width; widths are kept in the session and the draft beside each frame's place. Like a frame's place, a width is not
  in undo history. Start over forgets them, and leaving comes back to the project on Desktop.
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
  removed frame. Frames run no script, so a frame is one still state of the page (below).

## Where it is offered

macOS, Windows and Linux, labelled experimental on its header button. `designModeAvailable` in
`shared/ipc/designSession.ts` is the one rule: on any other system the window draws no button and registers nothing,
and main refuses every `design:session` request, makes no copy and installs no write guard. The startup sweep runs
everywhere. Studio and the demo never mount Design mode. A system belongs in the rule only where stopping what a crash
left running from a copy works there; `test/electron/handlers/designMode/` runs on all three in CI. The app-level soaks
in `test/renderer/app/designMode/` drive the real pointer, so like every pointer probe they run on macOS only: on
Windows and Linux the mode's window has not been driven by a test.

Where the systems differ: only macOS clones `node_modules` in one call (elsewhere it is copied, which is slower and
cannot be cancelled until it ends). On Windows a folder linked inside the project is copied as a junction; a file
linked inside it needs the right to make symbolic links, without which the mode says the copy failed; and a
`node_modules` whose top-level entries are junctions with whole paths (pnpm) is refused as linking outside the copy.

## Stopping what a crash left running

`electron/handlers/designMode/designLeftovers.ts` stops what runs from a copy before the copy is deleted.

- **Which processes:** one whose program is a file in the copy; or a JavaScript runtime (Node, Bun, Deno, Electron,
  Stacki's own program; on Windows also `cmd.exe` running a package shim) whose command line names a path in the copy,
  or, on Linux, whose working directory is in it; or a runtime one of those started. Never this app or what started it.
  An editor, a log viewer, a shell or a browser is left alone, even when it names the copy or the server opened it.
- **How they are read:** Linux `/proc`, macOS `ps`, Windows PowerShell's `Win32_Process` (it gives no working
  directory, and keeps parent ids after the parent has gone, so a child older than its parent is not followed).
- **How they are stopped:** one process id at a time, three rounds at most of one signal and 3 seconds each (SIGTERM,
  then SIGKILL; Windows ends a process either way), each round after a fresh listing.
- **Deleting:** a delete the system refuses for the moment is retried 5 times over 3 seconds. A copy that still will
  not go, or that something still runs from, loses its secret files on their own (`.env*`, `.dev.vars`, key files) and
  stays in `design-sandboxes/`: every later start, and every time the mode begins, tries it again. It holds back no
  other copy, and neither it nor quitting raises an error. Where the processes cannot be read at all (PowerShell
  blocked by policy), deleting is still tried.

`test/electron/handlers/designMode/designLeftovers.test.ts` holds this with real leftover processes and real folders.

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
  quits, and, for a copy a crash left behind (or one that would not go), the next time the app starts.
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
   - `test/electron/preload/designSnapshotChromium.test.js` and `test/fixtures/design-snapshot/`
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
   - `src/features/style/embed/useInlineTarget.ts`: the `inlineDefault` import, the block in `useInlineState` that
     forgets another node's pick (`if (pick !== undefined && … inlineDefault() === 'inline')`), `|| startsInline(style, inline)`
     in `inlineTargetOf`, the `startsInline` function, the `style.kind === 'none'` branch in `useInlineCard`, and the last
     line of `attributePicked`, which becomes `return false;`; in `select`, the `if (inlineDefault() !== 'inline')` around
     `showBase();`, which stays.
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
   - `scripts/gate/testSuites.ts`: the comment and the four `test/renderer/app/designMode/` entries that run alone.
3. Optionally delete `design-drafts/` (and `design-sandboxes/`, which is empty unless the app crashed during a
   session) from Stacki's user data folder: once the feature is gone nothing reads or sweeps them.

Kept on purpose: the mode buttons and their registry (`src/features/ai/panelModes.ts`, `sessions/ModeButtons.tsx`),
which belong to comment pins too. Nothing outside the lists above changes.

Left behind: the `brush` entry of `src/ui/central/centralGeometry.tsx` (Central's "brush, color"), which only
Design mode draws (its header button). Delete that entry too, unless another icon has come to use it.
