// Shows a window created hidden once its first frame has painted, so the person never sees the
// window's empty background before the page (index.html paints a skeleton at once, so that frame
// comes early) and never sees a half-drawn one.
//
// Why a fallback: `ready-to-show` is the only signal and a page that fails to load may never send
// it. A window that stays hidden forever reads as an app that did not start, so after
// `REVEAL_FALLBACK_MS` the window is shown regardless, and the failed load is visible.
import { assert } from '../../shared/core/assert';

/** Longest a window stays hidden waiting for its first frame. */
export const REVEAL_FALLBACK_MS = 2_000;

/** The part of a BrowserWindow this needs; a fake stands in for it in tests. */
export interface RevealableWindow {
  readonly once: (event: 'ready-to-show', listener: () => void) => unknown;
  readonly show: () => void;
  readonly isDestroyed: () => boolean;
}

/** Shows `window` on its first paint, or after the fallback. `onShown` runs once, when it is shown. */
export function revealWhenPainted(window: RevealableWindow, onShown: () => void): void {
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
  window.once('ready-to-show', reveal);
}
