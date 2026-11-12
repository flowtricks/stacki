// Microphone access for dictation: what the operating system says about it, and what the
// person can do about it. The operating system owns the permission (macOS keeps it per
// application, under the application's own name), so Stacki asks the question and points
// the way; it never decides for the system. These are the values that cross the preload
// bridge, parsed on the way in (docs/contracts.md, "Microphone access").
import { assert } from '../core/assert';
import { record } from '../core/boundary';

/**
 * macOS's own answers (Electron's `systemPreferences.getMediaAccessStatus`), plus 'unknown' for
 * systems that cannot say. Only 'denied' and 'restricted' stop dictation before it starts.
 */
export const MICROPHONE_STATUSES = ['granted', 'not-determined', 'denied', 'restricted', 'unknown'] as const;
export type MicrophoneStatus = (typeof MICROPHONE_STATUSES)[number];

export interface MicrophoneReport {
  readonly status: MicrophoneStatus;
  /** The name the system lists the permission under: "Electron" while developing, "Stacki" installed. */
  readonly appName: string;
  /** Whether the Microphone privacy pane can be opened from the app (macOS). */
  readonly settingsAvailable: boolean;
}

/**
 * The one address the "Open System Settings" button opens. It is fixed here and in the main
 * process alone: no renderer ever supplies an address to open (the channel carries no payload).
 */
export const MICROPHONE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

const APP_NAME_CHARS_MAX = 80;

export function parseMicrophoneReport(input: unknown): MicrophoneReport {
  const value = record(input);
  const status = MICROPHONE_STATUSES.find((candidate) => candidate === value['status']);
  if (status === undefined) {
    throw new Error('microphone.status: unknown status');
  }
  const appName = value['appName'];
  if (typeof appName !== 'string' || appName.length === 0 || appName.length > APP_NAME_CHARS_MAX) {
    throw new Error('microphone.appName: expected a short name');
  }
  if (typeof value['settingsAvailable'] !== 'boolean') {
    throw new Error('microphone.settingsAvailable: expected a boolean');
  }
  return { status, appName, settingsAvailable: value['settingsAvailable'] };
}

/** The reply of the channel that opens the pane. */
export function parseMicrophoneOpened(input: unknown): true {
  const value = record(input);
  if (value['ok'] !== true) {
    throw new Error('microphone.opened: expected ok');
  }
  return true;
}

/**
 * What to tell a person whose microphone is off: the sentence, and the one-line hint naming the
 * application to switch on (macOS lists the development build as "Electron", the installed app
 * as "Stacki"; switching on the wrong one changes nothing).
 */
export function microphoneAdvice(report: MicrophoneReport): { readonly message: string; readonly hint: string } {
  assert(report.appName.length > 0, 'microphoneAdvice: the application has a name');
  const restricted = report.status === 'restricted';
  const message = restricted
    ? 'Microphone access is restricted on this Mac, so voice input cannot start.'
    : 'Microphone access is off. Allow it in System Settings, then try again.';
  const hint = restricted
    ? 'A profile or Screen Time rule blocks it; only an administrator can change that.'
    : `In Privacy & Security → Microphone, switch on “${report.appName}”.`;
  return { message, hint };
}
