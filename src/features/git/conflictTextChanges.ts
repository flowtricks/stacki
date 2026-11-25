export interface ConflictTextChange {
  readonly from: number;
  readonly to: number;
  readonly targetFrom: number;
  readonly targetTo: number;
}
const DIFF_CELLS_MAX = 250_000;
const TOKENS_MAX = 2_000;
const DIFF_TEXT_CHARS_MAX = 40_000;

// A presentation diff only. Returning undefined on budget exhaustion keeps the
// original combined decision instead of guessing at independent editable ranges.
export function conflictTextChanges(source: string, target: string): readonly ConflictTextChange[] | undefined {
  if (source === target) {
    return [];
  }
  if (source.length + target.length > DIFF_TEXT_CHARS_MAX) {
    return undefined;
  }
  const left = source.match(/\s+|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  const right = target.match(/\s+|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  if (left.length > TOKENS_MAX || right.length > TOKENS_MAX || left.length * right.length > DIFF_CELLS_MAX) {
    return undefined;
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    const row = rows[i];
    const next = rows[i + 1];
    if (row === undefined || next === undefined) {
      continue;
    }
    for (let j = right.length - 1; j >= 0; j--) {
      row[j] = left[i] === right[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return conflictTextChangesWalk(left, right, rows);
}

function conflictTextChangesWalk(left: readonly string[], right: readonly string[], rows: readonly Uint32Array[]) {
  const changes: ConflictTextChange[] = [];
  let i = 0;
  let j = 0;
  let sourceOffset = 0;
  let targetOffset = 0;
  let start: { readonly from: number; readonly targetFrom: number } | undefined;
  // Each pass consumes at least one of the bounded tokens.
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      if (start !== undefined) {
        changes.push({ ...start, to: sourceOffset, targetTo: targetOffset });
        start = undefined;
      }
      sourceOffset += left[i]?.length ?? 0;
      targetOffset += right[j]?.length ?? 0;
      i++;
      j++;
    } else {
      start ??= { from: sourceOffset, targetFrom: targetOffset };
      if (i < left.length && (j === right.length || (rows[i + 1]?.[j] ?? 0) >= (rows[i]?.[j + 1] ?? 0))) {
        sourceOffset += left[i]?.length ?? 0;
        i++;
      } else {
        targetOffset += right[j]?.length ?? 0;
        j++;
      }
    }
  }
  if (start !== undefined) {
    changes.push({ ...start, to: sourceOffset, targetTo: targetOffset });
  }
  return changes;
}
