// Whether the pointer is inside the outline of a node that has no element.
//
// A loop, a condition, a Fragment or a component with several roots puts no box
// of its own on the page: its outline is the union of what it renders. The
// browser can only ever answer with an element, so the space between a loop's
// items comes back as the element holding them, and the outline drawn around
// that space could not be clicked. The canvas measures those unions and asks
// this module, which is pure: boxes in, decision out, so the rule is tested
// without a page (the DOM side is frameUnionTarget.ts).
//
// The rule: of the unions holding the point, the smallest wins, because a nested
// union sits inside the one around it. Equal boxes go to the outermost node. A
// condition and the branch it rendered always measure the same, and the then
// branch has no Navigator row (src/editor/branches.ts): selecting it would pick
// a node the tree cannot show or leave with the arrow keys.

import { assert } from '../../shared/core/assert';
import { type Box } from './frameBasics';
import { boxHolds } from './pseudoHit';

/** At most this many occurrences are measured for one element under the pointer. */
export const UNION_RUNS_MAX = 256;

/** One occurrence of a node that draws a union, with the box it draws in viewport pixels. */
export interface UnionCandidate {
  readonly path: string;
  readonly occurrence: number;
  readonly box: Box;
}

/** The union under the point (x, y), or undefined when the point is outside all of them. */
export function unionAt(x: number, y: number, candidates: readonly UnionCandidate[]): UnionCandidate | undefined {
  assert(Number.isFinite(x), 'unionAt: x is a finite number');
  assert(Number.isFinite(y), 'unionAt: y is a finite number');
  assert(candidates.length <= UNION_RUNS_MAX, 'unionAt: candidates are capped');
  let best: UnionCandidate | undefined = undefined;
  for (const candidate of candidates) {
    if (boxHolds(candidate.box, x, y)) {
      best = best === undefined ? candidate : innermost(best, candidate);
    }
  }
  return best;
}

// The first of two unions holding the same point unless the second sits inside it.
function innermost(held: UnionCandidate, next: UnionCandidate): UnionCandidate {
  const heldArea = areaOf(held.box);
  const nextArea = areaOf(next.box);
  if (nextArea < heldArea) {
    return next;
  }
  if (heldArea < nextArea) {
    return held;
  }
  return depthOf(next.path) < depthOf(held.path) ? next : held;
}

function areaOf(box: Box): number {
  const area = (box.right - box.left) * (box.bottom - box.top);
  assert(area > 0, 'areaOf: a box holding a point has area');
  return area;
}

function depthOf(nodePath: string): number {
  assert(nodePath.length > 0, 'depthOf: a node has a path');
  return nodePath.split('.').length;
}
