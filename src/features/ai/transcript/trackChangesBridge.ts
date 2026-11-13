// Turns the "Snapshot before & after each AI change" preference on from the transcript's quiet note. The preference
// itself lives in main (electron/main.ts) and is read by the agent host when each turn begins, so the
// next turn after this call is tracked.
import { parseIpcPayload } from '../../../../shared/ipc/ipcPayloads';
import { parsePreferenceResult } from '../../../../shared/ipc/preferences';

/** Resolves true when the preference was saved on, false when it applied for this session only or failed. */
export async function turnOnChangeTracking(): Promise<boolean> {
  try {
    const payload = parseIpcPayload('settings:set', { setting: 'aiTrackChanges', enabled: true });
    const result = parsePreferenceResult(await window.avb.setPreference(payload));
    return result.aiTrackChanges && result.saved;
  } catch {
    return false;
  }
}
