// A variable's value as it is being edited: shown on the canvas at once, written
// to its file one write at a time.
//
// Every nudge used to wait for the field to commit, then for a read of the file
// (for undo), the write, a reread of every variable and another read of the file,
// before the stylesheet reloaded on the canvas. Now each draft goes to the frame
// as a live override (shared/properties/liveVariables.ts) in the same frame, and
// the file follows: one write in flight per value, carrying the latest draft, and
// each next write is made from the range the previous one left, so our own writes
// never read as "This file changed". The override is released with the value just
// written, and the frame drops it only once the page computes that value itself.

import { createContext } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { WireColumn } from '../../../shared/ipc/ipcResults';
import { LIVE_VARIABLE_MESSAGE, liveVariableKey, type LiveVariable, type LiveVariableMessage } from '../../../shared/properties/liveVariables';
import type { VariableCell, VariableFile } from '../../ipc/variablesBridge';

/** Writes `value` over `cell`'s range; false when the write was refused or failed. */
export type VariableWrite = (cell: VariableCell, value: string) => Promise<boolean>;

// Writes one lane may chain before it stops taking more. Each is a round trip, so
// this is minutes of a held key: far past any real edit, and a stop well short of
// a runaway.
export const VARIABLE_SAVE_ROUNDS_MAX = 10_000;

/** Where `cell` is declared, as the frame needs it to override the value. */
export function liveVariableOf(files: readonly VariableFile[], cell: VariableCell): LiveVariable {
  const column = columnOf(files, cell);
  return { selector: cell.selector, context: column?.context ?? [], name: cell.name, value: cell.value };
}

function columnOf(files: readonly VariableFile[], cell: VariableCell): WireColumn | undefined {
  const file = files.find((candidate) => candidate.rel === cell.file);
  for (const group of file?.groups ?? []) {
    const found = group.columns.find((column) => column.id === cell.column);
    if (found !== undefined) {
      return found;
    }
    for (const block of group.blocks) {
      const inBlock = block.columns?.find((column) => column.id === cell.column);
      if (inBlock !== undefined) {
        return inBlock;
      }
    }
  }
  return undefined;
}

/** One value's identity across rereads: its offsets move when the file does. */
export function variableCellKey(cell: Pick<VariableCell, 'file' | 'column' | 'selector' | 'name'>): string {
  return [cell.file, cell.column, cell.selector, cell.name].join('\n');
}

/** The cell as the file holds it once `value` has replaced its range. */
export function cellAfterWrite(cell: VariableCell, value: string): VariableCell {
  assert(cell.valueEnd >= cell.valueStart, 'cellAfterWrite: the range is ordered');
  const next = { ...cell, value, valueEnd: cell.valueStart + value.length };
  assert(next.valueEnd - next.valueStart === value.length, 'cellAfterWrite: the range spans the value');
  return next;
}

interface Waiting {
  cell: VariableCell;
  draft: string;
  readonly settled: Array<() => void>;
}

interface Lane {
  /** The cell as our last successful write left it; undefined until one lands. */
  written: VariableCell | undefined;
  waiting: Waiting | undefined;
}

export interface VariableSaveHooks {
  /** A write for this value is about to start. */
  readonly onStart?: (cell: VariableCell, value: string) => void;
  /** The lane ran dry: `value` is what the file now holds, or undefined if the last write failed. */
  readonly onIdle?: (cell: VariableCell, value: string | undefined) => void;
}

/**
 * Coalesced writes, one lane per value. `save` resolves once the file holds this
 * value or a later one: a value that was superseded while it waited is never sent.
 */
export function createVariableSaves(write: VariableWrite, hooks: VariableSaveHooks = {}) {
  const lanes = new Map<string, Lane>();

  const run = async (key: string): Promise<void> => {
    const lane = lanes.get(key);
    assert(lane !== undefined, 'Variable saves: a lane runs only while it is registered');
    let failed = false;
    let last: { cell: VariableCell; value: string } | undefined;
    for (let round = 0; lane.waiting !== undefined; round += 1) {
      assert(round < VARIABLE_SAVE_ROUNDS_MAX, 'Variable saves: a lane chained past its round limit');
      const job = lane.waiting;
      lane.waiting = undefined;
      // Our previous write moved the range: the next one starts from where it left
      // the file, not from the read the field was rendered from.
      const cell = lane.written ?? job.cell;
      hooks.onStart?.(cell, job.draft);
      let ok = false;
      try {
        ok = job.draft === cell.value ? true : await write(cell, job.draft);
      } finally {
        for (const settle of job.settled) {
          settle();
        }
      }
      failed = !ok;
      lane.written = ok ? cellAfterWrite(cell, job.draft) : undefined;
      last = { cell, value: job.draft };
    }
    lanes.delete(key);
    if (last !== undefined) {
      hooks.onIdle?.(last.cell, failed ? undefined : last.value);
    }
  };

  const save = (cell: VariableCell, value: string): Promise<void> => {
    const key = variableCellKey(cell);
    const existing = lanes.get(key);
    return new Promise<void>((resolve) => {
      if (existing !== undefined) {
        // Behind the write in flight: the latest value replaces any older one waiting.
        const waiting = existing.waiting ?? { cell, draft: value, settled: [] };
        waiting.cell = cell;
        waiting.draft = value;
        waiting.settled.push(resolve);
        assert(waiting.settled.length <= VARIABLE_SAVE_ROUNDS_MAX, 'Variable saves: waiters stay bounded');
        existing.waiting = waiting;
        return;
      }
      assert(lanes.size < LIMITS.scanEntriesMax, 'Variable saves: lane limit exceeded');
      const lane: Lane = { written: undefined, waiting: { cell, draft: value, settled: [resolve] } };
      lanes.set(key, lane);
      void run(key);
    });
  };

  return { save, busy: (cell: VariableCell) => lanes.has(variableCellKey(cell)) };
}

/** What happened last to one value's live override. */
type LiveState = 'previewing' | 'saving' | 'released';

/**
 * The frame's overrides, as the panel drives them. A draft sets one; abandoning
 * the draft drops it; a save holds it until the write lands and then releases it
 * with the value written. A draft cleared because its save finished is not an
 * abandonment, and must not drop the override before the page has caught up.
 */
export function createLiveVariables(post: (message: LiveVariableMessage) => void) {
  const states = new Map<string, LiveState>();

  const remember = (key: string, state: LiveState): void => {
    if (!states.has(key)) {
      assert(states.size < LIMITS.scanEntriesMax, 'Live variables: state limit exceeded');
    }
    states.set(key, state);
  };

  return {
    draft(variable: LiveVariable, value: string | undefined): void {
      const key = liveVariableKey(variable);
      if (value !== undefined) {
        remember(key, 'previewing');
        post({ type: LIVE_VARIABLE_MESSAGE, op: 'set', variable: { ...variable, value } });
        return;
      }
      if (states.get(key) === 'previewing') {
        states.delete(key);
        post({ type: LIVE_VARIABLE_MESSAGE, op: 'drop', variable });
      }
    },
    saving(variable: LiveVariable): void {
      const key = liveVariableKey(variable);
      if (states.has(key)) {
        remember(key, 'saving');
      }
    },
    saved(variable: LiveVariable, value: string | undefined): void {
      const key = liveVariableKey(variable);
      // Still previewing: a newer draft is on screen than the one just written.
      if (states.get(key) !== 'saving') {
        return;
      }
      states.delete(key);
      post(
        value === undefined
          ? { type: LIVE_VARIABLE_MESSAGE, op: 'drop', variable }
          : { type: LIVE_VARIABLE_MESSAGE, op: 'drop', variable: { ...variable, value }, until: value },
      );
    },
    clear(): void {
      states.clear();
      post({ type: LIVE_VARIABLE_MESSAGE, op: 'clear' });
    },
  };
}

/** Where a field sends its draft for the canvas: the sheet provides it, so the
 *  table between them need not carry it. Undefined outside the Variables sheet. */
export const VariablePreviewContext = createContext<((cell: VariableCell, value: string | undefined) => void) | undefined>(undefined);
