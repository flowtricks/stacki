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
  /** At-rule levels in one context chain compared for containment. */
  chainLevelsMax: 8,
  /** Distinct query levels whose containment reading is kept. */
  levelReadingsMax: 256,
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

/** Which sides of the width a query's conditions limit, read by the same parser as canvasWidthForQuery. */
export type QueryWidthSides =
  { readonly kind: 'sides'; readonly lower: boolean; readonly upper: boolean } | { readonly kind: 'none'; readonly reason: QueryWidthSkip };

/**
 * Whether a context's query is a lower bound (`width >= X`, `min-width`), an upper bound
 * (`width < X`, `max-width`) or both (a range), as canvasWidthForQuery reads it, so the two
 * can never disagree about a query.
 */
export function queryWidthSides(atContext: string, rootFontSizePx: number): QueryWidthSides {
  assert(Number.isFinite(rootFontSizePx), 'queryWidthSides: a root font size is a number');
  assert(rootFontSizePx > 0, 'queryWidthSides: a root font size is positive');
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
  return { kind: 'sides', lower: bounds.some((bound) => bound.side === 'lower'), upper: bounds.some((bound) => bound.side === 'upper') };
}

/** Whether a canvas width is inside a query, and the interval it holds. */
export type QueryWidthMatch =
  /** `lowerPx` is 0 and `upperPx` Infinity when the query has no bound on that side. */
  | { readonly kind: 'match'; readonly lowerPx: number; readonly upperPx: number }
  | { readonly kind: 'miss' }
  /** The query says nothing measurable about width: it takes no part in following the canvas. */
  | { readonly kind: 'ignored'; readonly reason: QueryWidthSkip };

/**
 * Whether a canvas `widthPx` wide is inside a context's width query, read by the same parser
 * as canvasWidthForQuery (so a pick of a query and the following of the canvas can never
 * disagree about what a query means). Boundaries are exact: `width >= 30rem` holds at 480
 * and not at 479; `width > 30rem` not at 480. Anything the reader cannot measure is
 * `ignored`, never a guess.
 */
export function queryWidthMatch(atContext: string, widthPx: number, rootFontSizePx: number): QueryWidthMatch {
  assert(Number.isFinite(widthPx), 'queryWidthMatch: a canvas width is a number');
  assert(Number.isFinite(rootFontSizePx), 'queryWidthMatch: a root font size is a number');
  assert(rootFontSizePx > 0, 'queryWidthMatch: a root font size is positive');
  if (atContext.length > QUERY_WIDTH_LIMITS.queryCharsMax) {
    return { kind: 'ignored', reason: 'unparsed' };
  }
  const innermost = (atContext.split(' › ').pop() ?? '').trim();
  const media = /^@media\s+([\s\S]*)$/i.exec(innermost);
  if (media === null) {
    return { kind: 'ignored', reason: 'not-media' };
  }
  const bounds = boundsOf((media[1] ?? '').trim().toLowerCase(), rootFontSizePx);
  if (!Array.isArray(bounds)) {
    return { kind: 'ignored', reason: bounds };
  }
  let lowerPx = 0;
  let upperPx = Number.POSITIVE_INFINITY;
  for (const bound of bounds) {
    if (bound.side === 'lower') {
      if (bound.inclusive ? widthPx < bound.px : widthPx <= bound.px) {
        return { kind: 'miss' };
      }
      lowerPx = Math.max(lowerPx, bound.px);
    } else {
      if (bound.inclusive ? widthPx > bound.px : widthPx >= bound.px) {
        return { kind: 'miss' };
      }
      upperPx = Math.min(upperPx, bound.px);
    }
  }
  return { kind: 'match', lowerPx, upperPx };
}

/**
 * Whether `ruleContext` holds wherever `viewContext` holds, read by the same parser as
 * canvasWidthForQuery so the panel and the canvas agree on what a query means. Base ('')
 * always holds. Chains (` › `-joined) are compared level by level: the rule's chain may be
 * shorter (an ancestor), and each of its levels is either written exactly as the view's
 * level at that depth, or a width query whose interval holds the view level's whole
 * interval with the same media type (or `all`) or the same container name. Anything not
 * provable is false, never a guess: em/vw, `or`, `not`, lists, height, orientation,
 * @supports with different text, containers with different names or with px and rem mixed
 * (a container's rem is the page's root size, not a fixed one), and a view that never holds.
 */
export function queryContextImplies(viewContext: string, ruleContext: string): boolean {
  if (ruleContext === '' || ruleContext === viewContext) {
    return true;
  }
  if (viewContext.startsWith(`${ruleContext} › `)) {
    return true;
  }
  const ruleLevels = ruleContext.split(' › ');
  const viewLevels = viewContext.split(' › ');
  if (ruleLevels.length > viewLevels.length) {
    return false;
  }
  if (viewLevels.length > QUERY_WIDTH_LIMITS.chainLevelsMax) {
    return false;
  }
  for (const [index, ruleLevel] of ruleLevels.entries()) {
    const viewLevel = viewLevels[index];
    assert(viewLevel !== undefined, 'queryContextImplies: the view chain is at least as deep');
    if (!levelImplies(viewLevel, ruleLevel)) {
      return false;
    }
  }
  assert(ruleLevels.length <= viewLevels.length, 'queryContextImplies: every rule level was compared');
  return true;
}

// One side of a width interval: its value and whether the value itself is inside.
type Edge = { readonly px: number; readonly inclusive: boolean };

// One at-rule level as a width interval in a scope (the media type, or the container
// name), or opaque when it cannot be measured.
type LevelReading =
  | {
      readonly kind: 'interval';
      readonly at: 'media' | 'container';
      readonly scope: string;
      readonly lower: Edge | undefined;
      readonly upper: Edge | undefined;
      readonly units: ReadonlySet<string>;
    }
  | { readonly kind: 'opaque' };

// Readings are cached by level text: the panel compares the same few queries for every
// rule on every resolve, and parsing them each time is the only cost here. Bounded; a
// full cache starts over (local, owned mutation).
const levelReadings = new Map<string, LevelReading>();

// Containment uses the browser default root size for media `rem`, the size every
// other reader in the panel uses (useEditorContexts ROOT_FONT_SIZE_PX).
const CONTAINMENT_ROOT_FONT_SIZE_PX = 16;

function levelImplies(viewLevel: string, ruleLevel: string): boolean {
  if (viewLevel === ruleLevel) {
    return true;
  }
  const view = readLevel(viewLevel);
  const rule = readLevel(ruleLevel);
  if (view.kind === 'opaque') {
    return false;
  }
  if (rule.kind === 'opaque') {
    return false;
  }
  if (view.at !== rule.at) {
    return false;
  }
  if (view.at === 'media') {
    if (rule.scope !== 'all' && rule.scope !== view.scope) {
      return false;
    }
  } else {
    if (rule.scope !== view.scope) {
      return false;
    }
    if (new Set([...view.units, ...rule.units]).size > 1) {
      return false;
    }
  }
  if (intervalEmpty(view.lower, view.upper)) {
    return false;
  }
  return lowerHolds(view.lower, rule.lower) && upperHolds(view.upper, rule.upper);
}

// Whether every width above the view's lower edge is above the rule's too.
function lowerHolds(view: Edge | undefined, rule: Edge | undefined): boolean {
  if (rule === undefined) {
    return true;
  }
  if (view === undefined) {
    return false;
  }
  if (view.px === rule.px) {
    return rule.inclusive || !view.inclusive;
  }
  return view.px > rule.px;
}

// Whether every width below the view's upper edge is below the rule's too.
function upperHolds(view: Edge | undefined, rule: Edge | undefined): boolean {
  if (rule === undefined) {
    return true;
  }
  if (view === undefined) {
    return false;
  }
  if (view.px === rule.px) {
    return rule.inclusive || !view.inclusive;
  }
  return view.px < rule.px;
}

function intervalEmpty(lower: Edge | undefined, upper: Edge | undefined): boolean {
  if (lower === undefined || upper === undefined) {
    return false;
  }
  if (lower.px === upper.px) {
    return !(lower.inclusive && upper.inclusive);
  }
  return lower.px > upper.px;
}

function readLevel(level: string): LevelReading {
  const cached = levelReadings.get(level);
  if (cached !== undefined) {
    return cached;
  }
  const reading = readLevelUncached(level);
  if (levelReadings.size >= QUERY_WIDTH_LIMITS.levelReadingsMax) {
    levelReadings.clear();
  }
  levelReadings.set(level, reading);
  assert(levelReadings.size <= QUERY_WIDTH_LIMITS.levelReadingsMax, 'readLevel: the cache is bounded');
  return reading;
}

function readLevelUncached(level: string): LevelReading {
  const opaque: LevelReading = { kind: 'opaque' };
  const text = level.trim().toLowerCase();
  if (text.length > QUERY_WIDTH_LIMITS.queryCharsMax) {
    return opaque;
  }
  const media = /^@media\s+(?:(?:only\s+)?(all|screen)\s+and\s+)?(\([\s\S]*)$/.exec(text);
  if (media !== null) {
    return intervalOf('media', media[1] ?? 'all', (media[2] ?? '').trim());
  }
  const container = /^@container\s+(?:([a-z_-][\w-]*)\s+)?(\([\s\S]*)$/.exec(text);
  if (container !== null) {
    const name = container[1] ?? '';
    if (['and', 'or', 'not', 'none'].includes(name)) {
      return opaque;
    }
    return intervalOf('container', name, (container[2] ?? '').trim());
  }
  return opaque;
}

function intervalOf(at: 'media' | 'container', scope: string, conditions: string): LevelReading {
  const bounds = boundsOf(conditions, CONTAINMENT_ROOT_FONT_SIZE_PX);
  if (!Array.isArray(bounds)) {
    return { kind: 'opaque' };
  }
  assert(bounds.length > 0, 'intervalOf: a read query has at least one bound');
  let lower: Edge | undefined;
  let upper: Edge | undefined;
  for (const bound of bounds) {
    const edge = { px: bound.px, inclusive: bound.inclusive };
    if (bound.side === 'lower') {
      lower = tighterLower(lower, edge);
    } else {
      upper = tighterUpper(upper, edge);
    }
  }
  const units = new Set([...conditions.matchAll(/\d(px|rem)\b/g)].map((match) => match[1] ?? ''));
  return { kind: 'interval', at, scope, lower, upper, units };
}

function tighterLower(held: Edge | undefined, next: Edge): Edge {
  if (held === undefined || next.px > held.px) {
    return next;
  }
  if (next.px === held.px && !next.inclusive) {
    return next;
  }
  return held;
}

function tighterUpper(held: Edge | undefined, next: Edge): Edge {
  if (held === undefined || next.px < held.px) {
    return next;
  }
  if (next.px === held.px && !next.inclusive) {
    return next;
  }
  return held;
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
