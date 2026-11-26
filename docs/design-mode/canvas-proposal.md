# Design mode as a Figma-style canvas: proposal and handover

Status: proposal, not built. Branch `design-sandbox` (worktree `.claude/worktrees/agent-a4d565c2646a82b9b`), on top of
integration `ac15d16d`. Read `docs/design-mode/REMOVE.md` first: it describes what exists today.

## What the owner asked for

> design mode should default me to this canvas view. duplicating a frame should be as simple as clicking on it, holding
> option key and dragging to duplicate instead of having ui buttons. or right click on frame and click duplicate. also
> select frame and press delete key to remove. frames need to load instantly. i also don't see any option to freely
> drag elements around like we could in figma or unlink component. this needs to work like figma where i can freely
> drag and edit elements and select elements inside this canvas view

Read as requirements:

1. Entering Design mode shows the pan/zoom canvas with every frame. There is no separate Compare view and no frame tabs.
2. Frame gestures: Option+drag a frame duplicates it; right-click > Duplicate; select a frame and press Delete to
   remove it. The bar's frame buttons go.
3. Every frame is visible, rendered and editable in place. In any frame you can select elements, drag them freely with
   snapping, resize them, edit text, change props and variants, and unlink a component instance. The real Navigator,
   Style and Settings panels follow the selection.
4. Nothing is saved to the project.
5. Frames appear instantly: duplicating is immediate, with no dev server wait.
6. Light on memory on a Mac with a large project: one dev server at most and no renderer process per frame.

## What exists today

The **sandbox copy**: entering copies the site (a bounded, asynchronous copy) to the app's data folder and reopens the
window on it.

- **Panels:** the real panels edit that copy.
- **Frames:** each frame is a set of changed files; one frame is live at a time and the others are pictures.
- **Fence:** IPC allowlist plus file-system write guard, so the project is never written.

The **first version** (commit fd07860d and earlier on `worktree-agent-a4d565c2646a82b9b`) was different: snapshot
documents in sandboxed iframes, each frame its own DOM copy. It had free drag with snapping, unlink, a Layers panel,
and its own Style panel writing inline styles. That code is in git history: `src/app/designMode/model/*`,
`runtime/*`, `ui/*`, and `electron/preload/designMode/*` for the page snapshot with fonts and stylesheets inlined.

### Bugs in the current Compare board (from the owner's screenshot)

- **Nested picture in the "Original" tile:** the picture is a screenshot of the canvas box taken while the board was
  open, or before the board's own frame was hidden, so it captured the board.
  - Fix: capture only while the board is closed, never from inside it.
  - Better: drop pictures entirely (see the recommendation).
- **"Original copy" is a blank grey box:** a duplicated frame gets a picture only once it has been shown and left. A
  frame never shown has no picture, and the skeleton stays until it is opened.
  - Fix: copy the source frame's picture on duplicate (done for the in-memory map, but lost after a reload).
  - Better: render frames live, as below.

## Options

### (a) DOM snapshot frames driven by the real panels through an adapter

How it works:
- Each frame is a same-origin sandboxed iframe holding a snapshot of the live page's DOM, with styles inlined and
  scripts stripped.
- The real panels act on a "host" adapter (the style panel already talks to a host interface:
  `src/features/style/model/host.ts`) that reads and writes the frame's DOM instead of the page model.

What each operation does:
- **Inline style edits:** `style` attribute on the frame's element. Trivial.
- **Selector edits:** the frame keeps its own `<style>` overrides. Each panel write to a rule (`.hero { … }`) becomes
  a rule in a per-frame stylesheet, so the frame's look changes and the project does not. The panel's cascade reading
  comes from the frame's CSSOM.
- **Navigator:** a tree built from the frame's DOM, with node ids from snapshot markers (`data-avb-*`).
- **Props and variants:** re-render the component with the new props through the dev server (Astro container API,
  `POST /__avb/design-render`, which existed in the first version) and swap the element's subtree.
- **Unlink:** stop treating the subtree as an instance. Natural.
- **Free drag:** absolute positioning inside the frame, with snapping. Natural.

Cost and safety:
- **Instant:** a duplicate is a DOM clone, so no wait.
- **Memory:** one renderer and one dev server. Each frame is a same-process iframe, so DOM memory per frame is roughly
  the page's size (a few MB to tens of MB for big pages). Budget: 8 frames ≤ about 300 MB.
- **No-write:** nothing reaches a file at all. The fence is trivial: no write IPC is offered.

What it cannot do:
- No scripts run: JS-driven layout is frozen at snapshot time, islands are inert, and shadow DOM is flattened.
- Props re-render needs page context: components that read `Astro.url` or collections render out of context.
- The panels' file-oriented features need an adapter or must be hidden: "CSS file" pickers, variables files,
  component source editing, and the Navigator's frontmatter.
- The AI hand-off describes DOM and CSS changes, not source diffs: the AI has to translate them back to source.
- Building it means a second implementation of the panel host for every panel the owner expects to follow the
  selection. That is a large adapter, and the main risk.

### (b) The sandbox copy extended to many live frames

How it works:
- Each frame is its own copy of the site with its own dev server and canvas iframe.
- The real editor (one window) edits one frame at a time; the others render live but are read-only.

What each operation does:
- **Selector edits, props, source:** all real.
- **Fidelity:** full, with scripts and islands running.
- **Free drag:** only by writing `position: absolute` into source (ugly) or by a canvas-only overlay. Unnatural.
- **Unlink:** only by rewriting source: inline the component's markup into the page, which is a source transform.

Cost:
- **Not instant:** a duplicate means copying files, then dev server start, then render, about 3–8 s.
- **Memory:** one dev server per frame (Astro dev at 200–400 MB each) and one renderer frame each. Eight frames is
  about 3 GB. This conflicts with requirement 6.

What it cannot do: instant frames, a light memory budget, or natural free drag.

### (c) Hybrid: one live sandbox as the source of truth, instant DOM clones as the editable frames

How it works:
- **One live copy:** a single sandbox copy (today's) with one dev server renders the page for real. That render
  feeds every frame.
- **Frames:** each frame is a DOM clone of that render, made instantly, edited in place. Every frame stays editable,
  as in (a).
- **Panels:** the real panels follow the selection in whichever frame it is in, through the frame adapter from (a).

What each operation does:
- **Inline style:** written to the frame's element.
- **Selector edits:** go to a per-frame override stylesheet. Writing them to the sandbox source would change every
  frame, because the frames share one copy.
- **Props, variants and anything that needs a real render:** the frame asks the live sandbox to render once, with
  that change applied in a scratch copy of the file, then clones the result into that frame. Scripts and context are
  real for that one render.
- **Free drag, resize, unlink:** in the frame's DOM, as in (a).
- **Text edits:** in the DOM, recorded as a change.

Cost and safety:
- **Instant:** duplicate = clone.
- **Memory:** one dev server, one renderer, and N same-process frames. Budget below.
- **No-write:** the sandbox fence stays. Frames write nothing; scratch renders happen inside the sandbox copy, never
  the project.

What it cannot do:
- Scripts do not run inside the frames themselves (frozen DOM), only in the live render that feeds them.
- A selector edit is per frame, not written to the source file until "Send to AI" describes it.
- Same adapter cost as (a), but the real render covers props and context, the hardest part of (a).

## Recommendation: (c), in phases

The owner's words ("work like Figma", "instantly", "freely drag", "unlink") describe (a)'s interaction model, and (c)
keeps (a)'s instant, light frames while borrowing the live sandbox's real render for props and context.

| Phase | What | Done when |
|---|---|---|
| 1. Canvas is Design mode | On entry, the pan/zoom canvas shows the page as frame 1: a DOM snapshot of the live sandbox render, using the first version's `electron/preload/designMode/designModeFrame.ts` snapshot, revived. Option+drag a frame duplicates it (DOM clone, instant); right-click > Duplicate and Delete. Remove frame tabs, Compare and the picture capture. | Duplicating 4 frames takes under 100 ms each; no blank or nested tiles |
| 2. Select and edit in frames | Revive the first version's hit-testing, selection layer, free drag with snapping, resize, text editing and unlink (`model/designDom.ts`, `designSnap.ts`, `designSelect.ts`, `designDrop.ts`) on the new canvas, with undo per frame | The first version's soak gestures pass on the new canvas |
| 3. Real panels follow the selection | A frame host adapter for the Style panel first (`src/features/style/model/host.ts` interface): inline default writes the element's `style`, selector edits write a per-frame override sheet; the panel reads computed and matched rules from the frame. Then the Navigator, from the frame DOM. Then Settings (props and variants), through phase 4. | Style, Navigator and Settings edits change only the selected frame; check:changed and the soak pass |
| 4. Real renders for props | Settings changes call the live sandbox, which renders the component with the new props in a scratch file inside the copy (or the container API); the frame swaps the subtree | Variant switch on a Lumos component re-renders in under 1 s |
| 5. Send to AI | Per frame: picture (rendered from the frame), DOM and CSS change list (first version's `designChanges.ts`), and source diffs where phase 4 touched source | The AI draft carries each frame's picture and changes |

Keep from today:
- the sandbox copy and fence, with the freeze fix: bounded asynchronous copy, skips at every depth, one dev server,
  cleanup;
- the Modes menu entry;
- drafts;
- REMOVE.md discipline.

Drop:
- frame-as-files switching, the frame tabs and Compare;
- the canvas picture capture for tiles: tiles are live DOM now.

### Memory budget for (c)

| Part | Budget |
|---|---|
| Live sandbox dev server (one; the project's own is stopped while the copy is open) | 250–400 MB |
| Renderer, including frames | Each frame's DOM is held once, no images: about 5–40 MB per frame for typical marketing pages. Cap 8 frames and a per-frame DOM node limit (for example 20,000 nodes), refusing a duplicate past it with a toast |
| Above the normal editor | Total target ≤ 600 MB |

Measured today on the fixture: about 420 MB more during the session (one dev server).

## Risks and open questions

- The frame host adapter is the large piece: each panel section reads through `host.ts` today, but some reach the
  page model or files directly (CSS file pickers, variables, component sources). Those must be hidden or adapted
  per frame.
- Per-frame selector overrides diverge from source: "Send to AI" must describe them clearly, as selector-level CSS.
- Pages whose layout is JS-driven look frozen in frames; the live render (phase 4) only helps for re-rendered
  subtrees.
- Keyboard: Delete removes a frame only when a frame is selected, not an element; Option+drag must not collide with
  the editor's Option chords (the first version's `designCoveredKeys.ts` handled this).

## Handover notes

- **Tests:**
  - `test/electron/handlers/designMode/designSession.test.ts`: sandbox, fence, drafts and preflight.
  - `test/renderer/app/designMode/designModeSoak.test.js`: the real app, hidden window, 30 s step bounds.
  - `test/renderer/app/designMode/designModeBoundary.test.ts`: the seam list.
- **The first version's code:** `git show fd07860d -- src/app/designMode electron/preload/designMode`.
- **Never** run tests or the app against the owner's real project, run only one Electron at a time, and keep
  `npm run check:changed` green.
