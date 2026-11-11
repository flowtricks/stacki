/*
 * The Settings dialog's tabs, and the one it opened on last. A person's way of
 * working, not a project's: it is kept for the app as a whole, in localStorage
 * beside the other UI preferences (style/model/toolPreferences.ts).
 * Best-effort: a read or write failure falls back to the first tab rather than
 * throwing, so blocked or corrupt storage never stops Settings from opening.
 */
import { assert } from '../../../shared/core/assert';

/** The tabs, in sidebar order. */
export const SETTINGS_TABS = ['editor', 'folders', 'cms', 'studio', 'instructions', 'audits', 'roles'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_DEFAULT: SettingsTab = 'editor';

const SETTINGS_TAB_KEY = 'stacki.settings.tab';

/** A stored tab, or the default for anything absent or not one: storage is
 * shared with every earlier build, so what it holds is parsed like any input. */
export function parseStoredSettingsTab(raw: unknown): SettingsTab {
  if (typeof raw === 'string') {
    const found = SETTINGS_TABS.find((tab) => tab === raw);
    if (found === undefined) {
      return SETTINGS_TAB_DEFAULT;
    }
    return found;
  }
  return SETTINGS_TAB_DEFAULT;
}

export function loadSettingsTab(): SettingsTab {
  try {
    return parseStoredSettingsTab(localStorage.getItem(SETTINGS_TAB_KEY));
  } catch {
    return SETTINGS_TAB_DEFAULT;
  }
}

export function saveSettingsTab(tab: SettingsTab): void {
  assert(SETTINGS_TABS.includes(tab), 'A Settings tab is one of SETTINGS_TABS');
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, tab);
  } catch {
    /* noop: an unsaved tab only means Settings opens on the first one next time */
  }
}

/** The tab `key` moves to from `current`: arrows step and wrap, Home and End
 * jump to the ends. Undefined for a key the tab list does not handle. `tabs`
 * is the list shown, which leaves out tabs the project's role hides. */
export function settingsTabAfterKey(current: SettingsTab, key: string, tabs: readonly SettingsTab[] = SETTINGS_TABS): SettingsTab | undefined {
  const index = tabs.indexOf(current);
  assert(index >= 0, 'The current tab is one of the shown tabs');
  const count = tabs.length;
  let target: number;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      target = (index + 1) % count;
      break;
    case 'ArrowUp':
    case 'ArrowLeft':
      target = (index - 1 + count) % count;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = count - 1;
      break;
    default:
      return undefined;
  }
  const tab = tabs[target];
  assert(tab !== undefined, 'The target index is inside the shown tabs');
  return tab;
}
