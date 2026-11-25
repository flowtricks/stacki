// The dev server's error overlay, told to the app (docs/canvas-recovery.md).
//
// Some errors never reach the page's own answer. The page loads with a 200, and then a module it asked for fails:
// a stylesheet of a <style> block that has just been deleted ("No Astro CSS at index 0"), a client script that does
// not compile. The dev server's HMR client draws its error overlay over the page, and nothing the app watches (a
// failed navigation, an error status, the page's answer to a check) says so. The canvas stayed on that overlay
// until the person pressed Reload, even after the next edit had made everything right: the dev plugin turns the
// reload Vite would have sent into a patch, and a patch does not take an overlay down.
//
// So the frame watches for the overlay itself: Vite's `vite-error-overlay` element, which Astro's overlay also
// uses as its tag, appended to the body and removed when Vite closes it. Its coming and going are told to the app
// (`avb:error-overlay`), which keeps the canvas in an error state and reloads it on the next change that fixes it.
// Only the body's own children are watched, where the overlay goes: a subtree observer would wake on every change
// of a busy page for an element that is never anywhere else.
export const ERROR_OVERLAY_LIMITS = {
  /** Characters of the overlay's words sent to the app (the app's parser refuses more than 2000). */
  messageCharsMax: 1_000,
} as const satisfies Record<string, number>;

const OVERLAY_TAG = 'vite-error-overlay';
// The overlay's words, by the version that drew it: Astro's message, Vite's message, then its title.
const MESSAGE_SELECTORS = ['#message-content', '.message-body', '#title'] as const;

interface OverlayShown {
  readonly shown: boolean;
  readonly message: string | undefined;
}

/** Starts telling the app when the dev server's error overlay comes up over this canvas page and when it goes. */
export function reportErrorOverlay(post: (message: unknown) => void): void {
  if (!location.hash.includes('avb-design')) {
    return; // Only the canvas recovers; a tile or a thumbnail has no one to tell.
  }
  let last: OverlayShown = { shown: false, message: undefined };
  const look = (): void => {
    const now = overlayOf(document.body);
    if (now.shown === last.shown && now.message === last.message) {
      return;
    }
    last = now;
    post({ type: 'avb:error-overlay', shown: now.shown, message: now.message });
  };
  const watch = (): void => {
    // After DOMContentLoaded a document has its body: the parser made one if the page did not.
    new MutationObserver(look).observe(document.body, { childList: true });
    look();
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', watch, { once: true });
  } else {
    watch();
  }
}

/** Whether `body` holds the overlay, and the overlay's words. Exported for its test. */
export function overlayOf(body: HTMLElement): OverlayShown {
  let overlay: Element | undefined;
  for (const child of Array.from(body.children)) {
    if (child.localName === OVERLAY_TAG) {
      overlay = child;
      break;
    }
  }
  if (overlay === undefined) {
    return { shown: false, message: undefined };
  }
  return { shown: true, message: overlayWords(overlay) };
}

function overlayWords(overlay: Element): string | undefined {
  // Vite and Astro draw into an open shadow root; without one, the element's own text is all there is.
  const root = overlay.shadowRoot;
  const lines: string[] = [];
  for (const selector of MESSAGE_SELECTORS) {
    const found = root?.querySelector(selector)?.textContent?.trim() ?? '';
    if (found !== '') {
      lines.push(found);
    }
  }
  const words = lines.length === 0 ? (root?.textContent ?? overlay.textContent ?? '').trim() : lines.join('\n');
  if (words === '') {
    return undefined;
  }
  return words.slice(0, ERROR_OVERLAY_LIMITS.messageCharsMax);
}
