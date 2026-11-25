// The state of the Pages panel's Select mode: whether it is on, what is ticked, and what a click, a Shift-click and
// Select all do. The rules are the pure functions of pageSelection.ts; this holds them to React state. Nothing is
// persisted: leaving the mode, or a deletion, empties the selection, and a scan that drops a page drops its tick.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageOrder } from '../../../shared/properties/pageOrder';
import type { ScanPage } from '../../../shared/properties/projectScan';
import type { PageTreeNode } from './pageTree';
import {
  buildSelectionIndex,
  NO_SELECTION,
  pageSelectionRows,
  partialFolders,
  pruneSelection,
  selectAllRows,
  selectRange,
  toggleRow,
  visibleTreeRows,
  type Selection,
  type SelectionIndex,
  type SelectionRow,
} from './pageSelection';

export interface PageSelectionModel {
  readonly active: boolean;
  readonly selected: Selection;
  readonly partial: ReadonlySet<string>;
  readonly index: SelectionIndex;
  /** Whether every row that can be ticked among those shown is. */
  readonly allShown: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  /** A click on a row; `extend` (Shift) ticks the rows between it and the last click. */
  readonly click: (key: string, extend: boolean) => void;
  /** Ticks every row shown, or clears them when all already are. */
  readonly toggleAll: () => void;
  readonly selectAll: () => void;
}

export function usePageSelection(input: {
  readonly tree: PageTreeNode;
  readonly order: PageOrder;
  readonly collapsed: ReadonlySet<string>;
  readonly searchResults: readonly ScanPage[] | undefined;
}): PageSelectionModel {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Selection>(NO_SELECTION);
  const anchor = useRef<string | undefined>(undefined);
  const index = useMemo(() => buildSelectionIndex(input.tree), [input.tree]);
  // Rows are only needed while selecting: a panel that is not in the mode builds none.
  const rows = useMemo<readonly SelectionRow[]>(() => {
    if (!active) {
      return [];
    }
    return input.searchResults === undefined ? visibleTreeRows(input.tree, input.order, input.collapsed) : pageSelectionRows(input.searchResults);
  }, [active, input.collapsed, input.order, input.searchResults, input.tree]);
  const partial = useMemo(() => partialFolders(index, selected), [index, selected]);

  useEffect(() => {
    setSelected((previous) => (previous.size === 0 ? previous : pruneSelection(index, previous)));
  }, [index]);

  const start = useCallback(() => {
    anchor.current = undefined;
    setSelected(NO_SELECTION);
    setActive(true);
  }, []);
  const stop = useCallback(() => {
    anchor.current = undefined;
    setSelected(NO_SELECTION);
    setActive(false);
  }, []);
  const click = useCallback(
    (key: string, extend: boolean) => {
      const from = anchor.current;
      setSelected((previous) => (extend && from !== undefined ? selectRange(index, previous, rows, from, key) : toggleRow(index, previous, key)));
      if (!extend || from === undefined) {
        anchor.current = key;
      }
    },
    [index, rows],
  );
  const selectAll = useCallback(() => setSelected((previous) => selectAllRows(index, previous, rows)), [index, rows]);
  const allShown = useMemo(
    () => rows.length > 0 && rows.every((row) => selected.has(row.key) || index.refused.has(row.key)) && rows.some((row) => !index.refused.has(row.key)),
    [index, rows, selected],
  );
  const toggleAll = useCallback(() => {
    if (allShown) {
      setSelected(NO_SELECTION);
    } else {
      selectAll();
    }
  }, [allShown, selectAll]);

  return { active, selected, partial, index, allShown, start, stop, click, toggleAll, selectAll };
}
