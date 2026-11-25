import { useEffect, useRef, useState, type RefObject } from 'react';
import { parseCanvasLeaving, parseCanvasNavigation, type CanvasInteraction, type CanvasSitePages } from '../../../shared/properties/canvasInteraction';

interface Options {
  readonly projectKey: string | undefined;
  readonly url: string | undefined;
  readonly available: boolean;
  readonly frame: RefObject<HTMLIFrameElement>;
  readonly post: (message: unknown) => void;
  readonly subscribeLoad: (listener: () => void) => () => void;
  readonly editRoute: (route: string) => void;
  /**
   * Hosts that cannot stop a frame leaving the site take it back (useCanvasReturn),
   * dropping the outlines measured on the document that left. Desktop omits it:
   * its main process refuses those navigations before they start (previewNavigation.ts).
   */
  readonly offSite?: { readonly clearOverlays: () => void } | undefined;
  /** The site's pages: a same-origin link to anything else opens in the browser (frameInteraction.ts). */
  readonly pages?: CanvasSitePages | undefined;
}

// After a frame that announced it was leaving finishes loading, how long the new
// document has to say it is one of the site's pages. The preview clients say so
// as they start, before the load event, so this only runs out on a page with no
// client: another site, or the browser's own error page for one that refuses to
// be framed.
export const CANVAS_RETURN_WAIT_MS = 1500;
// The same, for a frame that left and never finished loading anything.
const CANVAS_LEAVE_WAIT_MS_MAX = 10_000;

export function useCanvasInteraction(options: Options) {
  const [choice, setChoice] = useState<{
    readonly projectKey: string | undefined;
    readonly mode: CanvasInteraction;
  }>();
  const mode = options.available && choice && choice.projectKey === options.projectKey ? choice.mode : 'select';
  const { subscribeLoad } = options;
  const current = useRef({ ...options, mode });
  current.current = { ...options, mode };
  // The page list goes with the mode, each time a frame loads; a key, so a new
  // array with the same routes does not resend it.
  const pagesKey = options.pages === undefined ? '' : JSON.stringify(options.pages);
  useEffect(() => {
    const send = () => {
      const pages = current.current.pages;
      if (pages !== undefined) {
        current.current.post({ type: 'avb:site-pages', base: pages.base, routes: pages.routes });
      }
      current.current.post({ type: 'avb:interaction', mode });
    };
    send();
    return subscribeLoad(send);
  }, [mode, options.url, pagesKey, subscribeLoad]);
  useCanvasNavigation(current);
  useCanvasReturn(current, subscribeLoad);
  return {
    active: mode === 'interact',
    available: options.available,
    toggle: () =>
      setChoice({
        projectKey: options.projectKey,
        mode: mode === 'select' ? 'interact' : 'select',
      }),
  };
}

function useCanvasNavigation(current: RefObject<Options & { readonly mode: CanvasInteraction }>) {
  useEffect(() => {
    let previous: string | undefined;
    const receive = (event: MessageEvent<unknown>) => {
      const options = current.current;
      if (!options || options.mode !== 'interact' || !options.url) {
        return;
      }
      if (event.source !== options.frame.current?.contentWindow) {
        return;
      }
      const initial = new URL(options.url);
      if (event.origin !== initial.origin) {
        return;
      }
      const route = parseCanvasNavigation(event.data);
      if (route === undefined) {
        return;
      }
      const destination = route.split(/[?#]/)[0]?.replace(/\/$/, '') || '/';
      const key = JSON.stringify([options.projectKey, options.url, destination]);
      if (key === previous) {
        return;
      }
      previous = key;
      if ((initial.pathname.replace(/\/$/, '') || '/') !== destination) {
        // Keep the editor model and the visible document on the same page immediately.
        options.editRoute(destination);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [current]);
}

// A frame in interact mode that slipped off the site anyway (a page script
// setting `location.href`, a form posting elsewhere, a browser without the
// Navigation API guard in frameInteraction.ts) is taken back to the page it was
// on. Its outlines go as soon as it says it is leaving, so none is ever drawn
// over another site or an error page.
function useCanvasReturn(current: RefObject<Options & { readonly mode: CanvasInteraction }>, subscribeLoad: Options['subscribeLoad']) {
  useEffect(() => {
    let leaving = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (waitMs: number) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (leaving) {
          leaving = false;
          returnToPage(current.current ?? undefined);
        }
      }, waitMs);
    };
    const settle = () => {
      leaving = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const receive = (event: MessageEvent<unknown>) => {
      const options = current.current;
      if (!options?.offSite || options.mode !== 'interact' || !options.url) {
        return;
      }
      if (event.source !== options.frame.current?.contentWindow) {
        return;
      }
      if (event.origin !== new URL(options.url).origin) {
        return;
      }
      if (parseCanvasLeaving(event.data)) {
        leaving = true;
        options.offSite.clearOverlays();
        wait(CANVAS_LEAVE_WAIT_MS_MAX);
      } else if (parseCanvasNavigation(event.data) !== undefined) {
        settle();
      }
    };
    window.addEventListener('message', receive);
    const unsubscribe = subscribeLoad(() => {
      if (leaving) {
        wait(CANVAS_RETURN_WAIT_MS);
      }
    });
    return () => {
      window.removeEventListener('message', receive);
      unsubscribe();
      settle();
    };
  }, [current, subscribeLoad]);
}

// Back to the page the editor has open. The frame's address is set directly:
// React's `src` never changed, so it would not reload the frame on its own.
function returnToPage(options: (Options & { readonly mode: CanvasInteraction }) | undefined): void {
  const frame = options?.frame.current;
  if (!options?.url || !frame) {
    return;
  }
  options.offSite?.clearOverlays();
  // Desktop's frame adds the design hash itself (PreviewFrame.tsx); Studio's URL carries it.
  frame.src = options.url.includes('#') ? options.url : `${options.url}#avb-design`;
}
