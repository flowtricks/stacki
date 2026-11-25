// Tells the main process which interface language the person chose, so the application menu and native dialogs follow it
// (docs/i18n-playbook.md, "Main process"). Fire and forget: if main cannot be reached the window still shows the right language,
// and the next launch or change tries again, so a failure is logged, not shown.
import type { LocalePreference } from '../../shared/core/i18n/locales';
import { parseLocaleSetResult } from '../../shared/ipc/localeChannel';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';

export function mirrorLocalePreference(preference: LocalePreference): void {
  window.avb
    .setLocale(parseIpcPayload('locale:set', { preference }))
    .then((reply) => {
      if (!parseLocaleSetResult(reply).saved) {
        console.warn('[i18n] the main process could not save the language; it applies until the app quits');
      }
    })
    .catch((failure: unknown) => {
      console.warn(`[i18n] could not tell the main process the language: ${String(failure)}`);
    });
}
