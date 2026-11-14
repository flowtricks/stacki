// The variable suggestion dropdowns' view of `.stacki/variables.json`: `useHiddenVariables(projectPath)`.
//
//   const { hidden, isHidden } = useHiddenVariables(projectPath);
//   const shown = suggestionNames(candidates, hidden, appliedName);   // shared/properties/variableVisibility.ts
//
// `hidden` is the cached set, available on the first render with no await, and the component renders again when a
// toggle (here or in another window's file) changes it. The rule a suggestion list follows is `suggestionNames`: hidden
// variables are left out, except the one applied to the property being edited, which stays listed and selected. Hiding
// never affects the Variables panel, how a variable resolves, the canvas or the exported CSS.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Result } from '../../../shared/core/result';
import { hiddenVariablesStore, type HiddenVariablesState } from './hiddenVariables';

export interface HiddenVariables {
  /** The names left out of suggestions (`--light-100`). Empty while the file is first read, and when it cannot be read. */
  readonly hidden: ReadonlySet<string>;
  readonly state: HiddenVariablesState;
  readonly isHidden: (name: string) => boolean;
  readonly hide: (name: string) => Promise<Result<void>>;
  readonly show: (name: string) => Promise<Result<void>>;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const NO_PROJECT: HiddenVariablesState = { kind: 'loading', hidden: NOTHING_HIDDEN };
const IGNORE_CHANGES = (): (() => void) => () => undefined;
const NO_PROJECT_STATE = (): HiddenVariablesState => NO_PROJECT;

export function useHiddenVariables(projectPath: string | undefined): HiddenVariables {
  const store = projectPath === undefined || projectPath.length === 0 ? undefined : hiddenVariablesStore(projectPath);
  const state = useSyncExternalStore(store === undefined ? IGNORE_CHANGES : store.subscribe, store === undefined ? NO_PROJECT_STATE : store.getState);
  // Holding the store reads the file now and again when the window comes back to the front.
  useEffect(() => store?.retain(), [store]);
  const isHidden = useCallback((name: string) => state.hidden.has(name), [state]);
  const hide = useCallback((name: string) => requireStore(store).hide(name), [store]);
  const show = useCallback((name: string) => requireStore(store).show(name), [store]);
  return { hidden: state.hidden, state, isHidden, hide, show };
}

function requireStore(store: ReturnType<typeof hiddenVariablesStore> | undefined): ReturnType<typeof hiddenVariablesStore> {
  if (store === undefined) {
    throw new Error('useHiddenVariables: no project is open, so nothing can be hidden');
  }
  return store;
}
