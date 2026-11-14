import { inOwnedPopup, isTopPopupLayer } from './popupOwnership';
import { useEffect, type RefObject } from 'react';
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
      if (mode === 'popover' && outsidePress && popupIsTop(surface.current)) {
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
      const kind = toRecord(event.data)?.['type'];
      if (mode === 'popover' && isCanvasPress(kind)) {
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
      if (popupIsTop(surface.current)) {
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

function isCanvasPress(kind: unknown): boolean {
  return kind === 'avb:click-node' || kind === 'avb:open-node' || kind === 'avb:context-node' || kind === 'studio:select' || kind === 'studio:open';
}
