// The rows of a before/after comparison, for the diff an edit card shows.
// Line-based longest common subsequence, bounded: past AI_DIFF_LIMITS.cellsMax
// table cells (a large file rewritten) the diff shows every old line removed and
// every new one added rather than spending the time.
import { assert } from '../../../shared/core/assert';

export const AI_DIFF_LIMITS = {
  cellsMax: 4_000_000,
  rowsMax: 20_000,
} as const satisfies Record<string, number>;

export type DiffRow =
  | { readonly kind: 'context'; readonly text: string; readonly before: number; readonly after: number }
  | { readonly kind: 'added'; readonly text: string; readonly after: number }
  | { readonly kind: 'deleted'; readonly text: string; readonly before: number };

/** The rows of a comparison and whether they are exact: a change too large to align is shown as the old region removed and the new one added. */
export interface LineDiffResult {
  readonly rows: readonly DiffRow[];
  readonly exact: boolean;
}

/** The first `AI_DIFF_LIMITS.rowsMax` rows; use `diffRows` when the total is needed (a change count must not stop at the cap). */
export function lineDiff(before: string | undefined, after: string): readonly DiffRow[] {
  return diffRows(before, after).rows.slice(0, AI_DIFF_LIMITS.rowsMax);
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
  const middleLeft = left.slice(head, left.length - tail);
  const middleRight = right.slice(head, right.length - tail);
  const exact = (middleLeft.length + 1) * (middleRight.length + 1) <= AI_DIFF_LIMITS.cellsMax;
  const middle = exact ? common(middleLeft, middleRight, head) : replaceAll(middleLeft, middleRight, head);
  const rows: DiffRow[] = [];
  for (let index = 0; index < head; index++) {
    rows.push({ kind: 'context', text: left[index] ?? '', before: index + 1, after: index + 1 });
  }
  rows.push(...middle);
  for (let offset = 0; offset < tail; offset++) {
    const beforeIndex = left.length - tail + offset;
    const afterIndex = right.length - tail + offset;
    rows.push({ kind: 'context', text: left[beforeIndex] ?? '', before: beforeIndex + 1, after: afterIndex + 1 });
  }
  assert(rows.filter((row) => row.kind !== 'added').length === left.length, 'diffRows: every old line appears once');
  assert(rows.filter((row) => row.kind !== 'deleted').length === right.length, 'diffRows: every new line appears once');
  return { rows, exact };
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

function replaceAll(left: readonly string[], right: readonly string[], offset: number): readonly DiffRow[] {
  return [
    ...left.map((text, index): DiffRow => ({ kind: 'deleted', text, before: offset + index + 1 })),
    ...right.map((text, index): DiffRow => ({ kind: 'added', text, after: offset + index + 1 })),
  ];
}

/** `offset` is how many lines both sides shared before these, so row numbers count from the top of the file. */
function common(left: readonly string[], right: readonly string[], offset: number): readonly DiffRow[] {
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
      rows.push({ kind: 'context', text: left[i] ?? '', before: offset + i + 1, after: offset + j + 1 });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
      rows.push({ kind: 'added', text: right[j] ?? '', after: offset + j + 1 });
      j += 1;
    } else {
      rows.push({ kind: 'deleted', text: left[i] ?? '', before: offset + i + 1 });
      i += 1;
    }
  }
  return rows;
}
