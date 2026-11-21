// Voice input for the composer. The words come from the platform's speech recognition
// (Chromium's, inside Electron); everything around them is Stacki's:
//
//   - one button, two ways to use it: hold to talk (letting go ends it) or tap to latch
//     hands-free (the next tap ends it), as a state machine (shared/properties/voice/voiceSession.ts);
//   - a live waveform from a read-only look at the microphone, and the phrase being spoken
//     shown cleaned, as it is spoken;
//   - cleanup of each finished phrase (fillers, stutters, spoken corrections, punctuation,
//     capitals) and a dictionary that follows the project's file names;
//   - spoken commands: "send", "new line", "scratch that", "stop listening".
//
// The microphone belongs to the operating system, which keeps (and on macOS caches) the
// person's answer per application. So before listening the hook asks the system: not asked
// yet → the system's prompt; off → a notice with a button to the right System Settings pane,
// which clears itself when the window regains focus with the switch on.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { messageRef, type TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import { type MicrophoneReport } from '../../../shared/properties/microphone';
import { parseVoiceCommands, type VoiceAction } from '../../../shared/properties/voice/voiceCommands';
import { parseTranscript } from '../../../shared/properties/voice/transcript';
import { cleanTranscript, type CleanupOptions, rulesForLanguage, startsSentence } from '../../../shared/properties/voice/transcriptCleanup';
import { entriesFromPaths, mergeDictionary, type DictionaryEntry } from '../../../shared/properties/voice/voiceDictionary';
import { VOICE_LIMITS } from '../../../shared/properties/voice/voiceLimits';
import { isVoiceActive, reduceVoice, VOICE_IDLE, type VoiceEffect, type VoiceEvent, type VoiceState } from '../../../shared/properties/voice/voiceSession';
import { hasSound } from '../../../shared/properties/voice/waveform';
import { openMicrophoneSettings, readMicrophone, requestMicrophone } from '../../ipc/microphoneBridge';
import { createLevelFeed, type LevelFeed } from './voice/levelFeed';
import { type Recognition, useVoiceEnvironment } from './voice/voiceEnvironment';
import { WAVEFORM_BARS } from './voice/Waveform';

/** What the composer shows under the field when dictation cannot run; undefined when there is nothing to say. */
export type DictationNotice =
  | { readonly kind: 'message'; readonly ref: TypedMessageRef }
  /** The system says the microphone is off for this application: `report` names it and says what can be done. */
  | { readonly kind: 'blocked'; readonly report: MicrophoneReport };

const ignore = (): void => undefined;

/** How often the silence and session timers look at the clock. */
const WATCH_INTERVAL_MS = 1_000;

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
    return { kind: 'message', ref: messageRef('ai.dictation.blockedWindow') };
  }
  if (error === 'no-speech' || error === 'aborted') {
    return { kind: 'message', ref: messageRef('ai.dictation.noSpeech') };
  }
  if (error === 'network') {
    return { kind: 'message', ref: messageRef('ai.dictation.network') };
  }
  if (error === 'language-not-supported') {
    return { kind: 'message', ref: messageRef('ai.dictation.language') };
  }
  return { kind: 'message', ref: messageRef('ai.dictation.failed', { error }) };
}

export interface DictationOptions {
  /** The box's text as it is now, for the capital at the start of a phrase. */
  readonly textBefore: () => string;
  /** Applies one spoken action to the box. */
  readonly onAction: (action: VoiceAction) => void;
  /** BCP 47 tag of the interface language: the recognizer listens for it. */
  readonly language: string;
  /** The project's file paths, loaded once per session for the dictionary; a failure means the built-in terms only. */
  readonly loadPaths: () => Promise<readonly string[]>;
}

export function useDictation(options: DictationOptions) {
  const environment = useVoiceEnvironment();
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const [interim, setInterim] = useState('');
  const [notice, setNotice] = useState<DictationNotice | undefined>(undefined);
  const feed = useMemo<LevelFeed>(() => createLevelFeed(), []);
  const stateRef = useRef<VoiceState>(VOICE_IDLE);
  const recognition = useRef<Recognition | undefined>(undefined);
  const stopLevels = useRef<(() => void) | undefined>(undefined);
  const dictionary = useRef<readonly DictionaryEntry[]>(mergeDictionary([]));
  const lastSoundAtMs = useRef(0);
  const startedAtMs = useRef(0);
  const settings = useRef(options);
  settings.current = options;
  const supported = useMemo(() => environment.isSupported(), [environment]);

  const dispatchRef = useRef<(event: VoiceEvent) => void>(ignore);
  dispatchRef.current = (event) => {
    const step = reduceVoice(stateRef.current, event);
    stateRef.current = step.state;
    setState(step.state);
    runEffect(step.effect);
  };
  const dispatch = useCallback((event: VoiceEvent): void => dispatchRef.current(event), []);

  const closeRecognition = useCallback((): void => {
    const current = recognition.current;
    recognition.current = undefined;
    if (current !== undefined) {
      current.onresult = ignore;
      current.onerror = ignore;
      current.onend = ignore;
      current.abort();
    }
  }, []);
  const closeLevels = useCallback((): void => {
    stopLevels.current?.();
    stopLevels.current = undefined;
    feed.publish(Array.from({ length: WAVEFORM_BARS }, () => 0));
  }, [feed]);
  useEffect(
    () => () => {
      closeRecognition();
      closeLevels();
    },
    [closeRecognition, closeLevels],
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

  // Whatever ended the session (a stop, a hold let go, the restart bound), nothing stays open after it.
  const idle = state.kind === 'idle';
  useEffect(() => {
    if (idle) {
      closeRecognition();
      closeLevels();
    }
  }, [idle, closeRecognition, closeLevels]);

  // While a session is open: the silence and the session clocks. Both end the session through the machine.
  const active = isVoiceActive(state);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => {
      const nowMs = environment.nowMs();
      if (nowMs - startedAtMs.current >= VOICE_LIMITS.sessionMsMax) {
        dispatch({ kind: 'stop' });
        return;
      }
      const silentMs = nowMs - lastSoundAtMs.current;
      if (silentMs >= VOICE_LIMITS.silenceMsMax && stateRef.current.kind === 'listening' && stateRef.current.latch === 'handsfree') {
        setNotice({ kind: 'message', ref: messageRef('ai.dictation.silence') });
      }
      dispatch({ kind: 'silence', silentMs });
    }, WATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, environment, dispatch]);

  function runEffect(effect: VoiceEffect): void {
    if (effect === 'start') {
      void begin();
    } else if (effect === 'restart') {
      if (!listen()) {
        dispatch({ kind: 'stop' });
      }
    } else if (effect === 'stop') {
      if (recognition.current === undefined) {
        queueMicrotask(() => dispatch({ kind: 'ended' }));
      } else {
        recognition.current.stop();
      }
      closeLevels();
    }
  }

  async function begin(): Promise<void> {
    setNotice(undefined);
    setInterim('');
    startedAtMs.current = environment.nowMs();
    lastSoundAtMs.current = startedAtMs.current;
    let report: MicrophoneReport | undefined;
    try {
      // Not asked yet → the system's prompt appears here; asked before → its remembered answer.
      report = await requestMicrophone();
    } catch {
      report = undefined; // The system cannot say: try, and let the recognition's own error speak.
    }
    if (stateRef.current.kind !== 'starting') {
      // Let go (or stopped) while the system was answering: nothing was ever opened.
      queueMicrotask(() => dispatch({ kind: 'ended' }));
      return;
    }
    if (report !== undefined && blocksDictation(report)) {
      setNotice({ kind: 'blocked', report });
      dispatch({ kind: 'failed' });
      return;
    }
    if (report?.status === 'not-determined') {
      setNotice({ kind: 'message', ref: messageRef('ai.dictation.notAllowed') });
      dispatch({ kind: 'failed' });
      return;
    }
    if (!listen()) {
      dispatch({ kind: 'failed' });
      return;
    }
    dispatch({ kind: 'started' });
    void openLevels();
    void loadDictionary();
  }

  async function openLevels(): Promise<void> {
    // Optional: a meter that cannot open leaves the bars flat and dictation working.
    const result = await environment.audioLevels.start(WAVEFORM_BARS, (bars) => {
      feed.publish(bars);
      if (hasSound(bars)) {
        lastSoundAtMs.current = environment.nowMs();
      }
    });
    if (!result.ok) {
      return;
    }
    if (isVoiceActive(stateRef.current)) {
      stopLevels.current = result.value;
    } else {
      result.value();
    }
  }

  async function loadDictionary(): Promise<void> {
    try {
      dictionary.current = mergeDictionary(entriesFromPaths(await settings.current.loadPaths()));
    } catch {
      // The project's names are a convenience; without them the built-in terms still apply.
    }
  }

  /** Starts a recognizer for the session; false when the platform has none or refuses to start. */
  function listen(): boolean {
    const current = environment.createRecognition();
    if (current === undefined) {
      setNotice({ kind: 'message', ref: messageRef('ai.dictation.unavailable') });
      return false;
    }
    recognition.current = current;
    current.continuous = true;
    current.interimResults = true;
    current.lang = settings.current.language;
    current.onresult = (event) => handleResult(event);
    current.onerror = (event) => {
      if (event.error === 'no-speech') {
        return; // The silence timer decides when a quiet session ends.
      }
      dispatch({ kind: 'stop' });
      // The system's answer decides what the person can do about it; without one, the plain message.
      void readMicrophone().then(
        (report) => setNotice(noticeForError(event.error, report)),
        () => setNotice(noticeForError(event.error, undefined)),
      );
    };
    current.onend = () => {
      recognition.current = undefined;
      setInterim('');
      dispatch({ kind: 'ended' });
    };
    try {
      current.start();
      return true;
    } catch {
      recognition.current = undefined;
      setNotice({ kind: 'message', ref: messageRef('ai.dictation.startFailed') });
      return false;
    }
  }

  function handleResult(event: Parameters<Recognition['onresult']>[0]): void {
    lastSoundAtMs.current = environment.nowMs();
    const heard = Array.from(event.results);
    let before = settings.current.textBefore();
    const rules = rulesForLanguage(settings.current.language);
    const cleanup = (): CleanupOptions => ({ capitalizeFirst: startsSentence(before), dictionary: dictionary.current, rules });
    const interimParts: string[] = [];
    heard.forEach((result, index) => {
      const parsed = parseTranscript(result[0].transcript);
      if (!parsed.ok) {
        if (parsed.error === 'too-long') {
          setNotice({ kind: 'message', ref: messageRef('ai.dictation.failed', { error: 'too-long' }) });
        }
        return;
      }
      if (!result.isFinal) {
        interimParts.push(parsed.value);
      } else if (index >= event.resultIndex) {
        // Spoken commands are English words: another language's phrase is always plain text.
        const actions = rules === 'english' ? parseVoiceCommands(parsed.value) : [{ kind: 'insert' as const, text: parsed.value }];
        for (const action of actions) {
          if (action.kind !== 'insert') {
            before = action.kind === 'newline' ? `${before}\n` : before;
            if (action.kind === 'stop') {
              dispatch({ kind: 'stop' });
            }
            settings.current.onAction(action);
            continue;
          }
          const cleaned = cleanTranscript(action.text, cleanup());
          if (cleaned !== '') {
            before = `${before}${before === '' || /\s$/u.test(before) ? '' : ' '}${cleaned}`;
            settings.current.onAction({ kind: 'insert', text: cleaned });
          }
        }
      }
    });
    setInterim(cleanTranscript(interimParts.join(' '), cleanup()));
  }

  return {
    state,
    listening: isVoiceActive(state),
    /** The session is open but the recognizer has not started yet: the waveform shows its skeleton. */
    starting: state.kind === 'starting',
    interim,
    notice,
    feed,
    supported,
    /** Whether spoken commands ("send", "new line", "scratch that") are active: they are English words. */
    commands: rulesForLanguage(options.language) === 'english',
    dismiss: () => setNotice(undefined),
    openSettings: () => void openMicrophoneSettings().catch(ignore),
    /** The button went down: a hold or a tap, decided when it comes back up. */
    press: () => {
      if (!supported) {
        setNotice({ kind: 'message', ref: messageRef('ai.dictation.unavailable') });
        return;
      }
      dispatch({ kind: 'press', atMs: environment.nowMs() });
    },
    release: () => dispatch({ kind: 'release', atMs: environment.nowMs() }),
    /** A press with no pointer (the keyboard): starts hands-free, or ends the session. */
    toggle: () => {
      if (isVoiceActive(stateRef.current)) {
        dispatch({ kind: 'stop' });
      } else if (supported) {
        const atMs = environment.nowMs();
        dispatch({ kind: 'press', atMs });
        dispatch({ kind: 'release', atMs });
      } else {
        setNotice({ kind: 'message', ref: messageRef('ai.dictation.unavailable') });
      }
    },
    stop: () => dispatch({ kind: 'stop' }),
  };
}
