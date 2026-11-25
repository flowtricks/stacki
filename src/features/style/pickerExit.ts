// Every way out of the variable picker that does not pick: one listener set, one idempotent restore.
//
// The picker previews a hovered or arrowed variable in the field and on the canvas, and the original value
// has to be back before anything else reacts to the way out. The close itself is too late: a popup leaves
// through a 160ms exit motion, and the press that dismisses it also blurs the field, whose blur commits what
// the field shows, which would commit the preview. So these listeners run in the capture phase, ahead of the
// browser's own focus change, and put the original back at once.
//
// What counts as a way out: a press anywhere outside the picker (including into the canvas, whose events do
// not reach this document, so the canvas's own click messages and the window losing focus stand in for them),
// Escape, Tab, the window or the document losing focus, a scroll or resize, and the selection changing.

import { useEffect, useRef } from 'react';
import { getHost, onHostChange } from './model/host';
import { epochNowMs, isCanvasPressMessage } from '../../ui/popupDismiss';

const PICKER_SELECTOR = '.embed-editor_varpicker';

/** While `active`, runs `restore` the moment any way out begins. `restore` must be idempotent. */
export function useExitRestore({ active, restore }: { readonly active: boolean; readonly restore: () => void }): void {
  const latest = useRef(restore);
  latest.current = restore;
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const run = (): void => latest.current();
    const insidePicker = (target: unknown): boolean => target instanceof Element && target.closest(PICKER_SELECTOR) !== null;
    const press = (event: Event): void => {
      // A press inside the picker is a pick in the making: it commits what was previewed.
      if (!insidePicker(event.target)) {
        run();
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        run();
      }
    };
    const scroll = (event: Event): void => {
      if (!insidePicker(event.target)) {
        run();
      }
    };
    // A press in the canvas made since the picker opened: never a retried click's answer, nor a press the
    // canvas posted late from before (both are the press already handled; popupDismiss.ts).
    const openedAtMs = epochNowMs();
    const message = (event: MessageEvent<unknown>): void => {
      if (isCanvasPressMessage(event.data, { openedAtMs })) {
        run();
      }
    };
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') {
        run();
      }
    };
    const focusOut = (event: FocusEvent): void => {
      // Focus left the document (into the canvas frame, another window): no related element.
      if (event.relatedTarget === null && !insidePicker(event.target)) {
        run();
      }
    };
    const selected = getHost().selectedId;
    const hostChanged = (): void => {
      if (getHost().selectedId !== selected) {
        run();
      }
    };
    const stopHost = onHostChange(hostChanged);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('mousedown', press, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', run);
    window.addEventListener('message', message);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', run);
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('focusout', focusOut, true);
    return () => {
      stopHost();
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('mousedown', press, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', run);
      window.removeEventListener('message', message);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', run);
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('focusout', focusOut, true);
    };
  }, [active]);
}
