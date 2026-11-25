import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import type { HistoryCommitFile } from './historyBridge';

export interface HistoryFileSummary {
  readonly added: number;
  readonly deleted: number;
  readonly updated: number;
}

export type HistoryFileCategory = keyof HistoryFileSummary;

export function historyFileCategory(file: HistoryCommitFile): HistoryFileCategory {
  switch (file.status) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'updated';
  }
}

export function summarizeHistoryFiles(files: readonly HistoryCommitFile[]): HistoryFileSummary {
  assert(files.length <= BOUNDARY_LIMITS.itemsMax, 'History files: file limit exceeded');
  // Copies create a new path; renames and type changes update an existing file.
  // Local counters keep the three categories disjoint without allocating lists.
  const counts = { added: 0, deleted: 0, updated: 0 };
  for (const file of files) {
    counts[historyFileCategory(file)] += 1;
  }
  assert(counts.added + counts.deleted + counts.updated === files.length, 'History files: every file is counted once');
  return counts;
}
