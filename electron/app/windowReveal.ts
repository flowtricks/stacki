// Shows a window created hidden once its first REAL frame has painted: the renderer says so (`boot:first-frame`,
// electron/boot/bootChannels.ts) after the app's own shell, with its real content, has been handed to the
// compositor. Nothing is drawn in front of it (no splash, no spinner, no skeleton), so the person's first sight of
// the window is the app.
//
// Why not `ready-to-show`: it fires after the first paint of ANY content, including an empty page, which would show
// an empty window. The renderer knows when its content is real; the window does not.
//
// Why a fallback, and why it is not a delay: the renderer's signal is the only way the window appears, and a page
// that fails to load never sends it. A window that stays hidden forever reads as an app that did not start, so after
// `REVEAL_FALLBACK_MS` the window is shown regardless, and the failed load is visible. It never holds back a window
// whose first frame arrived.
import { assert } from '../../shared/core/assert';

/** Longest a window stays hidden waiting for its first real frame. A safety net: a healthy start is far inside it. */
export const REVEAL_FALLBACK_MS = 5_000;

/** The part of a BrowserWindow this needs; a fake stands in for it in tests. */
export interface RevealableWindow {
  readonly show: () => void;
  readonly isDestroyed: () => boolean;
}

/** Where the renderer's "first real frame" arrives from: a listener registered once. */
export interface FirstFrameSignal {
  readonly once: (listener: () => void) => void;
}

/** Shows `window` on its first real frame, or after the fallback. `onShown` runs once, when it is shown. */
export function revealOnFirstFrame(window: RevealableWindow, firstFrame: FirstFrameSignal, onShown: () => void): void {
  assert(REVEAL_FALLBACK_MS > 0, 'windowReveal: the fallback is a positive wait');
  assert(!window.isDestroyed(), 'windowReveal: the window is alive when its reveal is armed');
  let shown = false;
  const reveal = (): void => {
    if (shown) {
      return;
    }
    shown = true;
    clearTimeout(timer);
    if (window.isDestroyed()) {
      return;
    }
    window.show();
    onShown();
  };
  const timer = setTimeout(reveal, REVEAL_FALLBACK_MS);
  firstFrame.once(reveal);
}

/** A one-shot signal: `once` listeners run when `fire` is called, and a listener added after it runs at once. */
export function createFirstFrameSignal(): FirstFrameSignal & { readonly fire: () => void } {
  let fired = false;
  const waiting: Array<() => void> = [];
  return {
    once(listener) {
      if (fired) {
        listener();
      } else {
        waiting.push(listener);
      }
    },
    fire() {
      fired = true;
      for (const listener of waiting.splice(0)) {
        listener();
      }
    },
  };
}
