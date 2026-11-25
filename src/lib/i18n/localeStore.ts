// The chosen interface language, kept for the app as a whole in localStorage beside the other UI
// preferences (app/settings/settingsTab.ts does the same), and the system languages it falls back
// to. It is a person's way of working, not a project's, so it is not in the project or in IPC.
// Best effort: blocked or corrupt storage means "follow the system", never an error. A change in
// one window reaches the others through the `storage` event.
import { assert } from '../../../shared/core/assert';
import { LOCALE_PREFERENCE_DEFAULT, LOCALE_PREFERENCES, type LocalePreference } from '../../../shared/core/i18n/locales';
import { parseLocalePreference } from '../../../shared/core/i18n/parseLocale';

const STORAGE_KEY = 'stacki.locale';

const listeners = new Set<() => void>();
let started = false;

/** The stored choice; anything absent or not a shipped locale means "system". */
export function readLocalePreference(): LocalePreference {
  try {
    const parsed = parseLocalePreference(localStorage.getItem(STORAGE_KEY));
    return parsed.ok ? parsed.value : LOCALE_PREFERENCE_DEFAULT;
  } catch {
    return LOCALE_PREFERENCE_DEFAULT;
  }
}

export function writeLocalePreference(preference: LocalePreference): void {
  assert(LOCALE_PREFERENCES.includes(preference), 'writeLocalePreference: a known preference');
  try {
    if (preference === LOCALE_PREFERENCE_DEFAULT) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    /* noop: the choice still applies until the window closes */
  }
  notify();
}

/** For `useSyncExternalStore`. */
export function subscribeLocalePreference(listener: () => void): () => void {
  assert(listeners.size < 64, 'subscribeLocalePreference: listeners are removed on unmount');
  listeners.add(listener);
  if (!started && typeof window !== 'undefined') {
    started = true;
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        notify();
      }
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The system's preferred languages: the browser's list, which Electron fills from the operating system's. */
export function systemLanguageTags(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  const tags = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return tags.slice(0, 32);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}
