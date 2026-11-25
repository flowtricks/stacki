import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import { caretAtX } from '../model/caretAtX';
import { findScrubTarget, hasScrubTarget, scrubNumber, stepModeOf } from '../model/numberStep';
import type { NumberRun, StepMode } from '../model/numberStep';
import { startTouchClaim, useTouchClaimGuard, type TouchClaim } from '../../../ui/touchClaim';

// Drag-to-change on a CSS value, on two surfaces:
//
//   • the field's LABEL — plain drag, no modifier, grabs the value's first number.
//   • the INPUT itself — Alt or Shift drag, grabs the number under the pointer, so
//     `0 2px 4px` gives you three independent handles. A plain drag there is left
//     alone: it still selects text, which is the only thing you can do with a caret.
//
// Steps match the arrow keys exactly (lib/number-step.ts): plain 1, Shift 10, Alt 0.1
// — rem 1/16 — read live off the drag, so releasing Alt mid-drag drops you to whole
// units. One step per screen pixel.
//
// Writes follow the same discipline as DragSlider: the field's own text repaints every
// animation frame (free), but the CSS write is throttled, because each one is a real
// postcss edit and a high-Hz mouse emits moves far faster than they can drain. The final
// value always commits on release, so nothing is lost to the throttle.
//
// On touch the label sits in a panel that scrolls, so a press there is only a candidate
// (ui/touchClaim.ts): a horizontal drag or a held press makes it a scrub, and a vertical
// swipe lets it go so the panel scrolls without the value changing.

const DEAD_ZONE = 3; // px of travel before a press counts as a drag rather than a click
const PX_PER_STEP = 1;
const WRITE_MS = 50;

type Surface = 'input' | 'label';

type Drag = {
  pointerId: number;
  startX: number;
  /** The value as it was when the press landed; every frame recomputes from this. */
  base: string;
  run: NumberRun;
  mode: StepMode;
  moved: boolean;
  latestX: number;
  raf: number | undefined;
  lastWriteAt: number;
  text: string;
  /** Whether the press is the scrub's yet; a mouse press always is. */
  claim: TouchClaim;
};

export type ScrubHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
};

type ScrubOptions = {
  /** The field's current text. The scrub rewrites exactly this string. */
  value: string;
  disabled?: boolean;
  /** Multiplies the shared whole/fine/ten steps for normalized fields such as opacity. */
  stepScale?: number;
  /** Every frame of the drag — for the field's own text only, never a write. */
  onPreview?: (text: string) => void;
  /** Throttled during the drag: the live (preview-only) CSS write. Omit it on a field
   *  that has no preview channel — the drag then shows in the field and lands on the
   *  canvas once, at release, rather than writing for real at pointer speed. */
  onInput?: (text: string) => void;
  /** Once, on release, with the final text: the authoritative write. */
  onCommit: (text: string) => void;
};

type DragRef = MutableRefObject<Drag | undefined>;
type LatestOptions = MutableRefObject<ScrubOptions>;

export default function useScrub(options: ScrubOptions): {
  input: ScrubHandlers;
  label: ScrubHandlers;
} {
  // The pointer handlers outlive the render that installed them, so read callbacks and
  // the value through a ref rather than closing over a stale render's copies.
  const latest = useRef(options);
  latest.current = options;
  useTouchClaimGuard();
  const drag = useRef<Drag | undefined>(undefined);
  const { frame, finish } = useDragFrames(drag, latest);
  const { onPointerMove, onPointerUp } = useDragMoves(drag, frame, finish);
  const hover = useScrubHover({ disabled: options.disabled ?? false, value: options.value });
  const { onInputPointerDown, onLabelPointerDown } = useScrubPresses(drag, latest);

  const shared = {
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture: onPointerUp,
    onPointerLeave: hover.onPointerLeave,
  };
  return {
    input: {
      ...shared,
      onPointerDown: onInputPointerDown,
      onPointerEnter: hover.onInputPointerEnter,
    },
    label: {
      ...shared,
      onPointerDown: onLabelPointerDown,
      onPointerEnter: hover.onLabelPointerEnter,
    },
  };
}

// One animation frame of the drag (recompute the text from the press's base value,
// preview it, write it when the throttle allows) and the end of a drag.
function useDragFrames(dragRef: DragRef, latest: LatestOptions) {
  const frame = useCallback(() => {
    const state = dragRef.current;
    if (!state) {
      return;
    }
    state.raf = undefined;
    const steps = Math.round((state.latestX - state.startX) / PX_PER_STEP);
    const text = scrubNumber(state.base, state.run, steps, state.mode, latest.current.stepScale);
    if (text === state.text) {
      return;
    }
    state.text = text;
    latest.current.onPreview?.(text);
    const now = performance.now();
    if (now - state.lastWriteAt >= WRITE_MS) {
      state.lastWriteAt = now;
      latest.current.onInput?.(text);
    }
  }, [dragRef, latest]);

  const finish = useCallback(() => {
    const state = dragRef.current;
    if (!state) {
      return;
    }
    dragRef.current = undefined;
    state.claim.end();
    if (state.raf !== undefined) {
      cancelAnimationFrame(state.raf);
    }
    document.body.classList.remove('is-scrubbing');
    if (!state.moved) {
      return;
    } // never crossed the dead zone: it was a click, leave it be
    // The press that ended a dragRef must not also register as a click — on a label that
    // would pop the reset menu open the moment you let go.
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    latest.current.onCommit(state.text);
  }, [dragRef, latest]);

  // A dragRef can outlive its field — a commit elsewhere may re-render the section away.
  useEffect(() => finish, [finish]);
  return { frame, finish };
}

function useDragMoves(dragRef: DragRef, frame: () => void, finish: () => void) {
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }
      const claim = state.claim.move(event);
      if (claim === 'released') {
        // A vertical swipe: the panel's scroll, not a scrub. `moved` is still false, so
        // finishing writes nothing and leaves the click alone.
        assert(!state.moved, 'useScrub: a released touch never scrubbed');
        finish();
        return;
      }
      if (claim === 'pending') {
        return;
      }
      state.latestX = event.clientX;
      state.mode = stepModeOf(event);
      if (!state.moved) {
        if (Math.abs(event.clientX - state.startX) < DEAD_ZONE) {
          return;
        }
        state.moved = true;
        // One class on <body> beats a per-dragRef <style> tag: the cursor has to win over
        // every element the pointer crosses, including the ones it's captured away from.
        document.body.classList.add('is-scrubbing');
      }
      if (state.raf === undefined) {
        state.raf = requestAnimationFrame(frame);
      }
    },
    [dragRef, finish, frame],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }
      // Land on where the pointer actually was released, not on the last frame we drew.
      if (state.moved) {
        state.latestX = event.clientX;
        if (state.raf !== undefined) {
          cancelAnimationFrame(state.raf);
          state.raf = undefined;
        }
        frame();
      }
      finish();
    },
    [dragRef, finish, frame],
  );
  return { onPointerMove, onPointerUp };
}

// Hover state for the ew-resize affordance. `armed` is what the cursor reflects: over a
// label it's enough to be hovering a value with a number in it; over an input you also
// have to be holding the modifier that would start the scrub.
function useScrubHover({ disabled, value }: { readonly disabled: boolean; readonly value: string }) {
  const hoverElement = useRef<HTMLElement | undefined>(undefined);
  const hoverSurface = useRef<Surface>('input');
  const [hovering, setHovering] = useState(false);
  const [modifierHeld, setModifierHeld] = useState(false);

  const enter = useCallback((surface: Surface, event: ReactPointerEvent<HTMLElement>) => {
    hoverElement.current = event.currentTarget;
    hoverSurface.current = surface;
    setModifierHeld(event.altKey || event.shiftKey);
    setHovering(true);
  }, []);
  const onInputPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => enter('input', event), [enter]);
  const onLabelPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => enter('label', event), [enter]);
  const onPointerLeave = useCallback(() => {
    hoverElement.current = undefined;
    setHovering(false);
  }, []);

  // Only the hovered field listens for the modifier, so pressing Alt anywhere else in the
  // app costs nothing — with a few dozen fields on screen, always-on listeners wouldn't.
  useEffect(() => {
    if (!hovering || hoverSurface.current === 'label') {
      return;
    }
    const sync = (event: KeyboardEvent) => setModifierHeld(event.altKey || event.shiftKey);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
    };
  }, [hovering]);

  // Set the cursor on the element itself rather than through a class the caller has to
  // merge into its own className — every field would otherwise pay for the plumbing.
  useEffect(() => {
    const element = hoverElement.current;
    if (!element || !hovering) {
      return;
    }
    const armed = !disabled && hasScrubTarget(value) && (hoverSurface.current === 'label' || modifierHeld);
    element.style.cursor = armed ? 'ew-resize' : '';
    return () => {
      element.style.cursor = '';
    };
  }, [hovering, modifierHeld, disabled, value]);
  return { onInputPointerEnter, onLabelPointerEnter, onPointerLeave };
}

// A press that may start a dragRef: on the input only with Alt or Shift (a bare dragRef
// there still selects text), on the label always.
function useScrubPresses(dragRef: DragRef, latest: LatestOptions) {
  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, base: string, run: NumberRun) => {
      if (dragRef.current) {
        return;
      } // a second pointer (touch) must not hijack the one in flight
      // Capture so the dragRef survives leaving the field — and so pointerup still lands here
      // when the pointer is released halfway across the window.
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        base,
        run,
        mode: stepModeOf(event),
        moved: false,
        latestX: event.clientX,
        raf: undefined,
        lastWriteAt: performance.now(),
        text: base,
        claim: startTouchClaim(event, { axis: 'x' }),
      };
    },
    [dragRef],
  );

  const onInputPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (latest.current.disabled || event.button !== 0) {
        return;
      }
      if (!event.altKey && !event.shiftKey) {
        return;
      } // a bare dragRef is still a text selection
      const element = event.currentTarget;
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        return;
      }
      const run = findScrubTarget(element.value, caretAtX(element, event.clientX));
      if (!run) {
        return;
      }
      // Stops the caret from moving and the selection from starting. It also drops the
      // click, which is fine: a modifier-click on a value field means nothing else.
      event.preventDefault();
      begin(event, element.value, run);
    },
    [begin, latest],
  );

  const onLabelPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (latest.current.disabled || event.button !== 0) {
        return;
      }
      const run = findScrubTarget(latest.current.value, 0);
      if (!run) {
        return;
      }
      // Deliberately no preventDefault: a press that never turns into a dragRef has to reach
      // the label as a click and open its reset menu. Text selection is handled instead by
      // the body class, which lands the moment the dead zone is crossed.
      begin(event, latest.current.value, run);
    },
    [begin, latest],
  );
  return { onInputPointerDown, onLabelPointerDown };
}
