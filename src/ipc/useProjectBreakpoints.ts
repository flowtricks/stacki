// The preview bar's and Settings' view of `.stacki/breakpoints.json`: `useProjectBreakpoints(projectPath)`.
//
//   const { settings, widths, state, save } = useProjectBreakpoints(projectPath);
//
// `widths` is on the first render with no await (the Lumos defaults until the file answers, and when there is no project or no
// file), and the component renders again when an edit here or in another window changes the file.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Result } from '../../shared/core/result';
import {
  BREAKPOINT_DEFAULT_SETTINGS,
  resolveBreakpointWidths,
  type BreakpointSettings,
  type BreakpointWidths,
} from '../../shared/properties/projectBreakpoints';
import { breakpointsStore, type BreakpointsState } from './projectBreakpoints';

export interface ProjectBreakpoints {
  /** The breakpoints as typed: `64rem`, `1024px`. */
  readonly settings: BreakpointSettings;
  /** The canvas widths they resolve to: 1023, 767, 479 by default. */
  readonly widths: BreakpointWidths;
  readonly state: BreakpointsState;
  readonly save: (settings: BreakpointSettings) => Promise<Result<void>>;
}

const NO_PROJECT: BreakpointsState = { kind: 'loading', settings: BREAKPOINT_DEFAULT_SETTINGS, widths: resolveBreakpointWidths(BREAKPOINT_DEFAULT_SETTINGS) };
const IGNORE_CHANGES = (): (() => void) => () => undefined;
const NO_PROJECT_STATE = (): BreakpointsState => NO_PROJECT;

export function useProjectBreakpoints(projectPath: string | undefined): ProjectBreakpoints {
  const store = projectPath === undefined || projectPath.length === 0 ? undefined : breakpointsStore(projectPath);
  const state = useSyncExternalStore(store === undefined ? IGNORE_CHANGES : store.subscribe, store === undefined ? NO_PROJECT_STATE : store.getState);
  // Holding the store reads the file now and again when the window comes back to the front.
  useEffect(() => store?.retain(), [store]);
  const save = useCallback(
    (settings: BreakpointSettings): Promise<Result<void>> => {
      if (store === undefined) {
        throw new Error('useProjectBreakpoints: no project is open, so nothing can be saved');
      }
      return store.save(settings);
    },
    [store],
  );
  return { settings: state.settings, widths: state.widths, state, save };
}
