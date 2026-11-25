// The brute-force references for shared/engine/diff.ts and shared/engine/mapSpan.ts (plan §10:
// every fast path ships beside a slow, obviously correct version). Full edit
// distance tables — O(N·M) time and memory, so only for small inputs — and a
// span mapper that checks every column of the span against every target byte,
// straight from the definition in mapSpan.ts: resolved when every minimum edit
// script keeps the span whole at one place, gone when none keeps it whole,
// ambiguous otherwise. The fast mapper decides from two columns and Myers
// frontiers; the tests assert the two agree on every input they generate.
import { assert } from '#dist/shared/core/assert.js';
import type { SpanMapping } from '#dist/shared/engine/mapSpan.js';
import { toByteSpan, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';

/** Largest table the reference builds: 4 M cells, a few MB per table. */
export const REFERENCE_CELLS_MAX = 4_000_000;

export interface ReferenceTables {
  readonly source: ByteString;
  readonly target: ByteString;
  readonly distance: number;
  /** Edit distance of `source[0, x)` and `target[0, y)`. */
  readonly before: (x: number, y: number) => number;
  /** Edit distance of `source[x, end)` and `target[y, end)`. */
  readonly after: (x: number, y: number) => number;
}

export function referenceTables(source: ByteString, target: ByteString): ReferenceTables {
  const width = target.length + 1;
  const cells = (source.length + 1) * width;
  assert(cells <= REFERENCE_CELLS_MAX, 'The reference table fits its bound');
  const before = new Int32Array(cells);
  const after = new Int32Array(cells);
  for (let x = 0; x <= source.length; x++) {
    for (let y = 0; y <= target.length; y++) {
      const equal = () => source[x - 1] === target[y - 1];
      before[x * width + y] = cellCost(before, width, x, y, equal);
    }
  }
  for (let x = source.length; x >= 0; x--) {
    for (let y = target.length; y >= 0; y--) {
      const equal = () => source[x] === target[y];
      after[x * width + y] = cellCostAfter(after, width, x, y, equal);
    }
  }
  const read = (table: Int32Array, x: number, y: number): number => {
    const value = table[x * width + y];
    assert(value !== undefined, 'Reference lookups stay inside the table');
    return value;
  };
  const distance = read(before, source.length, target.length);
  assert(distance === read(after, 0, 0), 'Both reference tables agree on the distance');
  return {
    source,
    target,
    distance,
    before: (x, y) => read(before, x, y),
    after: (x, y) => read(after, x, y),
  };
}

// Distance to (x, y): the cheapest of deleting source[x − 1], inserting
// target[y − 1], or matching them when they are equal. The first row and
// column are the edges: only insertions, or only deletions, reach them.
function cellCost(table: Int32Array, width: number, x: number, y: number, equal: () => boolean): number {
  if (x === 0) {
    return y;
  }
  if (y === 0) {
    return x;
  }
  const deleted = (table[(x - 1) * width + y] ?? Infinity) + 1;
  const inserted = (table[x * width + y - 1] ?? Infinity) + 1;
  const matched = equal() ? (table[(x - 1) * width + y - 1] ?? Infinity) : Infinity;
  return Math.min(deleted, inserted, matched);
}

// The mirror of cellCost, from (x, y) to the end: the last row and column are
// the edges, where nothing of the source, or of the target, is left.
function cellCostAfter(table: Int32Array, width: number, x: number, y: number, equal: () => boolean): number {
  const sourceLeft = table.length / width - 1 - x;
  const targetLeft = width - 1 - y;
  if (sourceLeft === 0) {
    return targetLeft;
  }
  if (targetLeft === 0) {
    return sourceLeft;
  }
  const deleted = (table[(x + 1) * width + y] ?? Infinity) + 1;
  const inserted = (table[x * width + y + 1] ?? Infinity) + 1;
  const matched = equal() ? (table[(x + 1) * width + y + 1] ?? Infinity) : Infinity;
  return Math.min(deleted, inserted, matched);
}

/** Every way minimum scripts cross source byte x: matched target bytes and
 * whether some script deletes it — computed over every target byte. */
export function referenceCrossings(tables: ReferenceTables, x: number): { readonly matches: readonly number[]; readonly deleted: boolean } {
  const matches: number[] = [];
  let deleted = false;
  for (let y = 0; y <= tables.target.length; y++) {
    if (tables.before(x, y) + 1 + tables.after(x + 1, y) === tables.distance) {
      deleted = true;
    }
    if (y < tables.target.length) {
      if (tables.source[x] === tables.target[y]) {
        if (tables.before(x, y) + tables.after(x + 1, y + 1) === tables.distance) {
          matches.push(y);
        }
      }
    }
  }
  return { matches, deleted };
}

export function referenceMapSpan(tables: ReferenceTables, span: ByteSpan): SpanMapping {
  assert(span.start < span.end, 'The reference maps non-empty spans');
  assert(span.end <= tables.source.length, 'The reference span lies inside the source');
  const length = span.end - span.start;
  // Every place some minimum script keeps the whole span: an optimal path
  // through the diagonal from (start, j) to (end, j + length).
  const kept: number[] = [];
  for (let j = 0; j + length <= tables.target.length; j++) {
    if (sameBytes(tables, span.start, j, length)) {
      if (tables.before(span.start, j) + tables.after(span.end, j + length) === tables.distance) {
        kept.push(j);
      }
    }
  }
  const [only] = kept;
  if (only === undefined) {
    return { tag: 'gone' };
  }
  if (kept.length > 1) {
    return { tag: 'ambiguous' };
  }
  for (let x = span.start; x < span.end; x++) {
    const crossing = referenceCrossings(tables, x);
    if (crossing.deleted) {
      return { tag: 'ambiguous' };
    }
    if (crossing.matches.length !== 1) {
      return { tag: 'ambiguous' };
    }
    if (crossing.matches[0] !== only + x - span.start) {
      return { tag: 'ambiguous' };
    }
  }
  return { tag: 'resolved', span: toByteSpan(only, only + length) };
}

function sameBytes(tables: ReferenceTables, x: number, y: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (tables.source[x + offset] !== tables.target[y + offset]) {
      return false;
    }
  }
  return true;
}
