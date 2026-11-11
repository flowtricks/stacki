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

export function lineDiff(before: string | undefined, after: string): readonly DiffRow[] {
  const left = before === undefined || before === '' ? [] : before.split('\n');
  const right = after === '' ? [] : after.split('\n');
  const rows = (left.length + 1) * (right.length + 1) > AI_DIFF_LIMITS.cellsMax ? replaceAll(left, right) : common(left, right);
  assert(rows.filter((row) => row.kind !== 'added').length === left.length, 'lineDiff: every old line appears once');
  assert(rows.filter((row) => row.kind !== 'deleted').length === right.length, 'lineDiff: every new line appears once');
  return rows.slice(0, AI_DIFF_LIMITS.rowsMax);
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

function replaceAll(left: readonly string[], right: readonly string[]): readonly DiffRow[] {
  return [
    ...left.map((text, index): DiffRow => ({ kind: 'deleted', text, before: index + 1 })),
    ...right.map((text, index): DiffRow => ({ kind: 'added', text, after: index + 1 })),
  ];
}

function common(left: readonly string[], right: readonly string[]): readonly DiffRow[] {
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
      rows.push({ kind: 'context', text: left[i] ?? '', before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
      rows.push({ kind: 'added', text: right[j] ?? '', after: j + 1 });
      j += 1;
    } else {
      rows.push({ kind: 'deleted', text: left[i] ?? '', before: i + 1 });
      i += 1;
    }
  }
  return rows;
}
