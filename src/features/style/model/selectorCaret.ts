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

// What a person can press for an action: the press a blur cost is handed to it.
const PRESSABLE = [
  'button',
  'a[href]',
  'label',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ');

/** The control under a mouse down, and where it stood before the blur moved anything. */
interface Press {
  readonly control: HTMLElement;
  readonly box: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
}

/** Where the button came up, read at mouse up for the click handed on after it. */
interface Release {
  /** The node it came up over; undefined when that was not a node. */
  readonly target: Node | undefined;
  readonly x: number;
  readonly y: number;
}

/**
 * Holds a layout change until the press that caused it is over. A press elsewhere
 * blurs the field on mouse down; collapsing the field then moved everything below it
 * up, so the mouse came up over something else and the browser delivered no click.
 * The timeout is what puts the work after the click, which follows mouse up directly.
 *
 * Whatever else the blur changed (the restored selector redraws the panel), the press
 * still counts: when the button comes up where the pressed control stood at mouse down
 * but no longer over it, the control is clicked once, as the person meant. A button
 * released away from where the control stood is a cancelled press and clicks nothing.
 */
export function createPressWatch(target: PressWatchTarget): PressWatch {
  let pressed = false;
  let press: Press | undefined;
  let release: Release | undefined;
  let work: (() => void) | undefined;
  let timer: number | undefined;
  const flush = (): void => {
    timer = undefined;
    const held = work;
    const missed = press;
    const landed = release;
    work = undefined;
    press = undefined;
    release = undefined;
    if (held === undefined) {
      return;
    }
    // Handed on before the held layout change, so it lands on the panel the person saw.
    if (missed !== undefined) {
      if (landed !== undefined) {
        deliverMissedClick(missed, landed);
      }
    }
    held();
  };
  const onPress = (event: MouseEvent): void => {
    pressed = true;
    release = undefined;
    press = event.button === 0 && event.target instanceof Element ? pressedControl(event.target) : undefined;
  };
  const settle = (): void => {
    pressed = false;
    if (work !== undefined) {
      target.clearTimeout(timer);
      timer = target.setTimeout(flush, 0);
    } else {
      press = undefined;
    }
  };
  const onMouseUp = (event: MouseEvent): void => {
    release = { target: event.target instanceof Node ? event.target : undefined, x: event.clientX, y: event.clientY };
    settle();
  };
  const onDragEnd = (): void => {
    press = undefined; // A drag is not a click, wherever it ends.
    settle();
  };
  // The window losing focus ends a press it will never see come up. An element's blur
  // reaches this capture listener too; that one is the field's own blur in the middle
  // of the press, and ending the press there ran the collapse before the click.
  // The window is not a node; every element is.
  const onWindowBlur = (event: Event): void => {
    if (!(event.target instanceof Node)) {
      press = undefined;
      settle();
    }
  };
  const cancel = (): void => {
    work = undefined;
    press = undefined;
    release = undefined;
    target.clearTimeout(timer);
    timer = undefined;
  };
  const options = { capture: true } as const;
  target.addEventListener('mousedown', onPress, options);
  target.addEventListener('mouseup', onMouseUp, options);
  target.addEventListener('dragend', onDragEnd, options);
  target.addEventListener('blur', onWindowBlur, options);
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
      target.removeEventListener('mouseup', onMouseUp, options);
      target.removeEventListener('dragend', onDragEnd, options);
      target.removeEventListener('blur', onWindowBlur, options);
    },
  };
}

// The pressable control a mouse down landed on, with its box at that moment.
function pressedControl(pressTarget: Element): Press | undefined {
  const control = pressTarget.closest(PRESSABLE);
  if (!(control instanceof HTMLElement)) {
    return undefined;
  }
  const rect = control.getBoundingClientRect();
  assert(rect.left <= rect.right, 'pressedControl: a box has its left edge before its right');
  return { control, box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
}

// The browser clicks the control itself when the button comes up over it; otherwise,
// released where it stood, the click goes to it here.
function deliverMissedClick(missed: Press, landed: Release): void {
  assert(Number.isFinite(landed.x), 'deliverMissedClick: a mouse up has a position');
  assert(Number.isFinite(landed.y), 'deliverMissedClick: a mouse up has a position');
  if (landed.target !== undefined) {
    if (missed.control.contains(landed.target)) {
      return;
    }
  }
  if (!missed.control.isConnected) {
    return;
  }
  if (boxHolds(missed.box, landed.x, landed.y)) {
    missed.control.click();
  }
}

function boxHolds(box: Press['box'], x: number, y: number): boolean {
  if (x < box.left) {
    return false;
  }
  if (x > box.right) {
    return false;
  }
  if (y < box.top) {
    return false;
  }
  return y <= box.bottom;
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
