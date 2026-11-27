# Instant edits

The product rule: **an action shows its result on the canvas in the frame it is made in.** The page
is written, compiled and rendered afterwards, and the rebuilt page replaces what was shown; it is
never what the person waits for. Everything shown ahead of a write is **view only**: it lives in the
frame's DOM and is never written to disk by itself.

## The contract

1. **Plan, then show.** The editor plans the edit (the same plan the writer is given), and only after
   the edit is accepted (placement rule passed, `commitEdit` returned true) does it tell the canvas.
   A refused place never shows anything.
2. **Real DOM changes, never hiding.** A shown delete removes the elements (kept detached for
   rollback), an insert, duplicate or wrap adds real nodes, a reorder moves the real nodes. A node
   hidden with `display: none` still counts as a sibling, so `:last-child`, `:first-child`,
   `:only-child`, `:nth-*`, `+`, `~`, `:empty` and margin-trim rules on the neighbours would keep
   matching the page as it was. No optimistic layer adds an inline style or class to a neighbour.
3. **Same task as the patch.** The morph client takes every shown change back just before it patches
   and puts it back right after when the rendering is of the old source (`avb:before-morph`,
   `avb:after-patch`; judged by the source stamps), so nothing flashes or jumps and nothing is
   shown twice. No change to the page's DOM skips this. The patch writes only what two renderings
   disagree about, so a guess left on the page is never corrected by it: a class taken off an
   instance, which its component also writes itself, stayed off until a refresh.
4. **Refusal reverts.** `onRefusedGesture` (`src/app/state/appLifecycle.ts`) sends `avb:move-revert`
   and `avb:insert-revert` (which also takes back deletes and edits); a rendering that never comes
   takes the change away after a bound (20 s; 5 s for a delete).
5. **Bounded.** Changes shown at once, elements per change and the hold time have stated limits.
6. **Selection does not wait.** The new node's id is made before the edit and selected with it.
7. **What cannot be predicted keeps the old DOM** and says `data-avb-updating` (a slight fade) only
   after 80 ms, never a blank. Words are never put into an element being typed in.

## Actions and strategies

`shared/engine/instantEdits.ts` is typed over the planner's operation tags: a new operation does not
compile until it says how it shows (or why it cannot), and `test/shared/engine/instantEdits.test.ts`
reads the operation union, checks every named module exists and that nothing is left `planned`.

| Action | Strategy | Where |
|---|---|---|
| Insert element | Stand-in at the future path, from the writer's template | `shared/page/canvasInsert.ts`, `framePendingInsert.ts` |
| Insert component | A copy of an instance already on the page that is written the same way; otherwise nothing is drawn until the render, and a quiet bar with no label after 600 ms | same, `shared/page/canvasTwin.ts` |
| Duplicate | Deep copy of what the original rendered, paths renamed | same (`clone`) |
| Wrap | Plain wrapper where the node stood, node inside, paths under it renumbered | same (`wrap`) |
| Delete | Elements removed, kept detached | `framePendingDelete.ts` |
| Reorder | Real nodes moved, paths renumbered | `canvasMove.ts`, `frameMove.ts` |
| Attribute, class, prop on a plain element, rename attribute | Set or removed | `shared/page/canvasEdit.ts`, `framePendingEdit.ts` |
| Words of an element, rename tag | Words set, element replaced with children moved | same |
| A class added to or taken off an element or instance (`avb:class-patch`) | Only the names that really changed, taken back like every other shown edit | same |
| Words typed on the canvas, until their save renders | Kept in the page's text nodes, taken back like every other shown edit | `frameTextNative.ts` (`showTypedWords`) |
| Component props, expressions, component rename | Old DOM, `updating` cue after 80 ms | same |
| Undo, redo | The step's result applied from the model diff the moment it is installed (including the one node an undo added or removed) | `src/editor/canvasEditShow.ts` |

Every gesture goes through `commitEdit`, which diffs the model before and after; an added or removed
node is shown by the action that made it (insert, delete, duplicate, wrap) or, for undo and redo, by
`showModelChangeOnCanvas`. Studio shares the frame code; its delete, duplicate, reorder, component
insert and quick-insert pick (elements too, `studio/src/features/components/quickInsertPlan.ts`) send
the same messages (`studio/src/features/project/useEditor.ts`). Studio's attribute, class and text
edits are not wired yet.

## Successive edits over a slow render

A hosted Studio renders in its container and answers over the network, so a rendering can take a
second or more, and the next edit is often made before it lands. Three rules keep that edit instant:

1. **A delete renumbers the page** (`renumberedDeletePath`, `shared/page/canvasMove.ts`), as a move
   and an insert already did, and takes its marker comments with it. The next edit is planned over
   the new source; without this, deleting a paragraph and then the one that moved into its place
   named a path no element carried, and the second delete showed only with its own render.
2. **A change names its base** (Studio): the stamp of the source it was planned over
   (`studio/src/features/collaboration/sourceStamp.ts`). A rendering that carries a change's base was
   rendered from before it, so that change and every later one stay shown, and only the earlier ones
   settle (`pendingKeptFrom`, `electron/preload/frameMove.ts`). Desktop sends no base and settles on
   any newer rendering, as before; its renders land before the next edit.
3. **A render started before a write is dropped** (`studio/src/features/preview/renderPush.ts`): it
   renders a file the room has since replaced. The write's own invalidation renders the page again,
   or a bound (500 ms) does when Vite watches no such file.

Measured with `studio/test/structuralEdits.bench.ts` (in `studio/`: `npm run build`, then
`npx tsx test/structuralEdits.bench.ts`; it builds a disposable fixture, never a real project): a page
whose component takes 700 ms to render, every socket message held 100 ms each way (a stand-in for the
container and the network), first visual change after the key press or drop, in a hidden Chrome. Two
runs of three each, on a loaded machine (load average 12 to 18), 2026-11-21:

| Action | Before (f3f64372) | After |
|---|---|---|
| Quick-insert `<div>` | 943 to 1244 ms (the render) | 4 to 23 ms |
| Delete | 3 to 19 ms | 3 to 19 ms |
| Reorder (from the drop) | 4 to 7 ms | 4 to 6 ms |
| Second delete, made once the Navigator shows the first | 1381 to 1516 ms (its own render) | 6 to 17 ms |

A single delete and a reorder were already shown ahead of the render; what was slow was a pick from
the quick-insert search and every delete made before the previous one's rendering landed, which in a
hosted Studio is most successive deletes. Also fixed and checked by the browser test below: a second
delete made after the first's rendering landed was shown, then came back for a whole render.

`studio/test/structuralInstant.browser.ts` holds each rendering on a gate and checks that every one
of these shows before any rendering arrives, and that no rendering brings a deleted node back.

## The write path (every action)

An app write tells the dev server (`/__avb/touch`, `DevServers.touch`) instead of waiting for its
file watcher, and the watcher's later event for the same bytes is dropped. The server compares real
paths (a project under a symlinked folder, such as macOS `/var`, is the same project).

## Latency (generated fixture, real main process and dev server, 20 runs per row)

First visual change is the real preload in real Chromium (`test/electron/preload/instantEditsChromium.test.js`):
message received to first DOM mutation, about 1 ms for every row. Reconciled is `npm run bench:insert`:
write began to the rendered node on the canvas, median / worst ms.

| Action | First visual change | Reconciled, before | Reconciled, after |
|---|---|---|---|
| Insert p | about 1 ms | 121 / 149 | 37 / 71 |
| Insert div | about 1 ms | 128 / 133 | 33 / 43 |
| Insert Section component | about 1 ms (the labelled block of that day) | 129 / 134 | 36 / 40 |
| Insert Image component | about 1 ms (the labelled block of that day) | 129 / 149 | 34 / 46 |
| Delete | about 1 ms | 120 / 139 | 36 / 52 |
| Reorder | about 1 ms | 122 / 146 | 35 / 38 |
| Attribute | about 1 ms | 129 / 138 | 34 / 41 |
| Text | about 1 ms | 98 / 147 | 35 / 47 |
| Dependent styles (`:where(:last-child)` margin trim) | same task as the delete (checked in Chromium) | after the render | same task |

The "before" column is the same bench with the app's write announcement not reaching the server
(the state before `cc062913`, and the symlink bug fixed after it). Panel refresh (the style panel's
matched selectors) is one canvas round trip within a frame of the change; it is tested in jsdom
(`test/renderer/style/panelRefresh.test.js`) and not timed.

Component inserts since 2026-11-25, in the real app on a copy of the Lumos framework (RichText,
Accordion, Card, Heading): the first visible change is the real content, 111 to 199 ms
after Enter (written at 46 to 82 ms, then one page render and patch); a second RichText written like
the first showed its content at 19 ms and did not move when the render landed. A component that took
1.8 s to render got the bar at 621 ms.

Not measured: duplicate, wrap and undo and redo (their first visual change is the same frame code;
undo and redo start after the app's revert call returns, tens of milliseconds at most).

## Measuring

`npm run bench:insert` starts the real main process and the real dev server on a generated project.
`shared/core/stageTrace.ts` is the trace helper (off by default, free when off); the app uses it from
`src/lib/editTrace.ts` (`localStorage.setItem('stacki.trace', 'edits')`, then `stackiEditTrace()`).

## Palette prefetch

While the palette highlights a component, its defaults and import paths are read
(`src/app/model/componentWarm.ts`, kept for 10 s and forgotten on any metadata write), so choosing it
finds them done.

## For `docs/enforcement.md` (owner approval needed)

The operation table test above is the guard: a new planner operation fails the type check and the
test until it declares how the canvas shows it.
