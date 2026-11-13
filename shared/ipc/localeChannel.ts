// The renderer's chosen interface language, mirrored to the main process so the application menu and native dialogs speak it
// (docs/i18n-playbook.md, "Main process"). The renderer's `stacki.locale` remains the source of truth: it tells main at startup and on
// every change, and main keeps the last value in settings.json so the menu is right from its first paint on the next launch.
import { boolean, object } from '../core/boundary';
import { LOCALE_PREFERENCES, type LocalePreference } from '../core/i18n/locales';
import { parseLocalePreference } from '../core/i18n/parseLocale';

/** Throws on anything but a shipped locale or "system"; the contract layer's parsers throw (docs/contracts.md). */
export function parseLocalePreferenceValue(input: unknown): LocalePreference {
  const parsed = parseLocalePreference(input);
  if (!parsed.ok) {
    throw new Error(`Locale preference: expected one of ${LOCALE_PREFERENCES.join(', ')}`);
  }
  return parsed.value;
}

export const parseLocaleSet = object({ preference: parseLocalePreferenceValue });
export const parseLocaleSetResult = object({ saved: boolean });
