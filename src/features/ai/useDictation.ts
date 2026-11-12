// Speech to text for the composer, through the platform's speech recognition
// (Chromium's, inside Electron). Ported from Studio's chat
// (studio/src/features/ai/useDictation.ts).
//
// The microphone belongs to the operating system, which keeps (and on macOS caches) the
// person's answer per application. So before listening the hook asks the system: not asked
// yet → the system's prompt; off → a notice with a button to the right System Settings pane,
// which clears itself when the window regains focus with the switch on.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type MicrophoneReport } from '../../../shared/properties/microphone';
import { openMicrophoneSettings, readMicrophone, requestMicrophone } from '../../ipc/microphoneBridge';

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

/** What the composer shows under the field when dictation cannot run; undefined when there is nothing to say. */
export type DictationNotice =
  | { readonly kind: 'message'; readonly text: string }
  /** The system says the microphone is off for this application: `report` names it and says what can be done. */
  | { readonly kind: 'blocked'; readonly report: MicrophoneReport };

const ignore = (): void => undefined;

/** Whether the system's answer stops dictation before it starts (macOS keeps a refusal until the person changes it). */
export function blocksDictation(report: MicrophoneReport): boolean {
  return report.status === 'denied' || report.status === 'restricted';
}

/**
 * The notice for a recognition error. `report` is the system's answer read after the error:
 * a refusal there is the cause the person can fix; a "not-allowed" with the system saying yes
 * means Stacki's own window was refused, which a restart repairs.
 */
export function noticeForError(error: string, report: MicrophoneReport | undefined): DictationNotice {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    if (report !== undefined && blocksDictation(report)) {
      return { kind: 'blocked', report };
    }
    return { kind: 'message', text: 'The microphone was blocked for this window. Restart Stacki and try again.' };
  }
  if (error === 'no-speech' || error === 'aborted') {
    return { kind: 'message', text: 'No speech was heard. Try again.' };
  }
  return { kind: 'message', text: `Voice input failed (${error}).` };
}

export function useDictation(append: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [notice, setNotice] = useState<DictationNotice | undefined>(undefined);
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

  // The person flips the switch in System Settings and comes back: the notice clears itself.
  const blocked = notice?.kind === 'blocked';
  useEffect(() => {
    if (!blocked) {
      return undefined;
    }
    const recheck = (): void => {
      void readMicrophone().then((report) => setNotice((current) => (current?.kind === 'blocked' && !blocksDictation(report) ? undefined : current)), ignore);
    };
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [blocked]);

  const listen = useCallback((Recognizer: new () => Recognition): void => {
    const current = new Recognizer();
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
      setListening(false);
      // The system's answer decides what the person can do about it; without one, the plain message.
      void readMicrophone().then(
        (report) => setNotice(noticeForError(event.error, report)),
        () => setNotice(noticeForError(event.error, undefined)),
      );
    };
    current.onend = () => {
      setListening(false);
      setInterim('');
    };
    try {
      current.start();
      setListening(true);
    } catch {
      setNotice({ kind: 'message', text: 'Could not start the microphone. Try again.' });
    }
  }, []);

  async function begin(Recognizer: new () => Recognition): Promise<void> {
    let report: MicrophoneReport | undefined;
    try {
      // Not asked yet → the system's prompt appears here; asked before → its remembered answer.
      report = await requestMicrophone();
    } catch {
      report = undefined; // The system cannot say: try, and let the recognition's own error speak.
    }
    if (report !== undefined && blocksDictation(report)) {
      setNotice({ kind: 'blocked', report });
      return;
    }
    if (report?.status === 'not-determined') {
      setNotice({ kind: 'message', text: 'Microphone access was not allowed. Press the microphone to try again.' });
      return;
    }
    listen(Recognizer);
  }

  function toggle(): void {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!Constructor) {
      setNotice({ kind: 'message', text: 'Voice input is not available here.' });
      return;
    }
    setNotice(undefined);
    void begin(Constructor);
  }

  return {
    listening,
    interim,
    notice,
    dismiss: () => setNotice(undefined),
    openSettings: () => void openMicrophoneSettings().catch(ignore),
    supported: Constructor !== undefined,
    toggle,
  };
}
