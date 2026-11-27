// The selected frame's settings, in a popover over the canvas's right edge: the frame's size and background. It is
// always there while a canvas is open, so it can never be lost: a press on its header, and Escape, minimize it to the
// header alone, and the header expands it again. It never closes on a press outside, since the canvas is where the next
// frame is picked. The whole header is one button, and dragging it moves the popover (useFloatingDrag), kept inside the
// window; a drag never toggles.
import { useEffect, useLayoutEffect, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import Popup from '../../../ui/Popup';
import { ChevronDownIcon } from '../../../ui/Icons';
import { useFloatingDrag } from '../../../ui/useFloatingDrag';
import { FLOATING_DRAG_HANDLE_ATTRIBUTE } from '../../../ui/floatingDrag';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ComponentCanvasPanel } from './ComponentCanvasPanel';
import type { CanvasOpen, ComponentCanvasControl } from './componentCanvasSession';
import './componentCanvas.css';

const POPUP_LIMITS = {
  widthPx: 300,
  /** Between the popover and the canvas's edges. */
  insetPx: 12,
} as const satisfies Record<string, number>;

interface Place {
  readonly top: number;
  readonly left: number;
  readonly height: number;
}

export function ComponentCanvasFramePopup({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const place = useCanvasPlace();
  const drag = useFloatingDrag();
  const label = translate('componentCanvas.popup.title');
  const shown = state.framePanel === 'shown';
  const toggle = translate(shown ? 'componentCanvas.popup.minimize' : 'componentCanvas.popup.expand');
  assert(toggle.length > 0, 'The header button says what it does');
  useCoverRight(canvas, place);
  return (
    <Popup
      mode="popover"
      className={`component-canvas-popup${shown ? '' : ' is-minimized'}`}
      role="dialog"
      label={label}
      dismissible={false}
      keepOnScroll
      onClose={canvas.hideFramePanel}
      onEscape={canvas.hideFramePanel}
      onPointerDown={drag.onPointerDown}
      style={{
        top: place.top,
        left: place.left, // physical: measured from the canvas's right edge in viewport pixels
        maxHeight: place.height,
        marginLeft: drag.offset.x, // physical: drag offset from pointer x
        marginTop: drag.offset.y,
      }}
    >
      <button
        type="button"
        className="component-canvas-popup-head"
        aria-label={toggle}
        aria-expanded={shown}
        onClick={(event) => {
          if (!drag.endedDrag(event)) {
            (shown ? canvas.hideFramePanel : canvas.showFramePanel)();
          }
        }}
        {...{ [FLOATING_DRAG_HANDLE_ATTRIBUTE]: '' }}
      >
        <span className="component-canvas-popup-title">{label}</span>
        <span className="component-canvas-popup-chevron">
          <ChevronDownIcon size={14} />
        </span>
      </button>
      {shown && <ComponentCanvasPanel canvas={canvas} state={state} />}
    </Popup>
  );
}

// Tells the canvas how much of its right side the popover covers, so fitting keeps the frames beside it; nothing once it closes.
function useCoverRight(canvas: ComponentCanvasControl, place: Place): void {
  const { coverRight } = canvas;
  useEffect(() => {
    const frame = document.querySelector('.preview-frame-wrap iframe');
    const right = frame?.getBoundingClientRect().right ?? 0;
    coverRight(Math.max(0, right - place.left + POPUP_LIMITS.insetPx));
    return () => coverRight(0);
  }, [coverRight, place.left]);
}

// Inside the canvas's right edge, below its toolbar, never taller than the canvas: the frames stay in view to its left.
function useCanvasPlace(): Place {
  const [place, setPlace] = useState<Place>({ top: 0, left: 0, height: 0 });
  useLayoutEffect(() => {
    const measure = (): void => {
      const wrap = document.querySelector('.preview-frame-wrap');
      const box = wrap?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const next = {
        top: Math.round(box.top + POPUP_LIMITS.insetPx),
        left: Math.round(Math.max(box.left + POPUP_LIMITS.insetPx, box.right - POPUP_LIMITS.widthPx - POPUP_LIMITS.insetPx)),
        height: Math.max(0, Math.round(box.height - POPUP_LIMITS.insetPx * 2)),
      };
      setPlace((previous) => (previous.top === next.top && previous.left === next.left && previous.height === next.height ? previous : next));
    };
    measure();
    const wrap = document.querySelector('.preview-frame-wrap');
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    if (wrap !== null) {
      observer?.observe(wrap);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return place;
}
