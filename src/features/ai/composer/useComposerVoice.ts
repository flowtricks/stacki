// Dictation for a message box: the chat's composer (ChatComposer.tsx) and a comment pin's (pins/PinPopover.tsx)
// share it, so both hear the same commands, clean phrases the same way and learn the same vocabulary.
//
// The box's text is a `ChatDraft` (a pin's plain text is a draft of one text run, `draftFromText`): each phrase
// is appended to it, "new line" ends it in a paragraph break, "scratch that" takes back the last dictated piece
// (never typed text, voiceHistory.ts) and "send" asks the box to send. A word fixed by hand in what was just
// dictated is offered for the vocabulary as a toast, and dictation's notices are toasts too (dictationToasts.ts),
// never rows under the box.
import { useCallback, useEffect, useRef } from 'react';
import { pushDictated, takeBackLast } from '../../../../shared/properties/voice/voiceHistory';
import { correctedWord } from '../../../../shared/properties/voice/dictationVocabulary';
import { withParagraphBreak, type VoiceAction } from '../../../../shared/properties/voice/voiceCommands';
import { useLocale, useTranslate, useTranslateRef } from '../../../lib/i18n/useTranslate';
import { reportActionToast } from '../../../ui/errorNotices';
import { draftTrailingText, draftWithAppendedText, draftWithTrailingText, mentionCandidates, type ChatDraft } from '../aiStore';
import { useDictation } from '../useDictation';
import { dictationToast } from './dictationToasts';

/** How long after a dictated piece a fix by hand counts as correcting it. */
const LEARN_WINDOW_MS = 60_000;

export interface ComposerVoiceOptions {
  /** The box's text now: speech arrives between renders, so it is read when a phrase lands. */
  readonly read: () => ChatDraft;
  readonly write: (change: (draft: ChatDraft) => ChatDraft) => void;
  /** The spoken "send". */
  readonly onSend: () => void;
  /** The box's text as rendered, for noticing a fix by hand. */
  readonly draft: ChatDraft;
}

export function useComposerVoice(options: ComposerVoiceOptions) {
  const translate = useTranslate();
  const translateRef = useTranslateRef();
  const { locale } = useLocale();
  const latest = useRef(options);
  latest.current = options;
  // What each dictated piece added, newest last, so "scratch that" takes back that piece and never typing.
  const dictated = useRef<readonly string[]>([]);
  // The last piece dictated, so a word the person fixes in it right after can be offered for the vocabulary.
  const lastDictation = useRef<{ readonly text: string; readonly atMs: number; offered: boolean } | undefined>(undefined);
  const applyVoice = (action: VoiceAction): void => {
    const { read, write } = latest.current;
    if (action.kind === 'insert') {
      dictated.current = pushDictated(dictated.current, action.text);
      lastDictation.current = { text: action.text, atMs: Date.now(), offered: false };
      write((current) => draftWithAppendedText(current, action.text));
    } else if (action.kind === 'newline') {
      // A paragraph break: trailing spaces go, and the box ends in exactly one blank line (withParagraphBreak).
      write((current) => draftWithTrailingText(current, withParagraphBreak(draftTrailingText(current))));
    } else if (action.kind === 'deleteLast') {
      const taken = takeBackLast(dictated.current, draftTrailingText(read()));
      dictated.current = taken.history;
      if (taken.removed) {
        write((current) => draftWithTrailingText(current, taken.text));
      }
    } else if (action.kind === 'send') {
      voice.stop();
      latest.current.onSend();
    }
    // A 'stop' action was already handed to the session by the hook.
  };
  const voice = useDictation({
    textBefore: () => draftTrailingText(latest.current.read()),
    onAction: applyVoice,
    language: recognitionLanguage(locale),
    loadPaths: useCallback(async () => {
      const reply = await mentionCandidates('', ['file']);
      return reply.ok ? reply.value.flatMap((candidate) => (candidate.kind === 'file' ? [candidate.path] : [])) : [];
    }, []),
  });
  // A word fixed by hand in what was just dictated: offered once, as a toast, for the vocabulary (Flow's "learns").
  const draftTail = draftTrailingText(options.draft);
  useEffect(() => {
    const last = lastDictation.current;
    const store = voice.whisperStore;
    if (last === undefined || last.offered || store === undefined || Date.now() - last.atMs > LEARN_WINDOW_MS) {
      return;
    }
    const fixed = correctedWord(last.text, draftTail);
    if (fixed === undefined) {
      return;
    }
    last.offered = true;
    reportActionToast(translate('dictation.words.learn', { word: fixed.corrected }), 'info', [
      {
        label: translate('dictation.words.learnAction'),
        run: () => {
          const words = store.snapshot().words;
          if (!words.vocabulary.some((entry) => entry.word.toLowerCase() === fixed.corrected.toLowerCase())) {
            store.setWords({ ...words, vocabulary: [...words.vocabulary, { word: fixed.corrected, misheard: fixed.heard }] });
          }
        },
      },
    ]);
    // Only the draft's words decide; the store and the translator are read when a fix is seen.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [draftTail]);
  // Dictation's notices are toasts, never rows under the box (dictationToasts.ts): each is shown once, then cleared.
  const voiceNotice = voice.notice;
  useEffect(() => {
    if (voiceNotice === undefined) {
      return;
    }
    const toast = dictationToast(
      voiceNotice,
      { translate, translateRef },
      { openSettings: voice.openSettings, retry: voice.retryDownload, useSmall: voice.useSmallModel },
    );
    reportActionToast(toast.message, toast.kind, toast.recovery);
    voice.dismiss();
    // The actions are read when the notice arrives; a new notice is the only thing that shows another toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [voiceNotice]);
  return {
    voice,
    /** A new press of the microphone starts a fresh history: "scratch that" never reaches into an earlier session. */
    resetHistory: () => {
      dictated.current = [];
    },
  };
}

export type ComposerVoice = ReturnType<typeof useComposerVoice>;

/** The tag the recognizer listens for: the interface language, English as the United States'. */
export function recognitionLanguage(locale: string): string {
  return locale === 'en' ? 'en-US' : locale;
}
