// Finding and rewriting the width bounds of `@media` queries that equal a breakpoint (Settings > Breakpoints > sync).
//
// When a breakpoint changes from `64rem` to `70rem`, every `@media` condition whose boundary is the OLD value should move with
// it: `(width >= 64rem)`, `(width < 64rem)`, `(64rem <= width)`, `(48rem < width <= 64rem)` (each bound on its own),
// `(min-width: 64rem)`, `(max-width: 64rem)`, inside `only screen and`, `and` and comma lists, in any case and spacing.
//
// This is a small hand-written tokenizer, bounded everywhere, and never a regular expression over the whole text. It reads only
// `@media` preludes (comments and strings are skipped, so `/* @media (width >= 64rem) */` and `content: "@media …"` are not
// preludes) and only `width`, `min-width` and `max-width` with a `px` or `rem` number. `height`, `min-height`, `prefers-*`,
// `em`, `vw`, `calc()` and every other feature are not bounds and are never touched. A bound is replaced by its number and unit
// token alone: the selector, the scope, the other conditions, the spacing and the line endings stay as written, byte for byte.
//
// What counts as a match (`classifyBound`), with the boundary in pixels (1rem = 16px, the root the canvas reads rem at):
//   exact      the bound equals the old boundary in either unit (64rem and 1024px are the same boundary).
//   exclusive  for a breakpoint that is `width >= X` (up): `(width > X)` or `(X < width)`, which starts a pixel later than the
//              breakpoint does. It is the same boundary written another way, offered but never checked, and rewritten as it is.
//   inclusive  the bound is 1px short of it in the form that includes its own edge: `(max-width: 1023px)`, `(width <= 1023px)`,
//              `(width > 1023px)`, `63.9375rem`. This is how a boundary written as the old canvas width reads, so it may be a
//              different intent: it is offered, but never checked for the person.
//
// A bound's locator names it without its number or its line, so a record of it survives the number changing and lines moving:
// the prelude with the bound masked, hashed, plus which of the identical preludes in the file's CSS section it is.
import { assert } from '../core/assert';
import { BREAKPOINT_LIMITS, boundaryPx, type Breakpoint, type BreakpointSetting } from './projectBreakpoints';

export const MEDIA_SYNC_LIMITS = {
  /** CSS text read per section: a stylesheet this large is not hand-written. */
  textCharsMax: 4 * 1024 * 1024,
  /** `@media` rules read per section. */
  mediaRulesMax: 20_000,
  /** Tokens read in one prelude. */
  preludeTokensMax: 256,
  /** Characters of the prelude shown beside a replacement. */
  previewCharsMax: 96,
  /** Decimal places a rem number is written with (a 1px step is 0.0625rem). */
  remDecimalsMax: 4,
} as const satisfies Record<string, number>;

/** How the CSS is written: SCSS reads `//` as a comment. */
export interface CssSyntax {
  readonly lineComments: boolean;
}

export type BoundSide = 'upper' | 'lower';
export type BoundMatch = 'exact' | 'inclusive' | 'exclusive';

/** One width bound in a `@media` prelude: where its number and unit sit, and how it bounds the width. */
export interface WidthBound {
  /** Offsets of the number+unit token in the text read. */
  readonly start: number;
  readonly end: number;
  readonly value: number;
  readonly unit: 'px' | 'rem';
  /** `upper` limits the width from above (`width < X`, `max-width`); `lower` from below. */
  readonly side: BoundSide;
  /** The width may equal the bound (`<=`, `>=`, `min-width`, `max-width`). */
  readonly inclusive: boolean;
  /** The prelude's text range (after `@media`, up to the block). */
  readonly preludeStart: number;
  readonly preludeEnd: number;
  /** The name of the bound: the masked prelude, hashed, and the position among the identical ones. */
  readonly locator: string;
}

interface Token {
  readonly kind: 'open' | 'close' | 'comma' | 'colon' | 'operator' | 'ident' | 'dimension' | 'other';
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly value?: number;
  readonly unit?: string;
}

/** The width bounds of every `@media` prelude in `css`. `lineComments` reads `//` as a comment (SCSS). */
export function findWidthBounds(css: string, options: CssSyntax): readonly WidthBound[] {
  assert(css.length <= MEDIA_SYNC_LIMITS.textCharsMax, 'findWidthBounds: the text is within the bound');
  const bounds: WidthBound[] = [];
  const seen = new Map<string, number>();
  let rules = 0;
  let index = 0;
  while (index < css.length) {
    const skipped = skipNonCode(css, index, options);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (css[index] === '@' && isMediaKeyword(css, index)) {
      rules += 1;
      if (rules > MEDIA_SYNC_LIMITS.mediaRulesMax) {
        break;
      }
      const preludeStart = index + '@media'.length;
      const preludeEnd = preludeEndFrom(css, preludeStart, options);
      collectBounds(css, preludeStart, preludeEnd, options, seen, bounds);
      index = preludeEnd;
      continue;
    }
    index += 1;
  }
  return bounds;
}

/** How a bound relates to a breakpoint's old value, or undefined when it is unrelated. */
export function classifyBound(
  bound: Pick<WidthBound, 'value' | 'unit' | 'side' | 'inclusive'>,
  old: Pick<Breakpoint, 'direction' | 'setting'>,
): BoundMatch | undefined {
  const boundPx = bound.unit === 'rem' ? bound.value * BREAKPOINT_LIMITS.remPx : bound.value;
  const oldPx = boundaryPx(old.setting);
  if (near(boundPx, oldPx)) {
    return old.direction === 'up' && bound.side === 'lower' && !bound.inclusive ? 'exclusive' : 'exact';
  }
  const inclusiveForm = (bound.side === 'upper' && bound.inclusive) || (bound.side === 'lower' && !bound.inclusive);
  if (inclusiveForm && near(boundPx, oldPx - 1)) {
    return 'inclusive';
  }
  return undefined;
}

/**
 * The text that replaces a matched bound's number and unit. An exact match takes the new breakpoint as typed (`70rem`, or
 * `1100px`); an inclusive one takes the new boundary minus 1px, in px for a px bound and in rem otherwise. A Lumos project
 * (`rem` only) is always written in rem, a px value converted at 16px per rem.
 */
export function replacementText(match: BoundMatch, bound: Pick<WidthBound, 'unit'>, next: BreakpointSetting, options: { readonly lumos: boolean }): string {
  const nextPx = boundaryPx(next);
  assert(nextPx > 0, 'replacementText: the new boundary is positive');
  if (match === 'exact' || match === 'exclusive') {
    if (next.unit === 'rem') {
      return `${formatNumber(next.value)}rem`;
    }
    return options.lumos ? `${formatNumber(nextPx / BREAKPOINT_LIMITS.remPx)}rem` : `${formatNumber(next.value)}px`;
  }
  const targetPx = nextPx - 1;
  if (bound.unit === 'px' && !options.lumos) {
    return `${formatNumber(targetPx)}px`;
  }
  return `${formatNumber(targetPx / BREAKPOINT_LIMITS.remPx)}rem`;
}

/** A number written without trailing zeros, at most four decimals: `70`, `62.5`, `63.9375`. */
export function formatNumber(value: number): string {
  assert(Number.isFinite(value), 'formatNumber: a finite number');
  const fixed = value.toFixed(MEDIA_SYNC_LIMITS.remDecimalsMax);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** One replacement: the range of text to replace and what it becomes. */
export interface TextReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * `text` with the replacements applied. They must not overlap; everything between them is copied untouched, which is what
 * keeps CRLF, tabs and minified lines exactly as written.
 */
export function applyReplacements(text: string, replacements: readonly TextReplacement[]): string {
  const ordered = [...replacements].sort((first, second) => first.start - second.start);
  let cursor = 0;
  let result = '';
  for (const replacement of ordered) {
    assert(replacement.start >= cursor, 'applyReplacements: replacements do not overlap');
    assert(replacement.end >= replacement.start, 'applyReplacements: a replacement is a forward range');
    assert(replacement.end <= text.length, 'applyReplacements: a replacement is inside the text');
    result += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return result + text.slice(cursor);
}

/** The prelude around a bound with the bound's token shown as `before`, clipped to a few dozen characters, for the dialog. */
export function previewAround(css: string, bound: WidthBound, token: string): string {
  const head = css.slice(bound.preludeStart, bound.start);
  const tail = css.slice(bound.end, bound.preludeEnd);
  const flat = (part: string): string => part.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const left = flat(head).trimStart();
  const right = flat(tail).trimEnd();
  const half = Math.floor(MEDIA_SYNC_LIMITS.previewCharsMax / 2);
  const clippedLeft = left.length > half ? `…${left.slice(left.length - half)}` : left;
  const clippedRight = right.length > half ? `${right.slice(0, half)}…` : right;
  return `@media${clippedLeft.startsWith(' ') ? '' : ' '}${clippedLeft}${token}${clippedRight}`;
}

function near(first: number, second: number): boolean {
  return Math.abs(first - second) < 1e-6;
}

function isMediaKeyword(css: string, at: number): boolean {
  if (css.slice(at, at + 6).toLowerCase() !== '@media') {
    return false;
  }
  const after = css[at + 6];
  return after === undefined || !/[A-Za-z0-9_-]/.test(after);
}

// Comments and strings are not code. Returns the index after one, or `index` when none starts here.
function skipNonCode(css: string, index: number, syntax: CssSyntax): number {
  const char = css[index];
  const next = css[index + 1];
  if (char === '/' && next === '*') {
    const close = css.indexOf('*/', index + 2);
    return close === -1 ? css.length : close + 2;
  }
  if (syntax.lineComments && char === '/' && next === '/') {
    const close = css.indexOf('\n', index + 2);
    return close === -1 ? css.length : close;
  }
  if (char === '"' || char === "'") {
    return skipString(css, index);
  }
  return index;
}

function skipString(css: string, index: number): number {
  const quote = css[index];
  let cursor = index + 1;
  while (cursor < css.length) {
    const char = css[cursor];
    if (char === '\\') {
      cursor += 2;
    } else if (char === quote) {
      return cursor + 1;
    } else if (char === '\n') {
      return cursor;
    } else {
      cursor += 1;
    }
  }
  return css.length;
}

// A prelude ends at the `{` that opens its block, or at a `;` (a statement at-rule). Parentheses nest.
function preludeEndFrom(css: string, from: number, syntax: CssSyntax): number {
  let depth = 0;
  let index = from;
  while (index < css.length) {
    const skipped = skipNonCode(css, index, syntax);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const char = css[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && (char === '{' || char === ';')) {
      return index;
    }
    index += 1;
  }
  return css.length;
}

function tokenize(css: string, from: number, to: number, syntax: CssSyntax): readonly Token[] {
  const tokens: Token[] = [];
  let index = from;
  while (index < to && tokens.length < MEDIA_SYNC_LIMITS.preludeTokensMax) {
    const char = css[index] ?? '';
    const skipped = skipNonCode(css, index, syntax);
    if (skipped > index) {
      index = Math.min(skipped, to);
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '(') {
      tokens.push({ kind: 'open', start: index, end: index + 1, text: char });
      index += 1;
    } else if (char === ')') {
      tokens.push({ kind: 'close', start: index, end: index + 1, text: char });
      index += 1;
    } else if (char === ',') {
      tokens.push({ kind: 'comma', start: index, end: index + 1, text: char });
      index += 1;
    } else if (char === ':') {
      tokens.push({ kind: 'colon', start: index, end: index + 1, text: char });
      index += 1;
    } else if (char === '<' || char === '>' || char === '=') {
      const length = css[index + 1] === '=' && char !== '=' ? 2 : 1;
      tokens.push({ kind: 'operator', start: index, end: index + length, text: css.slice(index, index + length) });
      index += length;
    } else if (isDigit(char) || (char === '.' && isDigit(css[index + 1] ?? ''))) {
      const token = readDimension(css, index, to);
      tokens.push(token);
      index = token.end;
    } else {
      let end = index + 1;
      while (end < to && !/[\s(),:<>=/'"]/.test(css[end] ?? ' ')) {
        end += 1;
      }
      const text = css.slice(index, end);
      tokens.push({ kind: /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(text) ? 'ident' : 'other', start: index, end, text });
      index = end;
    }
  }
  return tokens;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function readDimension(css: string, from: number, to: number): Token {
  let index = from;
  while (index < to && isDigit(css[index] ?? '')) {
    index += 1;
  }
  if (css[index] === '.') {
    index += 1;
    while (index < to && isDigit(css[index] ?? '')) {
      index += 1;
    }
  }
  const numberEnd = index;
  while (index < to && /[A-Za-z%]/.test(css[index] ?? '')) {
    index += 1;
  }
  const number = Number(css.slice(from, numberEnd));
  const unit = css.slice(numberEnd, index).toLowerCase();
  if (!Number.isFinite(number) || number <= 0 || (unit !== 'px' && unit !== 'rem')) {
    return { kind: 'other', start: from, end: Math.max(index, from + 1), text: css.slice(from, Math.max(index, from + 1)) };
  }
  return { kind: 'dimension', start: from, end: index, text: css.slice(from, index), value: number, unit };
}

// The innermost parenthesised groups of a prelude: `(min-width: 64rem)`, `(width >= 64rem)`, `(48rem < width <= 64rem)`.
function collectBounds(css: string, preludeStart: number, preludeEnd: number, syntax: CssSyntax, seen: Map<string, number>, bounds: WidthBound[]): void {
  const tokens = tokenize(css, preludeStart, preludeEnd, syntax);
  let open = -1;
  for (const [position, token] of tokens.entries()) {
    if (token.kind === 'open') {
      open = position;
    } else if (token.kind === 'close' && open !== -1) {
      const group = tokens.slice(open + 1, position);
      for (const found of boundsOfGroup(group)) {
        bounds.push(located(css, preludeStart, preludeEnd, syntax, found, seen));
      }
      open = -1;
    }
  }
}

interface RawBound {
  readonly token: Token;
  readonly side: BoundSide;
  readonly inclusive: boolean;
}

function boundsOfGroup(group: readonly Token[]): readonly RawBound[] {
  const found: RawBound[] = [];
  const [first, second, third] = group;
  if (group.length === 3 && first?.kind === 'ident' && second?.kind === 'colon' && third?.kind === 'dimension') {
    const name = first.text.toLowerCase();
    if (name === 'min-width') {
      found.push({ token: third, side: 'lower', inclusive: true });
    } else if (name === 'max-width') {
      found.push({ token: third, side: 'upper', inclusive: true });
    }
    return found;
  }
  const widthAt = group.findIndex((token) => token.kind === 'ident' && token.text.toLowerCase() === 'width');
  if (widthAt === -1) {
    return found;
  }
  const rightOperator = group[widthAt + 1];
  const rightValue = group[widthAt + 2];
  if (rightOperator?.kind === 'operator' && rightValue?.kind === 'dimension') {
    const side = sideOf(rightOperator.text, 'right');
    if (side !== undefined) {
      found.push({ token: rightValue, ...side });
    }
  }
  const leftOperator = group[widthAt - 1];
  const leftValue = group[widthAt - 2];
  if (leftOperator?.kind === 'operator' && leftValue?.kind === 'dimension') {
    const side = sideOf(leftOperator.text, 'left');
    if (side !== undefined) {
      found.push({ token: leftValue, ...side });
    }
  }
  return found;
}

// `width < X` and `X > width` bound the width from above; `width > X` and `X < width` from below. `=` is no bound.
function sideOf(operator: string, placement: 'left' | 'right'): { readonly side: BoundSide; readonly inclusive: boolean } | undefined {
  if (operator !== '<' && operator !== '<=' && operator !== '>' && operator !== '>=') {
    return undefined;
  }
  const less = operator.startsWith('<');
  const inclusive = operator.endsWith('=');
  const upper = placement === 'right' ? less : !less;
  return { side: upper ? 'upper' : 'lower', inclusive };
}

function located(css: string, preludeStart: number, preludeEnd: number, syntax: CssSyntax, raw: RawBound, seen: Map<string, number>): WidthBound {
  const masked = maskedPrelude(css, preludeStart, preludeEnd, raw.token, syntax);
  const hash = hashText(masked);
  const ordinal = seen.get(`${hash}`) ?? 0;
  seen.set(`${hash}`, ordinal + 1);
  assert(raw.token.value !== undefined, 'located: a dimension token carries its number');
  assert(raw.token.unit === 'px' || raw.token.unit === 'rem', 'located: a dimension token carries px or rem');
  return {
    start: raw.token.start,
    end: raw.token.end,
    value: raw.token.value,
    unit: raw.token.unit,
    side: raw.side,
    inclusive: raw.inclusive,
    preludeStart,
    preludeEnd,
    locator: `${hash}:${ordinal}`,
  };
}

// The prelude without comments, lower-cased, spaces collapsed and dropped around punctuation, with the bound's token replaced by `@`.
function maskedPrelude(css: string, from: number, to: number, token: Token, syntax: CssSyntax): string {
  let text = '';
  let index = from;
  while (index < to) {
    if (index === token.start) {
      text += '@';
      index = token.end;
      continue;
    }
    const skipped = skipNonCode(css, index, syntax);
    if (skipped > index && css[index] !== '"' && css[index] !== "'") {
      text += ' ';
      index = Math.min(skipped, to);
      continue;
    }
    text += css[index] ?? '';
    index += 1;
  }
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?([(),:<>=]) ?/g, '$1')
    .trim();
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
