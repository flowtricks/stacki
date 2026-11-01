// The patch's caps: the node markers one rendering may carry and the
// child-list work one patch may spend, from shared/core/limits.ts as main
// prepends them. Past either, the page reloads, and says why.

import { asElement, asComment } from './morphNodes';

// The patcher's bounds (plan §9, step 7), from shared/core/limits.ts: main prepends
// this constant when it hands the source to the dev plugin — the bridge
// boundary — so the page and the app answer to one number. Past either, the
// page reloads instead of patching, and tells the app why.
declare const AVB_PREVIEW_LIMITS: {
  /** Node markers one rendering may carry. */
  readonly previewMarkersMax: number;
  /** Child-list matrix cells one patch may spend lining renderings up. */
  readonly previewMorphWorkMax: number;
};

// Why the page reloaded instead of patching. The first two are the caps: a
// rendering with more nodes than the canvas may map, or two renderings too far
// apart to line up within the work bound. The others were always reloads.
export type ReloadReason = 'markers-over-cap' | 'diff-over-cap' | 'scripts-changed' | 'patch-failed';

// Thrown where a cap is hit, caught by update(), which reloads for its reason.
export class OverCap extends Error {
  readonly reason: 'markers-over-cap' | 'diff-over-cap';
  constructor(reason: 'markers-over-cap' | 'diff-over-cap') {
    super(`the canvas patch is over its cap (${reason})`);
    this.reason = reason;
  }
}

// The work one patch may still spend. update() refills it before each patch;
// diffChildren draws on it before it allocates a matrix, so the cap is hit
// before the memory is taken, never after.
let morphWorkLeft = AVB_PREVIEW_LIMITS.previewMorphWorkMax;
export function refillMorphWork(): void {
  morphWorkLeft = AVB_PREVIEW_LIMITS.previewMorphWorkMax;
}
export function spendMorphWork(cells: number): void {
  if (morphWorkLeft < cells) {
    throw new OverCap('diff-over-cap');
  }
  morphWorkLeft -= cells;
}

// The node markers a rendering carries — one pair per rendered copy of a node.
// Counted by walking, and the walk stops at the cap: it is a bound, not a size.
export function checkMarkerCap(root: ParentNode): void {
  let markers = 0;
  const stack: ParentNode[] = [root];
  while (stack.length) {
    const parent = stack.pop();
    if (!parent) {
      break;
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (asComment(node) && /^avb-s:/.test(node.data)) {
        markers++;
        if (markers > AVB_PREVIEW_LIMITS.previewMarkersMax) {
          throw new OverCap('markers-over-cap');
        }
      } else if (asElement(node)) {
        stack.push(node);
      }
    }
  }
}
