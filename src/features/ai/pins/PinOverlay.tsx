// Comment pins on the canvas: a numbered marker at each pin's point, drawn in the canvas's overlay layer from the
// same measurements as the selection outlines, so it follows its element through scrolling, zoom, resizing and
// breakpoints with no lag. The marker's tip is the point the person clicked (a fraction of the element's box), and
// its fill says how the pin stands: blue while a draft, grey while queued, pulsing while working, green when done,
// orange when it needs the person. Clicking a marker opens its popover (PinPopover.tsx).
//
// Only the markers take the pointer: the rest of the layer lets clicks through to the canvas, where comment mode
// turns them into new pins. A wheel over a marker is handed to the canvas frame, so the page scrolls under it as if
// the marker were not there (the frame's `avb:app-wheel`, electron/preload/frameAppScroll.ts).
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { CommentPin, PinId } from '../../../../shared/properties/ai/commentPins';
import { tellCanvas } from '../../../editor/canvasQuery';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { markerPosition, type CanvasBox, type PinProgress } from './pinModel';
import { openPin, usePinState } from './pinStore';
import { PinPopover } from './PinPopover';
import './pins.css';

/** A pin the canvas shows now, at the path its element is at. */
export interface PlacedPin {
  readonly pin: CommentPin;
  readonly path: string;
}

export interface PinOverlayProps {
  readonly rects: Readonly<Record<string, readonly CanvasBox[] | undefined>>;
  readonly scale: number;
  readonly placed: readonly PlacedPin[];
  /** Pins whose element is gone from this canvas: their popover sits under the pin bar. */
  readonly detached: ReadonlySet<PinId>;
  readonly progressOf: (pin: CommentPin) => PinProgress;
  /** Takes pin `id`'s crop again, of its area as the canvas shows it now; undefined where the pin is not on screen. */
  readonly recapture: (id: PinId) => (() => void) | undefined;
}

export function PinOverlay({ rects, scale, placed, detached, progressOf, recapture }: PinOverlayProps) {
  const translate = useTranslate();
  const pins = usePinState();
  const markers = useRef(new Map<PinId, HTMLButtonElement>());
  const root = useRef<HTMLDivElement>(null);
  const latestScale = useRef(scale);
  latestScale.current = scale;
  const [layout, setLayout] = useState(0);
  // Native and not passive, so the editor neither scrolls nor zooms under the frame's own scroll.
  const mode = pins.mode;
  useEffect(() => {
    const element = root.current ?? undefined;
    if (element === undefined) {
      return undefined;
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest('.ai-pin-marker') !== null) {
        forwardWheel(element, event, latestScale.current);
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [mode]);
  // Every measurement moves the markers; the open popover follows on the next frame.
  useEffect(() => {
    setLayout((count) => (count + 1) % Number.MAX_SAFE_INTEGER);
  }, [rects, scale]);
  if (pins.mode !== 'on') {
    return undefined;
  }
  const open = pins.open === undefined ? undefined : pins.board.pins.find((pin) => pin.id === pins.open);
  return (
    <div ref={root} className={`ai-pin-layer${pins.moving === undefined ? '' : ' is-moving'}`}>
      {placed.map(({ pin, path }) => {
        const box = rects[path]?.[pin.anchor.occurrence] ?? rects[path]?.[0];
        if (box === undefined || (box.w <= 0 && box.h <= 0)) {
          return undefined; // Not drawn at this width (display: none), or not measured yet.
        }
        const point = markerPosition(box, pin.anchor.at, scale);
        const progress = progressOf(pin);
        return (
          <button
            key={pin.id}
            type="button"
            ref={(element) => {
              const marker = element ?? undefined;
              if (marker === undefined) {
                markers.current.delete(pin.id);
              } else {
                markers.current.set(pin.id, marker);
              }
            }}
            className={`ai-pin-marker is-${progress.kind}${pins.open === pin.id ? ' is-open' : ''}${pin.included || pin.delivery.kind === 'sent' ? '' : ' is-excluded'}`}
            style={{ left: point.left, top: point.top }}
            aria-label={translate('ai.pins.marker', { number: pin.number, element: pin.place.elementLabel })}
            data-pin-marker={pin.id}
            onClick={() => openPin(pins.open === pin.id ? undefined : pin.id)}
          >
            {pin.number}
          </button>
        );
      })}
      {open !== undefined && (
        <PinPopover
          key={open.id}
          pin={open}
          progress={progressOf(open)}
          anchor={markers.current.get(open.id) ?? document.querySelector<HTMLElement>('.ai-pin-bar') ?? undefined}
          detached={detached.has(open.id)}
          onRecapture={recapture(open.id)}
          layout={layout}
        />
      )}
    </div>
  );
}

// A wheel on a marker scrolls the page under it: the frame takes it at the same point, in its own CSS pixels.
function forwardWheel(layer: HTMLElement, event: WheelEvent, scale: number): void {
  assert(scale > 0, 'forwardWheel: the canvas scale is positive');
  event.preventDefault();
  const origin = layer.getBoundingClientRect();
  tellCanvas({
    type: 'avb:app-wheel',
    x: (event.clientX - origin.left) / scale,
    y: (event.clientY - origin.top) / scale,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  });
}
