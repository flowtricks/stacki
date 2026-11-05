// What a style control shows for one property, and how a typed value splits
// into the value and its `!important`. Every section of the style panel reads a
// property the same way; these were copied into each of them, and the copies
// were identical, so they live here once.

import type { ResolvedProp } from './resolved';
import { assert } from '../../../../shared/core/assert';

/** One property as a control shows it: whether anything sets it, whether the
 * picked selector is the one that does, and the value that wins. */
export type Display = {
  present: boolean;
  isSelected: boolean;
  overridden: boolean;
  winnerSelector: string;
  value: string;
  important: boolean;
};

export function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return {
      present: false,
      isSelected: false,
      overridden: false,
      winnerSelector: '',
      value: '',
      important: false,
    };
  }
  const isSelected = resolved.source === 'selected';
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return {
    present: true,
    isSelected,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
    value: source.value,
    important: source.important,
  };
}

/** Typed text, split into its value and whether it ends in `!important`. */
export function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  if (match) {
    return { value: input.slice(0, match.index).trim(), important: true };
  }
  return { value: input.trim(), important: false };
}

// ─────────────────── `!important` in a field's text ───────────────────
//
// A property written `!important` shows it in every field that holds its value
// as text, at rest as well as while typed into: the declaration is what the
// person wrote, and a field that hid the flag let a value look plain while the
// cascade treated it otherwise. These are the one way a field puts the flag on
// and reads it back, so every field spells it the same.

/** The marker a field's text carries after the value. */
export const IMPORTANT_SUFFIX = ' !important';

/** The value with its `!important` put back: what a text field shows. */
export function withImportant(parsed: { readonly value: string; readonly important: boolean }): string {
  if (!parsed.important) {
    return parsed.value;
  }
  const text = `${parsed.value}${IMPORTANT_SUFFIX}`;
  assert(parseImportant(text).important, 'withImportant: the joined text reads back as important');
  return text;
}

/** A field's text for one property: empty when nothing sets it, else the value
 *  with its `!important`. */
export function displayText(display: Pick<Display, 'present' | 'value' | 'important'>): string {
  if (display.present) {
    return withImportant(display);
  }
  assert(!display.important, 'displayText: an absent property is not important');
  return '';
}

/**
 * A value from a control that has no text to delete the flag from — a preset
 * pick, a swatch, a variable pick, a drag — written with the flag the property
 * already shows. Only typing can take `!important` away, because only typing
 * shows it; a pick that dropped it changed more than the person asked for. A
 * value that names the flag itself (a pick from a field's own text) keeps it too.
 */
export function keepImportant(next: string, current: Pick<Display, 'important'>): { value: string; important: boolean } {
  const parsed = parseImportant(next);
  const important = parsed.important || current.important;
  assert(!/!\s*important\s*$/i.test(parsed.value), 'keepImportant: the value no longer carries the flag');
  return { value: parsed.value, important };
}
