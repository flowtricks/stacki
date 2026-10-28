import { inOwnedPopup, isTopPopupLayer } from './popupOwnership';
import { useEffect, type RefObject } from 'react';
import type { PopupProps, PopupActions } from './Popup';
import { toRecord } from '../../shared/core/record';
interface DismissOptions extends Pick<
  PopupProps,
  'dismissible' | 'anchor' | 'within' | 'onEscape'
> {
  readonly active: boolean;
  readonly mode: 'modal' | 'popover';
}
export function usePopupDismiss(
  surface: RefObject<HTMLDivElement>,
  options: DismissOptions,
  { close, finish }: PopupActions,
): void {
  const { active, anchor, within, dismissible = true, mode, onEscape } = options;
  usePopupEnvironment(surface, options, close);
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
        event.preventDefault();
        consumePopupClick(event.target);
        close();
      }
    };
    const click = (event: MouseEvent): void => {
      if (
        mode === 'modal' &&
        outsidePress &&
        outside(event.target) &&
        popupIsTop(surface.current)
      ) {
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
        close();
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
function usePopupEnvironment(
  surface: RefObject<HTMLDivElement>,
  options: DismissOptions,
  close: () => void,
): void {
  const { active, dismissible = true, mode } = options;
  useEffect(() => {
    if (!active || !dismissible || mode === 'modal') {
      return undefined;
    }
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
      if (event.target instanceof window.Node && surface.current?.contains(event.target)) {
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
  }, [active, close, dismissible, mode, surface]);
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
  return (
    kind === 'avb:click-node' ||
    kind === 'avb:open-node' ||
    kind === 'avb:context-node' ||
    kind === 'studio:select' ||
    kind === 'studio:open'
  );
}
