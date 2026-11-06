// The node with no element of its own whose outline the pointer is inside, for
// hover and click.
//
// Thin DOM glue around unionHit.ts. The browser answers with the element under
// the pointer, so only the runs sitting directly in that element can have space
// there that it does not own: the runs a page's own markup put beside each other.
// A run holding one thing is that thing's box, with nothing between to point at.
// It is left out on purpose, or a `pointer-events: none` overlay would take
// clicks from the parent it covers.
//
// Measuring reads every box in those runs, which is not free on every mousemove
// over a page's largest grid, so what was measured is kept briefly while the
// pointer stays over the same element. A click measures afresh (forgetUnionBoxes).

import { assert } from '../../shared/core/assert';
import { isElement, isText } from './frameBasics';
import { boxOfRun } from './frameMeasure';
import { inScope, regions, runsOf } from './frameRegions';
import { UNION_RUNS_MAX, unionAt, type UnionCandidate } from './unionHit';

/** A union the pointer is inside: the node that draws it and which copy of it. */
export interface UnionTarget {
  readonly path: string;
  readonly occurrence: number;
}

// Long enough to skip most of a pointer's moves, short enough that a page which
// scrolled underneath it is put right before anyone can see the difference.
const HOVER_KEEP_MS = 100;

interface KeptUnions {
  readonly best: string | undefined;
  readonly target: Node;
  readonly measuredMs: number;
  readonly candidates: readonly UnionCandidate[];
}

let kept: KeptUnions | undefined;

/** Drops the kept boxes, so the next question measures again (a click must see the page as it is). */
export function forgetUnionBoxes(): void {
  kept = undefined;
}

/**
 * The union under (x, y) drawn by a node below `best`, the node the pointer
 * resolved to, in the element the browser hit. `best` is undefined where that
 * element belongs to no node of the open file: a loop at the top of a page sits
 * in the layout's markup. Undefined when no such union holds the point.
 */
export function unionTargetAt(best: string | undefined, target: Node | undefined, x: number, y: number): UnionTarget | undefined {
  if (target === undefined) {
    return undefined;
  }
  const hit = unionAt(x, y, candidatesFor(best, target));
  if (hit === undefined) {
    return undefined;
  }
  assert(hit.occurrence >= 0, 'unionTargetAt: an occurrence is an index');
  return { path: hit.path, occurrence: hit.occurrence };
}

function candidatesFor(best: string | undefined, target: Node): readonly UnionCandidate[] {
  const nowMs = Date.now();
  if (kept !== undefined && kept.target === target && kept.best === best) {
    if (nowMs - kept.measuredMs < HOVER_KEEP_MS) {
      return kept.candidates;
    }
  }
  const candidates = measureCandidates(best, target);
  kept = { best, target, measuredMs: nowMs, candidates };
  return candidates;
}

function measureCandidates(best: string | undefined, target: Node): readonly UnionCandidate[] {
  const prefix = best === undefined ? '' : `${best}.`;
  const out: UnionCandidate[] = [];
  for (const [nodePath, recorded] of regions) {
    if (!nodePath.startsWith(prefix)) {
      continue;
    }
    // Checked on what was recorded first: on a large page nearly every path
    // fails here, and runsOf would have filtered its runs for nothing.
    if (recorded.some((run) => sitsIn(run, target))) {
      if (inScope(nodePath)) {
        addCandidates(nodePath, target, out);
      }
    }
    if (out.length >= UNION_RUNS_MAX) {
      break;
    }
  }
  assert(out.length <= UNION_RUNS_MAX, 'measureCandidates: candidates are capped');
  return out;
}

// The occurrence is the run's index in runsOf, narrowed to the focused instance,
// as it is for every other located event (occurrenceOf).
function addCandidates(nodePath: string, target: Node, out: UnionCandidate[]): void {
  const runs = runsOf(nodePath) ?? [];
  for (const [occurrence, run] of runs.entries()) {
    if (out.length >= UNION_RUNS_MAX) {
      return;
    }
    if (sitsIn(run, target) && drawsUnion(run)) {
      const box = boxOfRun(nodePath, run, runs.length);
      if (box !== undefined) {
        out.push({ path: nodePath, occurrence, box });
      }
    }
  }
}

function sitsIn(run: readonly Node[], target: Node): boolean {
  return run.some((node) => node.parentNode === target);
}

// More than one thing on the page: an outline that is a union, with space in it.
// Only what is still connected, since a marker stays in its run once removed.
function drawsUnion(run: readonly Node[]): boolean {
  let count = 0;
  for (const node of run) {
    if (node.isConnected && putsContent(node)) {
      count += 1;
      if (count === 2) {
        return true;
      }
    }
  }
  return false;
}

function putsContent(node: Node): boolean {
  if (isElement(node)) {
    return node.tagName !== 'TEMPLATE';
  }
  return isText(node) && node.textContent.trim() !== '';
}
