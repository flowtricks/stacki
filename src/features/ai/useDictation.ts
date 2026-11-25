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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { messageRef, type TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import { type MicrophoneReport } from '../../../shared/properties/microphone';
import { canListen, downloadPercent, ENGINE_NOT_INSTALLED, type DictationEngineState } from '../../../shared/properties/voice/dictationEngine';
import { installOf, type DownloadFailure } from '../../../shared/properties/voice/dictationModel';
import { applyVocabulary, BUILT_IN_VOCABULARY, expandSnippets, VOCABULARY_LIMITS } from '../../../shared/properties/voice/dictationVocabulary';
import { WHISPER_MODEL_FAST } from '../../../shared/properties/voice/whisperModels';
import { classifyRecognitionError, type SpeechEngine } from '../../../shared/properties/voice/speechEngine';
import { parseVoiceCommands, withParagraphBreak, type VoiceAction } from '../../../shared/properties/voice/voiceCommands';
import { parseTranscript } from '../../../shared/properties/voice/transcript';
import { cleanTranscript, type CleanupOptions, rulesForLanguage, startsSentence } from '../../../shared/properties/voice/transcriptCleanup';
import { entriesFromPaths, mergeDictionary, type DictionaryEntry } from '../../../shared/properties/voice/voiceDictionary';
import { VOICE_LIMITS } from '../../../shared/properties/voice/voiceLimits';
import { isVoiceActive, reduceVoice, VOICE_IDLE, type VoiceEffect, type VoiceEvent, type VoiceState } from '../../../shared/properties/voice/voiceSession';
import { hasSound } from '../../../shared/properties/voice/waveform';
import { openMicrophoneSettings, readMicrophone, requestMicrophone } from '../../ipc/microphoneBridge';
import { createLevelFeed, type LevelFeed } from './voice/levelFeed';
import type { DictationStore } from './voice/dictationStore';
import { type Recognition, useVoiceEnvironment } from './voice/voiceEnvironment';
import { WAVEFORM_BARS } from './voice/Waveform';

/** What the composer shows under the field when dictation cannot run; undefined when there is nothing to say. */
export type DictationNotice =
  | { readonly kind: 'message'; readonly ref: TypedMessageRef }
  /** The system says the microphone is off for this application: `report` names it and says what can be done. */
  | { readonly kind: 'blocked'; readonly report: MicrophoneReport }
  /** Whisper's model is not on this computer (removed while the app ran): the notice offers to download it again. */
  | { readonly kind: 'modelMissing' }
  /** The model's download stopped: `failure` says why, and the notice offers Retry. */
  | { readonly kind: 'downloadFailed'; readonly failure: DownloadFailure }
  /** This computer decodes the standard model slower than speech: the notice offers the small one. */
  | { readonly kind: 'tooSlow' };

const ignore = (): void => undefined;

/** How often the silence and session timers look at the clock. */
const WATCH_INTERVAL_MS = 1_000;

/** Whether the system's answer stops dictation before it starts (macOS keeps a refusal until the person changes it). */
export function blocksDictation(report: MicrophoneReport): boolean {
  return report.status === 'denied' || report.status === 'restricted';
}

/**
 * The notice for a recognition error (shared/properties/voice/speechEngine.ts says what each code
 * means). `report` is the system's answer read after the error: a refusal there is the cause the
 * person can fix. A "network" error while online means no speech service, never the connection.
 */
export function noticeForError(error: string, report: MicrophoneReport | undefined, connection: 'online' | 'offline'): DictationNotice {
  const microphone = report === undefined ? 'unknown' : blocksDictation(report) ? 'refused' : 'allowed';
  const failure = classifyRecognitionError(error, { connection, microphone });
  switch (failure.kind) {
    case 'microphoneBlocked':
      assert(report !== undefined, 'noticeForError: a refused microphone comes with the system report');
      return { kind: 'blocked', report };
    case 'windowBlocked':
      return { kind: 'message', ref: messageRef('ai.dictation.blockedWindow') };
    case 'serviceMissing':
      return { kind: 'message', ref: messageRef('ai.dictation.serviceMissing') };
    case 'offline':
      return { kind: 'message', ref: messageRef('ai.dictation.network') };
    case 'noMicrophone':
      return { kind: 'message', ref: messageRef('ai.dictation.noMicrophone') };
    case 'noSpeech':
      return { kind: 'message', ref: messageRef('ai.dictation.noSpeech') };
    case 'interrupted':
      return { kind: 'message', ref: messageRef('ai.dictation.interrupted') };
    case 'language':
      return { kind: 'message', ref: messageRef('ai.dictation.language') };
    case 'modelMissing':
      return { kind: 'modelMissing' };
    case 'engineBackend':
      return { kind: 'message', ref: messageRef('dictation.notice.engineBackend') };
    case 'modelCorrupt':
      return { kind: 'message', ref: messageRef('dictation.notice.modelCorrupt') };
    case 'engineCrashed':
      return { kind: 'message', ref: messageRef('dictation.notice.engineCrashed') };
    case 'tooSlow':
      return { kind: 'tooSlow' };
    case 'unknown':
      return { kind: 'message', ref: messageRef('ai.dictation.failed', { error: failure.code }) };
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** The notice when no engine can run, or undefined when one can (or the platform has not answered yet). */
export function noticeForEngine(engine: SpeechEngine | undefined): DictationNotice | undefined {
  if (engine === undefined || engine.kind !== 'none') {
    return undefined;
  }
  return engine.reason === 'serviceMissing'
    ? { kind: 'message', ref: messageRef('ai.dictation.serviceMissing') }
    : { kind: 'message', ref: messageRef('ai.dictation.unavailable') };
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
  // Whisper is decoding the words being spoken: the draft pulses so the box never looks frozen.
  const [decoding, setDecoding] = useState(false);
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
  // Undefined until the platform answers; a "network" error while online settles it as no service for the session.
  const [engine, setEngine] = useState<SpeechEngine | undefined>(undefined);
  const engineRef = useRef<SpeechEngine | undefined>(undefined);
  engineRef.current = engine;
  const language = options.language;
  useEffect(() => {
    let live = true;
    void environment.detectEngine(language).then(
      (found) => live && setEngine(found),
      () => live && setEngine({ kind: 'online' }), // The platform could not say: try, and let the recognizer's own error speak.
    );
    return () => {
      live = false;
    };
  }, [environment, language]);
  const whisper = environment.whisper;
  const engineState = useEngineState(whisper?.store);
  // A press while the model is missing downloads it (the person asked for dictation; docs/voice-engine.md) and
  // listens as soon as it is ready, so one press leads to dictation. A press during the download cancels it.
  const listenWhenReady = useRef(false);
  useEffect(() => {
    // One read of what is on disk, so the first press already knows whether to offer the setup.
    void whisper?.store.refresh().catch(ignore);
  }, [whisper]);
  const recognizerPresent = useMemo(() => environment.isSupported() || environment.whisper !== undefined, [environment]);
  const supported = recognizerPresent && engine?.kind !== 'none';
  const usesWhisper = engine?.kind === 'whisper' && whisper !== undefined;
  /** Whether a press may start a session now; otherwise it opens the setup (Whisper's model is not ready). */
  const readyToListen = (): boolean => {
    if (!usesWhisper) {
      return true;
    }
    const snapshot = whisper.store.snapshot();
    if (snapshot.engine.kind === 'error') {
      whisper.store.dispatch({ kind: 'reset', install: installOf(snapshot.status, snapshot.model) });
    }
    const current = whisper.store.snapshot().engine;
    if (canListen(current)) {
      return true;
    }
    if (current.kind === 'downloading') {
      listenWhenReady.current = false;
      void whisper.store.cancel().catch(ignore);
    } else if (current.kind === 'notInstalled' || current.kind === 'error') {
      downloadThenListen();
    }
    return false; // Loading, listening or decoding the last words: the running session owns the engine.
  };
  const downloadThenListen = (): void => {
    if (whisper === undefined) {
      return;
    }
    listenWhenReady.current = true;
    setNotice(undefined);
    void whisper.store.download().then(
      (outcome) => {
        if (outcome.kind === 'failed') {
          listenWhenReady.current = false;
          if (outcome.failure !== 'cancelled') {
            setNotice({ kind: 'downloadFailed', failure: outcome.failure });
          }
        }
      },
      () => {
        listenWhenReady.current = false;
        setNotice({ kind: 'downloadFailed', failure: 'offline' });
      },
    );
  };
  /** What the button says when it cannot dictate, and the notice a press shows. */
  const unavailable: DictationNotice = noticeForEngine(engine) ?? { kind: 'message', ref: messageRef('ai.dictation.unavailable') };

  // The download the press started has finished: that press becomes a hands-free session.
  const engineReady = engineState.kind === 'ready';
  useEffect(() => {
    if (engineReady && listenWhenReady.current && stateRef.current.kind === 'idle') {
      listenWhenReady.current = false;
      const atMs = environment.nowMs();
      dispatchRef.current({ kind: 'press', atMs });
      dispatchRef.current({ kind: 'release', atMs });
    }
  }, [engineReady, environment]);

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
    const levels = usesWhisper ? whisper.audioLevels : environment.audioLevels;
    const result = await levels.start(WAVEFORM_BARS, (bars) => {
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
    const current = usesWhisper ? whisper.createRecognition() : environment.createRecognition();
    if (current === undefined) {
      setNotice({ kind: 'message', ref: messageRef('ai.dictation.unavailable') });
      return false;
    }
    recognition.current = current;
    current.continuous = true;
    current.interimResults = true;
    current.lang = settings.current.language;
    if (engineRef.current?.kind === 'onDevice') {
      current.processLocally = true;
    }
    current.onresult = (event) => handleResult(event);
    current.onerror = (event) => {
      if (event.error === 'no-speech') {
        return; // The silence timer decides when a quiet session ends.
      }
      dispatch({ kind: 'stop' });
      // The system's answer decides what the person can do about it; without one, the plain message.
      const connection = window.navigator.onLine ? 'online' : 'offline';
      const settle = (report: MicrophoneReport | undefined): void => {
        const shown = noticeForError(event.error, report, connection);
        setNotice(shown);
        if (shown.kind === 'message' && shown.ref.key === 'ai.dictation.serviceMissing') {
          setEngine({ kind: 'none', reason: 'serviceMissing' }); // Pressing again would fail the same way.
        }
      };
      void readMicrophone().then(settle, () => settle(undefined));
    };
    current.ondecoding = (busy) => setDecoding(busy);
    current.onend = () => {
      recognition.current = undefined;
      setDecoding(false);
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
            before = action.kind === 'newline' ? withParagraphBreak(before) : before;
            if (action.kind === 'stop') {
              dispatch({ kind: 'stop' });
            }
            settings.current.onAction(action);
            continue;
          }
          // The person's vocabulary corrects the words, then their snippets expand: final words only, one pass each.
          const words = whisper?.store.snapshot().words;
          const cleaned =
            words === undefined
              ? cleanTranscript(action.text, cleanup())
              : expandSnippets(
                  applyVocabulary(
                    cleanTranscript(action.text, cleanup()),
                    [...BUILT_IN_VOCABULARY, ...words.vocabulary].slice(0, VOCABULARY_LIMITS.entriesMax),
                  ),
                  words.snippets,
                );
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
    /** The session is open but the recognizer (or Whisper's model) is not ready yet: the waveform shows its skeleton. */
    starting: state.kind === 'starting' || engineState.kind === 'loadingModel',
    /** The microphone has closed and Whisper is writing down the last words: the line stays, as a skeleton. */
    transcribing: engineState.kind === 'transcribing',
    /** Stacki's Whisper engine's store, when it is the one that listens: the vocabulary toast writes to it. */
    whisperStore: usesWhisper ? whisper.store : undefined,
    /** The model download a press started, as a whole percent, while it runs; the button draws it as a ring. */
    downloadPercent: engineState.kind === 'downloading' ? downloadPercent(engineState.receivedBytes, engineState.totalBytes) : undefined,
    /** The notice's Retry: the download again, and listening when it is done. */
    retryDownload: downloadThenListen,
    /** The notice's offer when the standard model is too slow here: switch to the small one and download it. */
    useSmallModel: () => {
      whisper?.store.setModel(WHISPER_MODEL_FAST);
      downloadThenListen();
    },
    interim,
    /** A decode of the words being spoken is running (Whisper only). */
    decoding,
    notice,
    feed,
    supported,
    /** Why the button cannot dictate, for its title; meaningful only while `supported` is false. */
    unavailableTitle: messageRef(
      engine?.kind === 'none' && engine.reason === 'serviceMissing' ? 'ai.composer.dictate.serviceMissing' : 'ai.composer.dictate.unavailable',
    ),
    /** Whether spoken commands ("send", "new line", "scratch that") are active: they are English words. */
    commands: rulesForLanguage(options.language) === 'english',
    dismiss: () => setNotice(undefined),
    openSettings: () => void openMicrophoneSettings().catch(ignore),
    /** The button went down: a hold or a tap, decided when it comes back up. */
    press: () => {
      if (!supported) {
        setNotice(unavailable);
        return;
      }
      if (!isVoiceActive(stateRef.current) && !readyToListen()) {
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
        if (!readyToListen()) {
          return;
        }
        const atMs = environment.nowMs();
        dispatch({ kind: 'press', atMs });
        dispatch({ kind: 'release', atMs });
      } else {
        setNotice(unavailable);
      }
    },
    stop: () => dispatch({ kind: 'stop' }),
  };
}

const NO_STORE = {
  subscribe: () => ignore,
  snapshot: (): DictationEngineState => ENGINE_NOT_INSTALLED,
};

/** The Whisper engine's state, re-rendering on change; not installed where there is no Whisper. */
function useEngineState(store: DictationStore | undefined): DictationEngineState {
  const source = store ?? NO_STORE;
  return useSyncExternalStore(source.subscribe, () => (store === undefined ? ENGINE_NOT_INSTALLED : store.snapshot().engine));
}
