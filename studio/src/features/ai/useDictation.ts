import { useEffect, useRef, useState } from 'react';
import { studioTranslate } from './studioWords';

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: {
        readonly resultIndex: number;
        readonly results: ArrayLike<{
          readonly isFinal: boolean;
          readonly 0: { readonly transcript: string };
        }>;
      }) => void)
    | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}
export function useDictation(append: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const recognition = useRef<Recognition>();
  const callback = useRef(append);
  callback.current = append;
  const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  useEffect(
    () => () => {
      const current = recognition.current;
      if (current) {
        current.onresult = null;
        current.onerror = null;
        current.onend = null;
        current.abort();
      }
    },
    [],
  );
  function toggle() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!Constructor) {
      setError(studioTranslate()('ai.studio.dictation.unavailable'));
      return;
    }
    setError('');
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
      setError(dictationError(event.error));
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
      setError(studioTranslate()('ai.dictation.startFailed'));
    }
  }
  return { listening, interim, error, supported: !!Constructor, toggle };
}

function dictationError(code: string) {
  return code === 'not-allowed' ? studioTranslate()('ai.studio.dictation.denied') : studioTranslate()('ai.studio.dictation.failed', { code });
}
