// Cleanup of one recognized phrase, by rules and with no model: what a person says is not
// what they would type. Fillers go ("um"), a stuttered word collapses ("the the"), a spoken
// correction replaces what it corrects ("at five no wait at six"), spoken punctuation becomes
// the mark ("comma"), "i" becomes "I", sentences start with a capital, and the personal
// dictionary writes names the way the project spells them.
//
// Why rules and not an LLM: a rule runs in a microsecond, offline, with the same answer every
// time, and its mistakes can be read in this file. The rules are deliberately conservative: a
// word that is also real vocabulary ("like", "I mean", "actually") is never removed.
import { assert } from '../../core/assert';
import { applyDictionary, type DictionaryEntry } from './voiceDictionary';
import { wordCore, wordsOf } from './transcript';
import { VOICE_LIMITS } from './voiceLimits';

export interface CleanupOptions {
  /** Whether the phrase starts a sentence: false when it continues text that has no full stop yet. */
  readonly capitalizeFirst: boolean;
  readonly dictionary: readonly DictionaryEntry[];
  /**
   * 'english' runs every rule. Any other language gets the dictionary only: the filler, correction and
   * punctuation words below are English, and a rule that fires on a word of another language
   * ("period", "er") would damage what the person said.
   */
  readonly rules: 'english' | 'dictionary';
}

/** Whether the recognizer's language tag (BCP 47) is English, and so gets the English rules. */
export function rulesForLanguage(language: string): CleanupOptions['rules'] {
  return /^en(?:-|$)/iu.test(language) ? 'english' : 'dictionary';
}

const FILLERS: ReadonlySet<string> = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'hm', 'ah', 'eh']);

/** Words that are legitimately said twice in a row ("had had", "that that"), so a repeat of them is kept. */
const REPEATABLE: ReadonlySet<string> = new Set(['had', 'that', 'no', 'very', 'bye']);

/** Spoken corrections: what follows replaces the words just before. Longer phrases first. */
const CORRECTION_MARKERS: readonly (readonly string[])[] = [
  ['no', 'wait'],
  ['wait', 'no'],
  ['or', 'rather'],
];

/** Spoken punctuation, longest first. "period" is a word too, so it counts only after another word. */
const SPOKEN_PUNCTUATION: readonly { readonly spoken: readonly string[]; readonly mark: string }[] = [
  { spoken: ['exclamation', 'point'], mark: '!' },
  { spoken: ['exclamation', 'mark'], mark: '!' },
  { spoken: ['question', 'mark'], mark: '?' },
  { spoken: ['full', 'stop'], mark: '.' },
  { spoken: ['semicolon'], mark: ';' },
  { spoken: ['colon'], mark: ':' },
  { spoken: ['comma'], mark: ',' },
  { spoken: ['period'], mark: '.' },
];

const SENTENCE_END = /[.!?]$/u;
const PHRASE_END = /[,.!?;:]$/u;

export function cleanTranscript(text: string, options: CleanupOptions): string {
  const words = wordsOf(text);
  assert(words.length <= VOICE_LIMITS.utteranceWordsMax, 'cleanTranscript: the phrase is bounded');
  if (options.rules === 'dictionary') {
    return applyDictionary(words, options.dictionary).join(' ');
  }
  const spoken = removeFillersAndStutters(words);
  const corrected = applyCorrections(spoken);
  const punctuated = applySpokenPunctuation(corrected);
  const pronouns = punctuated.map(capitalizePronoun);
  const capitalized = capitalizeSentences(pronouns, { capitalizeFirst: options.capitalizeFirst });
  const written = applyDictionary(capitalized, options.dictionary);
  const cleaned = written.join(' ');
  assert(cleaned.length <= text.length + words.length, 'cleanTranscript: cleanup never grows a phrase beyond its punctuation');
  return cleaned;
}

/** Whether the text before the cursor ends a sentence (or is empty), so the next phrase starts with a capital. */
export function startsSentence(textBefore: string): boolean {
  const trimmed = textBefore.trimEnd();
  if (trimmed === '') {
    return true;
  }
  return SENTENCE_END.test(trimmed) || textBefore.endsWith('\n');
}

function removeFillersAndStutters(words: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (const word of words) {
    const core = wordCore(word);
    const filler = FILLERS.has(core);
    const previous = kept[kept.length - 1];
    const stutter = previous !== undefined && core !== '' && wordCore(previous) === core && !REPEATABLE.has(core) && !/\d/u.test(core);
    if (!filler && !stutter) {
      kept.push(word);
    } else if (filler && PHRASE_END.test(word) && previous !== undefined && !PHRASE_END.test(previous)) {
      // The filler carried the pause's mark ("so, um,"): the mark stays on the word before it.
      kept[kept.length - 1] = `${previous}${word.slice(-1)}`;
    }
  }
  return kept;
}

function applyCorrections(words: readonly string[]): readonly string[] {
  const output: string[] = [];
  let index = 0;
  while (index < words.length) {
    const marker = CORRECTION_MARKERS.find((candidate) => candidate.every((part, offset) => wordCore(words[index + offset] ?? '') === part));
    const replacementStart = index + (marker?.length ?? 0);
    const replacement = marker === undefined ? 0 : replacementLength(words, replacementStart);
    if (marker !== undefined && replacement > 0) {
      const clauseStart = lastSentenceStart(output);
      const removable = Math.min(replacement, output.length - clauseStart);
      output.length -= removable;
      // Whatever mark the corrected words carried goes with them; the replacement brings its own.
      index = replacementStart;
    } else {
      output.push(words[index] ?? '');
      index += 1;
    }
  }
  return output;
}

/** The words after a marker that make its replacement: up to the next mark or the end, at most the bound; zero when nothing follows. */
function replacementLength(words: readonly string[], start: number): number {
  let count = 0;
  while (start + count < words.length && count < VOICE_LIMITS.correctionWordsMax) {
    const word = words[start + count] ?? '';
    count += 1;
    if (PHRASE_END.test(word)) {
      break;
    }
  }
  return count;
}

function lastSentenceStart(words: readonly string[]): number {
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_END.test(words[index] ?? '')) {
      return index + 1;
    }
  }
  return 0;
}

function applySpokenPunctuation(words: readonly string[]): readonly string[] {
  const output: string[] = [];
  let index = 0;
  while (index < words.length) {
    const entry = SPOKEN_PUNCTUATION.find((candidate) => candidate.spoken.every((part, offset) => wordCore(words[index + offset] ?? '') === part));
    const previous = output[output.length - 1];
    if (entry !== undefined && previous !== undefined && !PHRASE_END.test(previous)) {
      output[output.length - 1] = `${previous}${entry.mark}`;
      index += entry.spoken.length;
    } else {
      output.push(words[index] ?? '');
      index += 1;
    }
  }
  return output;
}

function capitalizePronoun(word: string): string {
  return /^i(?:'(?:m|ll|ve|d)|’(?:m|ll|ve|d))?(?=[^\p{L}]|$)/u.test(word) ? `I${word.slice(1)}` : word;
}

function capitalizeSentences(words: readonly string[], start: Pick<CleanupOptions, 'capitalizeFirst'>): readonly string[] {
  let capitalizeNext = start.capitalizeFirst;
  return words.map((word) => {
    const result = capitalizeNext ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
    capitalizeNext = SENTENCE_END.test(word);
    return result;
  });
}
