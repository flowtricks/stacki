// The one place the renderer keeps dictation's engine state (shared/properties/voice/dictationEngine.ts)
// and the person's choices for it: which model and which language. The composer's microphone, the setup
// dialog and the Settings row all read this store, so they never disagree about what is installed or
// running. The model and language are a person's way of working, kept in localStorage like the interface
// language (src/lib/i18n/localeStore.ts); what is on disk is always asked of the main process.
//
// `createDictationStore` takes the main process's channels as a value, so the composer test provides a
// fake and never touches IPC.
import { assert } from '../../../../shared/core/assert';
import { ENGINE_NOT_INSTALLED, reduceEngine, type DictationEngineEvent, type DictationEngineState } from '../../../../shared/properties/voice/dictationEngine';
import { NO_DICTATION_WORDS, parseDictationWords, type DictationWords } from '../../../../shared/properties/voice/dictationVocabulary';
import { installOf, type DictationStatus, type DownloadOutcome, type DownloadProgress } from '../../../../shared/properties/voice/dictationModel';
import {
  DICTATION_LANGUAGE_DEFAULT,
  parseDictationLanguage,
  parseWhisperModelId,
  modelTotalBytes,
  WHISPER_MODEL_DEFAULT,
  WHISPER_MODELS,
  type DictationLanguage,
  type WhisperModelId,
} from '../../../../shared/properties/voice/whisperModels';

/** What the main process offers for the model (src/ipc/dictationBridge.ts in Desktop). */
export interface DictationChannels {
  readonly status: () => Promise<DictationStatus>;
  readonly download: (id: WhisperModelId) => Promise<DownloadOutcome>;
  readonly cancel: (id: WhisperModelId) => Promise<void>;
  readonly remove: (id: WhisperModelId) => Promise<void>;
  readonly onProgress: (listener: (progress: DownloadProgress) => void) => () => void;
}

export interface DictationSnapshot {
  /** The person's vocabulary and snippets (dictationVocabulary.ts). */
  readonly words: DictationWords;
  readonly engine: DictationEngineState;
  /** Undefined until the main process first answers. */
  readonly status: DictationStatus | undefined;
  readonly model: WhisperModelId;
  readonly language: DictationLanguage;
}

export interface DictationStore {
  readonly snapshot: () => DictationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  /** Downloads the chosen model: a press of the microphone without it, Retry, or Settings' Download. */
  readonly download: () => Promise<DownloadOutcome>;
  readonly cancel: () => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly dispatch: (event: DictationEngineEvent) => void;
  readonly setModel: (id: WhisperModelId) => void;
  readonly setLanguage: (language: DictationLanguage) => void;
  /** Replaces the vocabulary and snippets; they are parsed with their bounds before they are kept. */
  readonly setWords: (words: DictationWords) => void;
}

const MODEL_KEY = 'stacki.dictation.model';
const LANGUAGE_KEY = 'stacki.dictation.language';
const WORDS_KEY = 'stacki.dictation.words';
/** Listeners at once: the composer of each open chat, the dialog and Settings. */
const LISTENERS_MAX = 32;

export function createDictationStore(channels: DictationChannels): DictationStore {
  const listeners = new Set<() => void>();
  let current: DictationSnapshot = { engine: ENGINE_NOT_INSTALLED, status: undefined, model: readModel(), language: readLanguage(), words: readWords() };
  let progressStop: (() => void) | undefined;

  const publish = (next: DictationSnapshot): void => {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const dispatch = (event: DictationEngineEvent): void => {
    publish({ ...current, engine: reduceEngine(current.engine, event) });
  };
  const refresh = async (): Promise<void> => {
    const status = await channels.status();
    const install = installOf(status, current.model);
    publish({ ...current, status, engine: reduceEngine(current.engine, { kind: 'install', install }) });
  };
  const listenForProgress = (): void => {
    progressStop ??= channels.onProgress((progress) => {
      if (progress.id === current.model) {
        dispatch({ kind: 'downloadProgress', receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes });
      }
    });
  };

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      assert(listeners.size < LISTENERS_MAX, 'createDictationStore: listeners are removed on unmount');
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    download: async () => {
      const id = current.model;
      listenForProgress();
      const install = installOf(current.status, id);
      const receivedBytes = install.kind === 'partial' ? install.receivedBytes : 0;
      const totalBytes = modelTotalBytes(WHISPER_MODELS[id]);
      dispatch({ kind: 'downloadProgress', receivedBytes, totalBytes });
      const outcome = await channels.download(id);
      dispatch({ kind: 'downloadEnded', outcome });
      await refresh().catch(() => undefined); // The outcome already shows; the sizes follow when main answers.
      return outcome;
    },
    cancel: () => channels.cancel(current.model),
    remove: async () => {
      await channels.remove(current.model);
      await refresh();
    },
    dispatch,
    setModel: (id) => {
      writeStored(MODEL_KEY, id === WHISPER_MODEL_DEFAULT ? undefined : id);
      publish({ ...current, model: id, engine: reduceEngine(ENGINE_NOT_INSTALLED, { kind: 'install', install: installOf(current.status, id) }) });
    },
    setWords: (words) => {
      // Through the parser, so the stored and the kept words are both within the bounds (paired with readWords).
      const parsed = parseDictationWords(words);
      writeStored(WORDS_KEY, JSON.stringify(parsed));
      publish({ ...current, words: parsed });
    },
    setLanguage: (language) => {
      writeStored(LANGUAGE_KEY, language === DICTATION_LANGUAGE_DEFAULT ? undefined : language);
      publish({ ...current, language });
    },
  };
}

function readModel(): WhisperModelId {
  try {
    return parseWhisperModelId(localStorage.getItem(MODEL_KEY) ?? WHISPER_MODEL_DEFAULT);
  } catch {
    return WHISPER_MODEL_DEFAULT; // Absent, blocked or unknown storage: the default model.
  }
}

function readWords(): DictationWords {
  try {
    const raw = localStorage.getItem(WORDS_KEY);
    if (raw === null || raw.length > 2_000_000) {
      return NO_DICTATION_WORDS;
    }
    const stored: unknown = JSON.parse(raw);
    return parseDictationWords(stored);
  } catch {
    return NO_DICTATION_WORDS; // Blocked or damaged storage: no words, never an error.
  }
}

function readLanguage(): DictationLanguage {
  try {
    return parseDictationLanguage(localStorage.getItem(LANGUAGE_KEY));
  } catch {
    return DICTATION_LANGUAGE_DEFAULT;
  }
}

function writeStored(key: string, value: string | undefined): void {
  try {
    if (value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    /* noop: the choice still applies until the window closes */
  }
}
