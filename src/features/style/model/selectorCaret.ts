// What the selector field's chips stand for, and which one Backspace or Delete
// takes off. The gap arithmetic itself is shared with the Settings panel's class
// field, in src/lib/chipCaret.ts, which says why the two fields use it
// differently.
//
// Everything here is pure, so it is tested without a browser
// (test/renderer/style/selectorCaret.test.js).

import { assert } from '../../../../shared/core/assert';
import { clampCaret } from '../../../lib/chipCaret';

/** What a chip stands for on the element, as far as Delete is concerned. */
export type ChipPart = { readonly kind: 'class'; readonly name: string } | { readonly kind: 'attribute'; readonly name: string } | { readonly kind: 'other' };

export type CaretKey = 'Backspace' | 'Delete';

/** The chip Backspace (the one before the caret) or Delete (after) takes off, if any. */
export function chipAtCaret(caret: number, chipCount: number, key: CaretKey): number | undefined {
  const gap = clampCaret(caret, chipCount);
  const index = key === 'Backspace' ? gap - 1 : gap;
  if (index < 0) {
    return undefined;
  }
  if (index < chipCount) {
    return index;
  }
  return undefined;
}

/**
 * The part a chip stands for. `loneClass` is the chip's lone class, when it is
 * one (`.hero_title`); an attribute chip is a lone `[name]` or `[name="value"]`.
 * Anything else — a tag, `[class*="text-"]`, a combinator, a state — is part of
 * a selector, not something written on the element.
 */
export function chipPart(selectorText: string, loneClass: string | undefined): ChipPart {
  if (loneClass !== undefined) {
    assert(loneClass.length > 0, 'chipPart: a lone class has a name');
    return { kind: 'class', name: loneClass };
  }
  const name = attributeChipName(selectorText);
  return name === undefined ? { kind: 'other' } : { kind: 'attribute', name };
}

// `[data-state]` or `[data-state="open"]`, alone. Substring and prefix matches
// (`*=`, `^=`, `~=`, …) select a family of values, not an attribute to remove.
const ATTRIBUTE_CHIP = /^\[\s*([A-Za-z_][\w:.-]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\]\s"']+)\s*(?:[is]\s*)?)?\]$/;

export function attributeChipName(selectorText: string): string | undefined {
  const match = ATTRIBUTE_CHIP.exec(selectorText.trim());
  return match?.[1];
}
