// Fuzzy matching for class names typed into a suggestion field.
//
// A class name is long and made of words — `button-primary`, `hero_title`,
// `textStyleH1` — and the person typing it remembers the shape, not the
// spelling. So the query is matched as a subsequence: its characters appear in
// the name in order, not necessarily side by side. `btnprim` finds
// `button-primary`, `hrtit` finds `hero_title`. Case never matters.
//
// A subsequence matches a lot, so the order is what makes it useful. Best first:
//
//   exact        the whole name
//   prefix       the name starts with the query
//   boundary     a word inside the name starts with it (after - _ / . : or a
//                space, or at a camelCase hump)
//   substring    the query appears whole, somewhere
//   subsequence  the query's characters appear in order
//
// Ties go to the shorter name (closer to what was typed), then alphabetically.
// Each match carries the positions of the characters it matched, so a row can
// show why it is there.
//
// Shared by the Style panel's selector field and the Settings panel's class box,
// so the two fields agree on what a query finds.

import { assert } from '../../shared/core/assert';

export type FuzzyTier = 'exact' | 'prefix' | 'boundary' | 'substring' | 'subsequence';

const TIER_RANK: Readonly<Record<FuzzyTier, number>> = { exact: 0, prefix: 1, boundary: 2, substring: 3, subsequence: 4 };

export interface FuzzyHit {
  readonly tier: FuzzyTier;
  /** The matched characters' positions in the text, ascending. */
  readonly indexes: readonly number[];
}

export interface FuzzyRanked<T> {
  readonly item: T;
  readonly hit: FuzzyHit;
}

/** A run of text, matched or not, for drawing a highlighted row. */
export interface FuzzySegment {
  readonly text: string;
  readonly hit: boolean;
}

// A project's class list is a few thousand names at most; the cap makes a
// runaway list a loud failure rather than a frozen field.
export const FUZZY_CANDIDATES_MAX = 100_000;
// Nobody types a class name longer than this; past it there is nothing to rank.
const FUZZY_QUERY_LENGTH_MAX = 256;

/** How `query` lands on `text`, or undefined for not at all. An empty query matches nothing. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | undefined {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (needle.length === 0 || needle.length > FUZZY_QUERY_LENGTH_MAX) {
    return undefined;
  }
  if (needle.length > haystack.length) {
    return undefined;
  }
  if (haystack === needle) {
    return { tier: 'exact', indexes: run(0, needle.length) };
  }
  if (haystack.startsWith(needle)) {
    return { tier: 'prefix', indexes: run(0, needle.length) };
  }
  const boundary = boundaryStart(text, needle);
  if (boundary !== undefined) {
    return { tier: 'boundary', indexes: run(boundary, needle.length) };
  }
  const at = haystack.indexOf(needle);
  if (at >= 0) {
    return { tier: 'substring', indexes: run(at, needle.length) };
  }
  const indexes = subsequence(text, needle);
  if (indexes === undefined) {
    return undefined;
  }
  assert(indexes.length === needle.length, 'fuzzyMatch: one position per query character');
  return { tier: 'subsequence', indexes };
}

/**
 * The items `query` finds, best first, at most `limit` of them. `textOf` names
 * the text an item is matched on.
 */
export function rankFuzzy<T>(query: string, items: readonly T[], options: { readonly limit: number }, textOf: (item: T) => string): readonly FuzzyRanked<T>[] {
  assert(items.length <= FUZZY_CANDIDATES_MAX, 'rankFuzzy: a bounded candidate list');
  assert(Number.isSafeInteger(options.limit), 'rankFuzzy: the limit is a whole number');
  assert(options.limit >= 0, 'rankFuzzy: the limit is not negative');
  const ranked: { readonly item: T; readonly hit: FuzzyHit; readonly text: string }[] = [];
  for (const item of items) {
    const text = textOf(item);
    const hit = fuzzyMatch(query, text);
    if (hit !== undefined) {
      ranked.push({ item, hit, text });
    }
  }
  ranked.sort(
    (left, right) => TIER_RANK[left.hit.tier] - TIER_RANK[right.hit.tier] || left.text.length - right.text.length || compareText(left.text, right.text),
  );
  const shown = ranked.slice(0, options.limit).map(({ item, hit }) => ({ item, hit }));
  assert(shown.length <= options.limit, 'rankFuzzy: no more than the limit');
  return shown;
}

/** `text` cut into matched and unmatched runs, in order, for a highlighted row. */
export function fuzzySegments(text: string, indexes: readonly number[]): readonly FuzzySegment[] {
  const hits = new Set(indexes);
  const segments: FuzzySegment[] = [];
  let current = '';
  let currentHit = false;
  for (let index = 0; index < text.length; index++) {
    const hit = hits.has(index);
    if (current.length > 0 && hit !== currentHit) {
      segments.push({ text: current, hit: currentHit });
      current = '';
    }
    current += text.charAt(index);
    currentHit = hit;
  }
  if (current.length > 0) {
    segments.push({ text: current, hit: currentHit });
  }
  assert(segments.map((segment) => segment.text).join('') === text, 'fuzzySegments: the runs spell the text');
  return segments;
}

// Where a word inside `text` starts with `needle`: after a separator, or at a
// lower-to-upper hump. Position 0 is the prefix tier, so it is skipped here.
function boundaryStart(text: string, needle: string): number | undefined {
  const haystack = text.toLowerCase();
  for (let index = 1; index + needle.length <= text.length; index++) {
    if (isWordStart(text, index)) {
      if (haystack.startsWith(needle, index)) {
        return index;
      }
    }
  }
  return undefined;
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text.charAt(index - 1);
  if (/[-_/.:\s]/.test(previous)) {
    return true;
  }
  const character = text.charAt(index);
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(character);
}

// The query's characters in order, leftmost first — except that a character
// jumps to a nearby word start holding it (`btn` on `button-tab` lights the `t`
// of `tab`) when the rest of the query still fits after it, so the highlight
// falls on the letters a person reads as the name's initials.
function subsequence(text: string, needle: string): readonly number[] | undefined {
  const haystack = text.toLowerCase();
  const indexes: number[] = [];
  let from = 0;
  for (let position = 0; position < needle.length; position++) {
    const character = needle.charAt(position);
    const next = haystack.indexOf(character, from);
    if (next < 0) {
      return undefined;
    }
    const start = nextWordStartWith(text, character, next);
    const chosen = start !== undefined && fits(haystack, needle.slice(position + 1), start + 1) ? start : next;
    indexes.push(chosen);
    from = chosen + 1;
  }
  return indexes;
}

// A word start holding `character`, at or after `from`, in the same word as
// `from` or the one right after — further than that, skipping ahead would trade
// a closer match for a prettier one.
function nextWordStartWith(text: string, character: string, from: number): number | undefined {
  if (isWordStart(text, from)) {
    return undefined;
  }
  let wordsCrossed = 0;
  for (let index = from + 1; index < text.length; index++) {
    if (isWordStart(text, index)) {
      wordsCrossed++;
      if (wordsCrossed > 1) {
        return undefined;
      }
      if (text.charAt(index).toLowerCase() === character) {
        return index;
      }
    }
  }
  return undefined;
}

// Whether `rest` is still a subsequence of `haystack` from `from` on.
function fits(haystack: string, rest: string, from: number): boolean {
  let at = from;
  for (const character of rest) {
    const next = haystack.indexOf(character, at);
    if (next < 0) {
      return false;
    }
    at = next + 1;
  }
  return true;
}

function run(start: number, length: number): readonly number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function compareText(left: string, right: string): number {
  return collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}
