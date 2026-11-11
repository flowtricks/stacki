// Speech to text for the composer, through the platform's speech recognition
// (Chromium's, inside Electron). Ported from Studio's chat
// (studio/src/features/ai/useDictation.ts).
import { useEffect, useRef, useState } from 'react';

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: {
    readonly resultIndex: number;
    readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: string } }>;
  }) => void;
  onerror: (event: { readonly error: string }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

// `navigator` is there so a Window is assignable without a global declaration Studio's own would collide with.
interface SpeechWindow {
  readonly navigator: Navigator;
  readonly SpeechRecognition?: new () => Recognition;
  readonly webkitSpeechRecognition?: new () => Recognition;
}

const ignore = (): void => undefined;

export function useDictation(append: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const recognition = useRef<Recognition>();
  const callback = useRef(append);
  callback.current = append;
  const speech: SpeechWindow = window;
  const Constructor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
  useEffect(
    () => () => {
      const current = recognition.current;
      if (current) {
        current.onresult = ignore;
        current.onerror = ignore;
        current.onend = ignore;
        current.abort();
      }
    },
    [],
  );
  function toggle(): void {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!Constructor) {
      setError('Voice input is not available here.');
      return;
    }
    setError(undefined);
    const current = new Constructor();
    recognition.current = current;
    current.continuous = false;
    current.interimResults = true;
    current.lang = navigator.language;
    current.onresult = (event) => {
      const results = Array.from(event.results);
      setInterim(
        results
          .filter((result) => !result.isFinal)
          .map((result) => result[0].transcript)
          .join(' '),
      );
      const final = results
        .slice(event.resultIndex)
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript)
        .join(' ');
      if (final) {
        callback.current(final);
      }
    };
    current.onerror = (event) => {
      setError(
        event.error === 'not-allowed' ? 'Microphone access was denied. Allow it in System Settings and try again.' : `Voice input failed (${event.error}).`,
      );
      setListening(false);
    };
    current.onend = () => {
      setListening(false);
      setInterim('');
    };
    try {
      current.start();
      setListening(true);
    } catch {
      setError('Could not start the microphone. Try again.');
    }
  }
  return { listening, interim, error, supported: Constructor !== undefined, toggle };
}
