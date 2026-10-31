import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

export interface SearchItem {
  readonly name?: string;
  readonly label?: string;
  readonly search?: string;
  readonly sub?: string;
  readonly folder?: string;
  readonly cat?: string;
}

// Searching the insert palette.
//
// What is being searched is a list of things with two names: what the thing is
// called, and where it came from — `Input` in the `Form` folder, `Picture` from
// `astro:assets`. So the query is words, and a word can land on either.
//
//   form          — still being typed, so it is a beginning: Form,
//                   FormattedDate, <form>, and everything in the Form folder
//   form          + a space — now a whole word, and FormattedDate is not it
//   form input    — two words that have to land on different things: the Input
//                   in the Form folder
//
// The space is the whole trick. A word you have finished typing is a word you
// have finished saying, and matching it as a prefix after that is the palette
// pretending not to have heard you.

/** The words in a name, including the pieces of a camelCase one. */
function wordsOf(text: unknown): readonly string[] {
  const raw = String(text || '').toLowerCase();
  if (!raw) {
    return [];
  }
  const out = new Set<string>();
  // The whole thing, so `astro:assets` and `<form>` can be said as they read.
  out.add(raw);
  for (const part of raw.split(/[^a-z0-9]+/i)) {
    if (part) {
      out.add(part);
    }
  }
  // FormattedDate → formatted, date. Written on the original text, because the
  // capitals are what say where the pieces are.
  for (const part of String(text || '').split(/[^A-Za-z0-9]+/)) {
    for (const piece of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      if (piece) {
        out.add(piece.toLowerCase());
      }
    }
  }
  return [...out];
}

// What a token can land on, best first: an item's own name beats the folder it
// sits in, because that is what it is called.
const FIELDS = [
  { of: (item: SearchItem) => item.search || item.label || item.name, base: 0 },
  { of: (item: SearchItem) => item.label || item.name, base: 0 },
  // `sub` in the palette, `folder` on a component record straight off the
  // scan — the components panel searches the same list without dressing it up
  // first. A folder is a path (`Form/Fields/Advanced`), and its words are its
  // segments, so any one of them can be typed.
  { of: (item: SearchItem) => item.sub || item.folder, base: 4 },
];

/** A word the person has finished typing (there is a space after it), or one
 * they are still typing. */
type TokenState = 'finished' | 'typing';

/**
 * How well one token lands on one item, or undefined for not at all.
 * A finished token has to match a word rather than begin one.
 */
function scoreToken(item: SearchItem, token: string, state: TokenState): number | undefined {
  let best: number | undefined;
  for (const field of FIELDS) {
    const text = String(field.of(item) || '').toLowerCase();
    if (!text) {
      continue;
    }
    const words = wordsOf(field.of(item));
    let score: number | undefined;
    if (text === token || words.includes(token)) {
      score = field.base;
    } else if (state === 'finished') {
      score = undefined;
    } else if (text.startsWith(token)) {
      score = field.base + 1;
    } else if (words.some((word) => word.startsWith(token))) {
      score = field.base + 2;
    } else if (text.includes(token)) {
      score = field.base + 3;
    }
    if (score !== undefined && (best === undefined || score < best)) {
      best = score;
    }
  }
  return best;
}

// What an element is called in words, for the tags whose names don't say it.
// A person looking for a paragraph types `paragraph`, not `p`; the tag still
// lists below any component that matched, because the category sort decides
// that, not the words.
const TAG_WORDS: Readonly<Record<string, string>> = {
  a: 'link',
  blockquote: 'quote',
  br: 'line break',
  em: 'italic emphasis',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hr: 'divider line',
  iframe: 'embed',
  img: 'image',
  li: 'list item',
  nav: 'navigation',
  ol: 'list ordered',
  p: 'paragraph',
  slot: 'children content',
  strong: 'bold',
  ul: 'list unordered',
};

/** The search text for an element: its tag, then the words it goes by. */
export function tagSearchText(tag: string): string {
  assert(tag.length > 0, 'An element search text needs a tag');
  const words = Object.hasOwn(TAG_WORDS, tag) ? TAG_WORDS[tag] : undefined;
  return words === undefined ? tag : `${tag} ${words}`;
}

// Components first, then elements, then everything else — the order the tabs
// are in, and the order of how much of the project a thing belongs to. A
// project's own components are its vocabulary; `<form>` is always there.
const CATEGORY: Readonly<Record<string, number>> = { components: 0, elements: 1, other: 2 };

/**
 * The items that match, best first. An empty query keeps the list as it is,
 * which is the palette's own order.
 *
 * Every word must land somewhere. `form input` is not "anything with form or
 * input in it" — it is the thing called Input in the folder called Form, and a
 * list that answered with forty rows would be answering a different question.
 */
export function rankInsertItems<T extends SearchItem>(
  items: readonly T[] | undefined,
  query: unknown,
): readonly T[] {
  assert((items?.length ?? 0) <= LIMITS.scanEntriesMax, 'Palette item count exceeds limit');
  const text = String(query || '').toLowerCase();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return [...(items || [])];
  }
  // A trailing space means the last word is finished too.
  const finished = /\s$/.test(text);
  const scored = [];
  for (const [index, item] of (items || []).entries()) {
    let total = 0;
    let matched = true;
    for (const [at, token] of tokens.entries()) {
      const state = finished || at < tokens.length - 1 ? 'finished' : 'typing';
      const score = scoreToken(item, token, state);
      if (score === undefined) {
        matched = false;
        break;
      }
      total += score;
    }
    if (matched) {
      scored.push({ item, total, index });
    }
  }
  scored.sort(
    (left, right) =>
      (CATEGORY[left.item.cat ?? ''] ?? 3) - (CATEGORY[right.item.cat ?? ''] ?? 3) ||
      left.total - right.total ||
      left.index - right.index,
  );
  return scored.map((entry) => entry.item);
}
