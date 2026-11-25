// The text rules every panel search shares (Assets, Instructions, Navigator): a query is words, a
// word matches anywhere in a name, and neither case nor accents matter. Pure, so each panel's own
// search module and its tests rest on one definition of "the same word".
import { assert } from '../../shared/core/assert';

/** Lowercase with accents removed: `Éclair` and `eclair` are one word, and so are `STRASSE.png` and `strasse.png`. */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a query, folded; a query of only spaces has none. */
export function queryWords(query: string): readonly string[] {
  return foldSearchText(query)
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** True when the query has a word, which is when a panel shows results instead of its whole list. */
export function isSearching(query: string): boolean {
  return queryWords(query).length > 0;
}

/** True when every word is somewhere in the folded haystack. A list of no words matches nothing. */
export function holdsEveryWord(haystack: string, words: readonly string[]): boolean {
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

/** A run of a label, and whether the query's words land on it. */
export interface HighlightSegment {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * The label cut into runs, the ones the words land on marked. Each character is folded on its own so
 * that a position in the folded text maps back to the character it came from: an accent never shifts
 * a highlight. With no words, or none found, the whole label is one run.
 */
export function highlightSegments(label: string, words: readonly string[]): readonly HighlightSegment[] {
  assert(label.length <= 100_000, 'A label is short enough to cut');
  if (words.length === 0) {
    return [{ text: label, hit: false }];
  }
  const characters = Array.from(label);
  let folded = '';
  const owner: number[] = [];
  for (const [position, character] of characters.entries()) {
    const piece = foldSearchText(character);
    for (let step = 0; step < piece.length; step += 1) {
      owner.push(position);
    }
    folded += piece;
  }
  const marked = new Array<boolean>(characters.length).fill(false);
  for (const word of words) {
    let from = 0;
    // Each pass moves `from` past the last hit, so the walk ends within the folded length.
    for (let pass = 0; pass <= folded.length; pass += 1) {
      const at = folded.indexOf(word, from);
      if (at < 0) {
        break;
      }
      for (let offset = at; offset < at + word.length; offset += 1) {
        const position = owner[offset];
        if (position !== undefined) {
          marked[position] = true;
        }
      }
      from = at + word.length;
    }
  }
  const segments: HighlightSegment[] = [];
  for (const [position, character] of characters.entries()) {
    const hit = marked[position] === true;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.hit === hit) {
      segments[segments.length - 1] = { text: last.text + character, hit };
    } else {
      segments.push({ text: character, hit });
    }
  }
  assert(segments.map((segment) => segment.text).join('') === label, 'The runs put back together are the label');
  return segments;
}
