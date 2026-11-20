/*
 * The Style selectors panel's tab, remembered per project in this app's local storage (the mechanism
 * the Assets panel's view uses, src/lib/projectPreference.ts). Only a tab the person picked is stored,
 * so a project with none still opens on the first-open default (see `initialFilter`), and a stored tab
 * wins on every later open, even when its count is 0.
 */
import { loadProjectPreference, saveProjectPreference, type PreferenceStorage, type ProjectPreferenceSpec } from '../../lib/projectPreference';
import { isSelectorFilter, type SelectorFilter } from './selectorList';

export const SELECTOR_TAB_KEY = 'stacki.selectorsPanel.tabs';

/** Projects whose tab is remembered; the least recently changed is forgotten first. */
export const SELECTOR_TAB_PROJECTS_MAX = 50;

export const SELECTOR_TAB_SPEC: ProjectPreferenceSpec<SelectorFilter> = {
  storageKey: SELECTOR_TAB_KEY,
  projectsMax: SELECTOR_TAB_PROJECTS_MAX,
  parseValue: (stored) => (isSelectorFilter(stored) ? stored : undefined),
};

/** The project's remembered tab, or `undefined` when it has none (or the stored one is not a tab). */
export function loadSelectorTab(project: string, storage?: PreferenceStorage): SelectorFilter | undefined {
  return loadProjectPreference(SELECTOR_TAB_SPEC, project, storage);
}

/** Remembers the tab the person picked for the project. */
export function saveSelectorTab(project: string, filter: SelectorFilter, storage?: PreferenceStorage): void {
  saveProjectPreference(SELECTOR_TAB_SPEC, project, filter, storage);
}
