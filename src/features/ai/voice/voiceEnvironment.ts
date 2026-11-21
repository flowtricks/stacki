// What dictation needs from the outside world, as one value a test can replace: the platform's
// speech recognizer, the audio meter and the clock. The default is the real thing; the
// composer test provides a fake recognizer and a fake meter, so it never touches a microphone.
import { createContext, useContext } from 'react';
import { browserAudioLevels, type AudioLevelSource } from './audioLevels';

/** The slice of the Web Speech API's recognizer that dictation uses. */
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: {
    readonly resultIndex: number;
    readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: unknown } }>;
  }) => void;
  onerror: (event: { readonly error: string }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface VoiceEnvironment {
  /** Whether the platform has a recognizer at all; asking does not create one. */
  readonly isSupported: () => boolean;
  /** A fresh recognizer, or undefined where the platform has none. */
  readonly createRecognition: () => Recognition | undefined;
  readonly audioLevels: AudioLevelSource;
  readonly nowMs: () => number;
}

// `navigator` is there so a Window is assignable without a global declaration Studio's own would collide with.
interface SpeechWindow {
  readonly navigator: Navigator;
  readonly SpeechRecognition?: new () => Recognition;
  readonly webkitSpeechRecognition?: new () => Recognition;
}

export function browserVoiceEnvironment(): VoiceEnvironment {
  const constructorOf = (): (new () => Recognition) | undefined => {
    const speech: SpeechWindow = window;
    return speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
  };
  return {
    isSupported: () => constructorOf() !== undefined,
    createRecognition: () => {
      const Constructor = constructorOf();
      return Constructor === undefined ? undefined : new Constructor();
    },
    audioLevels: browserAudioLevels,
    nowMs: () => performance.now(),
  };
}

const DEFAULT_ENVIRONMENT = browserVoiceEnvironment();
export const VoiceEnvironmentContext = createContext<VoiceEnvironment>(DEFAULT_ENVIRONMENT);

export function useVoiceEnvironment(): VoiceEnvironment {
  return useContext(VoiceEnvironmentContext);
}
