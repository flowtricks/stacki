// What dictation needs from the outside world, as one value a test can replace: the platform's
// speech recognizer, Stacki's own Whisper engine where it runs (Desktop), the audio meter and the
// clock. The default is the real thing; the composer test provides a fake recognizer, a fake Whisper
// host and a fake meter, so it never touches a microphone, a worker or a model.
import { createContext, useContext } from 'react';
import { chooseSpeechEngine, type SpeechEngine } from '../../../../shared/properties/voice/speechEngine';
import { VOICE_LIMITS } from '../../../../shared/properties/voice/voiceLimits';
import {
  cancelDictationDownload,
  downloadDictationModel,
  hasDictationChannels,
  onDictationProgress,
  readDictationStatus,
  removeDictationModel,
} from '../../../ipc/dictationBridge';
import { browserAudioLevels, type AudioLevelSource } from './audioLevels';
import { createDictationStore, type DictationStore } from './dictationStore';
import { listenToMicrophone } from './microphoneCapture';
import { captureAudioLevels, createVadHost, createWhisperRecognition, createWorkerHost } from './whisperEngine';

/** The slice of the Web Speech API's recognizer that dictation uses. */
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  /** Chromium's on-device recognition; set only when `detectEngine` found the model installed. */
  processLocally: boolean;
  onresult: (event: {
    readonly resultIndex: number;
    readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: unknown } }>;
  }) => void;
  onerror: (event: { readonly error: string }) => void;
  onend: () => void;
  /** Stacki's Whisper engine says when a decode starts and ends, so the draft can pulse; the platform's recognizer never calls it. */
  ondecoding?: (decoding: boolean) => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface VoiceEnvironment {
  /** Whether the platform has a recognizer at all; asking does not create one. */
  readonly isSupported: () => boolean;
  /** A fresh recognizer, or undefined where the platform has none. */
  readonly createRecognition: () => Recognition | undefined;
  /** Which engine would turn speech into words for `language`; asking captures no audio. */
  readonly detectEngine: (language: string) => Promise<SpeechEngine>;
  readonly audioLevels: AudioLevelSource;
  readonly nowMs: () => number;
  /** Stacki's Whisper engine, where it can run; absent in a browser and in tests of the platform recognizer. */
  readonly whisper?: WhisperEnvironment;
}

export interface WhisperEnvironment {
  /** The engine's state and the person's model and language (dictationStore.ts). */
  readonly store: DictationStore;
  /** A Whisper-backed recognizer for one session. */
  readonly createRecognition: () => Recognition;
  /** The waveform, from the same microphone the words come from. */
  readonly audioLevels: AudioLevelSource;
}

// `navigator` is there so a Window is assignable without a global declaration Studio's own would collide with.
interface SpeechWindow {
  readonly navigator: Navigator;
  readonly SpeechRecognition?: RecognitionConstructor;
  readonly webkitSpeechRecognition?: RecognitionConstructor;
}

// `available` is Chromium's static capability query (Chrome 139+); older platforms lack it.
interface RecognitionConstructor {
  new (): Recognition;
  readonly available?: (options: { readonly langs: readonly string[]; readonly processLocally: boolean }) => Promise<unknown>;
}

// Whether the platform says its on-device model for `language` is installed. A missing query, a
// failure or no answer within the bound all mean no: the decision must never hold up the button.
async function onDeviceAvailable(Constructor: RecognitionConstructor, language: string): Promise<'available' | 'unavailable'> {
  const available = Constructor.available;
  if (available === undefined) {
    return 'unavailable';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<unknown>((resolve) => {
    timer = setTimeout(() => resolve(undefined), VOICE_LIMITS.engineDetectMsMax);
  });
  try {
    const answer = await Promise.race([available.call(Constructor, { langs: [language], processLocally: true }), timeout]);
    return answer === 'available' ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

export function browserVoiceEnvironment(): VoiceEnvironment {
  const whisper = browserWhisper();
  const constructorOf = (): RecognitionConstructor | undefined => {
    const speech: SpeechWindow = window;
    return speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
  };
  return {
    isSupported: () => constructorOf() !== undefined,
    createRecognition: () => {
      const Constructor = constructorOf();
      return Constructor === undefined ? undefined : new Constructor();
    },
    detectEngine: async (language) => {
      const Constructor = constructorOf();
      return chooseSpeechEngine({
        recognizer: Constructor === undefined ? 'absent' : 'present',
        // With Whisper here the platform's answer is not needed, and asking can take seconds.
        onDevice: Constructor === undefined || whisper !== undefined ? 'unavailable' : await onDeviceAvailable(Constructor, language),
        userAgent: window.navigator.userAgent,
        whisper: whisper === undefined ? 'unavailable' : 'available',
      });
    },
    audioLevels: browserAudioLevels,
    nowMs: () => performance.now(),
    ...(whisper === undefined ? {} : { whisper }),
  };
}

// Whisper runs where the page can start a module worker, run WebAssembly and capture audio through a
// worklet, and the main process serves the model: Desktop. Nothing here starts a worker or loads a byte;
// the first session does (whisperEngine.ts).
function browserWhisper(): WhisperEnvironment | undefined {
  if (!hasDictationChannels() || typeof Worker !== 'function' || typeof WebAssembly !== 'object' || typeof AudioWorkletNode !== 'function') {
    return undefined;
  }
  const store = createDictationStore({
    status: readDictationStatus,
    download: downloadDictationModel,
    cancel: cancelDictationDownload,
    remove: removeDictationModel,
    onProgress: onDictationProgress,
  });
  const host = createWorkerHost(() => new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module', name: 'stacki-whisper' }));
  // Silero VAD in its own worker, so a Whisper decode never delays it (vadWorker.ts).
  const vad = createVadHost(() => new Worker(new URL('./vadWorker.ts', import.meta.url), { type: 'module', name: 'stacki-vad' }));
  return {
    store,
    createRecognition: () => createWhisperRecognition({ host, vad, store, listen: listenToMicrophone, nowMs: () => performance.now() }),
    audioLevels: captureAudioLevels(listenToMicrophone),
  };
}

const DEFAULT_ENVIRONMENT = browserVoiceEnvironment();
export const VoiceEnvironmentContext = createContext<VoiceEnvironment>(DEFAULT_ENVIRONMENT);

export function useVoiceEnvironment(): VoiceEnvironment {
  return useContext(VoiceEnvironmentContext);
}
