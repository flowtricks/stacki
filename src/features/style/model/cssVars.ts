// Custom properties in a CSS value, and the value with them filled in. The
// panel's own document defines none of a project's variables, so a gradient
// written with `var(--divider-size)` paints nothing in a preview here: the page
// says what each one is on the selected element (canvasQuery), and the preview
// paints the value with those filled in.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';

/** At most this many substitution passes: one per level of nested fallback. */
const SUBSTITUTION_PASSES_MAX = 32;

/** The custom properties `text` reads, each once, in order. */
export function customPropertiesIn(text: string): readonly string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = match[1];
    if (name !== undefined && names.size < LIMITS.scanEntriesMax) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * `text` with each `var(--name, fallback)` replaced by the value `values` gives
 * the name, or else its fallback (empty when it has none, as CSS treats an
 * unset variable with no fallback: the declaration fails). Nested fallbacks are
 * replaced innermost first.
 */
export function substituteCustomProperties(text: string, values: ReadonlyMap<string, string>): string {
  assert(values.size <= LIMITS.scanEntriesMax, 'substituteCustomProperties: the values are a bounded answer');
  let out = text;
  for (let pass = 0; pass < SUBSTITUTION_PASSES_MAX; pass++) {
    const found = innermostVar(out);
    if (found === undefined) {
      return out;
    }
    const known = values.get(found.name)?.trim() ?? '';
    const replacement = known !== '' ? known : found.fallback;
    out = out.slice(0, found.start) + replacement + out.slice(found.end);
  }
  // Deeper nesting than the pass limit is left as written: the preview may
  // then paint nothing, which is what an unresolvable value paints anyway.
  return out;
}

// The first var() whose arguments hold no other var(), with its extent. Its
// fallback may hold other functions (`rgb(…)`), so the closing parenthesis is
// found by counting, not by pattern.
function innermostVar(text: string): { readonly name: string; readonly fallback: string; readonly start: number; readonly end: number } | undefined {
  for (const match of text.matchAll(/var\(/g)) {
    const start = match.index;
    let depth = 0;
    let close = -1;
    for (let i = start + 3; i < text.length; i++) {
      const char = text[i];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) {
      return undefined; // Unbalanced: nothing to fill in.
    }
    const inside = text.slice(start + 4, close);
    if (!inside.includes('var(')) {
      const comma = inside.indexOf(',');
      const name = (comma < 0 ? inside : inside.slice(0, comma)).trim();
      assert(close > start, 'innermostVar: a var() closes after it opens');
      return { name, fallback: comma < 0 ? '' : inside.slice(comma + 1).trim(), start, end: close + 1 };
    }
  }
  return undefined;
}
