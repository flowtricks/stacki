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

/** The window events a press is read from, and its timers. */
export type PressWatchTarget = Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>;

export interface PressWatch {
  /** Runs `work` now, or just after the press under way has delivered its click. */
  readonly whenPressEnds: (work: () => void) => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

/**
 * Holds a layout change until the press that caused it is over. A press elsewhere
 * blurs the field on mouse down; collapsing the field then moved everything below it
 * up, so the mouse came up over something else and the browser delivered no click.
 * The timeout is what puts the work after the click, which follows mouse up directly.
 */
export function createPressWatch(target: PressWatchTarget): PressWatch {
  let pressed = false;
  let work: (() => void) | undefined;
  let timer: number | undefined;
  const flush = (): void => {
    timer = undefined;
    const held = work;
    work = undefined;
    held?.();
  };
  const onPress = (): void => {
    pressed = true;
  };
  const onRelease = (): void => {
    pressed = false;
    if (work !== undefined) {
      target.clearTimeout(timer);
      timer = target.setTimeout(flush, 0);
    }
  };
  const cancel = (): void => {
    work = undefined;
    target.clearTimeout(timer);
    timer = undefined;
  };
  const options = { capture: true } as const;
  const releases = ['mouseup', 'dragend', 'blur'] as const;
  target.addEventListener('mousedown', onPress, options);
  releases.forEach((type) => target.addEventListener(type, onRelease, options));
  return {
    whenPressEnds: (next) => {
      if (pressed) {
        work = next;
      } else {
        next();
      }
    },
    cancel,
    dispose: () => {
      cancel();
      target.removeEventListener('mousedown', onPress, options);
      releases.forEach((type) => target.removeEventListener(type, onRelease, options));
    },
  };
}

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
