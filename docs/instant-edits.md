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
   shown twice.
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
| Insert element or component | Stand-in at the future path (element from the writer's template; component as a labelled neutral block) | `shared/page/canvasInsert.ts`, `framePendingInsert.ts` |
| Duplicate | Deep copy of what the original rendered, paths renamed | same (`clone`) |
| Wrap | Plain wrapper where the node stood, node inside, paths under it renumbered | same (`wrap`) |
| Delete | Elements removed, kept detached | `framePendingDelete.ts` |
| Reorder | Real nodes moved, paths renumbered | `canvasMove.ts`, `frameMove.ts` |
| Attribute, class, prop on a plain element, rename attribute | Set or removed | `shared/page/canvasEdit.ts`, `framePendingEdit.ts` |
| Words of an element, rename tag | Words set, element replaced with children moved | same |
| Component props, expressions, component rename | Old DOM, `updating` cue after 80 ms | same |
| Undo, redo | The step's result applied from the model diff the moment it is installed (including the one node an undo added or removed) | `src/editor/canvasEditShow.ts` |

Every gesture goes through `commitEdit`, which diffs the model before and after; an added or removed
node is shown by the action that made it (insert, delete, duplicate, wrap) or, for undo and redo, by
`showModelChangeOnCanvas`. Studio shares the frame code; its delete, duplicate and component insert
send the same messages (`studio/src/features/project/useEditor.ts`). Studio's attribute, class and
text edits are not wired yet.

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
| Insert Section component | about 1 ms (labelled block) | 129 / 134 | 36 / 40 |
| Insert Image component | about 1 ms (labelled block) | 129 / 149 | 34 / 46 |
| Delete | about 1 ms | 120 / 139 | 36 / 52 |
| Reorder | about 1 ms | 122 / 146 | 35 / 38 |
| Attribute | about 1 ms | 129 / 138 | 34 / 41 |
| Text | about 1 ms | 98 / 147 | 35 / 47 |
| Dependent styles (`:where(:last-child)` margin trim) | same task as the delete (checked in Chromium) | after the render | same task |

The "before" column is the same bench with the app's write announcement not reaching the server
(the state before `cc062913`, and the symlink bug fixed after it). Panel refresh (the style panel's
matched selectors) is one canvas round trip within a frame of the change; it is tested in jsdom
(`test/renderer/style/panelRefresh.test.js`) and not timed.

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
