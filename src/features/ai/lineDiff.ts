// The rows of a before/after comparison, for the diff an edit card shows.
// Line-based alignment with no size limit. A region small enough for a table
// (AI_DIFF_LIMITS.cellsMax cells) is aligned by longest common subsequence; a
// bigger one is split at the lines that occur exactly once on each side, kept in
// order (patience diff), and the stretches between those anchors are aligned the
// same way. So a large file with real edits is aligned line by line, and only a
// stretch with no line in common is shown as removed and added, which is exact.
import { assert } from '../../../shared/core/assert';

export const AI_DIFF_LIMITS = {
  /** Table cells one longest-common-subsequence alignment fills: the work of one step, not the size of a file. */
  cellsMax: 4_000_000,
} as const satisfies Record<string, number>;

export type DiffRow =
  | { readonly kind: 'context'; readonly text: string; readonly before: number; readonly after: number }
  | { readonly kind: 'added'; readonly text: string; readonly after: number }
  | { readonly kind: 'deleted'; readonly text: string; readonly before: number };

/** The rows of a comparison and whether they are exact: a stretch that could only be aligned by guessing is shown as the old lines removed and the new ones added. */
export interface LineDiffResult {
  readonly rows: readonly DiffRow[];
  readonly exact: boolean;
}

/**
 * Every row of the comparison. The lines both sides share at the start and end are set aside before
 * the alignment runs, so a small edit in a long file costs only the edited region (a 5,000-line file
 * with one changed line would otherwise exceed the table bound and show as wholly replaced).
 */
export function diffRows(before: string | undefined, after: string | undefined): LineDiffResult {
  const left = before === undefined || before === '' ? [] : before.split('\n');
  const right = after === undefined || after === '' ? [] : after.split('\n');
  const sharedMax = Math.min(left.length, right.length);
  let head = 0;
  while (head < sharedMax && left[head] === right[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < sharedMax - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) {
    tail += 1;
  }
  const middle = alignRegion(left.slice(head, left.length - tail), right.slice(head, right.length - tail), head);
  const rows: DiffRow[] = [];
  for (let index = 0; index < head; index++) {
    rows.push({ kind: 'context', text: left[index] ?? '', before: index + 1, after: index + 1 });
  }
  for (const row of middle.rows) {
    rows.push(row);
  }
  for (let offset = 0; offset < tail; offset++) {
    const beforeIndex = left.length - tail + offset;
    const afterIndex = right.length - tail + offset;
    rows.push({ kind: 'context', text: left[beforeIndex] ?? '', before: beforeIndex + 1, after: afterIndex + 1 });
  }
  assert(rows.filter((row) => row.kind !== 'added').length === left.length, 'diffRows: every old line appears once');
  assert(rows.filter((row) => row.kind !== 'deleted').length === right.length, 'diffRows: every new line appears once');
  return { rows, exact: middle.exact };
}

/** Only the changed rows and `context` lines around each change, for a compact card. */
export function compactRows(rows: readonly DiffRow[], context: number): readonly (DiffRow | { readonly kind: 'gap'; readonly hidden: number })[] {
  assert(context >= 0, 'compactRows: context is a count');
  const keep = rows.map((row) => row.kind !== 'context');
  const near = rows.map((_row, index) => {
    for (let offset = -context; offset <= context; offset++) {
      if (keep[index + offset] === true) {
        return true;
      }
    }
    return false;
  });
  const out: (DiffRow | { readonly kind: 'gap'; readonly hidden: number })[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (near[index] === true) {
      if (hidden > 0) {
        out.push({ kind: 'gap', hidden });
        hidden = 0;
      }
      out.push(row);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) {
    out.push({ kind: 'gap', hidden });
  }
  return out;
}

/** A stretch of both sides still to align, and the line numbers (counted from 1) it starts at. */
interface Region {
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly before: number;
  readonly after: number;
}

type Work = { readonly kind: 'region'; readonly region: Region } | { readonly kind: 'row'; readonly row: DiffRow };

/** `offset` is how many lines both sides shared before these, so row numbers count from the top of the file. */
function alignRegion(left: readonly string[], right: readonly string[], offset: number): LineDiffResult {
  const rows: DiffRow[] = [];
  let exact = true;
  const stack: Work[] = [{ kind: 'region', region: { left, right, before: offset + 1, after: offset + 1 } }];
  // Every pass emits a row or splits a region into smaller ones around lines it
  // has matched, so the passes are bounded by the lines on both sides.
  const passesMax = 4 * (left.length + right.length) + 8;
  for (let passes = 0; stack.length > 0; passes++) {
    assert(passes <= passesMax, 'alignRegion: every pass makes progress');
    const work = stack.pop();
    if (work === undefined) {
      break;
    }
    if (work.kind === 'row') {
      rows.push(work.row);
      continue;
    }
    const outcome = expandRegion(work.region);
    exact = exact && outcome.exact;
    // The stack is last in, first out, so the pieces go on in reverse order.
    for (let index = outcome.work.length - 1; index >= 0; index--) {
      const piece = outcome.work[index];
      assert(piece !== undefined, 'alignRegion: a piece exists');
      stack.push(piece);
    }
  }
  return { rows, exact };
}

// One step of the alignment: the rows it decides, and the regions it leaves, in file order.
function expandRegion(region: Region): { readonly work: readonly Work[]; readonly exact: boolean } {
  const { left, right } = region;
  const sharedMax = Math.min(left.length, right.length);
  let head = 0;
  while (head < sharedMax && left[head] === right[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < sharedMax - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) {
    tail += 1;
  }
  if (head > 0 || tail > 0) {
    // Lines both sides share at the ends of a stretch are matched without any alignment.
    const work: Work[] = [];
    for (let index = 0; index < head; index++) {
      work.push({ kind: 'row', row: { kind: 'context', text: left[index] ?? '', before: region.before + index, after: region.after + index } });
    }
    work.push({
      kind: 'region',
      region: {
        left: left.slice(head, left.length - tail),
        right: right.slice(head, right.length - tail),
        before: region.before + head,
        after: region.after + head,
      },
    });
    for (let offset = 0; offset < tail; offset++) {
      const leftIndex = left.length - tail + offset;
      const rightIndex = right.length - tail + offset;
      work.push({
        kind: 'row',
        row: { kind: 'context', text: left[leftIndex] ?? '', before: region.before + leftIndex, after: region.after + rightIndex },
      });
    }
    return { work, exact: true };
  }
  if (left.length === 0 || right.length === 0) {
    return { work: changedRows(region), exact: true };
  }
  if ((left.length + 1) * (right.length + 1) <= AI_DIFF_LIMITS.cellsMax) {
    return { work: tableRows(region).map((row): Work => ({ kind: 'row', row })), exact: true };
  }
  const anchors = patienceAnchors(left, right);
  if (anchors.length === 0) {
    // Nothing both sides hold exactly once: the stretch is replaced outright, which
    // is the exact answer when no line is shared at all and a guess otherwise.
    const shared = new Set(left);
    return { work: changedRows(region), exact: !right.some((line) => shared.has(line)) };
  }
  const work: Work[] = [];
  let leftAt = 0;
  let rightAt = 0;
  for (const anchor of anchors) {
    work.push({
      kind: 'region',
      region: {
        left: left.slice(leftAt, anchor.left),
        right: right.slice(rightAt, anchor.right),
        before: region.before + leftAt,
        after: region.after + rightAt,
      },
    });
    work.push({
      kind: 'row',
      row: { kind: 'context', text: left[anchor.left] ?? '', before: region.before + anchor.left, after: region.after + anchor.right },
    });
    leftAt = anchor.left + 1;
    rightAt = anchor.right + 1;
  }
  work.push({
    kind: 'region',
    region: { left: left.slice(leftAt), right: right.slice(rightAt), before: region.before + leftAt, after: region.after + rightAt },
  });
  assert(
    work.every((piece) => piece.kind === 'row' || piece.region.left.length < left.length || piece.region.right.length < right.length),
    'expandRegion: a split leaves smaller regions',
  );
  return { work, exact: true };
}

// A region with nothing in common: every old line removed, then every new one added.
function changedRows(region: Region): readonly Work[] {
  return [
    ...region.left.map((text, index): Work => ({ kind: 'row', row: { kind: 'deleted', text, before: region.before + index } })),
    ...region.right.map((text, index): Work => ({ kind: 'row', row: { kind: 'added', text, after: region.after + index } })),
  ];
}

// The lines that occur exactly once on each side, in an order both sides agree on:
// the longest increasing run of their positions on the right, read down the left.
function patienceAnchors(left: readonly string[], right: readonly string[]): readonly { readonly left: number; readonly right: number }[] {
  const leftOnce = new Map<string, number>();
  const leftSeen = new Set<string>();
  left.forEach((line, index) => {
    if (leftSeen.has(line)) {
      leftOnce.delete(line);
    } else {
      leftSeen.add(line);
      leftOnce.set(line, index);
    }
  });
  const rightOnce = new Map<string, number>();
  const rightSeen = new Set<string>();
  right.forEach((line, index) => {
    if (rightSeen.has(line)) {
      rightOnce.delete(line);
    } else {
      rightSeen.add(line);
      rightOnce.set(line, index);
    }
  });
  const pairs: { readonly left: number; readonly right: number }[] = [];
  for (const [line, leftIndex] of leftOnce) {
    const rightIndex = rightOnce.get(line);
    if (rightIndex !== undefined) {
      pairs.push({ left: leftIndex, right: rightIndex });
    }
  }
  pairs.sort((first, second) => first.left - second.left);
  return longestIncreasing(pairs);
}

// Patience sorting: the longest run of pairs whose right positions increase.
function longestIncreasing(pairs: readonly { readonly left: number; readonly right: number }[]): readonly { readonly left: number; readonly right: number }[] {
  const tails: number[] = [];
  const previous: number[] = [];
  pairs.forEach((pair, index) => {
    let low = 0;
    let high = tails.length;
    // The tails' right positions increase, so a binary search places this pair; each step halves the range.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((pairs[tails[middle] ?? 0]?.right ?? 0) < pair.right) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = index;
  });
  const run: { readonly left: number; readonly right: number }[] = [];
  let cursor = tails.length > 0 ? (tails[tails.length - 1] ?? -1) : -1;
  while (cursor >= 0) {
    const pair = pairs[cursor];
    assert(pair !== undefined, 'longestIncreasing: a chain index names a pair');
    run.push(pair);
    cursor = previous[cursor] ?? -1;
  }
  return run.reverse();
}

function tableRows(region: Region): readonly DiffRow[] {
  const { left, right } = region;
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ kind: 'context', text: left[i] ?? '', before: region.before + i, after: region.after + j });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
      rows.push({ kind: 'added', text: right[j] ?? '', after: region.after + j });
      j += 1;
    } else {
      rows.push({ kind: 'deleted', text: left[i] ?? '', before: region.before + i });
      i += 1;
    }
  }
  return rows;
}
