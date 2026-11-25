// The timers around rowTransitions.ts: one hook owns the held rows, starts each
// phase's timer and clears them all on unmount. The rows live in a ref so a
// second click in the same tick already sees the first (state alone would not
// update until the next render); a version counter makes React draw the change.
//
// Every lock click, a row's or a heading's, also takes a snapshot of the rows
// in the open tab. Those rows stay listed while the write is in flight and for
// the colour change after it, so the re-read report cannot drop one before it
// animates; then each row that left the tab is held (`left`) and closes like a
// clicked row. Each row that was not in the snapshot is `entering`: it opens
// to its height as it is drawn. A heading lock needs nothing of its own.
//
// Held rows belong to the tab they were clicked in. Opening another tab drops
// them at once, because a row leaving the old tab may never have been in the
// new one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { SelectorEntry } from '../../../shared/properties/selectorUsage';
import type { SelectorFilter } from './selectorList';
import {
  heldReasons,
  NO_ROW_TRANSITIONS,
  ROW_TRANSITION_TIMINGS,
  ROW_TRANSITIONS_MAX,
  stepTransitionsMany,
  type RowEvent,
  type RowTransitions,
} from './rowTransitions';

export interface RowTransitionActions {
  /** The rows animating in the open tab. */
  readonly rows: RowTransitions;
  /** Rows the list keeps though their verdict has left the open tab: held rows, and the snapshot while a write is in flight. */
  readonly listed: ReadonlySet<string>;
  /** The "Can't tell" reason of each listed row that has left that tab, so it keeps its group. */
  readonly reasons: ReadonlyMap<string, string>;
  /** Whether a row has just arrived in the open tab through a lock change, so it opens in. */
  readonly entering: (id: string) => boolean;
  /**
   * Runs a row lock's work, animating the row around it. A click on a row
   * that is already animating is ignored, so one click is one change.
   */
  readonly runRow: (entry: SelectorEntry, work: () => Promise<void>) => void;
  /** Runs a stylesheet or folder lock's work; the rows it moves animate out or in. */
  readonly runHeading: (work: () => Promise<void>) => void;
  /** The row's collapse transition ended. */
  readonly collapsed: (id: string) => void;
}

interface Held {
  readonly filter: SelectorFilter;
  readonly rows: RowTransitions;
}

/** The rows in the open tab when a lock was clicked, kept until the rows it moved have animated. */
interface Snapshot {
  readonly filter: SelectorFilter;
  readonly before: ReadonlyMap<string, SelectorEntry>;
  /** Lock changes whose rows have not yet been sorted into staying and leaving; while any is, the snapshot's rows stay listed. */
  readonly pending: number;
}

/** Lock changes pending at once; past this a click runs without animation. */
const SNAPSHOT_PENDING_MAX = 16;
const NO_IDS: ReadonlySet<string> = new Set();

/** `inTab` holds, from the latest report, every row whose verdict is in the open tab. */
export function useRowTransitions(filter: SelectorFilter, inTab: ReadonlyMap<string, SelectorEntry>): RowTransitionActions {
  const held = useRef<Held>({ filter, rows: NO_ROW_TRANSITIONS });
  const snapshot = useRef<Snapshot | undefined>(undefined);
  const [, setVersion] = useState(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const active = useRef(true);
  // Timers ask about the report as it is when they fire, not as it was at the click.
  const inTabLatest = useRef(inTab);
  useEffect(() => {
    inTabLatest.current = inTab;
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
    // Each step of a batch of held rows waits on one timer, and each write on one more.
    assert(timers.current.size < ROW_TRANSITIONS_MAX * 2, 'useRowTransitions: timers stay within the held rows');
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (active.current) {
        callback();
      }
    }, delayMs);
    timers.current.add(timer);
  }, []);

  // The one place held rows change: steps the rows, then starts the timer their new phase needs.
  const apply = useCallback(
    (at: SelectorFilter, ids: readonly string[], event: RowEvent): void => {
      if (active.current) {
        // The panel is still drawn.
      } else {
        // A write that settles after unmount has no rows to move.
        return;
      }
      const current = held.current;
      if (current.filter === at) {
        // The event is for the tab still open.
      } else {
        // The tab changed since the click: its rows were dropped, and a late event has nothing to move.
        return;
      }
      const rows = stepTransitionsMany(current.rows, ids.slice(0, ROW_TRANSITIONS_MAX), event);
      if (rows === current.rows) {
        return;
      }
      held.current = { filter: at, rows };
      setVersion((version) => version + 1);
      const showing: string[] = [];
      const collapsing: string[] = [];
      for (const id of ids) {
        const row = rows.get(id);
        if (row === undefined) {
          continue;
        }
        if (row.phase === 'changing') {
          if (row.step === 'showing') {
            showing.push(id);
          }
        } else {
          assert(row.phase === 'collapsing', 'useRowTransitions: a held row changes or collapses');
          collapsing.push(id);
        }
      }
      if (showing.length > 0) {
        later(ROW_TRANSITION_TIMINGS.changeMs, () => {
          const stays = showing.filter((id) => inTabLatest.current.has(id));
          const leaves = showing.filter((id) => !inTabLatest.current.has(id));
          assert(stays.length + leaves.length === showing.length, 'useRowTransitions: each shown row stays or leaves');
          apply(at, stays, { kind: 'shown', belongs: true });
          apply(at, leaves, { kind: 'shown', belongs: false });
        });
      }
      if (collapsing.length > 0) {
        // A collapse ends on `transitionend`; this catches the case where none fires (hidden panel, no layout).
        later(ROW_TRANSITION_TIMINGS.collapseFallbackMs, () => apply(at, collapsing, { kind: 'collapsed' }));
      }
    },
    [later],
  );

  if (held.current.filter === filter) {
    // The rows were held in this tab.
  } else {
    held.current = { filter, rows: NO_ROW_TRANSITIONS };
  }
  if (snapshot.current !== undefined && snapshot.current.filter !== filter) {
    // A snapshot of another tab: its writes settle with nothing to move here.
    snapshot.current = undefined;
  }
  const rows = held.current.rows;
  const taken = snapshot.current;

  // A lock change has shown its colours: each snapshot row no longer in the tab closes.
  const sortLeaving = (at: SelectorFilter): void => {
    const now = snapshot.current;
    if (now === undefined || now.filter !== at) {
      // The tab changed since the click, which dropped its snapshot.
      return;
    }
    assert(now.pending > 0, 'useRowTransitions: a sorted lock change was pending');
    // Grouped by reason so each "Can't tell" group keeps its rows; one step per group.
    const byReason = new Map<string | undefined, string[]>();
    for (const entry of now.before.values()) {
      if (inTabLatest.current.has(entry.id)) {
        continue;
      }
      const reason = entry.verdict.kind === 'unknown' ? entry.verdict.reason : undefined;
      const list = byReason.get(reason) ?? [];
      list.push(entry.id);
      byReason.set(reason, list);
    }
    const sorted: Snapshot = { ...now, pending: now.pending - 1 };
    snapshot.current = sorted;
    for (const [reason, ids] of byReason) {
      apply(at, ids, { kind: 'left', reason });
    }
    setVersion((version) => version + 1);
    // Arrivals opened as they were drawn; after that the snapshot has nothing left to say.
    later(ROW_TRANSITION_TIMINGS.enterMs + ROW_TRANSITION_TIMINGS.collapseFallbackMs, () => {
      if (snapshot.current === sorted) {
        snapshot.current = undefined;
      }
    });
  };

  // Snapshots the tab, runs the work, then animates every row it moved.
  const watch = (at: SelectorFilter, work: () => Promise<void>): Promise<void> => {
    // Only a change still pending carries its rows over: a sorted one's leaving rows are held or gone.
    const previous = snapshot.current !== undefined && snapshot.current.filter === at && snapshot.current.pending > 0 ? snapshot.current : undefined;
    if (previous !== undefined && previous.pending >= SNAPSHOT_PENDING_MAX) {
      return work();
    }
    // Rows already held are listed already; a second click adds the rows it finds to the first's.
    const before = new Map([...inTabLatest.current, ...(previous?.before ?? [])]);
    snapshot.current = { filter: at, before, pending: (previous?.pending ?? 0) + 1 };
    setVersion((version) => version + 1);
    // The re-read report is drawn after the write settles, and its rows then
    // show their new colour for the same time a clicked row's does.
    const settle = (): void => later(ROW_TRANSITION_TIMINGS.changeMs, () => sortLeaving(at));
    return work().then(settle, settle);
  };

  const runRow = (entry: SelectorEntry, work: () => Promise<void>): void => {
    if (held.current.rows.has(entry.id)) {
      return;
    }
    if (prefersReducedMotion()) {
      // No animation: the row moves when the report says so.
      void work();
      return;
    }
    const at = filter;
    const reason = entry.verdict.kind === 'unknown' ? entry.verdict.reason : undefined;
    apply(at, [entry.id], { kind: 'toggle', from: entry.verdict.kind, reason });
    void watch(at, work).then(() => apply(at, [entry.id], { kind: 'settled' }));
  };
  const runHeading = (work: () => Promise<void>): void => {
    if (prefersReducedMotion()) {
      void work();
      return;
    }
    void watch(filter, work);
  };
  const collapsed = (id: string): void => apply(filter, [id], { kind: 'collapsed' });
  const listed = taken !== undefined && taken.pending > 0 ? new Set([...rows.keys(), ...taken.before.keys()]) : rows.size === 0 ? NO_IDS : new Set(rows.keys());
  const reasons = taken !== undefined && taken.pending > 0 ? new Map([...snapshotReasons(taken), ...heldReasons(rows)]) : heldReasons(rows);
  const entering = (id: string): boolean => taken !== undefined && !taken.before.has(id) && !rows.has(id);
  return { rows, listed, reasons, entering, runRow, runHeading, collapsed };
}

/** The "Can't tell" reason of each row in a snapshot, so a row leaving that tab keeps its group until it is held. */
function snapshotReasons(taken: Snapshot): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const entry of taken.before.values()) {
    if (entry.verdict.kind === 'unknown') {
      out.set(entry.id, entry.verdict.reason);
    }
  }
  assert(out.size <= taken.before.size, 'snapshotReasons: one reason per row at most');
  return out;
}

function prefersReducedMotion(): boolean {
  // JSDOM and older hosts have no matchMedia; they get the animation, which ends on its timers.
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
