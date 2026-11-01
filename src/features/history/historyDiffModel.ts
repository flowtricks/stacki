import { assert } from '../../../shared/core/assert';
import { COMMIT_DIFF_LIMITS } from '../../../shared/ipc/gitCommitDiff';

export type HistoryDiffLine =
  | { readonly kind: 'metadata' | 'hunk'; readonly text: string }
  | { readonly kind: 'added'; readonly text: string; readonly after: number }
  | { readonly kind: 'deleted'; readonly text: string; readonly before: number }
  | {
      readonly kind: 'context';
      readonly text: string;
      readonly before: number;
      readonly after: number;
    };

interface HunkPosition {
  readonly before: number;
  readonly after: number;
  readonly beforeRemaining: number;
  readonly afterRemaining: number;
}

export function parseHistoryPatch(patch: string): readonly HistoryDiffLine[] {
  assert(patch.length <= COMMIT_DIFF_LIMITS.charactersMax, 'Diff: character limit exceeded');
  const lines = patch.split('\n');
  assert(lines.length <= COMMIT_DIFF_LIMITS.linesMax, 'Diff: line limit exceeded');
  const rows: HistoryDiffLine[] = [];
  let position: HunkPosition | undefined;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      assertHistoryHunkComplete(position);
      position = {
        before: parseHistoryLineNumber(hunk[1]),
        after: parseHistoryLineNumber(hunk[3]),
        beforeRemaining: parseHistoryLineNumber(hunk[2] ?? '1'),
        afterRemaining: parseHistoryLineNumber(hunk[4] ?? '1'),
      };
      rows.push({ kind: 'hunk', text: line });
    } else if (position) {
      if (line.startsWith('\\')) {
        rows.push({ kind: 'metadata', text: line });
        continue;
      }
      const next = parseHistoryHunkLine(line, position);
      rows.push(next.row);
      position = next.position;
    } else if (line.length > 0) {
      rows.push({ kind: 'metadata', text: line });
    }
    if (position?.beforeRemaining === 0) {
      if (position.afterRemaining === 0) {
        position = undefined;
      }
    }
  }
  assertHistoryHunkComplete(position);
  return rows;
}

function parseHistoryHunkLine(line: string, position: HunkPosition): { readonly row: HistoryDiffLine; readonly position: HunkPosition } {
  const { before, after, beforeRemaining, afterRemaining } = position;
  const text = line.slice(1);
  if (line.startsWith('+')) {
    assert(afterRemaining > 0, 'Diff: added line exceeds hunk');
    return {
      row: { kind: 'added', text, after },
      position: { ...position, after: after + 1, afterRemaining: afterRemaining - 1 },
    };
  }
  assert(beforeRemaining > 0, 'Diff: original line exceeds hunk');
  if (line.startsWith('-')) {
    return {
      row: { kind: 'deleted', text, before },
      position: { ...position, before: before + 1, beforeRemaining: beforeRemaining - 1 },
    };
  }
  assert(line.startsWith(' '), 'Diff: unknown hunk line');
  assert(afterRemaining > 0, 'Diff: context exceeds hunk');
  return {
    row: { kind: 'context', text, before, after },
    position: {
      before: before + 1,
      after: after + 1,
      beforeRemaining: beforeRemaining - 1,
      afterRemaining: afterRemaining - 1,
    },
  };
}

function parseHistoryLineNumber(value: string | undefined): number {
  assert(value !== undefined, 'Diff: missing line number');
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed), 'Diff: invalid line number');
  assert(parsed >= 0, 'Diff: negative line number');
  assert(parsed <= Number.MAX_SAFE_INTEGER - COMMIT_DIFF_LIMITS.linesMax, 'Diff: line overflow');
  return parsed;
}

function assertHistoryHunkComplete(position: HunkPosition | undefined): void {
  if (position) {
    assert(position.beforeRemaining === 0, 'Diff: incomplete original hunk');
    assert(position.afterRemaining === 0, 'Diff: incomplete updated hunk');
  }
}
