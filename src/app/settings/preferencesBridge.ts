import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parsePreferences, parsePreferenceResult, type PreferenceChange } from '../../../shared/ipc/preferences';

export function readPreferences() {
  return window.avb.settings(parseIpcPayload('settings:get', undefined)).then(parsePreferences);
}

export function savePreference(input: PreferenceChange) {
  const payload = parseIpcPayload('settings:set', input);
  return window.avb.setPreference(payload).then(parsePreferenceResult);
}
