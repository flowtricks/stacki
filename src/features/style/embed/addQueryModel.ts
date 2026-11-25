// What the Add query form offers and writes.
//
// The form is suggestion-first: the project's own breakpoints (`.stacki/breakpoints.json`, the
// resolved list) are listed with the exact condition each would write, in the order of the preview
// bar, and a Custom row takes any width the Settings editor would accept. The direction decides the
// operator and nothing else: Mobile first writes `width >= X`, Desktop first writes `width < X`,
// always with the breakpoint's own number and unit, so a Laptop (`< 64rem` as a breakpoint) offers
// `width >= 64rem` in Mobile first, which is what the person expects. The numbers are the shared
// resolver's (shared/properties/projectBreakpoints.ts): nothing here derives a boundary itself.
//
// The default direction is the project's convention, read from the queries it already has: the
// majority of its width queries, lower-bounded (`>=`) or upper-bounded (`<`), and Mobile first when
// there is no majority. A condition that already exists is listed as such, so no duplicate is made.
// Pure, so it is tested without React.

import { assert } from '../../../../shared/core/assert';
import type { Result } from '../../../../shared/core/result';
import { findWidthBounds, formatNumber } from '../../../../shared/properties/mediaBreakpointSync';
import {
  boundaryPx,
  formatBreakpoint,
  parseBreakpointEntry,
  type BreakpointSetting,
  type ResolvedBreakpoint,
} from '../../../../shared/properties/projectBreakpoints';
import type { LengthUnit } from '../../../../shared/properties/lengthUnit';
import { queryWidthSides } from '../model/queryWidth';

/** `up` writes `width >= X` (mobile first); `down` writes `width < X` (desktop first). */
export type QueryDirection = 'up' | 'down';

/** The most queries and suggestions weighed: a project lists a handful; the bound keeps the loops honest. */
export const ADD_QUERY_ENTRIES_MAX = 512;

const ROOT_FONT_SIZE_PX = 16;

/** The query written for a boundary: `@media (width >= 64rem)` or `@media (width < 64rem)`. */
export function queryFor(setting: BreakpointSetting, direction: QueryDirection): string {
  return `@media (width ${direction === 'up' ? '>=' : '<'} ${formatBreakpoint(setting)})`;
}

/** The condition alone, as shown beside a name: `width >= 64rem`. */
export function conditionFor(setting: BreakpointSetting, direction: QueryDirection): string {
  return `width ${direction === 'up' ? '>=' : '<'} ${formatBreakpoint(setting)}`;
}

/**
 * The convention of a project's existing queries (the at-rule chains of its contexts): `up` when
 * most of its width queries are lower-bounded, `down` when most are upper-bounded, and undefined
 * with no width query or an even split. Ranges and queries that are not about width do not vote.
 */
export function detectConvention(atContexts: readonly string[]): QueryDirection | undefined {
  assert(atContexts.length <= ADD_QUERY_ENTRIES_MAX, 'detectConvention: the context list is bounded');
  let up = 0;
  let down = 0;
  for (const atContext of atContexts) {
    const sides = queryWidthSides(atContext, ROOT_FONT_SIZE_PX);
    if (sides.kind !== 'sides') {
      continue;
    }
    if (sides.lower && !sides.upper) {
      up += 1;
    } else if (sides.upper && !sides.lower) {
      down += 1;
    }
  }
  if (up === down) {
    return undefined;
  }
  return up > down ? 'up' : 'down';
}

/** The direction the form opens on. */
export function defaultDirection(atContexts: readonly string[]): QueryDirection {
  return detectConvention(atContexts) ?? 'up';
}

/**
 * The key of the existing context whose query is exactly this boundary in this direction
 * (`width >= 64rem`, `min-width: 1024px` for `up`; `width < 64rem`, `max-width` is not the same
 * boundary and is not matched), or undefined. `contexts` pair each context key with its at-rule chain.
 */
export function existingQueryKey(
  contexts: readonly { readonly key: string; readonly embedAtContext?: string | undefined }[],
  setting: BreakpointSetting,
  direction: QueryDirection,
): string | undefined {
  assert(contexts.length <= ADD_QUERY_ENTRIES_MAX, 'existingQueryKey: the context list is bounded');
  const wanted = boundaryPx(setting);
  for (const context of contexts) {
    const atContext = context.embedAtContext ?? '';
    if (context.key === '' || atContext === '') {
      continue;
    }
    const innermost = (atContext.split(' › ').pop() ?? '').trim();
    const sides = queryWidthSides(atContext, ROOT_FONT_SIZE_PX);
    if (sides.kind !== 'sides') {
      continue;
    }
    const bounds = findWidthBounds(innermost, { lineComments: false });
    const only = bounds.length === 1 ? bounds[0] : undefined;
    if (only === undefined) {
      continue;
    }
    const wantedSide = direction === 'up' ? 'lower' : 'upper';
    const wantedInclusive = direction === 'up';
    if (only.side === wantedSide && only.inclusive === wantedInclusive && Math.abs(boundaryPx({ value: only.value, unit: only.unit }) - wanted) < 1e-6) {
      return context.key;
    }
  }
  return undefined;
}

/** One breakpoint as the form lists it. */
export interface BreakpointSuggestion {
  readonly breakpoint: ResolvedBreakpoint;
  /** What would be written: `@media (width >= 64rem)`. */
  readonly query: string;
  /** The condition shown beside the name: `width >= 64rem`. */
  readonly condition: string;
  /** The context key of the same query when it already exists, else undefined. */
  readonly existingKey: string | undefined;
}

/** The project's breakpoints for a direction, in the preview bar's order (the list's own), with what already exists marked. */
export function suggestionsFor(
  resolved: readonly ResolvedBreakpoint[],
  direction: QueryDirection,
  contexts: readonly { readonly key: string; readonly embedAtContext?: string | undefined }[],
): BreakpointSuggestion[] {
  assert(resolved.length <= ADD_QUERY_ENTRIES_MAX, 'suggestionsFor: the breakpoint list is bounded');
  return resolved.map((breakpoint) => ({
    breakpoint,
    query: queryFor(breakpoint.setting, direction),
    condition: conditionFor(breakpoint.setting, direction),
    existingKey: existingQueryKey(contexts, breakpoint.setting, direction),
  }));
}

/** What the Custom row's text means. */
export type CustomQuery =
  | { readonly kind: 'empty' }
  /** A full at-rule typed by hand (`@media (hover: hover)`, `@container …`): taken as written. */
  | { readonly kind: 'raw'; readonly query: string }
  | { readonly kind: 'invalid'; readonly code: 'syntax' | 'pxWhole' | 'range' }
  /** A width: the query to write, and whether the typed px was converted to rem for a rem-only project. */
  | {
      readonly kind: 'width';
      readonly query: string;
      readonly setting: BreakpointSetting;
      readonly converted: boolean;
      readonly existingKey: string | undefined;
    };

/**
 * Reads the Custom row. A width takes the Settings editor's rules (`parseBreakpointEntry`: positive,
 * bounded, px whole, rem to four decimals; a bare number is px); a project that writes rem only
 * (Lumos) gets a typed px converted at its root font size, which the preview says. Text starting
 * with `@` is a hand-written at-rule, kept as the old field allowed.
 */
export function parseCustom(
  text: string,
  options: {
    readonly direction: QueryDirection;
    readonly lengthUnit: LengthUnit;
    readonly contexts: readonly { readonly key: string; readonly embedAtContext?: string | undefined }[];
  },
): CustomQuery {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '@') {
    return { kind: 'empty' };
  }
  if (trimmed.startsWith('@')) {
    return { kind: 'raw', query: trimmed };
  }
  const parsed: Result<BreakpointSetting> = parseBreakpointEntry(trimmed);
  if (!parsed.ok) {
    const code = parsed.error.code;
    // The shared parser's codes are `breakpoints-<reason>`.
    return { kind: 'invalid', code: code === 'breakpoints-pxWhole' ? 'pxWhole' : code === 'breakpoints-range' ? 'range' : 'syntax' };
  }
  const typed = parsed.value;
  let setting = typed;
  let converted = false;
  if (options.lengthUnit.kind === 'rem' && typed.unit === 'px') {
    // At most four decimals, as a rem is written everywhere (1px at 16px is 0.0625rem).
    setting = { value: Number(formatNumber(typed.value / options.lengthUnit.rootFontPx)), unit: 'rem' };
    converted = true;
  }
  return {
    kind: 'width',
    query: queryFor(setting, options.direction),
    setting,
    converted,
    existingKey: existingQueryKey(options.contexts, setting, options.direction),
  };
}

/** Whether a suggestion matches what is typed in the Custom row, for narrowing the list as the person types. */
export function suggestionMatches(suggestion: BreakpointSuggestion, typed: string, name: string): boolean {
  const query = typed.trim().toLowerCase();
  if (query === '' || query.startsWith('@')) {
    return true;
  }
  return `${name} ${formatBreakpoint(suggestion.breakpoint.setting)} ${suggestion.breakpoint.widthPx}`.toLowerCase().includes(query);
}
