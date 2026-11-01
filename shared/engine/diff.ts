// A byte diff between the bytes an intent was authored against and the bytes on
// disk now (plan §4, §11 step 2). It is Myers' O(ND) algorithm, run once over the
// bytes and once over the reversed bytes. The forward frontiers give, for any
// point (x, y) of the edit graph, the edit distance between the first x source
// bytes and the first y target bytes; the backward frontiers give the same for
// the suffixes. A point lies on some minimum edit script exactly when the two
// add up to the total distance — which is what lets the span mapper prove that
// *every* minimum script maps a span the same way, instead of trusting the one
// script a diff happens to print (mapSpan.ts).
//
// Why not the line diff in electron/git/conflicts.ts (plan §11 step 2): it fills an
// n·m table and, past 250 000 cells, silently returns the whole region as one
// change. Here the cost grows with the edit, not the file, and exhaustion is a
// typed outcome, never a silent loss of fidelity (plan §14).
//
// Bounds (AGENTS.md §10): LIMITS.diffWorkMax counts byte comparisons and
// frontier cells; LIMITS.diffDistanceMax caps the frontier memory. Both are
// checked while the work is done, so a hopeless diff stops near its cause. No
// recursion; every loop is bounded by the file length or the distance.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { toByteSpan, type ByteSpan, type ByteString } from '../core/span';

export interface DiffBudget {
  readonly workMax: number;
  readonly distanceMax: number;
}

/** The production budget. Tests pass smaller ones to reach exhaustion cheaply. */
export const DIFF_BUDGET: DiffBudget = {
  workMax: LIMITS.diffWorkMax,
  distanceMax: LIMITS.diffDistanceMax,
};

/** A computed diff. The frontiers stay inside the closures: callers read
 * distances, never the typed arrays that hold them. */
export interface ByteDiff {
  readonly source: ByteString;
  readonly target: ByteString;
  /** Bytes deleted plus bytes inserted by every minimum edit script. */
  readonly distance: number;
  readonly budget: DiffBudget;
  /** Work units the diff spent; mappings through it may spend the rest. */
  readonly workSpent: number;
  /** Edit distance between `source[0, x)` and `target[0, y)`, or undefined
   * when it exceeds `distance` — such a point lies on no minimum script. */
  readonly distanceBefore: (x: number, y: number) => number | undefined;
  /** Edit distance between `source[x, end)` and `target[y, end)`, or undefined
   * when it exceeds `distance`. */
  readonly distanceAfter: (x: number, y: number) => number | undefined;
}

export type DiffOutcome = { readonly tag: 'computed'; readonly diff: ByteDiff } | { readonly tag: 'too-costly' };

/** One region a minimum edit script replaces: `source` bytes out, `target` in. */
export interface Hunk {
  readonly source: ByteSpan;
  readonly target: ByteSpan;
}

/** `rows[d][k + d]`: the largest x on diagonal k = x − y reachable with edit
 * distance at most d, or −1 where the diagonal is unreachable or off the grid. */
type Frontiers = readonly Int32Array[];

interface FrontierRun {
  readonly rows: Frontiers;
  readonly distance: number;
  readonly workSpent: number;
}

export function diffBytes(source: ByteString, target: ByteString, budget: DiffBudget): DiffOutcome {
  assert(budget.workMax <= LIMITS.diffWorkMax, 'The diff budget stays inside the work bound');
  assert(budget.distanceMax <= LIMITS.diffDistanceMax, 'The diff budget stays inside the distance');
  assert(source.length <= LIMITS.sourceBytesMax, 'Diffed source bytes are inside the file bound');
  assert(target.length <= LIMITS.sourceBytesMax, 'Diffed target bytes are inside the file bound');
  if (Math.abs(source.length - target.length) > budget.distanceMax) {
    // Every script deletes or inserts at least the size change: no search can
    // come in under the bound, so none is started.
    return { tag: 'too-costly' };
  }
  const forward = runFrontiers(source, target, budget, 0);
  if (forward === undefined) {
    return { tag: 'too-costly' };
  }
  const backward = runFrontiers(reversed(source), reversed(target), budget, forward.workSpent);
  if (backward === undefined) {
    return { tag: 'too-costly' };
  }
  const distance = forward.distance;
  assert(backward.distance === distance, 'Both directions find the same minimum distance');
  const sizeChange = Math.abs(source.length - target.length);
  assert(distance >= sizeChange, 'The distance covers the size change');
  assert((distance - sizeChange) % 2 === 0, 'The distance has the parity of N + M');
  const diff: ByteDiff = {
    source,
    target,
    distance,
    budget,
    workSpent: backward.workSpent,
    distanceBefore: (x, y) => {
      checkPoint(source, target, x, y);
      return frontierDistance(forward.rows, distance, x, y);
    },
    distanceAfter: (x, y) => {
      checkPoint(source, target, x, y);
      return frontierDistance(backward.rows, distance, source.length - x, target.length - y);
    },
  };
  const endDistance = diff.distanceBefore(source.length, target.length);
  assert(endDistance === distance, 'The end costs the distance');
  assert(diff.distanceAfter(0, 0) === distance, 'The start costs the distance, read backward');
  return { tag: 'computed', diff };
}

/** One minimum edit script as hunks, ascending — the forward traceback. Where
 * several scripts tie, this is one of them; the mapper never relies on which. */
export function diffHunks(diff: ByteDiff): readonly Hunk[] {
  const { source, target } = diff;
  const hunks: Hunk[] = [];
  let x = source.length;
  let y = target.length;
  let distance = diff.distance;
  let hunkEnd: { readonly x: number; readonly y: number } | undefined;
  const stepsMax = source.length + target.length;
  for (let step = 0; step < stepsMax; step++) {
    if (x + y === 0) {
      break;
    }
    if (matchesBehind(source, target, x, y)) {
      // A match never costs anything, so stepping back along it stays optimal.
      if (hunkEnd !== undefined) {
        hunks.push({ source: toByteSpan(x, hunkEnd.x), target: toByteSpan(y, hunkEnd.y) });
        hunkEnd = undefined;
      }
      x -= 1;
      y -= 1;
      continue;
    }
    hunkEnd ??= { x, y };
    if (deletionBehind(diff, x, y, distance)) {
      x -= 1;
    } else {
      assert(y > 0, 'Without a deletion behind, an insertion is');
      assert(diff.distanceBefore(x, y - 1) === distance - 1, 'The insertion lies on the script');
      y -= 1;
    }
    distance -= 1;
  }
  assert(x + y === 0, 'The traceback reaches the start of both files');
  assert(distance === 0, 'The traceback spent exactly the distance');
  if (hunkEnd !== undefined) {
    hunks.push({ source: toByteSpan(0, hunkEnd.x), target: toByteSpan(0, hunkEnd.y) });
  }
  return hunks.reverse();
}

// --- Internal ----------------------------------------------------------------

function matchesBehind(source: ByteString, target: ByteString, x: number, y: number): boolean {
  if (x > 0) {
    if (y > 0) {
      return source[x - 1] === target[y - 1];
    }
  }
  return false;
}

function deletionBehind(diff: ByteDiff, x: number, y: number, distance: number): boolean {
  if (x > 0) {
    return diff.distanceBefore(x - 1, y) === distance - 1;
  }
  return false;
}

function checkPoint(source: ByteString, target: ByteString, x: number, y: number): void {
  assert(Number.isSafeInteger(x), 'A diff point has an integer x');
  assert(Number.isSafeInteger(y), 'A diff point has an integer y');
  assert(x >= 0, 'A diff point lies right of the grid start');
  assert(y >= 0, 'A diff point lies below the grid start');
  assert(x <= source.length, 'A diff point lies inside the source');
  assert(y <= target.length, 'A diff point lies inside the target');
}

// Myers' greedy loop, keeping every row for the distance lookups. Row d is
// complete when the loop stops, so a lookup at the final distance is exact on
// every diagonal, not only on the one that reached the end.
function runFrontiers(source: Uint8Array, target: Uint8Array, budget: DiffBudget, workStart: number): FrontierRun | undefined {
  const rows: Int32Array[] = [];
  let work = workStart;
  const endDiagonal = source.length - target.length;
  for (let distance = 0; distance <= budget.distanceMax; distance++) {
    work += 2 * distance + 1;
    if (work > budget.workMax) {
      return undefined;
    }
    const row = new Int32Array(2 * distance + 1).fill(-1);
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const start = frontierStart(rows, distance, diagonal, source.length, target.length);
      if (start < 0) {
        continue;
      }
      const end = snake(source, target, start, start - diagonal, budget.workMax - work);
      if (end === undefined) {
        return undefined;
      }
      work += end - start;
      row[diagonal + distance] = end;
    }
    rows.push(row);
    assert(rows.length === distance + 1, 'One frontier row per distance');
    if (row[endDiagonal + distance] === source.length) {
      assert(Math.abs(endDiagonal) <= distance, 'The end diagonal is inside the final row');
      return { rows, distance, workSpent: work };
    }
  }
  return undefined;
}

// The furthest x on diagonal k reachable with distance at most d, before the
// snake: an insertion from diagonal k + 1, a deletion from diagonal k − 1, or
// the same diagonal at d − 2. Every point on a diagonal at or before its
// frontier costs at most that row's distance (the distance never decreases
// along a diagonal), so a move may start from the last point that still has
// room for it, not only from the frontier itself.
function frontierStart(rows: Frontiers, distance: number, diagonal: number, sourceLength: number, targetLength: number): number {
  if (distance === 0) {
    return 0;
  }
  if (diagonal > sourceLength) {
    return -1; // The diagonal starts right of the grid.
  }
  if (diagonal < -targetLength) {
    return -1; // The diagonal starts below the grid.
  }
  let best = frontierAt(rows, distance - 2, diagonal);
  const above = frontierAt(rows, distance - 1, diagonal + 1);
  if (above >= 0) {
    // Insert target[y]: the point needs y < targetLength before the move.
    const from = Math.min(above, targetLength + diagonal);
    best = from >= Math.max(0, diagonal + 1) ? Math.max(best, from) : best;
  }
  const left = frontierAt(rows, distance - 1, diagonal - 1);
  if (left >= 0) {
    // Delete source[x]: the point needs x < sourceLength before the move.
    const from = Math.min(left, sourceLength - 1);
    best = from >= Math.max(0, diagonal - 1) ? Math.max(best, from + 1) : best;
  }
  assert(best <= sourceLength, 'A frontier start lies inside the source');
  if (best >= 0) {
    assert(best - diagonal <= targetLength, 'A frontier start lies inside the target');
  }
  return best;
}

function frontierAt(rows: Frontiers, distance: number, diagonal: number): number {
  if (distance < 0) {
    return -1;
  }
  if (Math.abs(diagonal) > distance) {
    return -1;
  }
  const row = rows[distance];
  assert(row !== undefined, 'Earlier frontier rows are kept');
  const x = row[diagonal + distance];
  assert(x !== undefined, 'The diagonal lies inside its row');
  return x;
}

/** Follow matching bytes from (x, y); undefined when the work budget ends first.
 * Each match costs one unit; the comparison that ends the snake is paid for by
 * the diagonal's frontier cell. */
function snake(source: Uint8Array, target: Uint8Array, x: number, y: number, workLeft: number): number | undefined {
  const stepsMax = Math.min(source.length - x, target.length - y);
  assert(stepsMax >= 0, 'A snake starts inside the grid');
  assert(workLeft >= 0, 'A snake starts inside the work budget');
  for (let step = 0; step < stepsMax; step++) {
    if (source[x + step] !== target[y + step]) {
      return x + step;
    }
    if (step + 1 > workLeft) {
      return undefined;
    }
  }
  return x + stepsMax;
}

// The distance of (x, y) is the first row whose frontier on its diagonal reaches
// x. Rows on one diagonal share its parity and their frontiers never move back,
// so a binary search over them finds it in log(D) probes.
function frontierDistance(rows: Frontiers, distance: number, x: number, y: number): number | undefined {
  const diagonal = x - y;
  const first = Math.abs(diagonal);
  if (first > distance) {
    return undefined;
  }
  const candidates = Math.floor((distance - first) / 2) + 1;
  let low = 0;
  let high = candidates;
  const probesMax = 64; // log2 of any row count, with room to spare.
  for (let probe = 0; probe < probesMax; probe++) {
    if (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (frontierAt(rows, first + 2 * middle, diagonal) >= x) {
        high = middle;
      } else {
        low = middle + 1;
      }
    } else {
      break;
    }
  }
  assert(low === high, 'The binary search converged inside its probe bound');
  if (low < candidates) {
    const found = first + 2 * low;
    // The postcondition, both sides: this row reaches x and the one before does not.
    assert(frontierAt(rows, found, diagonal) >= x, 'The found row reaches the point');
    assert(frontierAt(rows, found - 2, diagonal) < x, 'No cheaper row reaches the point');
    return found;
  }
  return undefined;
}

// `new Uint8Array` always copies; `slice` on a Node Buffer is a view, and
// reversing that reverses the caller's snapshot in place (step-3 spike).
function reversed(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes).reverse();
  assert(copy.length === bytes.length, 'Reversing keeps the length');
  assert(copy.buffer !== bytes.buffer, 'The reversed copy shares no memory with its input');
  return copy;
}
