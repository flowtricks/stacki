// Every operation the planner can write, and how the canvas shows it before the write lands.
//
// Why a table typed over the planner's own operation tags: a new operation added to
// `Operation` (shared/engine/intent.ts) is a compile error here until someone says how its
// result reaches the canvas at once, or why it cannot be predicted. The product rule is in
// docs/instant-edits.md: an action shows its result in the frame it is made in.
//
// `shipped` names the module that does it; `planned` is an honest gap, listed so it cannot be
// forgotten and so a test can count it. A `closest` strategy is the fallback for an operation
// whose result needs the server (a rename that changes what a component renders): the old DOM
// stays, and an updating cue shows after a short wait, never a blank.

import type { OperationTag } from './intent';

export type InstantStrategy = 'stand-in' | 'hide' | 'move' | 'class-patch' | 'live-rule' | 'text-session' | 'attribute' | 'closest' | 'not-canvas';

export type InstantEntry =
  | { readonly status: 'shipped'; readonly strategy: InstantStrategy; readonly module: string }
  | { readonly status: 'planned'; readonly strategy: InstantStrategy; readonly reason: string };

export const INSTANT_EDITS: Readonly<Record<OperationTag, InstantEntry>> = {
  'insert-node': { status: 'shipped', strategy: 'stand-in', module: 'electron/preload/framePendingInsert.ts' },
  'remove-node': { status: 'shipped', strategy: 'hide', module: 'electron/preload/framePendingDelete.ts' },
  'move-node': { status: 'shipped', strategy: 'move', module: 'electron/preload/frameMove.ts' },
  'set-attribute': {
    status: 'planned',
    strategy: 'attribute',
    reason: 'class edits are shipped (frameQueries.ts applyClassPatch); other attributes still wait for the render',
  },
  'remove-attribute': { status: 'planned', strategy: 'attribute', reason: 'same as set-attribute' },
  'set-inline-style': { status: 'shipped', strategy: 'live-rule', module: 'electron/preload/frameLiveRules.ts' },
  'apply-code-patch': { status: 'shipped', strategy: 'not-canvas', module: 'electron/preload/frameText.ts' },
  'edit-frontmatter-slot': { status: 'planned', strategy: 'closest', reason: 'frontmatter changes data the page renders; the cue shows until the render' },
  'revert-splices': { status: 'planned', strategy: 'closest', reason: 'undo applies the inverse of what was shown; inverse patches are the next slice' },
  'rename-tag': { status: 'planned', strategy: 'closest', reason: 'a tag rename can change what a component renders' },
  'rename-attribute': { status: 'planned', strategy: 'attribute', reason: 'follows set-attribute' },
  'rename-binding': { status: 'planned', strategy: 'closest', reason: 'a binding rename changes data the page reads' },
  'rewrite-node': { status: 'planned', strategy: 'text-session', reason: 'text edits show in the canvas text session; the rest waits for the render' },
  'append-body': { status: 'planned', strategy: 'stand-in', reason: 'first node of an empty page: nothing to stand beside' },
  'insert-frontmatter': { status: 'planned', strategy: 'not-canvas', reason: 'writes no markup' },
  'wrap-nodes': { status: 'planned', strategy: 'stand-in', reason: 'wrapping moves a run into a new element' },
  'rewrite-text': { status: 'planned', strategy: 'closest', reason: 'a program rewrite of a file: stylesheet rules show live, others wait' },
};
