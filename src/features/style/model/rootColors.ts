import { assert } from '../../../../shared/core/assert';
import type { ProjectVariable } from './webflow';

// The colour a code editor's swatch paints for a variable: what the page computes it to on its root
// element (`:root`, the <html> of the canvas), so `--brand-1-text: var(--light-100)`, a color-mix(), a
// light-dark() and a value declared in another stylesheet all show the colour the page really has.
// The question goes over the canvas query the Style panel's swatches already use (computedColor.ts,
// the `compute` half of avb:query, answered on the document element when no element is named).
//
// This module holds the pure halves: the bounded batch the page is asked, the parse of its answer into
// a colour a swatch can paint, and the declared-text reading used until the page has answered (or
// when there is no canvas at all), which follows `var()` chains through the project's declarations.

/** The most values one root question carries; a longer batch is asked in several. */
export const ROOT_COLOR_BATCH_MAX = 256;
/** The longest value asked about, and the longest colour accepted back. */
export const ROOT_COLOR_CHARS_MAX = 512;
/** How many `var()` steps the declared-text reading follows before it gives up (a cycle, or a deep chain). */
export const LITERAL_DEPTH_MAX = 16;

// A colour as getComputedStyle writes one: a colour function, a hex, or `transparent`. Nothing that
// could close the style it is painted into (`;`, braces, angle brackets) is accepted.
const COMPUTED_COLOR = /^(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}<>()]*\)|#[0-9a-f]{3,8}|transparent)$/i;
const REFERENCE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*))?\)$/i;

type Reply = Readonly<Record<string, unknown>> | undefined;

/** The cache's view of the root question (queryCache.ts), so a swatch can read it like the panel's. */
export interface RootColorQuery {
  readonly setScope: (next: readonly unknown[]) => void;
  readonly read: (path: string, key: string) => { readonly kind: 'pending' } | { readonly kind: 'settled'; readonly answer: string | undefined };
  readonly request: (path: string, key: string) => Promise<string | undefined>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The query the root cache runs: `ask` the page about each value, in batches of at most
 * ROOT_COLOR_BATCH_MAX, the replies merged. A value past ROOT_COLOR_CHARS_MAX is not asked and has no
 * answer; a batch the page does not answer leaves its values unanswered.
 */
export function rootColorQuery(ask: (values: string[]) => Promise<Reply>): (path: string, values: string[]) => Promise<Reply> {
  return async (_path, values) => {
    const asked = values.filter((value) => value.length <= ROOT_COLOR_CHARS_MAX);
    assert(asked.length <= values.length, 'rootColorQuery: only asked values are kept');
    const merged: Record<string, unknown> = {};
    const batches = Math.ceil(asked.length / ROOT_COLOR_BATCH_MAX);
    for (let batch = 0; batch < batches; batch++) {
      const slice = asked.slice(batch * ROOT_COLOR_BATCH_MAX, (batch + 1) * ROOT_COLOR_BATCH_MAX);
      assert(slice.length <= ROOT_COLOR_BATCH_MAX, 'rootColorQuery: a batch is bounded');
      const reply = await ask(slice);
      for (const value of slice) {
        merged[value] = reply?.[value];
      }
    }
    return merged;
  };
}

/**
 * The page's answer for one value as a colour a swatch can paint: an `rgb()`, `color(srgb …)`,
 * `oklch()` or other colour function, a hex, or `transparent`. Undefined for no answer, a value that
 * computed to no colour (a length, a font), or anything that is not a bounded colour.
 */
export function parseComputedColor(answer: unknown): string | undefined {
  if (typeof answer !== 'string') {
    return undefined;
  }
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > ROOT_COLOR_CHARS_MAX) {
    return undefined;
  }
  return COMPUTED_COLOR.test(trimmed) ? trimmed : undefined;
}

/** The project's declared values by custom property, the first declaration winning. */
export function declaredValues(variables: readonly ProjectVariable[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const variable of variables) {
    const name = /--[A-Za-z0-9_-]+/.exec(variable.binding)?.[0];
    if (name !== undefined && !values.has(name)) {
      values.set(name, variable.value);
    }
  }
  return values;
}

/**
 * `value` read from the declared text: a `var(--a)` (or `--a`) is replaced by what `--a` is declared
 * as, again while that is a reference, and a reference with no declaration takes its fallback. The
 * result is what the app's own document can paint (`white`, `#fff`); undefined for a reference that
 * names nothing declared and has no fallback, or a chain past LITERAL_DEPTH_MAX.
 */
export function literalColorOf(value: string, declared: ReadonlyMap<string, string>): string | undefined {
  let current = value.trim();
  if (current.startsWith('--')) {
    current = `var(${current})`;
  }
  for (let depth = 0; depth < LITERAL_DEPTH_MAX; depth++) {
    const match = REFERENCE.exec(current);
    if (match === null) {
      return current === '' ? undefined : current;
    }
    const name = match[1];
    assert(name !== undefined, 'literalColorOf: a reference has a name');
    const next = declared.get(name) ?? match[2];
    if (next === undefined) {
      return undefined;
    }
    current = next.trim();
  }
  return undefined;
}
