import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { assert } from '../../../../shared/core/assert';
import { startTouchClaim, useTouchClaimGuard, type TouchClaim } from '../../../ui/touchClaim';

function sliderStyle(percent: number): CSSProperties & { readonly '--pct': string } {
  return { '--pct': `${percent}%` };
}

// A thin, pointer-driven slider bar (Webflow's shadow/opacity sliders): the WHOLE
// track is draggable start→end, with arrow-key support (Shift = ×10, Home/End =
// min/max). Drag emits live values via onInput; release (and keys) commit via
// onCommit. Purely numeric — the caller maps the number to CSS (px, %, 0..1, …).
//
// While dragging, the thumb tracks a LOCAL value: a live write previews to the
// canvas but doesn't refresh the model, so the prop-derived `value` only catches up
// on commit. We re-sync from `value` whenever we're not mid-drag.
export default function DragSlider({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  className,
  onPreview,
  onInput,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /** Fires EVERY animation frame during a drag with the live value — for cheap UI
   *  (a number readout tracking the thumb). Unlike onInput it is not throttled. */
  onPreview?: (n: number) => void;
  onInput: (n: number) => void;
  onCommit: (n: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) {
      setLocal(value);
    }
  }, [value]);

  const { down, move, up, key } = useSliderDrag({
    trackRef,
    dragging,
    local,
    setLocal,
    min,
    max,
    step,
    disabled,
    onPreview,
    onInput,
    onCommit,
  });
  const percent = max > min ? Math.min(100, Math.max(0, ((local - min) / (max - min)) * 100)) : 0;
  return (
    <div
      ref={trackRef}
      className={['u-drag-slider', disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={local}
      aria-disabled={disabled || undefined}
      style={sliderStyle(percent)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <span className="u-drag-slider-fill" aria-hidden="true" />
      <span className="u-drag-slider-thumb" aria-hidden="true" />
    </div>
  );
}

// Arrow keys, Home and End commit a clamped value at once.
function sliderKeyHandler(drag: SliderDrag) {
  return (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (drag.disabled) {
      return;
    }
    const next = keyedValue(event, drag.local, drag.min, drag.max, drag.step);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    const clamped = Math.min(drag.max, Math.max(drag.min, next));
    drag.setLocal(clamped);
    drag.onCommit(clamped);
  };
}

// The value a key asks for: arrows use the caller's step (Shift = ×10), while
// Home/End jump to the ends. Undefined for any other key.
function keyedValue(event: ReactKeyboardEvent<HTMLDivElement>, local: number, min: number, max: number, step: number): number | undefined {
  assert(step > 0, 'DragSlider: keyboard step is positive');
  const delta = event.shiftKey ? step * 10 : step;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    return local - delta;
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    return local + delta;
  }
  if (event.key === 'Home') {
    return min;
  }
  if (event.key === 'End') {
    return max;
  }
  return undefined;
}

// The slider value under a pointer at `clientX`; `fallback` while the track can't be
// measured.
function valueAtX(
  track: HTMLDivElement | undefined,
  clientX: number,
  range: {
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly fallback: number;
  },
): number {
  assert(range.step > 0, 'DragSlider: pointer step is positive');
  if (!track) {
    return range.fallback;
  }
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) {
    return range.fallback;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const continuous = range.min + ratio * (range.max - range.min);
  const stepped = range.min + Math.round((continuous - range.min) / range.step) * range.step;
  const rounded = Math.round(stepped * 1e8) / 1e8;
  return Math.min(range.max, Math.max(range.min, rounded));
}

type SliderDrag = {
  readonly trackRef: RefObject<HTMLDivElement>;
  readonly dragging: MutableRefObject<boolean>;
  readonly local: number;
  readonly setLocal: (value: number) => void;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onPreview: ((n: number) => void) | undefined;
  readonly onInput: (n: number) => void;
  readonly onCommit: (n: number) => void;
};

// A pointer fires far faster than Webflow's async style write can drain (high-Hz
// mice/trackpads emit many moves per frame). Emitting onInput on every move backs
// the writes up into a growing lag. So we coalesce: the thumb (local state) updates
// once per animation frame, and the actual write is time-throttled to WRITE_MS —
// fast enough to feel live, slow enough never to queue. The final position always
// commits on release, so no move is lost.
//
// On touch the slider sits in a panel that scrolls, so a press does not move the thumb at
// once (ui/touchClaim.ts): a horizontal drag or a held press grabs it, a tap sets the value
// where it landed, and a vertical swipe scrolls the panel and leaves the value alone.
function useSliderDrag(drag: SliderDrag) {
  const { trackRef, dragging, local, setLocal, min, max, step, disabled } = drag;
  const WRITE_MS = 50;
  const rafId = useRef<number | undefined>(undefined);
  const latestX = useRef(0);
  const lastWriteAt = useRef(0);
  const claim = useRef<TouchClaim | undefined>(undefined);
  useTouchClaimGuard();
  useEffect(
    () => () => {
      if (rafId.current !== undefined) {
        cancelAnimationFrame(rafId.current);
      }
      claim.current?.end();
    },
    [],
  );
  const endClaim = () => {
    claim.current?.end();
    claim.current = undefined;
  };
  const range = { min, max, step, fallback: local };
  const valueAt = (clientX: number) => valueAtX(trackRef.current ?? undefined, clientX, range);

  const frame = () => {
    rafId.current = undefined;
    const next = valueAt(latestX.current);
    setLocal(next);
    drag.onPreview?.(next); // every frame — cheap UI (number readout) tracks the thumb
    const now = performance.now();
    if (now - lastWriteAt.current >= WRITE_MS) {
      lastWriteAt.current = now;
      drag.onInput(next);
    }
  };
  // The press is the slider's: the thumb jumps under it and the live writes begin.
  const grab = (element: HTMLDivElement, clientX: number) => {
    assert(!dragging.current, 'DragSlider: a drag is grabbed once');
    element.focus();
    dragging.current = true;
    latestX.current = clientX;
    lastWriteAt.current = performance.now();
    const next = valueAt(clientX);
    setLocal(next);
    drag.onPreview?.(next);
    drag.onInput(next);
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    endClaim();
    const element = event.currentTarget;
    const clientX = event.clientX;
    const pressClaim = startTouchClaim(event, { axis: 'x' }, () => grab(element, clientX));
    claim.current = pressClaim;
    if (pressClaim.state() === 'claimed') {
      grab(element, clientX);
    }
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Once a drag is in progress (pointer captured), keep tracking even if `disabled`
    // toggles mid-drag: a commit may briefly flip the caller's busy flag, and that must
    // not freeze the thumb. The drag only STARTS when enabled (see `down`).
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const state = claim.current?.move(event) ?? 'claimed';
    if (state === 'released') {
      // A vertical swipe: the panel scrolls, and the value never moved.
      assert(!dragging.current, 'DragSlider: a released touch never dragged');
      event.currentTarget.releasePointerCapture(event.pointerId);
      endClaim();
      return;
    }
    if (state === 'pending') {
      return;
    }
    if (!dragging.current) {
      grab(event.currentTarget, event.clientX);
    }
    latestX.current = event.clientX;
    if (rafId.current === undefined) {
      rafId.current = requestAnimationFrame(frame);
    }
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const state = claim.current?.state() ?? 'claimed';
    endClaim();
    if (rafId.current !== undefined) {
      cancelAnimationFrame(rafId.current);
      rafId.current = undefined;
    }
    if (!dragging.current) {
      // A touch that never became a drag. Lifted where it landed, it was a tap, which sets
      // the value there as a click does; cancelled, the browser took it to scroll.
      assert(state !== 'claimed', 'DragSlider: a claimed press is dragging');
      if (state === 'pending') {
        if (event.type === 'pointerup') {
          const tapped = valueAt(event.clientX);
          setLocal(tapped);
          drag.onPreview?.(tapped);
          drag.onCommit(tapped);
        }
      }
      return;
    }
    dragging.current = false;
    const next = valueAt(event.clientX);
    setLocal(next);
    drag.onCommit(next);
  };
  const key = sliderKeyHandler(drag);
  return { down, move, up, key };
}
