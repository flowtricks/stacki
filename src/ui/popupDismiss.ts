import { inOwnedPopup, isTopPopupLayer, ownsTopPopupLayer } from './popupOwnership';
import { useEffect, useRef, type RefObject } from 'react';
import type { PopupProps, PopupActions } from './Popup';
import { toRecord } from '../../shared/core/record';
import { popupLayer } from './popupLayer';
interface DismissOptions extends Pick<PopupProps, 'dismissible' | 'keepOnScroll' | 'anchor' | 'within' | 'onEscape'> {
  readonly active: boolean;
  readonly mode: 'modal' | 'popover';
}
// A popup closed by the user pressing elsewhere, or by the page around it moving, does not hand focus back to
// what opened it: the press already put focus where the person wanted it (or nowhere). The mark is read by
// the popup's focus handling (Popup.tsx) when it closes. Escape and a pick carry none, and do restore it.
export const DISMISSED_BY_ATTRIBUTE = 'data-popup-dismissed';

function dismissedBy(surface: RefObject<HTMLDivElement>, close: () => void): () => void {
  return () => {
    surface.current?.setAttribute(DISMISSED_BY_ATTRIBUTE, 'outside');
    close();
  };
}

// A press on something that takes typed text goes through to it: focus must land there, and the press
// does nothing to the popup's own controls. Anything else is swallowed so the press only dismisses.
function takesTypedText(target: Event['target']): boolean {
  return target instanceof window.Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null;
}

export function usePopupDismiss(surface: RefObject<HTMLDivElement>, options: DismissOptions, { close, finish }: PopupActions): void {
  const { active, anchor, within, dismissible = true, mode, onEscape } = options;
  usePopupEnvironment(surface, options, dismissedBy(surface, close));
  // When this popup opened: a canvas press stamped before that is not a press on it. Taken when it
  // becomes active, not when the listeners below are added again for a new callback.
  const openedAtRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    openedAtRef.current = active ? epochNowMs() : undefined;
  }, [active]);
  useEffect(() => {
    if (!active || !dismissible) {
      return undefined;
    }
    let outsidePress = false;
    const outside = (target: Event['target']): boolean =>
      target instanceof window.Node &&
      !(target instanceof window.Element && target.closest('.toast-stack')) &&
      !surface.current?.contains(target) &&
      !inOwnedPopup(target, surface.current ?? undefined) &&
      !anchor?.contains(target) &&
      !within?.contains(target);
    const down = (event: MouseEvent): void => {
      outsidePress = outside(event.target);
      if (mode === 'popover' && outsidePress && popupTakesOutsidePress(surface.current)) {
        // Anchored menus dismiss on press; native dialogs wait for a complete backdrop click.
        if (!takesTypedText(event.target)) {
          event.preventDefault();
          consumePopupClick(event.target);
        }
        dismissedBy(surface, close)();
      }
    };
    const click = (event: MouseEvent): void => {
      if (mode === 'modal' && outsidePress && outside(event.target) && popupIsTop(surface.current)) {
        // A dismissal gesture must not also activate a control behind the popup.
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && popupIsTop(surface.current)) {
        event.preventDefault();
        event.stopPropagation();
        if (onEscape) {
          finish(onEscape);
        } else {
          close();
        }
      }
    };
    const message = (event: MessageEvent<unknown>): void => {
      if (mode === 'popover' && isCanvasPressMessage(event.data, { openedAtMs: openedAtRef.current })) {
        dismissedBy(surface, close)();
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('mousedown', down, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key);
    window.addEventListener('message', message);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('message', message);
    };
  }, [active, anchor, within, close, finish, dismissible, mode, onEscape, surface]);
}

export function popupIsTop(surface: RefObject<HTMLDivElement>['current']): boolean {
  return isTopPopupLayer(surface ?? undefined);
}

// An outside press or a scroll of the anchor reaches the top popup and every popup beneath it that opened
// it, so one press closes a menu and its submenu together. Unrelated popups still answer one at a time.
function popupTakesOutsidePress(surface: RefObject<HTMLDivElement>['current']): boolean {
  return isTopPopupLayer(surface ?? undefined) || ownsTopPopupLayer(surface ?? undefined);
}

// Canvas focus and viewport movement can happen outside this document's click stream.
//
// A scroll closes a popover only when what it sits on moved. Closing on every scroll
// anywhere closed menus nobody touched: the panel's own data landing above an open menu
// makes Chromium's scroll anchoring adjust the scroller (a scroll event that keeps the
// anchor exactly where it was), a shrinking panel clamps its scroll, and another panel
// (the navigator following the selection) scrolls on its own. Each of those closed the
// Clear menu a person had just opened. The anchor's position on screen is the test: a
// person scrolling the panel moves it, those do not. A portaled popover with no anchor
// has nothing to measure and keeps closing on any outside scroll.
function usePopupEnvironment(surface: RefObject<HTMLDivElement>, options: DismissOptions, close: () => void): void {
  const { active, anchor, dismissible = true, keepOnScroll = false, mode } = options;
  useEffect(() => {
    if (!active || !dismissible || mode === 'modal') {
      return undefined;
    }
    const reference = scrollReference(surface.current ?? undefined, anchor);
    const origin = reference === undefined ? undefined : screenPosition(reference);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const blur = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') {
          close();
        }
      }, 0);
    };
    const scroll = (event: Event): void => {
      if (keepOnScroll || (event.target instanceof window.Node && surface.current?.contains(event.target))) {
        return;
      }
      if (reference !== undefined && origin !== undefined && !movedOnScreen(origin, screenPosition(reference))) {
        return;
      }
      if (popupTakesOutsidePress(surface.current)) {
        close();
      }
    };
    window.addEventListener('blur', blur);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('blur', blur);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [active, anchor, close, dismissible, keepOnScroll, mode, surface]);
}

// Under half a pixel is the same place: subpixel layout can differ between two reads.
const MOVED_PX_MIN = 0.5;

interface ScreenPosition {
  readonly left: number;
  readonly top: number;
}

// What the popover sits on: its anchor, or, for one drawn inline (not portaled), the
// element it is drawn in, which carries it along when the panel scrolls.
function scrollReference(surface: HTMLElement | undefined, anchor: HTMLElement | undefined): HTMLElement | undefined {
  if (anchor !== undefined) {
    return anchor;
  }
  const parent = surface?.parentElement ?? undefined;
  if (parent === undefined || parent === popupLayer() || parent instanceof window.HTMLDialogElement) {
    return undefined;
  }
  return parent;
}

function screenPosition(element: HTMLElement): ScreenPosition {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top };
}

function movedOnScreen(before: ScreenPosition, after: ScreenPosition): boolean {
  if (Math.abs(after.top - before.top) >= MOVED_PX_MIN) {
    return true;
  }
  return Math.abs(after.left - before.left) >= MOVED_PX_MIN;
}

let pendingClickCleanup: (() => void) | undefined;

function consumePopupClick(target: Event['target']): void {
  pendingClickCleanup?.();
  // At most one dismissal gesture survives unmount, and only for a bounded time.
  const cleanup = (): void => {
    document.removeEventListener('click', consume, true);
    window.clearTimeout(timer);
    pendingClickCleanup = undefined;
  };
  const consume = (event: MouseEvent): void => {
    if (event.target === target) {
      event.preventDefault();
      event.stopPropagation();
    }
    cleanup();
  };
  const timer = window.setTimeout(cleanup, 400);
  pendingClickCleanup = cleanup;
  document.addEventListener('click', consume, { capture: true });
}

const CANVAS_PRESSES: ReadonlySet<string> = new Set(['avb:click-node', 'avb:open-node', 'avb:context-node', 'studio:select', 'studio:open']);

/** Now, on the clock the canvas stamps its presses with (epoch milliseconds, frameTargets.ts pressedAtMsOf). */
export function epochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Whether a message from the canvas is a person's press in it that came after `openedAtMs` (when the
 * popup asking opened; absent: any press). Two kinds of message are not: a click the app retries on a
 * freshly reloaded canvas (canvasClickRetry.ts) comes back as an `avb:click-node` carrying `replay`,
 * the press already handled; and a freshly reloaded page can post a press a few hundred milliseconds
 * late, after the person went on to open something in the panel, so a press the canvas stamps as
 * made before the popup opened is not a press on it. Taking either for a new press closed whatever
 * the person had opened since the click (soak SP-04: a chip's picker, 230 to 270 ms after it opened,
 * with nothing in the panel to say why).
 */
export function isCanvasPressMessage(data: unknown, { openedAtMs }: { readonly openedAtMs?: number | undefined } = {}): boolean {
  const message = toRecord(data);
  const kind = message?.['type'];
  if (typeof kind !== 'string') {
    return false;
  }
  if (!CANVAS_PRESSES.has(kind)) {
    return false;
  }
  if (message?.['replay'] !== undefined) {
    return false;
  }
  if (openedAtMs === undefined) {
    return true;
  }
  // A canvas that does not stamp its presses (Studio's preview client, an older frame) is taken at its word.
  const pressedAtMs = message?.['pressedAtMs'];
  if (typeof pressedAtMs !== 'number') {
    return true;
  }
  if (!Number.isFinite(pressedAtMs)) {
    return true;
  }
  return pressedAtMs >= openedAtMs;
}
