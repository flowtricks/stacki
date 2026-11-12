// Moving one entry of a list to a new position: the optimistic reorder a drag or an Alt+Arrow shows
// before the main process answers with the real list.
import { assert } from '../../../shared/core/assert';

/**
 * `items` with the entry at `from` moved so it ends at index `to` (the indexes of the list before and
 * after). The result is a permutation of the input; moving an entry onto itself returns the list as it is.
 */
export function moveInList<T>(items: readonly T[], from: number, to: number): readonly T[] {
  assert(Number.isSafeInteger(from), 'moveInList: from is an integer');
  assert(from >= 0, 'moveInList: from is not negative');
  assert(from < items.length, 'moveInList: from is inside the list');
  assert(Number.isSafeInteger(to), 'moveInList: to is an integer');
  assert(to >= 0, 'moveInList: to is not negative');
  assert(to < items.length, 'moveInList: to is inside the list');
  if (from === to) {
    return items;
  }
  const next = [...items];
  const removed = next.splice(from, 1);
  assert(removed.length === 1, 'moveInList: the entry at from was taken out');
  next.splice(to, 0, ...removed);
  assert(next.length === items.length, 'moveInList: the length is unchanged');
  return next;
}
