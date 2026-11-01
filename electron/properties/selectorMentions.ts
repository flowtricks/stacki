// Whether any text could produce a class or id name. A name counts as
// mentioned when it appears as a whole word: between characters that cannot be
// part of a class name. It also counts when code assembles it: a piece ending
// in a separator right before `${` or a closing quote (`btn-${size}`,
// 'btn-' + size), or a piece starting with one right after `}` or an opening
// quote (`${base}--active`). Matching is deliberately loose in that direction:
// a stray word in a README protects a rule, which costs a leftover; missing a
// real use breaks a page.
//
// Scanning is one pass over each text with a token regex and set lookups, so
// its cost grows with the bytes read, not with how many names are asked about.
import { assert } from '../../shared/core/assert';

export const MENTION_LIMITS = {
  /** Distinct names one scan asks about. Bounded by the report's entries. */
  namesMax: 100_000,
  /** Separator runs one name is split at for its pieces. */
  piecesPerNameMax: 16,
} as const satisfies Record<string, number>;

/** What a scan looks for: the names, and the pieces code could build them from. */
export interface MentionInterest {
  /** Names made only of word characters, found by token lookup. */
  readonly words: ReadonlySet<string>;
  /** Names with other characters (`md:flex`, `w-1/2`), found by substring search. */
  readonly odd: readonly string[];
  /** Leading pieces that end in a separator: `btn-`. */
  readonly heads: ReadonlySet<string>;
  /** Leading pieces without their separator, joined with `+`: 'btn' + … */
  readonly bareHeads: ReadonlySet<string>;
  /** Trailing pieces that start with a separator: `-active`. */
  readonly tails: ReadonlySet<string>;
}

/** What a scan found. Sets only grow, so a scan can add into an earlier one. */
export interface MentionHits {
  readonly words: Set<string>;
  readonly heads: Set<string>;
  readonly tails: Set<string>;
}

const WORD_ONLY = /^[A-Za-z0-9_-]+$/;
const SEPARATORS = /[-_]+/g;

export function mentionInterest(names: Iterable<string>): MentionInterest {
  const words = new Set<string>();
  const odd: string[] = [];
  const heads = new Set<string>();
  const bareHeads = new Set<string>();
  const tails = new Set<string>();
  for (const name of names) {
    assert(name.length > 0, 'mentionInterest: names are non-empty');
    if (!WORD_ONLY.test(name)) {
      odd.push(name);
      continue;
    }
    words.add(name);
    for (const piece of namePieces(name)) {
      heads.add(piece.head);
      bareHeads.add(piece.bareHead);
      tails.add(piece.tail);
    }
  }
  assert(words.size + odd.length <= MENTION_LIMITS.namesMax, 'mentionInterest: the report bounds names');
  return { words, odd, heads, bareHeads, tails };
}

export function emptyHits(): MentionHits {
  return { words: new Set(), heads: new Set(), tails: new Set() };
}

// Everything a scan asks about in one set, plus which token lengths can match:
// most tokens in a package file have a length no name has, and are skipped
// without being copied out of the text. Built once per interest.
interface InterestIndex {
  readonly all: ReadonlySet<string>;
  readonly lengths: Uint8Array;
}
const indexes = new WeakMap<MentionInterest, InterestIndex>();
const TOKEN_CHARS_MAX = 256;

function indexOf(interest: MentionInterest): InterestIndex {
  const existing = indexes.get(interest);
  if (existing !== undefined) {
    return existing;
  }
  const all = new Set([...interest.words, ...interest.heads, ...interest.bareHeads, ...interest.tails]);
  const lengths = new Uint8Array(TOKEN_CHARS_MAX + 1);
  for (const token of all) {
    if (token.length <= TOKEN_CHARS_MAX) {
      lengths[token.length] = 1;
    }
  }
  const index = { all, lengths };
  indexes.set(interest, index);
  return index;
}

/** Add what `text` mentions to `hits`. Bare heads are recorded as heads. */
export function scanMentions(text: string, interest: MentionInterest, hits: MentionHits): void {
  const { all, lengths } = indexOf(interest);
  const length = text.length;
  let start = 0;
  // One pass over the characters: a token is a maximal run of word characters.
  while (start < length) {
    if (!isWordCode(text.charCodeAt(start))) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < length && isWordCode(text.charCodeAt(end))) {
      end += 1;
    }
    const size = end - start;
    if (size <= TOKEN_CHARS_MAX && lengths[size] === 1) {
      const token = text.slice(start, end);
      if (all.has(token)) {
        recordToken(text, token, start, end, interest, hits);
      }
    }
    start = end;
  }
  for (const name of interest.odd) {
    if (!hits.words.has(name)) {
      if (containsWord(text, name)) {
        hits.words.add(name);
      }
    }
  }
}

function recordToken(text: string, token: string, start: number, end: number, interest: MentionInterest, hits: MentionHits): void {
  if (interest.words.has(token)) {
    hits.words.add(token);
  }
  if (interest.heads.has(token)) {
    if (isQuote(text.charCodeAt(end)) || text.startsWith('${', end)) {
      hits.heads.add(token);
    }
  }
  if (interest.bareHeads.has(token)) {
    if (isQuote(text.charCodeAt(end)) && /^\s*\+/.test(text.slice(end + 1, end + 64))) {
      hits.heads.add(token);
    }
  }
  if (interest.tails.has(token)) {
    const before = text.charCodeAt(start - 1);
    if (before === 0x7d || isQuote(before)) {
      hits.tails.add(token);
    }
  }
}

export function mergeHits(target: MentionHits, source: MentionHits): void {
  for (const word of source.words) {
    target.words.add(word);
  }
  for (const head of source.heads) {
    target.heads.add(head);
  }
  for (const tail of source.tails) {
    target.tails.add(tail);
  }
}

/** The assembled piece that protects `name` in `hits`, if one does. */
export function assembledPiece(name: string, hits: MentionHits): string | undefined {
  if (!WORD_ONLY.test(name)) {
    return undefined;
  }
  for (const piece of namePieces(name)) {
    if (hits.heads.has(piece.head)) {
      return `${piece.head}…`;
    }
    if (hits.heads.has(piece.bareHead)) {
      return `${piece.bareHead} + …`;
    }
    if (hits.tails.has(piece.tail)) {
      return `…${piece.tail}`;
    }
  }
  return undefined;
}

/** Whether `interest` still asks about `name` or any piece it could be built from. */
export function asksAbout(interest: MentionInterest, name: string): boolean {
  if (interest.words.has(name) || interest.odd.includes(name)) {
    return true;
  }
  if (!WORD_ONLY.test(name)) {
    return false;
  }
  return namePieces(name).some((piece) => interest.heads.has(piece.head) || interest.bareHeads.has(piece.bareHead) || interest.tails.has(piece.tail));
}

/** The interest left after `hits`: what a further scan still has to find. */
export function remainingInterest(interest: MentionInterest, hits: MentionHits): MentionInterest {
  const words = new Set([...interest.words].filter((word) => !hits.words.has(word)));
  const odd = interest.odd.filter((name) => !hits.words.has(name));
  return {
    words,
    odd,
    heads: new Set([...interest.heads].filter((head) => !hits.heads.has(head))),
    bareHeads: new Set([...interest.bareHeads].filter((head) => !hits.heads.has(head))),
    tails: new Set([...interest.tails].filter((tail) => !hits.tails.has(tail))),
  };
}

export function interestIsEmpty(interest: MentionInterest): boolean {
  return interest.words.size === 0 && interest.odd.length === 0 && interest.heads.size === 0 && interest.bareHeads.size === 0 && interest.tails.size === 0;
}

interface NamePiece {
  readonly head: string;
  readonly bareHead: string;
  readonly tail: string;
}

/** Every split of `name` at a separator run: `btn-large` → btn- / btn / -large. */
function namePieces(name: string): readonly NamePiece[] {
  const pieces: NamePiece[] = [];
  SEPARATORS.lastIndex = 0;
  for (let match = SEPARATORS.exec(name); match !== null; match = SEPARATORS.exec(name)) {
    if (pieces.length >= MENTION_LIMITS.piecesPerNameMax) {
      break;
    }
    const start = match.index;
    const end = start + match[0].length;
    // A separator at either end leaves one side empty: no piece to build from.
    if (start > 0) {
      if (end < name.length) {
        pieces.push({ head: name.slice(0, end), bareHead: name.slice(0, start), tail: name.slice(start) });
      }
    }
  }
  return pieces;
}

function containsWord(text: string, name: string): boolean {
  for (let index = text.indexOf(name); index !== -1; index = text.indexOf(name, index + 1)) {
    if (!isWordCode(text.charCodeAt(index - 1))) {
      if (!isWordCode(text.charCodeAt(index + name.length))) {
        return true;
      }
    }
  }
  return false;
}

function isWordCode(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) {
    return true;
  }
  if (code >= 0x41 && code <= 0x5a) {
    return true;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return true;
  }
  return code === 0x2d || code === 0x5f;
}

function isQuote(code: number): boolean {
  return code === 0x22 || code === 0x27 || code === 0x60;
}
