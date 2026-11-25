// Goal: dictation's microphone access is decided from the system's answer, each answer in
// its own way. Granted and unknown start listening; not-determined makes the system ask
// (macOS shows its prompt); denied and restricted do not ask again and point the person
// to System Settings; the one address that opens is fixed, and only on macOS.
// Methodology: the main-process functions from dist/ over a fake MicrophoneSystem that
// records each question and every address opened, then the renderer-facing parser and
// advice text from shared/ against known-good and malformed replies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { microphoneStatus, narrowStatus, openMicrophoneSettings, requestMicrophone, type MicrophoneSystem } from '#dist/electron/app/microphoneAccess.js';
import { MICROPHONE_SETTINGS_URL, microphoneAdvice, parseMicrophoneOpened, parseMicrophoneReport } from '#dist/shared/properties/microphone.js';

function fakeSystem(status: string, overrides: Partial<Pick<MicrophoneSystem, 'platform' | 'appName'>> & { readonly allowOnPrompt?: boolean } = {}) {
  const opened: string[] = [];
  const log = { asked: 0, opened, status };
  const system: MicrophoneSystem = {
    platform: overrides.platform ?? 'darwin',
    appName: overrides.appName ?? 'Electron',
    mediaAccessStatus: () => log.status,
    askForAccess: async () => {
      log.asked += 1;
      const allowed = overrides.allowOnPrompt === true;
      log.status = allowed ? 'granted' : 'denied';
      return allowed;
    },
    openExternal: async (url) => {
      log.opened.push(url);
    },
  };
  return { system, log };
}

test('each status the system gives is reported as it is; anything else is unknown', async () => {
  for (const status of ['granted', 'not-determined', 'denied', 'restricted'] as const) {
    assert.deepEqual(microphoneStatus(fakeSystem(status).system), { status, appName: 'Electron', settingsAvailable: true }, status);
  }
  assert.equal(narrowStatus('surprise'), 'unknown');
  assert.equal(microphoneStatus(fakeSystem('surprise').system).status, 'unknown');
});

test('other systems cannot say and cannot be sent to a macOS pane', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.deepEqual(microphoneStatus(fakeSystem('granted', { platform }).system), { status: 'unknown', appName: 'Electron', settingsAvailable: false });
  }
});

test('granted, denied and restricted never ask again; not-determined asks once and reports the answer', async () => {
  for (const status of ['granted', 'denied', 'restricted']) {
    const { system, log } = fakeSystem(status);
    assert.equal((await requestMicrophone(system)).status, status);
    assert.equal(log.asked, 0, `${status}: the system would not ask again, so Stacki does not pretend to`);
  }
  const allowed = fakeSystem('not-determined', { allowOnPrompt: true });
  assert.equal((await requestMicrophone(allowed.system)).status, 'granted');
  assert.equal(allowed.log.asked, 1);
  const refused = fakeSystem('not-determined', { allowOnPrompt: false });
  assert.equal((await requestMicrophone(refused.system)).status, 'denied');
  assert.equal(refused.log.asked, 1);
});

test('System Settings opens the Microphone pane at its one fixed address, on macOS only', async () => {
  const { system, log } = fakeSystem('denied');
  await openMicrophoneSettings(system);
  assert.deepEqual(log.opened, [MICROPHONE_SETTINGS_URL]);
  assert.equal(MICROPHONE_SETTINGS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  const other = fakeSystem('denied', { platform: 'linux' });
  await assert.rejects(openMicrophoneSettings(other.system), /Assertion failed: openMicrophoneSettings: the pane exists on macOS only/);
  assert.deepEqual(other.log.opened, []);
});

test('the report parser accepts what main sends and refuses every other shape', () => {
  const good = { status: 'denied', appName: 'Electron', settingsAvailable: true };
  assert.deepEqual(parseMicrophoneReport(good), good);
  for (const bad of [
    undefined,
    'denied',
    [],
    { ...good, status: 'maybe' },
    { ...good, status: undefined },
    { ...good, appName: '' },
    { ...good, appName: 'x'.repeat(81) },
    { ...good, appName: 7 },
    { ...good, settingsAvailable: 'yes' },
    { status: 'granted', appName: 'Stacki' },
  ]) {
    assert.throws(() => parseMicrophoneReport(bad), JSON.stringify(bad));
  }
  assert.equal(parseMicrophoneOpened({ ok: true }), true);
  assert.throws(() => parseMicrophoneOpened({ ok: false }));
  assert.throws(() => parseMicrophoneOpened(undefined));
});

test('the advice names the application to switch on: Electron while developing, Stacki installed', () => {
  assert.match(microphoneAdvice({ status: 'denied', appName: 'Electron', settingsAvailable: true }).hint, /“Electron”/);
  assert.match(microphoneAdvice({ status: 'denied', appName: 'Stacki', settingsAvailable: true }).hint, /“Stacki”/);
  const restricted = microphoneAdvice({ status: 'restricted', appName: 'Stacki', settingsAvailable: true });
  assert.match(restricted.message, /restricted/);
  assert.doesNotMatch(restricted.hint, /switch on/, 'a restriction is not a switch the person can flip');
});
