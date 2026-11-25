// The preview bar's and Settings' view of `.stacki/breakpoints.json`: `useProjectBreakpoints(projectPath)`.
//
//   const { list, resolved, state, save } = useProjectBreakpoints(projectPath);
//
// `resolved` is on the first render with no await (the Lumos defaults until the file answers, and when there is no project or no
// file), and the component renders again when an edit here or in another window changes the file.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Result } from '../../shared/core/result';
import {
  BREAKPOINT_DEFAULT_CONFIG,
  desktopFramePx,
  resolveBreakpoints,
  type BreakpointConfig,
  type BreakpointList,
  type ResolvedBreakpoint,
} from '../../shared/properties/projectBreakpoints';
import { breakpointsStore, type BreakpointsState } from './projectBreakpoints';

export interface ProjectBreakpoints {
  /** Desktop's frame width and the breakpoints, as typed. */
  readonly config: BreakpointConfig;
  /** The breakpoints as typed: `64rem`, `1024px`, in bar order, each with its derived direction. */
  readonly list: BreakpointList;
  /** The width of the Desktop frame in the side-by-side view, in pixels (90rem is 1440). Never a media query. */
  readonly desktopFramePx: number;
  /** The same, each with the canvas width it resolves to: 1023, 767, 479 by default. */
  readonly resolved: readonly ResolvedBreakpoint[];
  readonly state: BreakpointsState;
  readonly save: (config: BreakpointConfig) => Promise<Result<void>>;
}

const NO_PROJECT: BreakpointsState = {
  kind: 'loading',
  config: BREAKPOINT_DEFAULT_CONFIG,
  list: BREAKPOINT_DEFAULT_CONFIG.list,
  resolved: resolveBreakpoints(BREAKPOINT_DEFAULT_CONFIG.list),
};
const IGNORE_CHANGES = (): (() => void) => () => undefined;
const NO_PROJECT_STATE = (): BreakpointsState => NO_PROJECT;

export function useProjectBreakpoints(projectPath: string | undefined): ProjectBreakpoints {
  const store = projectPath === undefined || projectPath.length === 0 ? undefined : breakpointsStore(projectPath);
  const state = useSyncExternalStore(store === undefined ? IGNORE_CHANGES : store.subscribe, store === undefined ? NO_PROJECT_STATE : store.getState);
  // Holding the store reads the file now and again when the window comes back to the front.
  useEffect(() => store?.retain(), [store]);
  const save = useCallback(
    (config: BreakpointConfig): Promise<Result<void>> => {
      if (store === undefined) {
        throw new Error('useProjectBreakpoints: no project is open, so nothing can be saved');
      }
      return store.save(config);
    },
    [store],
  );
  return { config: state.config, list: state.list, desktopFramePx: desktopFramePx(state.config.desktop), resolved: state.resolved, state, save };
}
