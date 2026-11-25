// The person's own words for dictation: a vocabulary (names and jargon Whisper does not know, each
// optionally with what Whisper tends to hear instead) and snippets (a spoken trigger that writes a saved
// text). Both apply to final words only, never to the draft being spoken, in one pass each, so an
// expansion is never expanded again and a correction never corrects its own result.
//
// Biasing Whisper itself with the vocabulary (an initial prompt) is not possible here: the Transformers.js
// Whisper pipeline (4.3) does not take prompt ids. The words are corrected after decoding instead:
//   - an explicit pair ("stack ee" → "Stacki") is replaced as a whole phrase, ignoring case and punctuation;
//   - otherwise a word of five letters or more within one edit (two for nine letters or more) of a
//     vocabulary word, with the same first and last letter (a plural "s" aside), becomes that word; numbers, addresses and words with digits are never touched.
// The vocabulary word is written as the person wrote it ("Stacki", "iOS"); only an all-lowercase entry
// takes the capital the heard word had at the start of a sentence.
import { assert } from '../../core/assert';
import { record, text } from '../../core/boundary';

export const VOCABULARY_LIMITS = {
  entriesMax: 200,
  wordCharsMax: 64,
  snippetsMax: 200,
  triggerCharsMax: 64,
  expansionCharsMax: 4_000,
  /** Words of a transcript corrected at most; a segment is far shorter. */
  transcriptWordsMax: 2_000,
  /** The shortest word a fuzzy match may change: short words are too often other real words. */
  fuzzyWordCharsMin: 5,
  /** From this length a fuzzy match may be two edits away instead of one. */
  fuzzyTwoEditsCharsMin: 9,
} as const satisfies Record<string, number>;

export interface VocabularyEntry {
  /** The word as it is written. */
  readonly word: string;
  /** What Whisper tends to hear instead, when the person told Stacki; replaced as a whole phrase. */
  readonly misheard?: string;
}

export interface Snippet {
  readonly trigger: string;
  readonly expansion: string;
}

export interface DictationWords {
  readonly vocabulary: readonly VocabularyEntry[];
  readonly snippets: readonly Snippet[];
}

export const NO_DICTATION_WORDS: DictationWords = { vocabulary: [], snippets: [] };

function boundedText(input: unknown, max: number, what: string): string {
  const value = text(input).trim();
  if (value.length === 0) {
    throw new Error(`Expected a non-empty ${what}`);
  }
  if (value.length > max) {
    throw new Error(`Expected a ${what} within ${max} characters`);
  }
  return value;
}

/** One vocabulary entry from storage or a form. Throws on anything else. */
export function parseVocabularyEntry(input: unknown): VocabularyEntry {
  const source = record(input);
  const word = boundedText(source['word'], VOCABULARY_LIMITS.wordCharsMax, 'word');
  if (/[\r\n]/u.test(word)) {
    throw new Error('Expected a word on one line');
  }
  const misheard =
    source['misheard'] === undefined || source['misheard'] === null
      ? undefined
      : boundedText(source['misheard'], VOCABULARY_LIMITS.wordCharsMax, 'misheard phrase');
  return misheard === undefined ? { word } : { word, misheard };
}

/** One snippet from storage or a form. Throws on anything else. */
export function parseSnippet(input: unknown): Snippet {
  const source = record(input);
  const trigger = boundedText(source['trigger'], VOCABULARY_LIMITS.triggerCharsMax, 'trigger');
  if (normalizeWords(trigger) === '') {
    throw new Error('Expected a trigger with words');
  }
  const expansion = text(source['expansion']);
  if (expansion.trim().length === 0) {
    throw new Error('Expected a non-empty expansion');
  }
  if (expansion.length > VOCABULARY_LIMITS.expansionCharsMax) {
    throw new Error(`Expected an expansion within ${VOCABULARY_LIMITS.expansionCharsMax} characters`);
  }
  return { trigger, expansion };
}

/** The stored words: entries past the bounds, malformed ones and duplicates are dropped, never trusted. */
export function parseDictationWords(input: unknown): DictationWords {
  if (typeof input !== 'object' || input === null) {
    return NO_DICTATION_WORDS;
  }
  const source = record(input);
  const vocabulary = keepValid(source['vocabulary'], VOCABULARY_LIMITS.entriesMax, { parse: parseVocabularyEntry, key: (entry) => entry.word.toLowerCase() });
  const snippets = keepValid(source['snippets'], VOCABULARY_LIMITS.snippetsMax, { parse: parseSnippet, key: (snippet) => normalizeWords(snippet.trigger) });
  assert(vocabulary.length <= VOCABULARY_LIMITS.entriesMax, 'parseDictationWords: the vocabulary stays within its bound');
  assert(snippets.length <= VOCABULARY_LIMITS.snippetsMax, 'parseDictationWords: the snippets stay within their bound');
  return { vocabulary, snippets };
}

function keepValid<T>(input: unknown, max: number, by: { readonly parse: (value: unknown) => T; readonly key: (value: T) => string }): readonly T[] {
  const { parse, key } = by;
  if (!Array.isArray(input)) {
    return [];
  }
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const item of input.slice(0, max * 2)) {
    if (kept.length >= max) {
      break;
    }
    try {
      const value = parse(item);
      if (!seen.has(key(value))) {
        seen.add(key(value));
        kept.push(value);
      }
    } catch {
      // A damaged entry is left out; the others still apply.
    }
  }
  return kept;
}

/** Lowercase words joined by single spaces, punctuation removed: how triggers and misheard phrases compare. */
export function normalizeWords(phrase: string): string {
  const normalized = phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  assert(normalized.length <= phrase.length, 'normalizeWords: normalizing never adds text');
  return normalized;
}

/** `text` with its words corrected by the vocabulary (see the file comment for the rules). */
export function applyVocabulary(transcript: string, vocabulary: readonly VocabularyEntry[]): string {
  assert(vocabulary.length <= VOCABULARY_LIMITS.entriesMax, 'applyVocabulary: the vocabulary is bounded');
  if (vocabulary.length === 0 || transcript.trim() === '') {
    return transcript;
  }
  let result = transcript;
  // Explicit pairs first, longest heard phrase first, as whole words.
  const pairs = vocabulary
    .filter((entry) => entry.misheard !== undefined)
    .sort((first, second) => (second.misheard?.length ?? 0) - (first.misheard?.length ?? 0));
  for (const entry of pairs) {
    const words = normalizeWords(entry.misheard ?? '')
      .split(' ')
      .filter((word) => word !== '');
    if (words.length > 0) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join('[\\s\\p{P}]+')}(?![\\p{L}\\p{N}])`, 'giu');
      result = result.replace(pattern, (heard) => withCase(entry.word, heard));
    }
  }
  const singles = vocabulary.filter((entry) => !/\s/u.test(entry.word));
  const tokens = result.split(/(\s+)/u);
  assert(tokens.length <= VOCABULARY_LIMITS.transcriptWordsMax * 2 + 1, 'applyVocabulary: a transcript is bounded');
  return tokens.map((token) => (/\s/u.test(token) ? token : correctToken(token, singles))).join('');
}

// One whitespace-free token: its letters may become a vocabulary word; its punctuation stays.
function correctToken(token: string, singles: readonly VocabularyEntry[]): string {
  const match = /^([^\p{L}\p{N}]*)([\p{L}][\p{L}'’-]*)([^\p{L}\p{N}]*)$/u.exec(token);
  if (match === null) {
    return token; // Digits, an address, an email or a path: never touched.
  }
  const [, before = '', word = '', after = ''] = match;
  if (word.length < VOCABULARY_LIMITS.fuzzyWordCharsMin) {
    return token;
  }
  const lower = word.toLowerCase();
  const allowed = word.length >= VOCABULARY_LIMITS.fuzzyTwoEditsCharsMin ? 2 : 1;
  let best: { readonly entry: VocabularyEntry; readonly distance: number } | undefined;
  for (const entry of singles) {
    const target = entry.word.toLowerCase();
    if (target === lower) {
      return `${before}${withCase(entry.word, word)}${after}`;
    }
    if (Math.abs(target.length - lower.length) > allowed || target.length < VOCABULARY_LIMITS.fuzzyWordCharsMin) {
      continue;
    }
    // Conservative: a near miss keeps the word's first letter, and its last one unless the difference is a plural
    // "s" ("tailwinds"), so a real word one letter away ("astro" for "Astra") is left alone.
    const plural = lower.endsWith('s') && !target.endsWith('s');
    if (lower.charAt(0) !== target.charAt(0) || (!plural && lower.charAt(lower.length - 1) !== target.charAt(target.length - 1))) {
      continue;
    }
    const distance = editDistance(lower, target, allowed);
    if (distance <= allowed && (best === undefined || distance < best.distance)) {
      best = { entry, distance };
    }
  }
  return best === undefined ? token : `${before}${withCase(best.entry.word, word)}${after}`;
}

// The vocabulary's spelling; an all-lowercase entry takes a capital the heard word started with.
function withCase(word: string, heard: string): string {
  if (word !== word.toLowerCase()) {
    return word;
  }
  const first = heard.charAt(0);
  return first !== first.toLowerCase() ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
}

/** Levenshtein distance, stopping early once it passes `limit` (it then answers `limit + 1`). */
export function editDistance(first: string, second: string, limit: number): number {
  assert(limit >= 0, 'editDistance: a limit is never negative');
  assert(first.length <= VOCABULARY_LIMITS.wordCharsMax * 2, 'editDistance: words are bounded');
  let previous = Array.from({ length: second.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    let smallest = row;
    for (let column = 1; column <= second.length; column += 1) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      const value = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, (previous[column - 1] ?? 0) + cost);
      current.push(value);
      smallest = Math.min(smallest, value);
    }
    if (smallest > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[second.length] ?? limit + 1;
}

/**
 * `text` with each spoken trigger replaced by its saved text, longest trigger first, in one pass (an
 * expansion is never matched again). A trigger may follow "insert" or "paste", which go with it.
 */
export function expandSnippets(transcript: string, snippets: readonly Snippet[]): string {
  assert(snippets.length <= VOCABULARY_LIMITS.snippetsMax, 'expandSnippets: the snippets are bounded');
  if (snippets.length === 0 || transcript.trim() === '') {
    return transcript;
  }
  const ordered = [...snippets].sort((first, second) => normalizeWords(second.trigger).length - normalizeWords(first.trigger).length);
  const alternatives = ordered.map((snippet) => normalizeWords(snippet.trigger).split(' ').map(escapeRegExp).join('[\\s\\p{P}]+'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:insert|paste)[\\s,]+)?(${alternatives.join('|')})(?![\\p{L}\\p{N}])[.!?,]?`, 'giu');
  return transcript.replace(pattern, (_whole, spoken: string) => {
    const key = normalizeWords(spoken);
    return ordered.find((snippet) => normalizeWords(snippet.trigger) === key)?.expansion ?? spoken;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The one word the person changed in text they had just dictated, as `{ heard, corrected }`, or undefined
 * when nothing, or more than one word, changed. `dictated` is the text as it was written; `current` is the
 * same stretch of the box now (its last words, as many as `dictated` has). Only words of letters, three
 * or more on both sides, count: fixing a comma or a typo in "a" teaches nothing.
 */
export function correctedWord(dictated: string, current: string): { readonly heard: string; readonly corrected: string } | undefined {
  const before = dictated.split(/\s+/u).filter((word) => word !== '');
  const after = current.split(/\s+/u).filter((word) => word !== '');
  assert(before.length <= VOCABULARY_LIMITS.transcriptWordsMax, 'correctedWord: a dictated piece is bounded');
  if (before.length === 0 || after.length < before.length) {
    return undefined;
  }
  const tail = after.slice(after.length - before.length);
  let changed: { readonly heard: string; readonly corrected: string } | undefined;
  for (let index = 0; index < before.length; index += 1) {
    const heard = (before[index] ?? '').replace(/[^\p{L}'’-]/gu, '');
    const corrected = (tail[index] ?? '').replace(/[^\p{L}'’-]/gu, '');
    if (heard.toLowerCase() === corrected.toLowerCase()) {
      continue;
    }
    if (changed !== undefined || heard.length < 3 || corrected.length < 3 || corrected.length > VOCABULARY_LIMITS.wordCharsMax) {
      return undefined;
    }
    changed = { heard, corrected };
  }
  return changed;
}

/**
 * Stacki's own names, as Whisper large-v3 turbo mishears them in the benchmark (docs/voice-engine.md):
 * "Stacki" as "Stacky" or "Stachy", "Lumos" as "Loomis". Applied before the person's own vocabulary.
 */
export const BUILT_IN_VOCABULARY: readonly VocabularyEntry[] = [
  { word: 'Stacki', misheard: 'stacky' },
  { word: 'Stacki', misheard: 'stachy' },
  { word: 'Stacki', misheard: 'stack ee' },
  { word: 'Lumos', misheard: 'loomis' },
  { word: 'Lumos', misheard: 'loomus' },
];
