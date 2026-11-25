// Comment pins on the canvas: a numbered marker at each pin's point, drawn in the canvas's overlay layer from the
// same measurements as the selection outlines, so it follows its element through scrolling, zoom, resizing and
// breakpoints with no lag. The marker's tip is the point the person clicked (a fraction of the element's box), and
// its fill says how the pin stands: blue while a draft, grey while queued, pulsing while working, green when done,
// orange when it needs the person. Clicking a marker opens its popover (PinPopover.tsx).
//
// Only the markers take the pointer: the rest of the layer lets clicks through to the canvas, where comment mode
// turns them into new pins. A wheel over a marker is handed to the canvas frame, so the page scrolls under it as if
// the marker were not there (the frame's `avb:app-wheel`, electron/preload/frameAppScroll.ts).
//
// A marker that is not sent can be dragged to another element: a press that travels past DRAG_THRESHOLD_PX is a drag,
// anything shorter a click (open or close its box). While it moves the marker follows the pointer (in the darker
// blue it has on hover) and its box steps aside; near the canvas's top or bottom edge the page scrolls; Escape puts it
// back. On release the shell asks the canvas what is under the point (setPinMover): an element there takes the pin,
// with its words, images and unsaved changes; nothing there (off the page) leaves it where it was. The pointer is the
// marker's own while it is held (pointer capture), so nothing on the page is selected or dragged underneath.
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { CommentPin, PinId } from '../../../../shared/properties/ai/commentPins';
import { tellCanvas } from '../../../editor/canvasQuery';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { markerPosition, type CanvasBox, type PinProgress } from './pinModel';
import { closePinBox, movePinTo, openPin, setDraggingPin, usePinState } from './pinStore';
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
  const press = useRef<MarkerPress | undefined>(undefined);
  const [dragPoint, setDragPoint] = useState<{ readonly id: PinId; readonly left: number; readonly top: number } | undefined>(undefined);
  // Escape while a marker is dragged puts it back where it was.
  const draggingId = dragPoint?.id;
  useEffect(() => {
    if (draggingId === undefined) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelPress(press.current, setDragPoint);
        press.current = undefined;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draggingId]);
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
        const resting = markerPosition(box, pin.anchor.at, scale);
        const point = dragPoint?.id === pin.id ? dragPoint : resting;
        const progress = progressOf(pin);
        const movable = pin.delivery.kind === 'draft';
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
            className={`ai-pin-marker is-${progress.kind}${pin.savedAt === undefined ? ' is-unsaved' : ''}${pins.open === pin.id ? ' is-open' : ''}${pin.included || pin.delivery.kind === 'sent' ? '' : ' is-excluded'}${movable ? ' is-movable' : ''}${dragPoint?.id === pin.id ? ' is-dragging' : ''}`}
            style={{ left: point.left, top: point.top }}
            aria-label={translate('ai.pins.marker', { number: pin.number, element: pin.place.elementLabel })}
            data-pin-marker={pin.id}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              const layer = root.current?.getBoundingClientRect();
              if (layer === undefined) {
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              press.current = { id: pin.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, layer, movable, moved: false };
            }}
            onPointerMove={(event) => {
              const held = press.current;
              if (held === undefined || held.pointerId !== event.pointerId || !held.movable) {
                return;
              }
              if (!held.moved && Math.hypot(event.clientX - held.startX, event.clientY - held.startY) < DRAG_THRESHOLD_PX) {
                return;
              }
              if (!held.moved) {
                held.moved = true;
                setDraggingPin(held.id);
              }
              setDragPoint({ id: held.id, left: event.clientX - held.layer.left, top: event.clientY - held.layer.top });
              scrollNearEdge(held.layer, event.clientY, latestScale.current);
            }}
            onPointerUp={(event) => {
              const held = press.current;
              if (held === undefined || held.pointerId !== event.pointerId) {
                return;
              }
              press.current = undefined;
              if (!held.moved) {
                // A click: open its box, or close it (kept, as a press elsewhere keeps it).
                if (pins.open === pin.id) {
                  closePinBox('keep', translate);
                } else {
                  openPin(pin.id, translate);
                }
                return;
              }
              const scaleNow = latestScale.current;
              const target = { x: (event.clientX - held.layer.left) / scaleNow, y: (event.clientY - held.layer.top) / scaleNow };
              void movePinTo(held.id, target, translate).finally(() => {
                setDragPoint(undefined);
                setDraggingPin(undefined);
              });
            }}
            onPointerCancel={() => {
              cancelPress(press.current, setDragPoint);
              press.current = undefined;
            }}
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

/** How far a press travels before it is a drag rather than a click, in pixels. */
const DRAG_THRESHOLD_PX = 4;
/** How near the canvas's top or bottom edge a dragged marker scrolls the page, and by how much per move. */
const EDGE_SCROLL_PX = 40;
const EDGE_SCROLL_STEP_PX = 24;

/** A press on a marker: where it began, the layer it was measured against, and whether it became a drag. */
interface MarkerPress {
  readonly id: PinId;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly layer: DOMRect;
  readonly movable: boolean;
  moved: boolean;
}

// Puts a dragged marker back where it was (Escape, or the system took the pointer away), given the press it ends;
// the caller forgets the press.
function cancelPress(held: MarkerPress | undefined, setDragPoint: (point: undefined) => void): void {
  setDragPoint(undefined);
  if (held?.moved === true) {
    setDraggingPin(undefined);
  }
}

// A marker dragged near the canvas's top or bottom edge scrolls the page under it, as a wheel there would.
function scrollNearEdge(layer: DOMRect, clientY: number, scale: number): void {
  const visibleTop = Math.max(layer.top, 0);
  const visibleBottom = Math.min(layer.bottom, window.innerHeight);
  const deltaY = clientY < visibleTop + EDGE_SCROLL_PX ? -EDGE_SCROLL_STEP_PX : clientY > visibleBottom - EDGE_SCROLL_PX ? EDGE_SCROLL_STEP_PX : 0;
  if (deltaY === 0) {
    return;
  }
  assert(scale > 0, 'scrollNearEdge: the canvas scale is positive');
  tellCanvas({
    type: 'avb:app-wheel',
    x: layer.width / 2 / scale,
    y: (clientY - layer.top) / scale,
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  });
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
