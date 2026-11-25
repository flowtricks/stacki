import { useEffect } from 'react';
import { assert } from '../../shared/core/assert';

// Who owns a touch that lands on a drag control inside a scrolling panel: the control or the
// panel's scroll.
//
// On a phone the style panel is mostly drag controls: spacing and position boxes, scrubbable
// labels, sliders. When each took every touch outright (`touch-action: none` and a value
// change on the press), a swipe that landed on one edited a value instead of scrolling, and on
// a phone that is most swipes. So a touch press is only a candidate. The control claims it
// once the intent is clear: a horizontal drag (a vertical swipe is the panel's scroll), or a
// press held still for HOLD_MS (the way to reach a control that drags vertically). A vertical
// move first releases the touch to the browser, which scrolls. The controls carry
// `touch-action: pan-y`, so the browser may pan vertically but leaves horizontal drags to us.
//
// A mouse or pen press is claimed at once, so desktop keeps its immediate drags.

export type TouchClaimState = 'pending' | 'claimed' | 'released';

/** Which gesture besides a held press claims the touch: a horizontal drag, or none. */
export type TouchClaimAxis = 'x' | 'hold';

export const TOUCH_CLAIM = {
  // Travel under this is a finger settling, not a direction: a tap wobbles a few pixels.
  slopPx: 8,
  // Shorter than the platform long press (about 500ms), which opens the text callout.
  holdMs: 350,
} as const satisfies Record<string, number>;

/** The state one pointer move leads to from `pending`, from the travel since the press. */
export function touchClaimStep(input: { readonly dxPx: number; readonly dyPx: number; readonly axis: TouchClaimAxis }): TouchClaimState {
  assert(Number.isFinite(input.dxPx), 'touchClaimStep: dx is finite');
  assert(Number.isFinite(input.dyPx), 'touchClaimStep: dy is finite');
  const across = Math.abs(input.dxPx);
  const along = Math.abs(input.dyPx);
  if (Math.max(across, along) < TOUCH_CLAIM.slopPx) {
    return 'pending';
  }
  if (input.axis === 'x') {
    if (across > along) {
      return 'claimed';
    }
    return 'released';
  }
  return 'released';
}

export interface TouchClaim {
  readonly state: () => TouchClaimState;
  /** Feeds a pointer move; returns the state after it. A settled state never changes. */
  readonly move: (point: { readonly clientX: number; readonly clientY: number }) => TouchClaimState;
  /** The press is over: stops the hold timer. Safe to call more than once. */
  readonly end: () => void;
}

/**
 * Starts deciding who owns the press `event` began. `onHold` runs if the press is claimed by
 * holding still, so the control can show it has the touch before the finger moves.
 */
export function startTouchClaim(
  event: { readonly pointerType: string; readonly clientX: number; readonly clientY: number },
  options: { readonly axis: TouchClaimAxis },
  onHold?: () => void,
): TouchClaim {
  if (event.pointerType !== 'touch') {
    return settledClaim();
  }
  const start = { x: event.clientX, y: event.clientY };
  let state: TouchClaimState = 'pending';
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    if (state === 'pending') {
      state = 'claimed';
      claimedTouches += 1;
      onHold?.();
    }
  }, TOUCH_CLAIM.holdMs);
  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  let ended = false;
  return {
    state: () => state,
    move: (point) => {
      if (state === 'pending') {
        state = touchClaimStep({ dxPx: point.clientX - start.x, dyPx: point.clientY - start.y, axis: options.axis });
        if (state === 'claimed') {
          claimedTouches += 1;
        }
        if (state !== 'pending') {
          stopTimer();
        }
      }
      return state;
    },
    end: () => {
      stopTimer();
      if (ended) {
        return;
      }
      ended = true;
      if (state === 'claimed') {
        claimedTouches -= 1;
        assert(claimedTouches >= 0, 'touchClaim: every claimed touch ends once');
      }
    },
  };
}

// Touches a control holds right now. While any is held, the page must not pan under it.
let claimedTouches = 0;

/** Whether a control holds a touch right now (for the touchmove guard, and for tests). */
export function touchClaimHeld(): boolean {
  assert(claimedTouches >= 0, 'touchClaim: the claimed count never goes negative');
  return claimedTouches > 0;
}

/**
 * Installs, for the life of the page, the listener that keeps a claimed touch from panning the
 * page. Call it from every control that claims touches.
 *
 * `touch-action: pan-y` stops the browser taking a horizontal drag, but not a held press that
 * then moves vertically, so a non-passive `touchmove` listener cancels the pan while a control
 * holds the touch. Safari decides at `touchstart` whether a touch may be cancelled, from the
 * listeners present then, so the listener has to exist before the first press: hence a hook
 * that installs it when the control mounts, not at the press. One listener per document, never
 * removed: it costs one comparison per move, and removing it with the last control would let
 * the next control's first touch scroll.
 */
export function useTouchClaimGuard(): void {
  useEffect(() => {
    installTouchClaimGuard(document);
  }, []);
}

const guarded = new WeakSet<Document>();

export function installTouchClaimGuard(target: Document): void {
  if (guarded.has(target)) {
    return;
  }
  guarded.add(target);
  target.addEventListener('touchmove', guardTouchMove, { passive: false, capture: true });
  assert(guarded.has(target), 'touchClaim: the guard is recorded once installed');
}

function guardTouchMove(event: Event): void {
  if (touchClaimHeld()) {
    if (event.cancelable) {
      event.preventDefault();
    }
  }
}

// A mouse or pen press: the control owns it from the start, as on desktop before.
function settledClaim(): TouchClaim {
  return {
    state: () => 'claimed',
    move: () => 'claimed',
    end: () => {},
  };
}
