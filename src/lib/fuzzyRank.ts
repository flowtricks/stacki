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
// so the two fields agree on what a query finds. For the same reason the rows both
// fields draw from their matches live here too: a typed name nothing matches
// exactly leads with a row that creates it (classRows).

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

// The shape shared/page/classNames.ts reads classes in: what the suggestions can
// hold is what the fields can create. Written out here because Studio's vendored
// tree has this file and not that one, and both panels ship in Studio.
const CLASS_NAME = /^-?[A-Za-z_][\w-]*$/;

/** Whether `text` is one plain class name, with no selector syntax in it. */
export function isClassName(text: string): boolean {
  return CLASS_NAME.test(text);
}

/** Said when a field refuses a name, in the words the app's add-class failure uses. */
export const CLASS_NAME_REFUSAL = 'Check the class name and retry.';

/** A row of a class field's list: the class the typed text would create, or a match. */
export type ClassRow<T> = { readonly kind: 'create'; readonly name: string } | { readonly kind: 'match'; readonly item: T };

export interface ClassRowList<T> {
  readonly rows: readonly ClassRow<T>[];
  /** The row selected until an arrow moves it, and the highest ↑ can reach; -1 is no row. */
  readonly rest: number;
}

/**
 * A class field's list. Matches are ranked with case ignored, but a class name is
 * not, so the exact class is pulled to the front here rather than left to its tier.
 * When there is one it is selected. Otherwise a valid name leads with a create row,
 * selected. A class the element already carries gets neither: nothing is selected,
 * and Enter falls to the field's own typed-text path, which never writes it twice.
 * Text that names no class leaves the list as ranked, resting on `restPlain`.
 */
export function classRows<T>(inputs: {
  /** The class the typed text would mean, if it means one. */
  readonly name: string | undefined;
  readonly matches: readonly T[];
  readonly nameOf: (item: T) => string | undefined;
  /** Whether the element already carries `name`. */
  readonly carried: boolean;
  readonly restPlain: -1 | 0;
}): ClassRowList<T> {
  const { name, matches, nameOf, carried, restPlain } = inputs;
  assert(matches.length <= FUZZY_CANDIDATES_MAX, 'classRows: a bounded list');
  const rows = matches.map((item): ClassRow<T> => ({ kind: 'match', item }));
  if (carried) {
    return { rows, rest: -1 };
  }
  if (name === undefined) {
    return { rows, rest: restPlain };
  }
  const exact = matches.findIndex((item) => nameOf(item) === name);
  if (exact >= 0) {
    const row = rows[exact];
    assert(row !== undefined, 'classRows: the exact match has a row');
    return { rows: [row, ...rows.slice(0, exact), ...rows.slice(exact + 1)], rest: 0 };
  }
  if (isClassName(name)) {
    return { rows: [{ kind: 'create', name }, ...rows], rest: 0 };
  }
  return { rows, rest: restPlain };
}

/** `index` kept on the list: never above its resting row, never past its last. */
export function classRowStep(index: number, list: ClassRowList<unknown>): number {
  assert(list.rest >= -1, 'classRowStep: the resting row is a row or none');
  assert(list.rest <= 0, 'classRowStep: the list rests at its top');
  return Math.min(Math.max(index, list.rest), list.rows.length - 1);
}

/** What Tab takes: the selected match, or the first when the selection is not one. */
export function classRowMatch<T>(list: ClassRowList<T>, selected: number): T | undefined {
  const row = list.rows[selected];
  if (row?.kind === 'match') {
    return row.item;
  }
  const first = list.rows.find((candidate) => candidate.kind === 'match');
  return first?.kind === 'match' ? first.item : undefined;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function compareText(left: string, right: string): number {
  return collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}
