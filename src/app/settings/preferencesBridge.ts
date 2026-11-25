import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parsePreferences, parsePreferenceResult, type PreferenceName } from '../../../shared/ipc/preferences';

export function readPreferences() {
  return window.avb.settings(parseIpcPayload('settings:get', undefined)).then(parsePreferences);
}

export function savePreference(input: { readonly setting: PreferenceName; readonly enabled: boolean }) {
  const payload = parseIpcPayload('settings:set', input);
  return window.avb.setPreference(payload).then(parsePreferenceResult);
}
