import type { RefObject } from 'react';
import { toRecord } from '../../shared/core/record';
import { useEffect } from 'react';

// Closing a popup when the user goes somewhere else.
//
// A `mousedown` listener on the document is the usual way, and it misses the
// biggest thing on screen. The canvas is an iframe, and a click inside an
// iframe raises its events in THAT document — the parent hears nothing. So a
// menu opened over the canvas stayed open while you clicked around the page
// behind it, and only closed when you happened to click some part of the app's
// own chrome.
//
// The missing half is focus: clicking into an iframe moves focus to the iframe
// element, which blurs the window that owns the popup. When that happens and
// the newly focused thing is an iframe, the click went into the canvas — or the
// preview, or any other frame — and the popup should close for the same reason
// it would have closed for a click anywhere else.
//
// (Not `window.blur` on its own: that also fires when the user switches to
// another application, and a menu should still be there when they come back.)

/**
 * Close `ref`'s popup on a click outside it, or on a click into any iframe.
 *
 * `active` skips the listeners entirely while the popup is shut, so a closed
 * menu costs nothing.
 */
export default function useDismiss(ref: RefObject<HTMLElement> | undefined, { active }: { readonly active: boolean }, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onDown = (event: MouseEvent): void => {
      const element = ref?.current;
      if (element && event.target instanceof Node && !element.contains(event.target)) {
        onDismiss();
      }
    };

    const onBlur = () => {
      // Read after the browser has moved focus, which it has not yet done when
      // blur fires.
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = undefined;
        if (document.activeElement?.tagName === 'IFRAME') {
          onDismiss();
        }
      }, 0);
    };

    // And the canvas says so itself. Every click in it is posted up to this
    // window (see electron/preload/frameTargets.ts), which is a signal that does not depend
    // on how focus behaves — belt and braces, since the two cost the same and
    // a menu left hanging over the page is the thing being fixed.
    const onMessage = (event: MessageEvent<unknown>): void => {
      const type = toRecord(event.data)?.['type'];
      if (typeof type === 'string' && (type === 'avb:click-node' || type === 'avb:open-node')) {
        onDismiss();
      }
    };

    document.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(blurTimer);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('message', onMessage);
    };
  }, [ref, active, onDismiss]);
}
