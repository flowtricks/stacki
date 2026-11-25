// Every operation the planner can write, and how the canvas shows it before the write lands.
//
// Why a table typed over the planner's own operation tags: a new operation added to
// `Operation` (shared/engine/intent.ts) is a compile error here until someone says how its
// result reaches the canvas at once, or why it cannot. The product rule is in
// docs/instant-edits.md: an action shows its result in the frame it is made in.
//
// `shipped` names the module that does it. `unpredictable` is an operation whose result only the
// server knows (typed code, data the page reads); it says why, and the closest honest feedback is
// the model diff's "updating" cue (shared/page/canvasEdit.ts) where a node is named, never a blank.
// There is no `planned`: a gap is either closed or explained.

import type { OperationTag } from './intent';

export type InstantStrategy = 'stand-in' | 'hide' | 'move' | 'class-patch' | 'live-rule' | 'text' | 'attribute' | 'tag' | 'closest' | 'not-canvas';

export type InstantEntry =
  | { readonly status: 'shipped'; readonly strategy: InstantStrategy; readonly module: string }
  | { readonly status: 'unpredictable'; readonly strategy: 'closest' | 'not-canvas'; readonly reason: string };

const EDIT = 'electron/preload/framePendingEdit.ts';
const INSERT = 'electron/preload/framePendingInsert.ts';

export const INSTANT_EDITS: Readonly<Record<OperationTag, InstantEntry>> = {
  'insert-node': { status: 'shipped', strategy: 'stand-in', module: INSERT },
  'remove-node': { status: 'shipped', strategy: 'hide', module: 'electron/preload/framePendingDelete.ts' },
  'move-node': { status: 'shipped', strategy: 'move', module: 'electron/preload/frameMove.ts' },
  'set-attribute': { status: 'shipped', strategy: 'attribute', module: EDIT },
  'remove-attribute': { status: 'shipped', strategy: 'attribute', module: EDIT },
  'rename-attribute': { status: 'shipped', strategy: 'attribute', module: EDIT },
  'set-inline-style': { status: 'shipped', strategy: 'live-rule', module: 'electron/preload/frameLiveRules.ts' },
  'rename-tag': { status: 'shipped', strategy: 'tag', module: EDIT },
  'rewrite-node': { status: 'shipped', strategy: 'text', module: EDIT },
  'revert-splices': { status: 'shipped', strategy: 'closest', module: 'src/editor/canvasEditShow.ts' },
  'wrap-nodes': { status: 'shipped', strategy: 'stand-in', module: INSERT },
  'apply-code-patch': {
    status: 'unpredictable',
    strategy: 'closest',
    reason: 'Typed code is arbitrary text: what it renders is known only once the server compiles it.',
  },
  'edit-frontmatter-slot': {
    status: 'unpredictable',
    strategy: 'closest',
    reason: 'Frontmatter is code that feeds the page; its effect on the markup is known only to the server.',
  },
  'rewrite-text': {
    status: 'unpredictable',
    strategy: 'closest',
    reason:
      'A program rewrite of a file (a stylesheet rule, a CMS entry): stylesheet rules already show live (frameLiveRules.ts), the rest is data the server renders.',
  },
  'append-body': { status: 'unpredictable', strategy: 'closest', reason: 'The first node of an empty page has no rendered sibling or parent to stand beside.' },
  'rename-binding': {
    status: 'unpredictable',
    strategy: 'not-canvas',
    reason: 'A renamed variable renders the same page; there is nothing to show before the write.',
  },
  'insert-frontmatter': { status: 'unpredictable', strategy: 'not-canvas', reason: 'Writes no markup: the canvas has nothing to show.' },
};
