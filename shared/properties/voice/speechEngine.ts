// Which engine turns speech into words, and what a recognition error means for the person.
//
// Chromium's Web Speech API has two backends: Google's online speech service, reached with API
// keys that Google builds into Chrome, and an on-device model (`processLocally`) that Chrome
// downloads through its component updater. Electron ships neither: no keys and no component
// updater. So in Desktop the recognizer exists, opens the microphone, and then ends with
// `error: "network"` although the computer is online (probed in a hidden Electron 44 window:
// "start | audiostart | audioend | error:network"), and `SpeechRecognition.available()` still
// answers "available" for the online service. A "check your connection" message there is wrong;
// these functions say what is true instead.
//
// Desktop therefore brings its own engine: Whisper, on this computer, in a worker
// (docs/voice-engine.md). Its failures arrive through the same recognizer seam as `engine-…` codes
// (`engineErrorCode`), so one table below says what every failure means, whichever engine raised it.
import { assert } from '../../core/assert';
import type { EngineFailure } from './dictationEngine';

/** The longest recognition error code shown to the person; Chromium's codes are under 32 characters. */
const ERROR_CODE_CHARS_MAX = 48;

/** Where the words come from, as far as the platform can say before any audio is captured. */
export type SpeechEngine =
  /** The platform's online service; whether it answers shows on the first try. */
  | { readonly kind: 'online' }
  /** An on-device model the platform says is installed for the language. */
  | { readonly kind: 'onDevice' }
  /** Stacki's own Whisper engine: runs in a worker on this computer once its model is downloaded. */
  | { readonly kind: 'whisper' }
  | { readonly kind: 'none'; readonly reason: SpeechEngineMissing };

/** Why no engine can run: no recognizer at all, or a recognizer with no speech service behind it. */
export type SpeechEngineMissing = 'noRecognizer' | 'serviceMissing';

/** What the platform reports before listening. `onDevice` is the answer of `available({ processLocally: true })`. */
export interface EngineFacts {
  readonly recognizer: 'present' | 'absent';
  readonly onDevice: 'available' | 'unavailable';
  readonly userAgent: string;
  /** Whether Stacki's Whisper engine can run here (Desktop: a worker, WebAssembly and the model channels). Absent means no. */
  readonly whisper?: 'available' | 'unavailable';
}

/** Picks the engine: Stacki's Whisper where it runs, the platform's on-device model, none in an Electron build without either, online otherwise. */
export function chooseSpeechEngine(facts: EngineFacts): SpeechEngine {
  // Whisper does not need the platform's recognizer at all, and it never sends audio anywhere.
  if (facts.whisper === 'available') {
    return { kind: 'whisper' };
  }
  if (facts.recognizer === 'absent') {
    return { kind: 'none', reason: 'noRecognizer' };
  }
  if (facts.onDevice === 'available') {
    return { kind: 'onDevice' };
  }
  if (isElectronUserAgent(facts.userAgent)) {
    return { kind: 'none', reason: 'serviceMissing' };
  }
  return { kind: 'online' };
}

/** Whether a user agent is Electron's: Electron adds `Electron/<version>` to Chromium's and Stacki keeps that default. */
export function isElectronUserAgent(userAgent: string): boolean {
  return /\bElectron\/\d/u.test(userAgent);
}

/** The cause of a recognition error, in the person's terms. */
export type RecognitionFailure =
  /** The recognizer has no speech service behind it (online, yet "network"; or the service refused). */
  | { readonly kind: 'serviceMissing' }
  /** A network error while the computer is offline: reconnecting fixes it. */
  | { readonly kind: 'offline' }
  /** The system keeps the microphone off for this application. */
  | { readonly kind: 'microphoneBlocked' }
  /** The system allows the microphone but Chromium refused this window. */
  | { readonly kind: 'windowBlocked' }
  /** No microphone could be opened. */
  | { readonly kind: 'noMicrophone' }
  | { readonly kind: 'noSpeech' }
  /** Something else ended the recognizer before it finished. */
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'language' }
  /** Whisper's model is not on this computer: the notice offers to set dictation up. */
  | { readonly kind: 'modelMissing' }
  /** Neither WebGPU nor WebAssembly could run the model here. */
  | { readonly kind: 'engineBackend' }
  /** The model's files could not be read: removing and downloading it again fixes it. */
  | { readonly kind: 'modelCorrupt' }
  /** The engine stopped answering or ended by itself (memory, a runtime fault). */
  | { readonly kind: 'engineCrashed' }
  /** This computer decodes slower than speech: the notice offers the smaller model. */
  | { readonly kind: 'tooSlow' }
  /** A code this table does not know; `code` is bounded and safe to show. */
  | { readonly kind: 'unknown'; readonly code: string };

/** What else is known when an error arrives: the connection, and the system's microphone answer. */
export interface FailureContext {
  readonly connection: 'online' | 'offline';
  readonly microphone: 'allowed' | 'refused' | 'unknown';
}

/** Maps a Web Speech `error` code (untrusted platform text) to its cause. */
export function classifyRecognitionError(code: string, context: FailureContext): RecognitionFailure {
  switch (code) {
    case 'network':
      return context.connection === 'offline' ? { kind: 'offline' } : { kind: 'serviceMissing' };
    case 'not-allowed':
      return microphoneFailure(context, { kind: 'windowBlocked' });
    case 'service-not-allowed':
      return microphoneFailure(context, { kind: 'serviceMissing' });
    case 'audio-capture':
      return { kind: 'noMicrophone' };
    case 'no-speech':
      return { kind: 'noSpeech' };
    case 'aborted':
      return { kind: 'interrupted' };
    case 'language-not-supported':
      return { kind: 'language' };
    case 'engine-model-missing':
      return { kind: 'modelMissing' };
    case 'engine-backend':
      return { kind: 'engineBackend' };
    case 'engine-model-corrupt':
      return { kind: 'modelCorrupt' };
    case 'engine-stuck':
    case 'engine-crashed':
      return { kind: 'engineCrashed' };
    case 'engine-too-slow':
      return { kind: 'tooSlow' };
    default:
      return { kind: 'unknown', code: displayableCode(code) };
  }
}

/** The recognizer error code a Whisper failure travels as (classifyRecognitionError reads it back). */
export function engineErrorCode(failure: EngineFailure): string {
  const code = ENGINE_ERROR_CODES[failure];
  assert(code.startsWith('engine-'), 'engineErrorCode: engine codes share a prefix');
  assert(classifyRecognitionError(code, { connection: 'online', microphone: 'allowed' }).kind !== 'unknown', 'engineErrorCode: every code is understood');
  return code;
}

const ENGINE_ERROR_CODES: { readonly [Failure in EngineFailure]: string } = {
  backendUnavailable: 'engine-backend',
  modelMissing: 'engine-model-missing',
  modelCorrupt: 'engine-model-corrupt',
  engineStuck: 'engine-stuck',
  engineCrashed: 'engine-crashed',
  tooSlow: 'engine-too-slow',
};

// A refusal by the system is the cause the person can fix; otherwise the code's own meaning.
function microphoneFailure(context: FailureContext, otherwise: RecognitionFailure): RecognitionFailure {
  if (context.microphone === 'refused') {
    return { kind: 'microphoneBlocked' };
  }
  return otherwise;
}

// The code goes into a sentence: only lowercase letters, digits and hyphens, and a bounded length.
function displayableCode(code: string): string {
  const cleaned = code.replace(/[^a-z0-9-]/gu, '').slice(0, ERROR_CODE_CHARS_MAX);
  assert(cleaned.length <= ERROR_CODE_CHARS_MAX, 'displayableCode: the code is bounded');
  assert(/^[a-z0-9-]*$/u.test(cleaned), 'displayableCode: the code holds only safe characters');
  return cleaned === '' ? 'unknown' : cleaned;
}
