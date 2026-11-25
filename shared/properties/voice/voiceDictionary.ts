// The personal dictionary: how a spoken name is written. A recognizer hears "hero section"
// and writes two words; the project has a file called HeroSection.astro. Entries come from
// two places: the names of the project's own files (so the dictionary follows the project
// with no setup) and a short built-in list of terms people say in a coding chat. Matching is
// by whole words, longest entry first, case-insensitive, and never uses a regular expression
// built from a name (a file called `a+b` must not change what the matcher does).
import { assert } from '../../core/assert';
import { wordCore } from './transcript';
import { VOICE_LIMITS } from './voiceLimits';

export interface DictionaryEntry {
  /** What the recognizer writes, as lower-case words. */
  readonly spoken: readonly string[];
  /** What the person means. */
  readonly written: string;
}

/** Terms said in a coding chat that recognizers split or flatten. Brand names keep their capitals. */
export const BUILT_IN_TERMS: readonly DictionaryEntry[] = [
  { spoken: ['stacki'], written: 'Stacki' },
  { spoken: ['astro'], written: 'Astro' },
  { spoken: ['tailwind'], written: 'Tailwind' },
  { spoken: ['type', 'script'], written: 'TypeScript' },
  { spoken: ['typescript'], written: 'TypeScript' },
  { spoken: ['java', 'script'], written: 'JavaScript' },
  { spoken: ['javascript'], written: 'JavaScript' },
  { spoken: ['github'], written: 'GitHub' },
  { spoken: ['git', 'hub'], written: 'GitHub' },
  { spoken: ['read', 'me'], written: 'README' },
  { spoken: ['readme'], written: 'README' },
  { spoken: ['css'], written: 'CSS' },
  { spoken: ['html'], written: 'HTML' },
  { spoken: ['json'], written: 'JSON' },
  { spoken: ['api'], written: 'API' },
  { spoken: ['url'], written: 'URL' },
  { spoken: ['svg'], written: 'SVG' },
  { spoken: ['mdx'], written: 'MDX' },
  { spoken: ['cms'], written: 'CMS' },
  { spoken: ['cloudflare'], written: 'Cloudflare' },
  { spoken: ['sanity'], written: 'Sanity' },
  { spoken: ['lumos'], written: 'Lumos' },
  { spoken: ['use', 'state'], written: 'useState' },
  { spoken: ['use', 'effect'], written: 'useEffect' },
  { spoken: ['node', 'js'], written: 'Node.js' },
  { spoken: ['react'], written: 'React' },
  { spoken: ['vite'], written: 'Vite' },
];

/** The words a file or component name is made of: `HeroSection`, `site-header` and `site_header_2` split at their joins. */
export function wordsOfName(name: string): readonly string[] {
  const spaced = name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return spaced
    .toLowerCase()
    .split(' ')
    .filter((word) => word !== '')
    .slice(0, VOICE_LIMITS.dictionarySpokenWordsMax + 1);
}

/**
 * Entries for a project's file paths: each file's name without its extension (said as its words:
 * "hero section" writes HeroSection), and with it ("hero section dot astro" writes HeroSection.astro).
 * A name of one plain lower-case word needs no entry; the recognizer already writes it.
 */
export function entriesFromPaths(paths: readonly string[]): readonly DictionaryEntry[] {
  const entries = new Map<string, DictionaryEntry>();
  for (const path of paths) {
    if (entries.size >= VOICE_LIMITS.dictionaryEntriesMax) {
      break;
    }
    const base = path.split('/').pop() ?? '';
    const dot = base.indexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot + 1) : '';
    const words = wordsOfName(stem);
    const addable = words.length > 0 && words.length <= VOICE_LIMITS.dictionarySpokenWordsMax && stem.length <= VOICE_LIMITS.dictionaryWrittenCharsMax;
    if (!addable) {
      continue;
    }
    if (words.length > 1 || stem !== stem.toLowerCase()) {
      entries.set(words.join(' '), { spoken: words, written: stem });
    }
    const extensionWords = wordsOfName(extension);
    if (extensionWords.length === 1 && words.length + 2 <= VOICE_LIMITS.dictionarySpokenWordsMax) {
      entries.set(`${words.join(' ')} dot ${extensionWords.join(' ')}`, { spoken: [...words, 'dot', ...extensionWords], written: base });
    }
  }
  return [...entries.values()].slice(0, VOICE_LIMITS.dictionaryEntriesMax);
}

/** The dictionary a phrase is matched against: the project's entries first (they win a tie), then the built-in terms, within the bound. */
export function mergeDictionary(project: readonly DictionaryEntry[]): readonly DictionaryEntry[] {
  const merged = [...project, ...BUILT_IN_TERMS].slice(0, VOICE_LIMITS.dictionaryEntriesMax);
  assert(merged.length <= VOICE_LIMITS.dictionaryEntriesMax, 'mergeDictionary: bounded');
  return merged;
}

/** Writes every spoken entry in `words` as its written form. Words carry their own punctuation, which stays outside the replaced name. */
export function applyDictionary(words: readonly string[], dictionary: readonly DictionaryEntry[]): readonly string[] {
  assert(dictionary.length <= VOICE_LIMITS.dictionaryEntriesMax, 'applyDictionary: the dictionary is bounded');
  const byFirstWord = new Map<string, DictionaryEntry[]>();
  for (const entry of dictionary) {
    const first = entry.spoken[0];
    if (first !== undefined) {
      byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), entry]);
    }
  }
  for (const candidates of byFirstWord.values()) {
    candidates.sort((left, right) => right.spoken.length - left.spoken.length);
  }
  const result: string[] = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    const match = (byFirstWord.get(wordCore(word)) ?? []).find((entry) =>
      entry.spoken.every((spoken, offset) => wordCore(words[index + offset] ?? '') === spoken),
    );
    if (match === undefined) {
      result.push(word);
      index += 1;
    } else {
      const last = words[index + match.spoken.length - 1] ?? word;
      const before = /^[^\p{L}\p{N}]*/u.exec(word)?.[0] ?? '';
      const after = /[^\p{L}\p{N}]*$/u.exec(last)?.[0] ?? '';
      result.push(`${before}${match.written}${after}`);
      index += match.spoken.length;
    }
  }
  assert(result.length <= words.length, 'applyDictionary: a replacement never adds words');
  return result;
}
