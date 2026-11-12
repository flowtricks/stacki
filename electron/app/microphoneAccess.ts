// The main-process side of dictation's microphone access. macOS keeps the permission per
// application and caches a refusal, so the question is asked here, where `systemPreferences`
// lives, and the answer travels to the panel as a MicrophoneReport.
//
// The seam is `MicrophoneSystem`: electron's `systemPreferences`, `shell` and `app` behind
// four functions, so each branch (granted, not determined, denied, restricted) is tested
// without a window or a real permission.
import { assert } from '../../shared/core/assert';
import { MICROPHONE_SETTINGS_URL, MICROPHONE_STATUSES, type MicrophoneReport, type MicrophoneStatus } from '../../shared/properties/microphone';

export interface MicrophoneSystem {
  readonly platform: NodeJS.Platform;
  /** The application's own name, as the system lists it under Privacy & Security. */
  readonly appName: string;
  readonly mediaAccessStatus: () => string;
  /** Shows the system's prompt; resolves true when the person allowed it. */
  readonly askForAccess: () => Promise<boolean>;
  readonly openExternal: (url: string) => Promise<void>;
}

/** What the system said, narrowed to a status Stacki knows; anything else is 'unknown'. */
export function narrowStatus(text: string): MicrophoneStatus {
  return MICROPHONE_STATUSES.find((candidate) => candidate === text) ?? 'unknown';
}

export function microphoneStatus(system: MicrophoneSystem): MicrophoneReport {
  assert(system.appName.length > 0, 'microphoneStatus: the application has a name');
  // Only macOS keeps a per-application microphone permission Stacki can read and send people to.
  if (system.platform !== 'darwin') {
    return { status: 'unknown', appName: system.appName, settingsAvailable: false };
  }
  return { status: narrowStatus(system.mediaAccessStatus()), appName: system.appName, settingsAvailable: true };
}

/**
 * Asks the system for the microphone when it has not been asked yet (that is what makes macOS
 * show its prompt); in every other status the system would not ask again, so the report is the
 * answer and the person is sent to System Settings instead.
 */
export async function requestMicrophone(system: MicrophoneSystem): Promise<MicrophoneReport> {
  const before = microphoneStatus(system);
  if (before.status !== 'not-determined') {
    return before;
  }
  const allowed = await system.askForAccess();
  const after = microphoneStatus(system);
  // The prompt's answer and the system's status are two reads of one fact; they must agree.
  assert(!allowed || after.status === 'granted', 'requestMicrophone: an allowed prompt leaves the status granted');
  return after;
}

/** Opens the Microphone privacy pane: the fixed address only, and only where it exists. */
export async function openMicrophoneSettings(system: MicrophoneSystem): Promise<void> {
  assert(system.platform === 'darwin', 'openMicrophoneSettings: the pane exists on macOS only');
  await system.openExternal(MICROPHONE_SETTINGS_URL);
}
