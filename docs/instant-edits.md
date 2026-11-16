# Instant edits

The product rule: **an action shows its result on the canvas in the frame it is made in.** The page
is written, compiled and rendered afterwards, and the rebuilt page replaces what was shown; it is
never what the person waits for. Everything shown ahead of a write is **view only**: it lives in the
frame's DOM and is never written to disk by itself.

## The contract

1. **Plan, then show.** The editor plans the edit (the same plan the writer is given), and only after
   the edit is accepted (placement rule passed, `commitEdit` returned true) does it tell the canvas.
   A refused place never shows anything.
2. **Same task as the patch.** The morph client takes every shown change back just before it patches
   and puts it back right after when the rendering is of the old source (`avb:before-morph`,
   `avb:after-patch`; judged by the source stamps), so nothing flashes or jumps and nothing is
   shown twice.
3. **Refusal reverts.** `onRefusedGesture` (`src/app/state/appLifecycle.ts`) sends the revert
   messages; a rendering that never comes takes the change away after a bound.
4. **Bounded.** Changes shown at once, elements per change and the hold time have stated limits.
5. **Selection does not wait.** The new node's id is made before the edit and selected with it.

## Actions and strategies

| Action | Strategy | Where |
|---|---|---|
| Insert element or component | Stand-in drawn at the node's future path (element from the writer's template; component as a labelled neutral block) | `shared/page/canvasInsert.ts`, `electron/preload/framePendingInsert.ts`, `src/editor/canvasInsertShow.ts` |
| Delete | Elements hidden at once | `electron/preload/framePendingDelete.ts` |
| Reorder | Elements moved at once, paths renumbered | `shared/page/canvasMove.ts`, `electron/preload/frameMove.ts` |

## The write path (every action)

An app write tells the dev server (`/__avb/touch`, `DevServers.touch`) instead of waiting for its
file watcher, and the watcher's later event for the same bytes is dropped. Measured on the generated
fixture (`npm run bench:insert`): the canvas showed a written node after about 110 ms, of which about
85 ms was the watcher; it is now about 45 ms.

## Measuring

`npm run bench:insert` starts the real main process and the real dev server on a generated project
and reports the stages (write reply, fetch start, fetch end, node on the canvas) for p, div, Section
and Image. `shared/core/stageTrace.ts` is the trace helper (off by default, free when off).

## Tests

`test/shared/page/canvasInsert.test.ts`, `test/electron/preload/framePendingInsert.test.js`,
`test/shared/core/stageTrace.test.ts`.

## For `docs/enforcement.md` (owner approval needed)

A test that fails when a canvas-affecting action has no declared optimistic strategy, derived from
the edit planner's operation types, is the next slice; it is not in place yet.
