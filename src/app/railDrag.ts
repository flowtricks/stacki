// Press-and-drag for the rail's buttons, for both rails (Desktop's LeftRail.tsx, Studio's EditorRail.tsx).
//
// A press becomes a drag only after RAIL_DRAG_THRESHOLD_PX of movement, so a click still opens its panel.
// The button captures the pointer, so the drag keeps going wherever the pointer is and ends in one place:
// release over a slot drops there, release outside the rail, Escape, a lost capture or a blur cancels.
// The button keeps its place, dimmed, and a ghost follows the pointer; the ghost moves by a direct style
// write, and React renders again only when the slot under the pointer changes. Rows are measured once per
// drag (the layout holds still until the drop), so moving the pointer never reads layout.
import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { exceedsThreshold, slotAt, type RailMeasure, type RailPoint, type RailRow, type RailSlot } from './railDragModel';
import { RAIL_GROUPS, type RailGroup } from './railOrder';

/** What the rail draws while a drag is on. */
export interface RailDragView {
  readonly id: string;
  /** The slot under the pointer, or undefined while it is outside the rail (a release there cancels). */
  readonly slot: RailSlot | undefined;
  /** The rail's top edge, to place the line inside it. */
  readonly railTop: number;
}

export interface RailDragHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface RailDragOptions {
  readonly railRef: RefObject<HTMLElement>;
  /** Called once when a press becomes a drag, before anything is drawn for it. */
  readonly onStart: () => void;
  /** Called on a release over a slot. Not called for a cancel. */
  readonly onDrop: (id: string, slot: RailSlot) => void;
}

interface Press {
  readonly id: string;
  readonly pointerId: number;
  readonly start: RailPoint;
  readonly offset: RailPoint;
  measure: RailMeasure | undefined;
  dragging: boolean;
}

export interface RailDrag {
  readonly view: RailDragView | undefined;
  /** The ghost element's ref: the hook moves it, the rail draws it. */
  readonly ghostRef: RefObject<HTMLDivElement>;
  readonly handlersFor: (id: string) => RailDragHandlers;
  /** True once after a drag ends: the click that follows its release is not a choice of the panel. */
  readonly takeSuppressedClick: () => boolean;
}

export function useRailDrag(options: RailDragOptions): RailDrag {
  const [view, setView] = useState<RailDragView | undefined>(undefined);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<Press | undefined>(undefined);
  const suppressRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback((): void => {
    const press = pressRef.current;
    pressRef.current = undefined;
    setView(undefined);
    if (press?.dragging === true) {
      // The click that follows a release on the same button comes in the same task; a timer clears the flag if none does.
      suppressRef.current = true;
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    }
  }, []);

  // Escape and a window blur cancel while a drag is on.
  const dragging = view !== undefined;
  useEffect(() => {
    if (!dragging) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', finish);
    };
  }, [dragging, finish]);

  const handlersFor = useCallback(
    (id: string): RailDragHandlers => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || !event.isPrimary || pressRef.current !== undefined) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        pressRef.current = {
          id,
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          offset: { x: event.clientX - rect.left, y: event.clientY - rect.top },
          measure: undefined,
          dragging: false,
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* noop: a pointer that cannot be captured still drags while it stays over the rail */
        }
      },
      onPointerMove: (event) => {
        const press = pressRef.current;
        if (press === undefined || press.pointerId !== event.pointerId) {
          return;
        }
        const point = { x: event.clientX, y: event.clientY };
        if (!press.dragging) {
          if (!exceedsThreshold(press.start, point)) {
            return;
          }
          press.dragging = true;
          optionsRef.current.onStart();
          // Drawn at once, so the placeholder of an empty bottom list exists when the rows are measured.
          flushSync(() => setView({ id: press.id, slot: undefined, railTop: 0 }));
          press.measure = measureRail(optionsRef.current.railRef.current ?? undefined);
        }
        moveGhost(ghostRef.current ?? undefined, point, press.offset);
        const measure = press.measure;
        if (measure === undefined) {
          return;
        }
        const slot = slotAt(measure, point);
        setView((previous) => (previous !== undefined && sameSlot(previous.slot, slot) ? previous : { id: press.id, slot, railTop: measure.rail.top }));
      },
      onPointerUp: (event) => {
        const press = pressRef.current;
        if (press === undefined || press.pointerId !== event.pointerId) {
          return;
        }
        const measure = press.measure;
        const slot = press.dragging && measure !== undefined ? slotAt(measure, { x: event.clientX, y: event.clientY }) : undefined;
        finish();
        if (slot !== undefined) {
          optionsRef.current.onDrop(press.id, slot);
        }
      },
      onPointerCancel: finish,
      onLostPointerCapture: (event) => {
        const press = pressRef.current;
        // A release ends the press first; a capture lost before one is a cancel.
        if (press !== undefined && press.pointerId === event.pointerId && press.dragging) {
          finish();
        }
      },
    }),
    [finish],
  );

  const takeSuppressedClick = useCallback((): boolean => {
    const was = suppressRef.current;
    suppressRef.current = false;
    return was;
  }, []);

  return { view, ghostRef, handlersFor, takeSuppressedClick };
}

function moveGhost(ghost: HTMLElement | undefined, point: RailPoint, offset: RailPoint): void {
  if (ghost !== undefined) {
    ghost.style.setProperty('transform', `translate(${point.x - offset.x}px, ${point.y - offset.y}px)`);
  }
}

function sameSlot(left: RailSlot | undefined, right: RailSlot | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.group === right.group && left.beforeId === right.beforeId && left.lineY === right.lineY;
}

// Reads the rail once: each list's draggable buttons and the two zones' edges. The bottom zone starts at its
// first button or, for an empty list, at its placeholder (`.rail-slot-empty`), which the rail draws for a drag.
function measureRail(rail: HTMLElement | undefined): RailMeasure | undefined {
  if (rail === undefined) {
    return undefined;
  }
  const box = rail.getBoundingClientRect();
  const rows: Record<RailGroup, RailRow[]> = { top: [], bottom: [] };
  for (const group of RAIL_GROUPS) {
    for (const button of rail.querySelectorAll<HTMLElement>(`[data-rail-group="${group}"]`)) {
      const rect = button.getBoundingClientRect();
      rows[group].push({ id: button.dataset['railId'] ?? '', top: rect.top, bottom: rect.bottom });
    }
  }
  const anchor = rail.querySelector<HTMLElement>('.rail-anchor')?.getBoundingClientRect();
  const placeholder = rail.querySelector<HTMLElement>('.rail-slot-empty')?.getBoundingClientRect();
  const bottomStartY = rows.bottom[0]?.top ?? placeholder?.top ?? anchor?.top ?? box.bottom;
  // The top column ends at the last flow child before the anchored list.
  let topEndY = rows.top.at(-1)?.bottom ?? box.top;
  for (const child of rail.children) {
    if (child instanceof HTMLElement && !child.classList.contains('rail-anchor') && child.dataset['railFloat'] === undefined) {
      topEndY = Math.max(topEndY, child.getBoundingClientRect().bottom);
    }
  }
  return { rail: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, rows, topEndY: Math.min(topEndY, bottomStartY), bottomStartY };
}
