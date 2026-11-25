// Goal: dictation says what is true. Every Web Speech error code maps to its real cause, a
// "network" error while online is a missing speech service (never "check your connection"), and
// the engine choice prefers on-device, refuses an Electron build's empty online service, and
// otherwise tries the online one.
// Methodology: the pure functions over every code Chromium emits, both connection states and the
// three microphone answers, plus hostile codes (markup, oversize, empty) and Electron and Chrome
// user agents.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseSpeechEngine, classifyRecognitionError, isElectronUserAgent, type FailureContext } from '#dist/shared/properties/voice/speechEngine.js';

const online: FailureContext = { connection: 'online', microphone: 'allowed' };
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) stacki/1.4.11 Chrome/152.0.7977.167 Electron/44.9.0 Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

test('network is a missing service while online and the connection only while offline', () => {
  assert.deepEqual(classifyRecognitionError('network', online), { kind: 'serviceMissing' });
  assert.deepEqual(classifyRecognitionError('network', { ...online, connection: 'offline' }), { kind: 'offline' });
});

test('a refusal by the system wins over the code; otherwise the code says what was refused', () => {
  for (const code of ['not-allowed', 'service-not-allowed']) {
    assert.deepEqual(classifyRecognitionError(code, { ...online, microphone: 'refused' }), { kind: 'microphoneBlocked' });
  }
  assert.deepEqual(classifyRecognitionError('not-allowed', online), { kind: 'windowBlocked' });
  assert.deepEqual(classifyRecognitionError('not-allowed', { ...online, microphone: 'unknown' }), { kind: 'windowBlocked' });
  assert.deepEqual(classifyRecognitionError('service-not-allowed', online), { kind: 'serviceMissing' });
});

test('every other Chromium code has its own cause', () => {
  assert.deepEqual(classifyRecognitionError('audio-capture', online), { kind: 'noMicrophone' });
  assert.deepEqual(classifyRecognitionError('no-speech', online), { kind: 'noSpeech' });
  assert.deepEqual(classifyRecognitionError('aborted', online), { kind: 'interrupted' });
  assert.deepEqual(classifyRecognitionError('language-not-supported', online), { kind: 'language' });
  assert.deepEqual(classifyRecognitionError('bad-grammar', online), { kind: 'unknown', code: 'bad-grammar' });
  assert.deepEqual(classifyRecognitionError('phrases-not-supported', online), { kind: 'unknown', code: 'phrases-not-supported' });
});

test('an unknown code is cleaned and bounded before it is shown', () => {
  assert.deepEqual(classifyRecognitionError('<b>x</b>', online), { kind: 'unknown', code: 'bxb' });
  assert.deepEqual(classifyRecognitionError('', online), { kind: 'unknown', code: 'unknown' });
  assert.deepEqual(classifyRecognitionError('NETWORK', online), { kind: 'unknown', code: 'unknown' });
  const long = classifyRecognitionError('a'.repeat(500), online);
  assert.equal(long.kind, 'unknown');
  assert.equal(long.kind === 'unknown' ? long.code.length : 0, 48);
});

test('Electron is recognized by its user agent token only', () => {
  assert.equal(isElectronUserAgent(ELECTRON_UA), true);
  assert.equal(isElectronUserAgent(CHROME_UA), false);
  assert.equal(isElectronUserAgent('Electronic/1'), false);
  assert.equal(isElectronUserAgent(''), false);
});

test('the engine: none without a recognizer, on-device when installed, none in Electron, online elsewhere', () => {
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'absent', onDevice: 'available', userAgent: CHROME_UA }), { kind: 'none', reason: 'noRecognizer' });
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'present', onDevice: 'available', userAgent: ELECTRON_UA }), { kind: 'onDevice' });
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'present', onDevice: 'unavailable', userAgent: ELECTRON_UA }), { kind: 'none', reason: 'serviceMissing' });
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'present', onDevice: 'unavailable', userAgent: CHROME_UA }), { kind: 'online' });
});
