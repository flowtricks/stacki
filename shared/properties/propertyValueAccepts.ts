// Which computed values a CSS property accepts, so a variable picker can offer
// only the variables that would work in the field being edited. The Weight
// field lists CSS variables; a `--border-width: 0.0625rem` in it would be
// written as `font-weight: var(--border-width)`, which the browser drops.
//
// Read-only by design: nothing here edits a stylesheet. A variable is judged by
// what its declared value computes to after `var()` references are followed,
// and a value that cannot be computed statically (`clamp()`, `calc()`, `env()`,
// `attr()`, a missing variable, a cycle) is not offered. A property with no
// predicate here is not filtered, so adding one never changes another picker.

import { assert } from '../core/assert';

export const VALUE_ACCEPTS_LIMITS = {
  /** Variable hops followed before giving up: a chain this long is a cycle, not a design. */
  depthMax: 8,
  /** `var()` references replaced in one value. */
  substitutionsMax: 64,
  /** A declared value longer than this is not a font weight or a variable chain. */
  valueCharsMax: 4_096,
} as const;

/** Finds the declared value of a custom property by its name without the `--`, or undefined when it is not declared. */
export type VariableLookup = (name: string) => string | undefined;

/** True when `computed` is a value the property accepts. */
export type ValuePredicate = (computed: string) => boolean;

const FONT_WEIGHT_KEYWORDS: ReadonlySet<string> = new Set(['normal', 'bold', 'bolder', 'lighter']);
const FONT_WEIGHT_MIN = 1;
const FONT_WEIGHT_MAX = 1000;
// The Weight picker's own floor: CSS accepts 1 to 1000, but a project's plain numbers
// below 100 (spacing steps, text sizes, `--viewport-min`) are never weights anyone
// means, and offering them buried the real ones. The user's rule is 100 to 1000.
const FONT_WEIGHT_OFFERED_MIN = 100;
// ...and only the steps a weight scale is built from: 100, 150, 200 ... 1000. A project's
// 143, 256 or 274 (fluid-size maxima, offsets) are numbers, not weights.
const FONT_WEIGHT_OFFERED_STEP = 50;
// A CSS number: optional sign, digits with an optional fraction, optional exponent. Units are not numbers.
const CSS_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Is `computed` a valid `font-weight`: normal, bold, bolder or lighter, or a
 * number from 1 to 1000 inclusive (CSS Fonts 4 allows fractions). The global
 * keywords are not weights a variable can hold, so they are refused.
 */
export function isValidFontWeight(computed: string): boolean {
  return acceptsFontWeight(computed, FONT_WEIGHT_MIN);
}

/**
 * Is `computed` a font weight the Weight picker offers: the same keywords, and
 * a multiple of 50 from 100 to 1000 inclusive. Narrower than CSS on purpose (see
 * FONT_WEIGHT_OFFERED_MIN); a fraction below 100 such as 1.5 is hidden.
 */
export function isOfferedFontWeight(computed: string): boolean {
  const accepted = acceptsFontWeight(computed, FONT_WEIGHT_OFFERED_MIN);
  if (accepted === false || FONT_WEIGHT_KEYWORDS.has(computed.trim().toLowerCase())) {
    return accepted;
  }
  // The number is parsed, so `4e2` and `400.0` normalise to 400 and pass; 400.5 does not.
  return Number(computed.trim()) % FONT_WEIGHT_OFFERED_STEP === 0;
}

function acceptsFontWeight(computed: string, weightMin: number): boolean {
  const trimmed = computed.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }
  if (FONT_WEIGHT_KEYWORDS.has(trimmed)) {
    return true;
  }
  if (CSS_NUMBER.test(trimmed)) {
    const weight = Number(trimmed);
    return weight >= weightMin && weight <= FONT_WEIGHT_MAX;
  }
  return false;
}

// Keywords that belong to other properties or are CSS-wide, so a variable holding one is a
// text-transform, a text-wrap, a colour or the like, never a family list. Matched on an
// unquoted single-word item; a quoted "Normal" is a family name and passes.
const NON_FONT_KEYWORDS: ReadonlySet<string> = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
  'none',
  'normal',
  'auto',
  'balance',
  'pretty',
  'stable',
  'nowrap',
  'wrap',
  'wrap-reverse',
  'break-word',
  'break-spaces',
  'pre',
  'pre-wrap',
  'uppercase',
  'lowercase',
  'capitalize',
  'left',
  'right',
  'center',
  'justify',
  'start',
  'end',
  'top',
  'bottom',
  'middle',
  'bold',
  'bolder',
  'lighter',
  'italic',
  'oblique',
  'underline',
  'overline',
  'line-through',
  'hidden',
  'visible',
  'block',
  'inline',
  'flex',
  'grid',
  'static',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'solid',
  'dashed',
  'dotted',
  'double',
  'ltr',
  'rtl',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'transparent',
  'currentcolor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'brown',
]);
const FONT_FAMILY_ITEMS_MAX = 32;
const QUOTED_FAMILY = /^(?:"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')$/;
const IDENTIFIER = /^-?[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF-]*$/;

/**
 * Is `computed` a `font-family` value: a comma-separated list whose items are
 * each a quoted name, a generic family, or unquoted identifiers (`Helvetica
 * Neue`). A lone keyword of another property (`none`, `balance`, `uppercase`),
 * a CSS-wide keyword, a number, length, function, colour or leftover `var()` is not.
 */
export function isValidFontFamily(computed: string): boolean {
  const items = splitTopLevel(computed.trim());
  if (items === undefined || items.length === 0 || items.length > FONT_FAMILY_ITEMS_MAX) {
    return false;
  }
  return items.every(isFamilyItem);
}

function isFamilyItem(item: string): boolean {
  if (item.length === 0) {
    return false;
  }
  if (QUOTED_FAMILY.test(item)) {
    return true;
  }
  const words = item.split(/\s+/);
  if (!words.every((word) => IDENTIFIER.test(word))) {
    return false;
  }
  // A single unquoted word that is another property's keyword is not a family.
  return words.length > 1 || !NON_FONT_KEYWORDS.has(item.toLowerCase());
}

// The items between top-level commas, ignoring commas inside quotes; undefined for an unbalanced quote.
function splitTopLevel(text: string): string[] | undefined {
  const items: string[] = [];
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quote !== '') {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ',') {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== '') {
    return undefined;
  }
  items.push(text.slice(start).trim());
  return items;
}

// Line height as a multiplier: a unitless number from 0 to 3. Lengths and percentages
// are other kinds of line height and `normal` is not a number; the Line height picker
// offers only the multipliers a type scale is built from.
const LINE_HEIGHT_MAX = 3;
const LINE_HEIGHT_MIN = 0;

/** Is `computed` a unitless number from 0 through 3, such as `1.5`? */
export function isLineHeightMultiplier(computed: string): boolean {
  const trimmed = computed.trim();
  if (CSS_NUMBER.test(trimmed)) {
    const multiplier = Number(trimmed);
    return multiplier >= LINE_HEIGHT_MIN && multiplier <= LINE_HEIGHT_MAX;
  }
  return false;
}

// Letter spacing as a small length: `0`, or a number of em or rem from -1 to 1. Other units
// (px, %, vh), plain numbers, `normal` and the CSS-wide keywords are not offered, and a
// calc() or clamp() has no static value here, so it is hidden too.
const LETTER_SPACING_EXTENT_MAX = 1;
const LETTER_SPACING_LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(em|rem)$/i;

/** Is `computed` `0`, or an em or rem length from -1 to 1 inclusive? */
export function isLetterSpacingLength(computed: string): boolean {
  const trimmed = computed.trim();
  if (CSS_NUMBER.test(trimmed)) {
    return Number(trimmed) === 0;
  }
  const match = LETTER_SPACING_LENGTH.exec(trimmed);
  const amount = match?.[1];
  if (amount === undefined) {
    return false;
  }
  return Math.abs(Number(amount)) <= LETTER_SPACING_EXTENT_MAX;
}

const CSS_WIDE_KEYWORDS: ReadonlySet<string> = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const TEXT_TRANSFORM_CASES: ReadonlySet<string> = new Set(['capitalize', 'uppercase', 'lowercase']);
const TEXT_TRANSFORM_WIDTHS: ReadonlySet<string> = new Set(['full-width', 'full-size-kana']);

/**
 * Is `computed` a `text-transform` value: `none`; one case keyword
 * (capitalize, uppercase, lowercase), optionally with full-width and/or
 * full-size-kana in any order; or a CSS-wide keyword alone. The CSS-wide keywords
 * are offered here, unlike for the Weight picker, because the user wants
 * `unset` and `inherit` as choices. `math-auto` is not widely supported, so it is refused.
 */
export function isValidTextTransform(computed: string): boolean {
  const tokens = computed.trim().toLowerCase().split(/\s+/);
  const first = tokens[0];
  if (first === undefined || first === '' || tokens.length > 3) {
    return false;
  }
  if (tokens.length === 1) {
    return first === 'none' || CSS_WIDE_KEYWORDS.has(first) || TEXT_TRANSFORM_CASES.has(first) || TEXT_TRANSFORM_WIDTHS.has(first);
  }
  if (new Set(tokens).size !== tokens.length) {
    return false;
  }
  const cases = tokens.filter((token) => TEXT_TRANSFORM_CASES.has(token));
  const widths = tokens.filter((token) => TEXT_TRANSFORM_WIDTHS.has(token));
  return cases.length <= 1 && cases.length + widths.length === tokens.length;
}

// One entry per property: its name and the predicate its variable picker applies. A
// property that is not listed is not filtered. To filter another picker (text-wrap,
// letter-spacing), add one line here and a predicate above.
const PROPERTY_PREDICATES: ReadonlyMap<string, ValuePredicate> = new Map([
  ['font-family', isValidFontFamily],
  ['font-weight', isOfferedFontWeight],
  ['letter-spacing', isLetterSpacingLength],
  ['line-height', isLineHeightMultiplier],
  ['text-transform', isValidTextTransform],
]);

/** The predicate for `property`, or undefined when its picker offers every variable. */
export function valuePredicateFor(property: string | undefined): ValuePredicate | undefined {
  if (property === undefined) {
    return undefined;
  }
  return PROPERTY_PREDICATES.get(property.trim().toLowerCase());
}

/**
 * `value` with every `var(--name, fallback)` replaced by what it computes to,
 * or undefined when one cannot be: an undeclared name without a fallback, a
 * cycle, or a chain past the depth bound.
 */
export function resolveVariableValue(value: string, lookup: VariableLookup): string | undefined {
  return substitute(value, lookup, []);
}

/** Does the variable declared as `declaredValue` compute to a value `predicate` accepts? */
export function variableAccepted(declaredValue: string, lookup: VariableLookup, predicate: ValuePredicate): boolean {
  const computed = resolveVariableValue(declaredValue, lookup);
  if (computed === undefined) {
    return false;
  }
  return predicate(computed);
}

function substitute(value: string, lookup: VariableLookup, chain: readonly string[]): string | undefined {
  assert(chain.length <= VALUE_ACCEPTS_LIMITS.depthMax + 1, 'substitute: the chain stays within the depth bound');
  if (chain.length > VALUE_ACCEPTS_LIMITS.depthMax) {
    return undefined;
  }
  if (value.length > VALUE_ACCEPTS_LIMITS.valueCharsMax) {
    return undefined;
  }
  let result = value;
  for (let count = 0; count <= VALUE_ACCEPTS_LIMITS.substitutionsMax; count += 1) {
    const reference = findReference(result);
    if (reference === undefined) {
      return result;
    }
    if (reference.malformed) {
      return undefined;
    }
    const resolved = referenceValue(reference, lookup, chain);
    if (resolved === undefined) {
      return undefined;
    }
    result = result.slice(0, reference.start) + resolved + result.slice(reference.end);
  }
  return undefined;
}

function referenceValue(reference: Reference, lookup: VariableLookup, chain: readonly string[]): string | undefined {
  if (chain.includes(reference.name)) {
    return undefined;
  }
  const declared = lookup(reference.name);
  if (declared !== undefined) {
    return substitute(declared, lookup, [...chain, reference.name]);
  }
  if (reference.fallback === undefined) {
    return undefined;
  }
  return substitute(reference.fallback, lookup, [...chain, reference.name]);
}

interface Reference {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly fallback: string | undefined;
  readonly malformed: boolean;
}

// The first `var(...)` in `text`, found by matching parentheses so a fallback
// holding its own function (`var(--a, calc(1 + 2))`) ends at the right `)`.
function findReference(text: string): Reference | undefined {
  const start = text.search(/var\(/i);
  if (start < 0) {
    return undefined;
  }
  const innerStart = start + 4;
  let depth = 1;
  let comma = -1;
  let end = -1;
  for (let index = innerStart; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    } else if (character === ',' && depth === 1 && comma < 0) {
      comma = index;
    }
  }
  if (end < 0) {
    return { start, end: text.length, name: '', fallback: undefined, malformed: true };
  }
  const nameEnd = comma < 0 ? end - 1 : comma;
  const rawName = text.slice(innerStart, nameEnd).trim();
  const fallback = comma < 0 ? undefined : text.slice(comma + 1, end - 1).trim();
  if (/^--[A-Za-z0-9_-]+$/.test(rawName)) {
    return { start, end, name: rawName.slice(2), fallback, malformed: false };
  }
  return { start, end, name: '', fallback: undefined, malformed: true };
}
