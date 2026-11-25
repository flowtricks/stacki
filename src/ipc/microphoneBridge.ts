// The renderer's side of the microphone channels: each reply is parsed before a component
// sees it (docs/contracts.md, "Microphone access"). The channels carry no payload; the one
// address "Open System Settings" opens is fixed in the main process.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseMicrophoneOpened, parseMicrophoneReport, type MicrophoneReport } from '../../shared/properties/microphone';

/** The system's answer for the microphone, without asking the person anything. */
export function readMicrophone(): Promise<MicrophoneReport> {
  return window.avb.microphoneStatus(parseIpcPayload('microphone:status', undefined)).then(parseMicrophoneReport);
}

/** Asks the system when it has not been asked yet (its prompt appears); otherwise reads the answer. */
export function requestMicrophone(): Promise<MicrophoneReport> {
  return window.avb.microphoneRequest(parseIpcPayload('microphone:request', undefined)).then(parseMicrophoneReport);
}

export function openMicrophoneSettings(): Promise<void> {
  return window.avb.microphoneOpenSettings(parseIpcPayload('microphone:openSettings', undefined)).then((input) => void parseMicrophoneOpened(input));
}
