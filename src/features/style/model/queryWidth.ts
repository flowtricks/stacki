// The canvas width that shows a picked media query in effect.
//
// Picking `@media (width < 50rem)` in the style panel's context dropdown is
// choosing to write styles that only apply below 50rem; a canvas wider than that
// shows none of them, so every edit would look like it did nothing. The canvas is
// moved to a width just inside the query instead. One clear rule per bound:
//
//   width < X, X > width          the largest whole pixel below X
//   width <= X, max-width: X       X, rounded down
//   width > X, X < width          the smallest whole pixel above X
//   width >= X, min-width: X       X, rounded up
//   a range (both bounds)         its upper bound, by the rule above
//
// Only `px` and `rem` widths are read; `rem` is the canvas page's root font
// size. Anything else (em, vw, height, orientation, hover, `or`, `not`, a list
// of queries, @container, @supports) leaves the canvas alone: a guess there
// would move the canvas somewhere the query may not hold.

import { assert } from '../../../../shared/core/assert';

/** What a picked query asks of the canvas width. */
export type QueryWidth = { readonly kind: 'width'; readonly widthPx: number } | { readonly kind: 'none'; readonly reason: QueryWidthSkip };

/** Why a query leaves the canvas alone. */
export type QueryWidthSkip = 'not-media' | 'no-width' | 'unit' | 'unparsed';

export const QUERY_WIDTH_LIMITS = {
  /** Characters of query text read; a hand-written query is a line or two. */
  queryCharsMax: 512,
  /** Conditions joined by `and` in one query. */
  conditionsMax: 16,
  /** The canvas width range a pick may set, as the width field accepts. */
  widthPxMin: 280,
  widthPxMax: 7_680,
} as const satisfies Record<string, number>;

// One width bound: which side of the width it limits, and whether the bound
// value itself is inside.
type Bound = { readonly side: 'upper' | 'lower'; readonly inclusive: boolean; readonly px: number };

/**
 * The canvas width for a context's at-rule chain (`@container x › @media y` is
 * read by its last link, the query the styles sit in) at `rootFontSizePx`.
 */
export function canvasWidthForQuery(atContext: string, rootFontSizePx: number): QueryWidth {
  assert(Number.isFinite(rootFontSizePx), 'canvasWidthForQuery: a root font size is a number');
  assert(rootFontSizePx > 0, 'canvasWidthForQuery: a root font size is positive');
  if (atContext.length > QUERY_WIDTH_LIMITS.queryCharsMax) {
    return { kind: 'none', reason: 'unparsed' };
  }
  const innermost = (atContext.split(' › ').pop() ?? '').trim();
  const media = /^@media\s+([\s\S]*)$/i.exec(innermost);
  if (media === null) {
    return { kind: 'none', reason: 'not-media' };
  }
  const bounds = boundsOf((media[1] ?? '').trim().toLowerCase(), rootFontSizePx);
  if (!Array.isArray(bounds)) {
    return { kind: 'none', reason: bounds };
  }
  const widthPx = widthInside(bounds);
  if (widthPx === undefined) {
    return { kind: 'none', reason: 'no-width' };
  }
  if (widthPx < QUERY_WIDTH_LIMITS.widthPxMin) {
    return { kind: 'none', reason: 'unparsed' };
  }
  if (widthPx > QUERY_WIDTH_LIMITS.widthPxMax) {
    return { kind: 'none', reason: 'unparsed' };
  }
  assert(Number.isSafeInteger(widthPx), 'canvasWidthForQuery: a width is whole pixels');
  return { kind: 'width', widthPx };
}

// The width bounds of a query's conditions, or why there are none to read. A
// leading media type (`screen and …`) is allowed; `only` too.
function boundsOf(query: string, rootFontSizePx: number): Bound[] | QueryWidthSkip {
  if (query.includes(',') || /\b(or|not)\b/.test(query)) {
    return 'unparsed';
  }
  const parts = query.split(/\s+and\s+/);
  if (parts.length > QUERY_WIDTH_LIMITS.conditionsMax) {
    return 'unparsed';
  }
  const bounds: Bound[] = [];
  for (const [index, raw] of parts.entries()) {
    const part = raw.trim();
    if (index === 0 && /^(only\s+)?(all|screen)$/.test(part)) {
      continue;
    }
    const inner = /^\((.*)\)$/.exec(part);
    if (inner === null) {
      return 'unparsed';
    }
    const read = conditionBounds((inner[1] ?? '').trim(), rootFontSizePx);
    if (!Array.isArray(read)) {
      return read;
    }
    bounds.push(...read);
  }
  if (bounds.length === 0) {
    return 'no-width';
  }
  return bounds;
}

// One parenthesised condition: `min-width: 40rem`, `width < 50rem`, or a range
// `40rem <= width < 50rem`.
function conditionBounds(condition: string, rootFontSizePx: number): Bound[] | QueryWidthSkip {
  const named = /^(min|max)-width\s*:\s*(\S+)$/.exec(condition);
  if (named !== null) {
    const px = lengthPx(named[2] ?? '', rootFontSizePx);
    if (typeof px !== 'number') {
      return px;
    }
    return [{ side: named[1] === 'max' ? 'upper' : 'lower', inclusive: true, px }];
  }
  if (!/\bwidth\b/.test(condition)) {
    return 'no-width';
  }
  // Split on the comparison operators, keeping them: `40rem`, `<=`, `width`, `<`, `50rem`.
  const tokens = condition
    .split(/\s*(<=|>=|<|>)\s*/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const at = tokens.indexOf('width');
  if (at < 0 || (tokens.length !== 3 && tokens.length !== 5)) {
    return 'unparsed';
  }
  const bounds: Bound[] = [];
  // The comparison after `width` reads as written; the one before reads
  // reversed (`40rem < width` is `width > 40rem`).
  if (at + 2 < tokens.length) {
    const bound = boundFrom(tokens[at + 1] ?? '', tokens[at + 2] ?? '', rootFontSizePx, 'after');
    if (typeof bound === 'string') {
      return bound;
    }
    bounds.push(bound);
  }
  if (at >= 2) {
    const bound = boundFrom(tokens[at - 1] ?? '', tokens[at - 2] ?? '', rootFontSizePx, 'before');
    if (typeof bound === 'string') {
      return bound;
    }
    bounds.push(bound);
  }
  if (bounds.length === 0) {
    return 'unparsed';
  }
  return bounds;
}

function boundFrom(operator: string, value: string, rootFontSizePx: number, position: 'after' | 'before'): Bound | QueryWidthSkip {
  const px = lengthPx(value, rootFontSizePx);
  if (typeof px !== 'number') {
    return px;
  }
  const inclusive = operator.endsWith('=');
  const less = operator.startsWith('<');
  // `width < X` limits from above; `X < width` from below.
  const upper = position === 'after' ? less : !less;
  if (!['<', '<=', '>', '>='].includes(operator)) {
    return 'unparsed';
  }
  return { side: upper ? 'upper' : 'lower', inclusive, px };
}

// A length in px: `px` as written, `rem` times the root font size.
function lengthPx(text: string, rootFontSizePx: number): number | QueryWidthSkip {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|[a-z%]*)$/.exec(text.trim());
  if (match === null) {
    return 'unparsed';
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return 'unparsed';
  }
  const unit = match[2] ?? '';
  if (unit === 'px') {
    return amount;
  }
  if (unit === 'rem') {
    return amount * rootFontSizePx;
  }
  return 'unit';
}

// The width the rule picks for a set of bounds: the tightest upper bound when
// there is one, else the tightest lower bound. Undefined when the bounds leave no
// whole pixel inside.
function widthInside(bounds: readonly Bound[]): number | undefined {
  const uppers = bounds.filter((bound) => bound.side === 'upper').map((bound) => (bound.inclusive ? Math.floor(bound.px) : Math.ceil(bound.px) - 1));
  const lowers = bounds.filter((bound) => bound.side === 'lower').map((bound) => (bound.inclusive ? Math.ceil(bound.px) : Math.floor(bound.px) + 1));
  const upper = uppers.length > 0 ? Math.min(...uppers) : undefined;
  const lower = lowers.length > 0 ? Math.max(...lowers) : undefined;
  if (upper === undefined) {
    return lower;
  }
  if (lower === undefined) {
    return upper;
  }
  // A range: its upper bound, when the range holds any whole pixel at all.
  return lower <= upper ? upper : undefined;
}
