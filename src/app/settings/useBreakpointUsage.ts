// Where each breakpoint is used in the project, for the Breakpoints screen: `useBreakpointUsage(projectPath, list)`.
//
// The scan describes the breakpoints' SAVED values, so it runs when the tab opens, when a saved value changes, when the window comes
// back to the front and after a sync is applied; the main process caches files by time and size, so a rescan reads only what changed.
// It never blocks typing and never writes: the person's ticks are saved one at a time (`toggle`), each shown at once and confirmed by
// a rescan. A scan that fails says so once, quietly, and leaves the last answer in place.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BreakpointUsage } from '../../../shared/properties/breakpointSyncPlan';
import type { PlaceChoice } from '../../../shared/properties/breakpointSyncSelection';
import { formatBreakpoint, type BreakpointList } from '../../../shared/properties/projectBreakpoints';
import { breakpointUsageAvailable, scanBreakpointUsageRequest } from '../../ipc/breakpointSyncBridge';
import { saveChoices } from '../../ipc/breakpointSyncChoices';
import { onWindowReturn } from '../../lib/windowReturn';

export type UsageState =
  /** The first scan is running. */
  | { readonly kind: 'scanning' }
  /** This window cannot scan the project (Studio): the screen shows no usage. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly usage: BreakpointUsage; readonly problem: string | undefined };

export interface BreakpointUsageView {
  readonly state: UsageState;
  /** Scans again now (after a sync was applied). */
  readonly refresh: () => void;
  /** Ticks or unticks places of one breakpoint and remembers it; an error text when it could not be remembered. */
  readonly toggle: (id: string, choices: readonly PlaceChoice[]) => Promise<string | undefined>;
}

// The saved values decide what is looked for; names and order do not.
const signatureOf = (list: BreakpointList): string =>
  list.map((breakpoint) => `${breakpoint.id}:${breakpoint.direction}:${formatBreakpoint(breakpoint.setting)}`).join('|');

export function useBreakpointUsage(projectPath: string, list: BreakpointList): BreakpointUsageView {
  const [state, setState] = useState<UsageState>(breakpointUsageAvailable() ? { kind: 'scanning' } : { kind: 'unavailable' });
  const listRef = useRef(list);
  listRef.current = list;
  const serial = useRef(0);
  const signature = signatureOf(list);

  const scan = useCallback(async (): Promise<void> => {
    if (!breakpointUsageAvailable()) {
      setState({ kind: 'unavailable' });
      return;
    }
    serial.current += 1;
    const mine = serial.current;
    const answer = await scanBreakpointUsageRequest(projectPath, listRef.current);
    if (mine !== serial.current) {
      return;
    }
    if (answer.ok) {
      setState({ kind: 'ready', usage: answer.usage, problem: undefined });
    } else {
      setState((current) => (current.kind === 'ready' ? { ...current, problem: answer.error } : { kind: 'ready', usage: EMPTY_USAGE, problem: answer.error }));
    }
  }, [projectPath]);

  useEffect(() => {
    void scan();
  }, [scan, signature]);
  useEffect(() => onWindowReturn(() => void scan()), [scan]);

  const toggle = useCallback(
    async (id: string, choices: readonly PlaceChoice[]): Promise<string | undefined> => {
      // Shown at once; the rescan after the write puts the file's truth back.
      setState((current) => (current.kind === 'ready' ? { ...current, usage: withChoices(current.usage, id, choices) } : current));
      const saved = await saveChoices(projectPath, id, choices);
      void scan();
      return saved.ok ? undefined : saved.error.message;
    },
    [projectPath, scan],
  );
  return { state, refresh: () => void scan(), toggle };
}

const EMPTY_USAGE: BreakpointUsage = { entries: [], lumos: false, truncated: false, skipped: 0, recordProblem: undefined };

function withChoices(usage: BreakpointUsage, id: string, choices: readonly PlaceChoice[]): BreakpointUsage {
  const chosen = new Map(choices.map((choice) => [`${choice.file}\0${choice.locator}`, choice.checked]));
  return {
    ...usage,
    entries: usage.entries.map((entry) =>
      entry.id !== id
        ? entry
        : {
            ...entry,
            files: entry.files.map((file) => ({
              ...file,
              occurrences: file.occurrences.map((place) => {
                const next = chosen.get(`${file.rel}\0${place.locator}`);
                return next === undefined ? place : { ...place, checked: next, excluded: place.reason === 'exact' && !next };
              }),
            })),
          },
    ),
  };
}
