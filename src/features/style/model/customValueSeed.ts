// What the large value editor opens with, and whether what it closes with is a write.
//
// A field shows a value even when its selector sets none: the cascade's winner (`.heading { color:
// var(--text) }`, a colour inherited from `body`, an inline style) appears as the field's hint. The
// editor `=` opens is the same value made bigger, so it opens on what the field shows: the field's
// own text when the selector sets the property, else the winning declaration as written (a
// variable stays `var(--text)`, which the editor draws as the same chip). Opening on a value is not
// setting it: closing with that inherited text untouched writes nothing, so looking at a value never
// copies it onto the selector. A property only a browser default sets opens empty, as before.

import { assert } from '../../../../shared/core/assert';

/** Where the editor's opening text came from. */
export type CustomValueSeedSource = 'own' | 'declared' | 'none';

export interface CustomValueSeed {
  readonly text: string;
  readonly source: CustomValueSeedSource;
}

/**
 * The editor's opening text: `own` (what the field holds now, typed or saved) when there is any,
 * else `declared` (the cascade's winning declaration for the property, read and never written).
 */
export function customValueSeed(input: { readonly own: string; readonly declared: string }): CustomValueSeed {
  if (input.own.trim().length > 0) {
    return { text: input.own, source: 'own' };
  }
  const declared = input.declared.trim();
  if (declared.length > 0) {
    const seed: CustomValueSeed = { text: declared, source: 'declared' };
    assert(seed.text.length > 0, 'customValueSeed: a declared seed is never empty');
    return seed;
  }
  return { text: '', source: 'none' };
}

/**
 * Whether the editor's closing text is a change to write. `fieldValue` is the value the field's
 * selector holds (what a write would replace). Unchanged text is never a write: the field's own
 * value written again is a no-op, and the inherited seed written back would add a declaration the
 * person never asked for.
 */
export function customValueWrites(seed: CustomValueSeed, fieldValue: string, next: string): boolean {
  if (next === fieldValue) {
    return false;
  }
  if (seed.source === 'declared') {
    assert(seed.text.length > 0, 'customValueWrites: a declared seed carries its text');
    if (next.trim() === seed.text) {
      return false;
    }
  }
  return true;
}
