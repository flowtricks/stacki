// Dragging a side of the spacing box: which sides a drag moves, how far a
// pointer move goes in each unit, the frames the box is drawn in, and the
// filled side that takes the drag and the hover (SpacingBox.tsx).

import { useEffect, useId, useRef } from 'react';
import { getHost } from './model/host';
import { getModifiers, onModifiers, setModifiers } from '../../editor/heldModifiers';
import { assert } from '../../../shared/core/assert';
import { type SetProp, type LiveSetProp, type Read, type Side, type Display, displayOf } from './spacingTypes';
import { withImportant } from './model/styleDisplay';

// Shared "spacing box" primitives: Webflow's masked-SVG frame with draggable side
// handles, click-to-edit value labels, and a popover editor. Used by SpacingSection
// (nested margin + padding) and PositionSection (a single inset frame: top/right/
// bottom/left). Each side is driven by the resolved model — blue when the picked
// selector sets it, orange when another selector does, dim (assumed unset) otherwise.

// ── Drag-to-adjust helpers (shared by the SVG side handles) ──────────────────

// Each side drags along one axis; `sign` maps "away from centre" to an increase
// (drag the top band up, the left band left, etc.).
export const SIDE_AXIS: Record<Side, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  top: { axis: 'y', sign: -1 },
  bottom: { axis: 'y', sign: 1 },
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
};

export const ALL_SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
export const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

// Sides a drag affects, by modifier: Shift → all four, Alt/Option → the dragged
// side + its opposite, otherwise just the dragged side. All affected sides are
// set to the same value (they equalise as you drag).
export function affectedSides(side: Side, event: { shiftKey: boolean; altKey: boolean }): Side[] {
  if (event.shiftKey) {
    return ALL_SIDES;
  }
  if (event.altKey) {
    return [side, OPPOSITE[side]];
  }
  return [side];
}

// The props of `sides` alongside `prop`, which names `side` (`padding-right` →
// `padding-`, the bare inset `right` → ``). Only sides share a prefix this way,
// so anything else stays a one-property edit.
export function siblingProps(prop: string, side: Side, sides: Side[]): string[] {
  if (!prop.endsWith(side)) {
    return [prop];
  }
  const prefix = prop.slice(0, prop.length - side.length);
  return sides.map((sibling) => `${prefix}${sibling}`);
}

// CSS px of value change per screen px dragged. 0.5 ≈ half-speed for fine control.
export const DRAG_SENSITIVITY = 0.5;

/** Split a length into its number and unit (unit '' when absent / non-numeric). */
export function parseAmountUnit(value: string): { amount: number; unit: string } {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (!match) {
    return { amount: 0, unit: '' };
  }
  return { amount: parseFloat(match[1] ?? ''), unit: (match[2] ?? '').toLowerCase() };
}

/** How many CSS px one unit spans, so a drag in screen px maps to a value delta. */
export function pxPerUnit(unit: string): number {
  switch (unit) {
    case 'px':
      return 1;
    case 'rem':
    case 'em':
      return 16;
    case 'pt':
      return 96 / 72;
    default:
      return 16; // %, vw, … — approximate so the drag still feels reasonable
  }
}

/** Round to a sensible precision for the unit and re-attach it. */
export function formatLength(amount: number, unit: string): string {
  const rounded = unit === 'px' || unit === '%' ? Math.round(amount) : Math.round(amount * 100) / 100;
  return `${rounded}${unit}`;
}

// The frame band, drawn exactly like Webflow's spacing control: four shaded
// trapezoids clipped by a mask that subtracts a rounded inner rect which is 1px
// larger than the centre hole on every side — so its rounded corners bite into
// the band and the trapezoids meet a rounded (not square) inner corner. Fixed
// geometry (viewBox == Webflow's) with preserveAspectRatio="none" scales the SVG
// to the frame while the frame keeps Webflow's aspect ratio, so nothing distorts.
export const FRAMES = {
  // w/h: viewBox size · band: side thickness · or/ir: outer/inner corner radius
  // mask: the subtracted inner rect (1px larger than the w-2·band × h-2·band hole)
  margin: {
    w: 224,
    h: 112,
    or: 4,
    ir: 4,
    mask: { x: 35, y: 23, w: 154, h: 66 },
    paths: {
      top: 'm0,0 h224 l-36,24 h-152 l-36,-24z',
      right: 'm224,0 v112 l-36,-24 v-64 l36,-24z',
      bottom: 'm0,112 h224 l-36,-24 h-152 l-36,24z',
      left: 'm0,0 v112 l36,-24 v-64 l-36,-24z',
    },
  },
  padding: {
    w: 150,
    h: 60,
    or: 2,
    ir: 2,
    mask: { x: 35, y: 23, w: 80, h: 14 },
    paths: {
      top: 'm0,0 h150 l-36,24 h-78 l-36,-24z',
      right: 'm150,0 v60 l-36,-24 v-12 l36,-24z',
      bottom: 'm0,60 h150 l-36,-24 h-78 l-36,24z',
      left: 'm0,0 v60 l36,-24 v-12 l-36,-24z',
    },
  },
  // Webflow's position/inset frame — a single 172×56 band with a 36×24 edge and a
  // 100×8 centre hole (the exact geometry from Webflow's position control SVG).
  position: {
    w: 172,
    h: 56,
    or: 4,
    ir: 4,
    mask: { x: 35, y: 23, w: 102, h: 10 },
    paths: {
      top: 'm0,0 h172 l-36,24 h-100 l-36,-24z',
      right: 'm172,0 v56 l-36,-24 v-8 l36,-24z',
      bottom: 'm0,56 h172 l-36,-24 h-100 l-36,24z',
      left: 'm0,0 v56 l36,-24 v-8 l-36,-24z',
    },
  },
} as const;

export type FrameKey = keyof typeof FRAMES;

export type FillProps = {
  frame: FrameKey;
  /** Maps a side to its CSS property (`margin-top`, `padding-top`, or plain `top`). */
  propFor: (side: Side) => string;
  /**
   * Grows inward (padding): flip the drag direction and clamp at 0. Insets & margins grow
   * outward.
   */
  inward?: boolean;
  read: Read;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  // Report the in-flight drag value (affected props + display string) so the
  // matching labels mirror it live; onLiveEnd clears it on release.
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
};

// Dragging a side, wherever the press lands: the band around it or the number
// written on it. Both are the same gesture — press, move along the side's axis,
// let go — so both run this. The value keeps the unit already in the field (rem
// when the field is empty or unitless), the canvas is written on every rAF, and
// the file once on release.
//
// `threshold` is what tells a drag from a press. The bands are nothing but drag
// handles, so they start at once; a number is also a button that opens the
// editor, so it waits a few pixels before it becomes a drag, and reports
// afterwards whether it did (`wasDrag`) so the click that follows can be
// ignored.
export type SideDragOptions = {
  propFor: (side: Side) => string;
  inward: boolean;
  /** The box the drag is drawn in on the canvas — see useSideHover. */
  kind: 'padding' | 'margin';
  read: Read;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
  threshold?: number;
};

// While a drag is on, the canvas hears its value from the drag (reportDrag) and
// not from the hover, which would report what the file still says: the band's
// label stayed on the old value for the whole drag. One drag at a time, so one
// flag, written only by reportDrag and by a drag that unmounts mid-flight.
let dragReporting = false;

// Tell the canvas what a drag holds for `sides`: the label to write on each
// band and, while the drag is live, the value to size it from. Only a real
// padding or margin side can be sized ahead of the page; an inset (`top` on a
// positioned element) is labelled but measured. On release the label stays and
// the size is measured again, which by then is the same number.
function reportDrag(
  box: { readonly kind: 'padding' | 'margin'; readonly propFor: (side: Side) => string },
  sides: readonly Side[],
  held: { readonly value: string; readonly live: boolean },
): void {
  dragReporting = held.live;
  const labels: Record<string, string> = {};
  const ahead: Record<string, string> = {};
  for (const side of sides) {
    labels[side] = held.value;
    if (held.live && /^(padding|margin)-/.test(box.propFor(side))) {
      ahead[side] = held.value;
    }
  }
  getHost().onSpacingHover?.({
    kind: box.kind,
    sides: [...sides],
    labels,
    ...(Object.keys(ahead).length > 0 ? { live: ahead } : {}),
  });
}

// What a drag tells the canvas, from its first frame to its release.
function useDragReport(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  box: { readonly kind: 'padding' | 'margin'; readonly propFor: (side: Side) => string },
) {
  // A drag that goes away mid-flight must not leave the hover silenced.
  useEffect(
    () => () => {
      if (dragRef.current) {
        dragReporting = false;
      }
    },
    [dragRef],
  );
  return {
    // The canvas, on the same frame as the labels: the band it draws for these
    // sides is labelled and sized from this value, so it passes through every
    // number the panel shows rather than the ones the page had time to lay out.
    live: (drag: SideDrag, display: string): void => {
      const value = display.replace(/ !important$/, '');
      reportDrag(box, affectedSides(drag.side, drag), { value, live: true });
    },
    // The last value stays on the band; its size goes back to being measured.
    // The hover takes over from here.
    release: (drag: SideDrag, value: string): void => {
      reportDrag(box, affectedSides(drag.side, drag), { value, live: false });
    },
  };
}

export function useSideDrag({ propFor, inward, kind, read, busy, setProp, liveSetProp, onLive, onLiveEnd, threshold = 0 }: SideDragOptions) {
  const dragRef = useRef<SideDrag | undefined>(undefined);
  const dragged = useRef(false);
  const report = useDragReport(dragRef, { kind, propFor });
  const frame = useLiveFrame(dragRef, liveSetProp, (props, display, drag) => {
    onLive(props, display);
    report.live(drag, display);
  });

  const apply = useDragApply({
    dragRef,
    draggedRef: dragged,
    propFor,
    inward,
    liveSetProp,
    frame,
  });
  useDragModifiers(dragRef, apply);

  const onPointerDown = (side: Side) => (event: React.PointerEvent) => {
    if (busy) {
      return;
    }
    // A band has nothing else to be, so it takes the press outright. A number is
    // a button: leave it its focus and its click until the pointer moves.
    if (threshold === 0) {
      event.preventDefault();
    }
    const shown = displayOf(read(propFor(side)));
    dragRef.current = startSideDrag({ side, shown, inward, threshold, event });
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (followPointer(dragRef, event, threshold)) {
      apply();
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    frame.cancel();
    if (drag.active) {
      // One last apply: the sides the modifiers name at the moment of release
      // are the sides that get written.
      followPointer(dragRef, event, threshold);
      apply();
      frame.cancel();
    }
    const value = drag.active ? dragValue(drag, { inward }) : undefined;
    dragRef.current = undefined;
    // Pressed and let go without moving: that was a click, and the click handler
    // is the one that should hear about it.
    if (value === undefined) {
      return;
    }
    onLiveEnd();
    report.release(drag, value);
    drag.props.forEach((prop) => setProp(prop, value, drag.important));
  };

  return { onPointerDown, onPointerMove, onPointerUp, wasDrag: () => dragged.current };
}

// Everything the drag does on any change — the pointer moving, or a modifier
// going down or up under a pointer that is standing still.
export function useDragApply({
  dragRef,
  draggedRef,
  propFor,
  inward,
  liveSetProp,
  frame,
}: {
  dragRef: React.MutableRefObject<SideDrag | undefined>;
  draggedRef: React.MutableRefObject<boolean>;
  propFor: (side: Side) => string;
  inward: boolean;
  liveSetProp: LiveSetProp;
  frame: { queue: (value: string) => void };
}) {
  return () => {
    const drag = dragRef.current;
    if (!drag?.active) {
      return;
    }
    draggedRef.current = true;
    const next = affectedSides(drag.side, drag).map((side) => propFor(side));
    // A side the modifier just dropped goes back to what it was. It was only
    // ever previewed — nothing has been written to the file yet — so putting it
    // back is undoing the live write, not another edit.
    for (const prop of drag.written) {
      if (!next.includes(prop)) {
        liveSetProp(prop, undefined, drag.important);
        drag.written.delete(prop);
      }
    }
    drag.props = next;
    for (const prop of next) {
      drag.written.add(prop);
    }
    const value = dragValue(drag, { inward });
    // Labels and the canvas share one frame. Pointer events can arrive faster
    // than paint, and rendering the panel between those paints only adds lag.
    frame.queue(value);
  };
}

// One drag in flight, from the press to the release.
export type SideDrag = {
  side: Side;
  /** The props being written right now — the modifiers decide, and they
   *  are free to change halfway through. */
  props: string[];
  /** Every prop this drag has written live, so one that stops being
   *  affected can be put back. */
  written: Set<string>;
  unit: string;
  startAmount: number;
  axis: 'x' | 'y';
  sign: 1 | -1;
  startX: number;
  startY: number;
  /** Where the pointer is now, so a modifier pressed without moving still
   *  has somewhere to apply. */
  x: number;
  y: number;
  shiftKey: boolean;
  altKey: boolean;
  important: boolean;
  /** Past the threshold — this is a drag now, not a press. */
  active: boolean;
};

// The drag as it stands at the press: the side's current value (rem when the
// field is empty or unitless) and the direction that grows it.
export function startSideDrag({
  side,
  shown,
  inward,
  threshold,
  event,
}: {
  side: Side;
  shown: Display;
  inward: boolean;
  threshold: number;
  event: React.PointerEvent;
}): SideDrag {
  const { amount, unit } = parseAmountUnit(shown.value);
  const sideAxis = SIDE_AXIS[side];
  // Outward grows away from centre; inward (padding) drags the opposite way
  // (Webflow flips the resize cursors to match).
  const sign: 1 | -1 = inward ? (sideAxis.sign === 1 ? -1 : 1) : sideAxis.sign;
  return {
    side,
    props: [],
    written: new Set(),
    unit: unit || 'rem',
    startAmount: amount,
    axis: sideAxis.axis,
    sign,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    important: shown.important,
    active: threshold === 0,
  };
}

// The value the drag has reached, formatted in its unit. Padding can't go
// negative; insets and margins can.
export function dragValue(drag: SideDrag, { inward }: { inward: boolean }): string {
  assert(drag.unit !== '', 'dragValue: a drag always carries a unit (rem when none was set)');
  const px = (drag.axis === 'x' ? drag.x - drag.startX : drag.y - drag.startY) * drag.sign;
  const next = drag.startAmount + (px * DRAG_SENSITIVITY) / pxPerUnit(drag.unit);
  if (inward && next < 0) {
    return formatLength(0, drag.unit);
  }
  return formatLength(next, drag.unit);
}

// Records where the pointer and the modifiers are now. Returns whether the drag
// should apply: it is active, or this move just carried it past the threshold.
export function followPointer(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean },
  threshold: number,
): boolean {
  const drag = dragRef.current;
  if (!drag) {
    return false;
  }
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.shiftKey = event.shiftKey;
  drag.altKey = event.altKey;
  if (drag.active) {
    return true;
  }
  const far = Math.abs(event.clientX - drag.startX) >= threshold || Math.abs(event.clientY - drag.startY) >= threshold;
  if (far) {
    drag.active = true;
  }
  return far;
}

// The canvas write, throttled to one per animation frame: the latest queued
// value is written to every prop the drag holds when the frame comes round.
export function useLiveFrame(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  liveSetProp: LiveSetProp,
  onLive: (props: string[], display: string, drag: SideDrag) => void,
) {
  const raf = useRef<number | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const cancel = () => {
    if (raf.current !== undefined) {
      cancelAnimationFrame(raf.current);
      raf.current = undefined;
    }
    pending.current = undefined;
  };
  useEffect(() => cancel, []);
  const flush = () => {
    raf.current = undefined;
    const drag = dragRef.current;
    const value = pending.current;
    if (drag && value !== undefined) {
      onLive(drag.props, withImportant({ value, important: drag.important }), drag);
      // Linked sides are one visual edit. Sending them together lets the style
      // writer serialize the shared stylesheet once instead of once per side.
      liveSetProp(drag.props, value, drag.important);
    }
  };
  const queue = (value: string) => {
    pending.current = value;
    if (raf.current === undefined) {
      raf.current = requestAnimationFrame(flush);
    }
  };
  return { queue, cancel };
}

// While a drag is live, Shift and Option are read as they are pressed rather
// than as they were at the start: reach for one mid-drag and the other sides
// join in from that moment.
export function useDragModifiers(dragRef: React.MutableRefObject<SideDrag | undefined>, apply: () => void): void {
  // The listeners below are registered once; this keeps them calling the
  // current `apply`, with the props of the render that is on screen.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (drag.shiftKey === shiftKey && drag.altKey === altKey) {
        return;
      }
      drag.shiftKey = shiftKey;
      drag.altKey = altKey;
      applyRef.current();
    };
    // Read off any key event, not just the modifiers themselves, and through
    // the shared store — see the hover hook below for both reasons.
    const onKey = (event: KeyboardEvent) => setModifiers({ shiftKey: event.shiftKey, altKey: event.altKey });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    const offModifiers = onModifiers(follow);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      offModifiers();
    };
  }, [dragRef]);
}

// Pointing at a side, as opposed to changing it. The canvas draws what the
// pointer is over — the strip of the page that side is holding open — so the
// panel has to say which sides those are, and keep saying it while Shift or
// Option change the answer under a pointer that hasn't moved.
export function useSideHover({ propFor, kind, read }: { propFor: (side: Side) => string; kind: 'padding' | 'margin'; read: Read }) {
  const overRef = useRef<HoveredSide | undefined>(undefined);

  const report = () => {
    if (dragReporting) {
      return; // The drag is saying what the band shows.
    }
    const hovered = overRef.current;
    if (!hovered) {
      getHost().onSpacingHover?.(undefined);
      return;
    }
    const sides = affectedSides(hovered.side, hovered);
    const labels: Record<string, string> = {};
    for (const side of sides) {
      try {
        const shown = displayOf(read(propFor(side)));
        labels[side] = shown.present ? shown.value : '0';
      } catch {
        // A value that can't be read is a missing label, not a missing band.
      }
    }
    getHost().onSpacingHover?.({ kind, sides, labels });
  };
  useHoverModifiers(overRef, report);

  return {
    onEnter: (side: Side) => (event: React.MouseEvent | React.PointerEvent) => {
      // A modifier held before the pointer arrived counts: the pointer event
      // knows what this window saw, the store knows what the canvas saw too.
      const held = getModifiers();
      overRef.current = {
        side,
        shiftKey: event.shiftKey || held.shiftKey,
        altKey: event.altKey || held.altKey,
      };
      report();
    },
    onLeave: () => {
      if (!overRef.current) {
        return;
      }
      overRef.current = undefined;
      report();
    },
    /** Follow a modifier held while the pointer moves within the same side. */
    onOver: (event: React.MouseEvent | React.PointerEvent) => {
      const hovered = overRef.current;
      if (!hovered) {
        return;
      }
      if (hovered.shiftKey === event.shiftKey && hovered.altKey === event.altKey) {
        return;
      }
      hovered.shiftKey = event.shiftKey;
      hovered.altKey = event.altKey;
      report();
    },
  };
}

// The side under the pointer, with the modifiers held while it is there.
export type HoveredSide = { side: Side; shiftKey: boolean; altKey: boolean };

// Keeps the hovered sides following Shift and Option while the pointer stands
// still, and clears the canvas when the panel goes away mid-hover.
export function useHoverModifiers(overRef: React.MutableRefObject<HoveredSide | undefined>, report: () => void): void {
  // The listener below is registered once; this keeps it calling the current
  // report, which reads the values as they are now rather than as they were when
  // the panel first rendered.
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const hovered = overRef.current;
      if (!hovered) {
        return;
      }
      if (hovered.shiftKey === shiftKey && hovered.altKey === altKey) {
        return;
      }
      hovered.shiftKey = shiftKey;
      hovered.altKey = altKey;
      reportRef.current();
    };
    // Every key event, not only the modifier keys themselves: what is wanted is
    // the state of Shift and Option right now, and reading it off whatever
    // event just happened means a missed keyup (focus moved for a moment, a
    // shortcut ate the event) is corrected by the next one rather than leaving
    // the canvas lit up for a modifier nobody is holding.
    //
    // Captured rather than bubbled: a field in the panel that stops a key event
    // from travelling must not stop the canvas from following the modifier. And
    // the answer goes through the shared store, because the other place these
    // are pressed is the canvas — see setModifiers.
    const onKey = (event: KeyboardEvent) => setModifiers({ shiftKey: event.shiftKey, altKey: event.altKey });
    const onBlur = () => setModifiers({ shiftKey: false, altKey: false });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    const offModifiers = onModifiers(follow);
    // Leaving the panel entirely (or unmounting mid-hover) must not leave the
    // canvas lit up with nothing pointing at it.
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      offModifiers();
      if (overRef.current) {
        overRef.current = undefined;
        getHost().onSpacingHover?.(undefined);
      }
    };
  }, [overRef]);
}

// Each trapezoid is also a drag handle: hovering brightens it (CSS), and dragging
// along its axis grows/shrinks that side's value.
export function SpacingFill({ frame, inward = false, ...dragOptions }: FillProps) {
  const geometry = FRAMES[frame];
  const maskId = 'sp-' + useId().replace(/:/g, '');
  const kind = inward ? 'padding' : 'margin';
  const { onPointerDown, onPointerMove, onPointerUp } = useSideDrag({
    ...dragOptions,
    inward,
    kind,
  });
  const hover = useSideHover({ propFor: dragOptions.propFor, kind, read: dragOptions.read });

  return (
    <svg className="embed-editor_spacing-fill" viewBox={`0 0 ${geometry.w} ${geometry.h}`} preserveAspectRatio="none" aria-hidden="true">
      <mask id={maskId} maskContentUnits="userSpaceOnUse">
        <rect x="0" y="0" width={geometry.w} height={geometry.h} rx={geometry.or} ry={geometry.or} fill="#fff" />
        <rect x={geometry.mask.x} y={geometry.mask.y} width={geometry.mask.w} height={geometry.mask.h} rx={geometry.ir} ry={geometry.ir} fill="#000" />
      </mask>
      <g mask={`url(#${maskId})`}>
        {(['top', 'right', 'bottom', 'left'] satisfies Side[]).map((side) => (
          <path
            key={side}
            className={`embed-editor_spacing-tri is-${side}`}
            d={geometry.paths[side]}
            onPointerDown={onPointerDown(side)}
            onPointerMove={(event) => {
              hover.onOver(event);
              onPointerMove(event);
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={hover.onEnter(side)}
            onPointerLeave={hover.onLeave}
          />
        ))}
      </g>
    </svg>
  );
}
