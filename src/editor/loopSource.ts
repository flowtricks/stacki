// What a loop goes through, read from its head: `stats.map((item) => (` loops
// over `stats`, handing each element to `item`. The binding picker looks the
// source up among the values it knows (dataSuggest.ts) to show the item's
// fields with a sampled element's values.
//
// The source is reduced to the value it names. A list narrowed on the way —
// `posts.filter(…)`, `.slice(0, 3)`, `.sort(…)` — holds the same kind of
// element, so it is read as the list it narrows; `data?.items ?? []` names
// `data.items`; and `Object.values(modules)` loops over an object's values,
// which is how an `import.meta.glob` result is usually listed.

import { assert } from '../../shared/core/assert';

export const LOOP_SOURCE_LIMITS = {
  // Steps peeled off a source before giving up: wrappers and narrowing calls
  // stack a few deep in a real page, never dozens.
  stepsMax: 16,
  // A loop head longer than this is not one the picker reads.
  headCharsMax: 4000,
} as const;

export interface LoopHead {
  /** What the loop goes through, as written: `data.items.slice(0, 3)`. */
  readonly source: string;
  /** The name each element is handed as: `item`. */
  readonly item: string;
  /** The index's name, when the callback takes one: `i`. */
  readonly index: string | undefined;
}

/** The value a loop goes through: a list, or an object whose values it lists. */
export type LoopSource = { readonly kind: 'list'; readonly path: string } | { readonly kind: 'values'; readonly path: string };

// `source.map((item, i) => (`, `source?.map(item => (`. The callback's body
// opens the markup, so the head ends where it does.
const MAP_HEAD = /^([\s\S]+?)\s*\??\.\s*map\(\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)|([A-Za-z_$][\w$]*))\s*=>\s*\(?$/;
// A value's address: `data`, `data.items`, `post.data["campus-name"]`, `list[0]`.
const VALUE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*$/;
// Calls that keep a list's element: what comes out is fewer, or reordered, of the same.
const KEEPS_ELEMENT = new Set(['filter', 'slice', 'sort', 'toSorted', 'reverse', 'toReversed', 'concat']);
// `?? []` and `|| []`: an empty fallback for a list that may be missing.
const EMPTY_FALLBACK = /\s*(?:\?\?|\|\|)\s*\[\s*\]$/;
const OBJECT_VALUES = /^Object\.values\(([\s\S]*)\)$/;

/** The loop a `.map` head describes, or undefined when it is not one. */
export function parseLoopHead(head: string): LoopHead | undefined {
  const text = head.trim();
  if (LOOP_SOURCE_LIMITS.headCharsMax < text.length) {
    return undefined;
  }
  const match = MAP_HEAD.exec(text);
  const source = match?.[1]?.trim();
  const item = match?.[2] ?? match?.[4];
  if (source === undefined || source === '' || item === undefined) {
    return undefined;
  }
  assert(text.includes(item), 'A loop item is named in its head');
  return { source, item, index: match?.[3] };
}

/**
 * The value `source` names once its wrappers and narrowing calls are peeled
 * off, or undefined when it computes something the picker cannot follow — a
 * call of its own (`await getPosts()` written inline), arithmetic, a literal.
 */
export function loopSourcePath(source: string): LoopSource | undefined {
  let text = source.trim();
  let kind: LoopSource['kind'] = 'list';
  for (let step = 0; step < LOOP_SOURCE_LIMITS.stepsMax; step++) {
    const peeled = peelStep(text);
    if (peeled === undefined) {
      break;
    }
    text = peeled;
  }
  const values = OBJECT_VALUES.exec(text);
  if (values?.[1] !== undefined) {
    kind = 'values';
    text = values[1].trim();
    for (let step = 0; step < LOOP_SOURCE_LIMITS.stepsMax; step++) {
      const peeled = peelStep(text);
      if (peeled === undefined) {
        break;
      }
      text = peeled;
    }
  }
  // Optional chaining reads the same value when it is there.
  const path = text.replace(/\?\.(?=\[)/g, '').replace(/\?\./g, '.');
  if (!VALUE_PATH.test(path)) {
    return undefined;
  }
  assert(path.length <= source.length, 'A loop source path is part of its source');
  return { kind, path };
}

// One wrapper or narrowing call off the outside of `text`, or undefined when
// there is none left to take.
function peelStep(text: string): string | undefined {
  const fallback = text.replace(EMPTY_FALLBACK, '');
  if (fallback !== text) {
    return fallback.trim();
  }
  if (!text.endsWith(')')) {
    return undefined;
  }
  const open = matchingOpen(text, text.length - 1);
  if (open === undefined) {
    return undefined;
  }
  if (open === 0) {
    return text.slice(1, -1).trim();
  }
  const call = /\??\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, open));
  const method = call?.[1];
  if (call === null || method === undefined) {
    return undefined;
  }
  return KEEPS_ELEMENT.has(method) ? text.slice(0, open - call[0].length).trim() : undefined;
}

// Where the bracket that `close` closes opens, skipping strings, or undefined
// when the brackets do not balance.
function matchingOpen(text: string, close: number): number | undefined {
  assert(close < text.length, 'A closing bracket is inside its text');
  let depth = 0;
  let quote: string | undefined = undefined;
  for (let i = close; i >= 0; i--) {
    const character = text.charAt(i);
    if (quote !== undefined) {
      if (character === quote && text.charAt(i - 1) !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === ')' || character === ']' || character === '}') {
      depth += 1;
    } else if (character === '(' || character === '[' || character === '{') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}
