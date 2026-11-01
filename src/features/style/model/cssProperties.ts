import { all } from 'known-css-properties';

// `known-css-properties` also lists @-rule descriptors (@font-face / @counter-style /
// @property / @font-palette-values) and dead IE-isms that aren't element properties —
// drop them so the list doesn't open on junk like `accelerator` / `additive-symbols`.
const NON_PROPERTIES = new Set([
  'accelerator',
  'additive-symbols',
  'alt',
  'ascent-override',
  'base-palette',
  'behavior',
  'descent-override',
  'fallback',
  'font-display',
  'inherits',
  'initial-value',
  'line-gap-override',
  'negative',
  'override-colors',
  'pad',
  'prefix',
  'range',
  'size-adjust',
  'speak-as',
  'src',
  'suffix',
  'symbols',
  'syntax',
  'system',
  'unicode-range',
]);

// Every standard CSS property (plus the still-widely-used `-webkit-` set) for the
// add-property autocomplete. Custom-property tokens (`--*`) and the other vendor
// prefixes (`-moz-`/`-ms-`/`-o-`/`-epub-`/`-internal-`/…) are dropped as noise — the
// standard property name already covers those. Sorted + de-duped once at load.
export const CSS_PROPERTIES: readonly string[] = Object.freeze(
  [...new Set(all.filter((prop) => !prop.startsWith('--') && !NON_PROPERTIES.has(prop) && (!prop.startsWith('-') || prop.startsWith('-webkit-'))))].sort(
    (left, right) => {
      // Standard properties first (a leading `-` otherwise sorts the 260+ `-webkit-` names
      // to the very top, burying accent-color/align-*); alphabetical within each group.
      const av = left.startsWith('-') ? 1 : 0;
      const bv = right.startsWith('-') ? 1 : 0;
      return av - bv || left.localeCompare(right);
    },
  ),
);

// Filter the property list for a typed query: prefix matches first (they're what you
// usually want), then substring matches, each keeping alphabetical order. An empty
// query returns the whole list so the field opens showing everything.
//
// `custom` is the project's own custom properties — `--brand-500` and the rest,
// which are properties too, and the ones a person typing `-` is most often
// reaching for. They are not in the standard list (nothing knows them but this
// project), so they are offered alongside it, and they lead once the query
// starts with a dash: `-webkit-align-content` is a fine suggestion for someone
// who typed `-webkit`, and a strange one for someone halfway through the name
// of a variable they wrote themselves.
export function filterCssProperties(query: string, custom: readonly string[] = []): readonly string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return custom.length ? [...custom, ...CSS_PROPERTIES] : CSS_PROPERTIES;
  }
  const dashed = normalized.startsWith('-');
  const prefix: string[] = [];
  const substring: string[] = [];
  const customPrefix: string[] = [];
  const customSubstring: string[] = [];
  for (const prop of custom) {
    const at = prop.toLowerCase().indexOf(normalized);
    if (at === 0) {
      customPrefix.push(prop);
    } else if (at > 0) {
      customSubstring.push(prop);
    }
  }
  for (const prop of CSS_PROPERTIES) {
    const at = prop.indexOf(normalized);
    if (at === 0) {
      prefix.push(prop);
    } else if (at > 0) {
      substring.push(prop);
    }
  }
  return dashed ? [...customPrefix, ...prefix, ...customSubstring, ...substring] : [...prefix, ...customPrefix, ...substring, ...customSubstring];
}

// ── Values a property cannot take ────────────────────────────────────────────

// Properties CSS itself refuses below zero. A negative one is not a small value:
// the browser drops the whole declaration, so the field goes on showing a number
// the page hasn't got — the one kind of wrong a style panel must not be, since
// everything else it shows is read back from what the page is really using.
//
// Only the two the panel has fields for. Plenty of other properties are
// non-negative too (widths, radii, blur), but each of those fields has its own
// keywords and its own reasons, and a list that guesses would eventually clamp
// something CSS was happy to take.
const NON_NEGATIVE = new Set([
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'grid-row-gap',
  'grid-column-gap',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-block-start',
  'padding-block-end',
  'padding-inline',
  'padding-inline-start',
  'padding-inline-end',
]);

/** Does this property refuse a negative value? */
export function isNonNegative(prop: string): boolean {
  return NON_NEGATIVE.has(prop.trim().toLowerCase());
}

// A negative length, where a value can begin: at the start, or after a space or
// comma. Anchored so it can't bite a hyphen inside something that only looks
// like one — a `-webkit-` prefix, a custom property's name.
const NEGATIVE_LENGTH = /(^|[\s,])-(?:\d+\.?\d*|\.\d+)[a-z%]*/gi;

/**
 * The value as the property can actually take it: a negative length becomes 0.
 *
 * Left alone when the value calls a function — `calc(100% - 2rem)`,
 * `var(--gap)`, `clamp(…)`. What those come out as isn't knowable from here, the
 * minus in a calc() is usually subtraction rather than a sign, and rewriting
 * someone's expression is worse than letting the browser judge it.
 */
export function clampNonNegative(prop: string, value: string): string {
  if (!isNonNegative(prop) || value.includes('(')) {
    return value;
  }
  return value.replace(NEGATIVE_LENGTH, (_match, lead: string) => `${lead}0`);
}
