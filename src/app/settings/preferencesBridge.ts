import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parsePreferences, parsePreferenceResult } from '../../../shared/ipc/preferences';

export function readPreferences() {
  return window.avb.settings(parseIpcPayload('settings:get', undefined)).then(parsePreferences);
}

export function savePreference(input: { readonly setting: 'sound' | 'usageCountsEnabled'; readonly enabled: boolean }) {
  const payload = parseIpcPayload('settings:set', input);
  return window.avb.setPreference(payload).then(parsePreferenceResult);
}
