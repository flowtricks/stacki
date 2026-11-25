import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import type { HistoryCommitFile } from './historyBridge';
import { historyFileCategory, type HistoryFileCategory } from './historyFileSummary';

export type HistoryFileFilter = 'all' | HistoryFileCategory;
export type HistoryFileSort = 'path' | 'status';

const STATUS_ORDER = { updated: 0, added: 1, deleted: 2 } as const;

export function selectHistoryFiles(
  files: readonly HistoryCommitFile[],
  options: { readonly filter: HistoryFileFilter; readonly sort: HistoryFileSort },
): readonly HistoryCommitFile[] {
  assert(files.length <= BOUNDARY_LIMITS.itemsMax, 'History files: file limit exceeded');
  const visible = files.filter((file) => options.filter === 'all' || historyFileCategory(file) === options.filter);
  // Sort a fresh list so filtering never changes the commit's original file order.
  visible.sort((left, right) => {
    if (options.sort === 'status') {
      const categoryOrder = STATUS_ORDER[historyFileCategory(left)] - STATUS_ORDER[historyFileCategory(right)];
      if (categoryOrder !== 0) {
        return categoryOrder;
      }
    }
    return left.path.localeCompare(right.path);
  });
  assert(visible.length <= files.length, 'History files: filtering cannot add files');
  return visible;
}
