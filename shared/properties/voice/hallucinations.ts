// What Whisper writes that nobody said. Trained on subtitled video, Whisper fills quiet or noisy audio
// with the phrases that end videos: "Thank you.", "Thanks for watching!", "Okay.", "You", subtitle
// credits. The voice detector (speechChunker.ts) keeps most quiet audio away from it; this is the
// second net, applied to each decoded window with what the detector heard in it:
//
//   - a whole output that is one of these phrases is dropped when the speech behind it was short or
//     quiet, so a real, clearly spoken "thank you" still lands;
//   - one of these phrases at the start or end of a longer output is dropped when the output has more
//     words than the speech could hold (a person dictates at most about three and a half words a second);
//   - a sentence Whisper repeats is written once, and a segment that only repeats the end of the one
//     before it (the same words decoded twice across a window boundary) adds nothing.
//
// The Transformers.js Whisper pipeline (4.3) exposes no no-speech probability, log-probability or
// compression-ratio thresholds, so these checks run on the text and the detector's evidence instead.
import { assert } from '../../core/assert';
import { DICTATION_LIMITS } from './dictationLimits';
import type { SpeechEvidence } from './speechChunker';

/** Why words were left out; the engine logs these in debug builds so a test or a person can see each decision. */
export type DropReason = 'knownPhrase' | 'outrunsSpeech' | 'shortAndUnsure' | 'noOnset' | 'repeat';

export interface FilterResult {
  readonly text: string;
  readonly dropped: readonly { readonly text: string; readonly reason: DropReason }[];
}

/** Speech at least this long and this loud is trusted even when its words are a usual hallucination. */
const TRUSTED_SPEECH_MS = 1_200;
const TRUSTED_SPEECH_RMS = 0.05;
/** Words a second a person dictates at most (conversation runs near 2.5); more words than this over the speech heard means invented ones. */
const WORDS_PER_SECOND_MAX = 3.5;
/** Sentences one output is split into at most; Whisper writes a few per window. */
const SENTENCES_MAX = 64;

/** Phrases Whisper invents, normalized (lowercase, no punctuation), by language; `all` applies to every language. */
const PHRASES: { readonly [Language in 'all' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'nl']: readonly string[] } = {
  all: ['you', 'bye', 'uh', 'um', 'hmm', 'mm', 'mhm', 'mmhmm', 'oh', 'ah', 'so', 'yeah', 'okay', 'ok', 'music', 'silence', 'applause', 'amaraorg'],
  en: [
    'thank you',
    'thank you very much',
    'thanks',
    'thanks for watching',
    'thank you for watching',
    'thanks for watching and see you next time',
    'please subscribe',
    'like and subscribe',
    'see you next time',
    'bye bye',
    'subtitles by the amaraorg community',
    'transcribed by',
    'thats it',
    'that is it',
    'thats all',
    'im sorry',
    'all right',
    'alright',
    'see you',
    'good night',
    'subtitles by',
  ],
  de: [
    'danke',
    'vielen dank',
    'danke schön',
    'danke fürs zuschauen',
    'tschüss',
    'untertitel im auftrag des zdf für funk 2017',
    'untertitel der amaraorg community',
  ],
  es: ['gracias', 'muchas gracias', 'gracias por ver', 'subtítulos realizados por la comunidad de amaraorg', 'adiós'],
  fr: ['merci', 'merci beaucoup', 'merci davoir regardé', 'soustitres réalisés par la communauté damaraorg', 'soustitrage stfrancais'],
  it: ['grazie', 'grazie mille', 'grazie per la visione', 'sottotitoli creati dalla comunità amaraorg'],
  pt: ['obrigado', 'obrigada', 'muito obrigado', 'legendas pela comunidade amaraorg'],
  nl: ['dank je', 'dank je wel', 'bedankt', 'bedankt voor het kijken', 'ondertiteling door de amaraorg gemeenschap'],
};

/** Lowercase, letters, digits and single spaces only: how phrases are compared. */
export function normalizePhrase(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  assert(normalized.length <= text.length, 'normalizePhrase: normalizing never adds text');
  return normalized;
}

/** Whether `text` as a whole is a phrase Whisper invents, in `language` or any language. */
export function isKnownHallucination(text: string, language: string): boolean {
  const phrase = normalizePhrase(text);
  if (phrase === '') {
    return true;
  }
  const own = Object.entries(PHRASES).find(([key]) => key === language)?.[1] ?? [];
  const all = [...PHRASES.all, ...own, ...PHRASES.en];
  assert(all.length > 0, 'isKnownHallucination: there are phrases to compare with');
  return all.includes(phrase);
}

/**
 * The words of one decoded window that were said, by what the detector heard. `continuing` is true when the
 * window starts inside speech whose onset an earlier window heard (a cut at the window bound).
 */
export function filterHallucinations(
  text: string,
  evidence: SpeechEvidence,
  context: { readonly language: string; readonly continuing: boolean },
): FilterResult {
  assert(evidence.speechMs >= 0, 'filterHallucinations: speech has no negative length');
  assert(evidence.speechRatio >= 0, 'filterHallucinations: the ratio is not negative');
  const { language } = context;
  const dropped: { text: string; reason: DropReason }[] = [];
  const drop = (words: string, reason: DropReason): FilterResult => ({ text: '', dropped: [...dropped, { text: words, reason }] });
  const raw = splitSentences(text);
  const sentences = collapseRepeats(raw);
  if (sentences.length < raw.length) {
    dropped.push({ text: raw.slice(sentences.length).join(' '), reason: 'repeat' });
  }
  if (sentences.length === 0) {
    return { text: '', dropped };
  }
  const whole = sentences.join(' ');
  // Continuous noise has no onset: speech that neither starts in this window nor continues an earlier one is not speech.
  if (!evidence.onset && !context.continuing) {
    return drop(whole, 'noOnset');
  }
  const trusted = evidence.speechMs >= TRUSTED_SPEECH_MS && evidence.speechRms >= TRUSTED_SPEECH_RMS;
  if (sentences.every((sentence) => isKnownHallucination(sentence, language))) {
    return trusted ? { text: whole, dropped } : drop(whole, 'knownPhrase');
  }
  // A short result needs a window that was mostly, and surely, speech, whatever its words.
  const unsure = evidence.speechRatio < DICTATION_LIMITS.shortResultSpeechRatioMin || evidence.meanProbability < DICTATION_LIMITS.shortResultProbabilityMin;
  if (wordCount(sentences) <= DICTATION_LIMITS.shortResultWordsMax && unsure) {
    return drop(whole, 'shortAndUnsure');
  }
  // More words than the speech could hold: the usual phrases at either end are the invented ones.
  const wordsMax = Math.max(2, Math.ceil((evidence.speechMs / 1000) * WORDS_PER_SECOND_MAX));
  const kept = [...sentences];
  if (wordCount(kept) <= wordsMax) {
    return { text: kept.join(' '), dropped };
  }
  // Each pass removes one sentence, so the passes are bounded by the sentences.
  for (let pass = 0; pass < sentences.length && kept.length > 1 && isKnownHallucination(kept[kept.length - 1] ?? '', language); pass += 1) {
    dropped.push({ text: kept.pop() ?? '', reason: 'outrunsSpeech' });
  }
  for (let pass = 0; pass < sentences.length && kept.length > 1 && isKnownHallucination(kept[0] ?? '', language); pass += 1) {
    dropped.push({ text: kept.shift() ?? '', reason: 'outrunsSpeech' });
  }
  return { text: kept.join(' '), dropped };
}

/** `next` without the words it repeats from the end of `previous` (a window boundary decoded twice); '' when it adds nothing. */
export function withoutOverlap(previous: string, next: string): string {
  const before = previous.split(' ').filter((word) => word !== '');
  const after = next.split(' ').filter((word) => word !== '');
  if (normalizePhrase(previous) !== '' && normalizePhrase(previous) === normalizePhrase(next)) {
    return '';
  }
  const longest = Math.min(before.length, after.length);
  for (let size = longest; size >= 2; size -= 1) {
    const tail = normalizePhrase(before.slice(before.length - size).join(' '));
    const head = normalizePhrase(after.slice(0, size).join(' '));
    if (tail !== '' && tail === head) {
      return after.slice(size).join(' ');
    }
  }
  assert(after.length >= 0, 'withoutOverlap: words are counted');
  return next;
}

/** The sentences of `text`, split after . ! ? and their full-width forms, each trimmed. */
export function splitSentences(text: string): readonly string[] {
  const parts = text.match(/[^.!?。！？]+[.!?。！？]*/gu) ?? [];
  const sentences = parts.map((part) => part.trim()).filter((part) => part !== '');
  assert(sentences.length <= text.length, 'splitSentences: no more sentences than characters');
  return sentences.slice(0, SENTENCES_MAX);
}

/** Sentences with immediate repeats removed ("Okay. Okay. Okay." is one "Okay."). */
export function collapseRepeats(sentences: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (normalizePhrase(kept[kept.length - 1] ?? '') !== normalizePhrase(sentence)) {
      kept.push(sentence);
    }
  }
  assert(kept.length <= sentences.length, 'collapseRepeats: never adds a sentence');
  return kept;
}

function wordCount(sentences: readonly string[]): number {
  return sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/u).filter((word) => word !== '').length, 0);
}
