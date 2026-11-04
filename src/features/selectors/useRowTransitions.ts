// The timers around rowTransitions.ts: one hook owns the held rows, starts each
// phase's timer and clears them all on unmount. The rows live in a ref so a
// second click in the same tick already sees the first (state alone would not
// update until the next render); a version counter makes React draw the change.
//
// Held rows belong to the tab they were clicked in. Opening another tab drops
// them at once, because a row leaving the old tab may never have been in the
// new one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { SelectorEntry } from '../../../shared/properties/selectorUsage';
import type { SelectorFilter } from './selectorList';
import { NO_ROW_TRANSITIONS, ROW_TRANSITION_TIMINGS, ROW_TRANSITIONS_MAX, stepTransitions, type RowEvent, type RowTransitions } from './rowTransitions';

export interface RowTransitionActions {
  /** The rows animating in the open tab. */
  readonly rows: RowTransitions;
  /**
   * Runs a lock click's work, animating the row around it. A click on a row
   * that is already animating is ignored, so one click is one change.
   */
  readonly run: (entry: SelectorEntry, reason: string | undefined, work: () => Promise<void>) => void;
  /** The row's collapse transition ended. */
  readonly collapsed: (id: string) => void;
}

interface Held {
  readonly filter: SelectorFilter;
  readonly rows: RowTransitions;
}

/** `belongs` answers, from the latest report, whether a row's verdict is in the open tab. */
export function useRowTransitions(filter: SelectorFilter, belongs: (id: string) => boolean): RowTransitionActions {
  const held = useRef<Held>({ filter, rows: NO_ROW_TRANSITIONS });
  const [, setVersion] = useState(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const active = useRef(true);
  // The timer that ends `showing` asks about the report as it is then, not as it was at the click.
  const belongsLatest = useRef(belongs);
  useEffect(() => {
    belongsLatest.current = belongs;
  });
  useEffect(() => {
    active.current = true;
    const pending = timers.current;
    return () => {
      active.current = false;
      for (const timer of pending) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const later = useCallback((delayMs: number, callback: () => void): void => {
    // Each held row has at most one timer waiting, so this set is bounded by the rows.
    assert(timers.current.size < ROW_TRANSITIONS_MAX * 2, 'useRowTransitions: timers stay within the held rows');
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (active.current) {
        callback();
      }
    }, delayMs);
    timers.current.add(timer);
  }, []);

  // The one place held rows change: steps the row, then starts the timer its new phase needs.
  const apply = useCallback(
    (at: SelectorFilter, id: string, event: RowEvent): void => {
      const current = held.current;
      if (current.filter === at) {
        // The event is for the tab still open.
      } else {
        // The tab changed since the click: its rows were dropped, and a late event has nothing to move.
        return;
      }
      const rows = stepTransitions(current.rows, id, event);
      if (rows === current.rows) {
        return;
      }
      held.current = { filter: at, rows };
      setVersion((version) => version + 1);
      const row = rows.get(id);
      if (row === undefined) {
        return;
      }
      if (row.phase === 'changing') {
        if (row.step === 'showing') {
          later(ROW_TRANSITION_TIMINGS.changeMs, () => apply(at, id, { kind: 'shown', belongs: belongsLatest.current(id) }));
        }
      } else {
        // A collapse ends on `transitionend`; this catches the case where none fires (hidden panel, no layout).
        assert(row.phase === 'collapsing', 'useRowTransitions: a held row changes or collapses');
        later(ROW_TRANSITION_TIMINGS.collapseFallbackMs, () => apply(at, id, { kind: 'collapsed' }));
      }
    },
    [later],
  );

  if (held.current.filter === filter) {
    // The rows were held in this tab.
  } else {
    held.current = { filter, rows: NO_ROW_TRANSITIONS };
  }
  const rows = held.current.rows;

  const run = (entry: SelectorEntry, reason: string | undefined, work: () => Promise<void>): void => {
    if (held.current.rows.has(entry.id)) {
      return;
    }
    if (prefersReducedMotion()) {
      // No animation: the row moves when the report says so.
      void work();
      return;
    }
    const at = filter;
    apply(at, entry.id, { kind: 'toggle', from: entry.verdict.kind, reason });
    const settle = (): void => {
      if (active.current) {
        apply(at, entry.id, { kind: 'settled' });
      }
    };
    void work().then(settle, settle);
  };
  const collapsed = (id: string): void => apply(filter, id, { kind: 'collapsed' });
  return { rows, run, collapsed };
}

function prefersReducedMotion(): boolean {
  // JSDOM and older hosts have no matchMedia; they get the animation, which ends on its timers.
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
