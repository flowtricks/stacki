// Drag-to-reorder for a list split into sections (the AI panel's chat list): an item moves
// within its section or into another one, with a drop line showing where it will land, edge
// auto-scroll while the pointer is near the top or bottom, and Alt+Up / Alt+Down as the
// keyboard way to do the same thing.
//
// How a caller uses it:
//   const drag = useSectionedDrag({ sections, onMove });
//   <div ref={drag.containerRef} className="the scrolling list">
//     <section {...drag.sectionProps(section.id)}> header, then for each item:
//       {drag.isDropBefore(item.id) && <DropLine />}   // DropLine.tsx draws the line
//       <button {...drag.itemProps(item.id)}> ... </button>
//     {drag.isDropAtEnd(section.id) && <DropLine />}
// The container is the element that scrolls. Each section element contains its header and
// its items, which is what lets a pointer over a header count as "start of this section".
//
// A press never starts a drag: the pointer has to travel DRAG_START_PX first, so an
// ordinary click still opens the row; a drag that happened swallows the click that ends it.
// A press on a nested control (a button inside the row) is left to that control unless it
// carries data-drag-through. Escape cancels a drag in progress.
//
// The drop is decided by resolveDrop (sectionedDragModel.ts), which refuses a drop on the
// item itself, into a collapsed section, or where nothing would change; the line is drawn
// only for a drop that would move something.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefCallback } from 'react';
import { assert } from '../../shared/core/assert';
import { usePointerDrag } from './usePointerDrag';
import { assertDragSections, locateDrop, resolveDrop, stepTarget } from './sectionedDragModel';
import type { DragSection, DropMove, DropTarget, RowBox, SectionBox } from './sectionedDragModel';

export type { DragSection, DropMove, DropTarget } from './sectionedDragModel';

/** How far the pointer must travel from the press before it is a drag and not a click. */
export const DRAG_START_PX = 5;
// How close to the container's top or bottom edge scrolling starts, and its fastest step per frame.
const AUTOSCROLL_EDGE_PX = 32;
const AUTOSCROLL_STEP_PX_MAX = 16;
// Frames the scroll loop may run for one drag (ten minutes at 60 frames a second).
const AUTOSCROLL_FRAMES_MAX = 36_000;
const INTERACTIVE = 'button, input, textarea, select, a, [contenteditable="true"]';

export interface SectionedDragOptions {
  readonly sections: readonly DragSection[];
  readonly onMove: (move: DropMove) => void;
  readonly disabled?: boolean;
}

interface Press {
  readonly itemId: string;
  readonly x: number;
  readonly y: number;
  active: boolean;
  cancelled: boolean;
  pointerY: number;
  target: DropTarget | undefined;
}

export function useSectionedDrag({ sections, onMove, disabled = false }: SectionedDragOptions) {
  assertDragSections(sections);
  const container = useRef<HTMLElement | undefined>(undefined);
  const press = useRef<Press | undefined>(undefined);
  const swallowClick = useRef(false);
  const focusAfterMove = useRef<string | undefined>(undefined);
  const latest = useRef({ sections, onMove });
  latest.current = { sections, onMove };
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [drop, setDrop] = useState<DropTarget | undefined>(undefined);
  const startPointerDrag = usePointerDrag();
  const containerRef = useCallback<RefCallback<HTMLElement>>((element) => {
    container.current = element ?? undefined;
  }, []);

  // A keyboard move can carry the item into another section, where it is a new element:
  // focus follows the item, or the keyboard user loses their place.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === undefined) {
      return;
    }
    focusAfterMove.current = undefined;
    const element = container.current?.querySelector<HTMLElement>(`[data-drag-item="${escapeAttribute(id)}"]`);
    element?.focus({ preventScroll: false });
  }, [sections]);

  const track = useCallback(() => {
    const element = container.current;
    const current = press.current;
    if (element === undefined || current === undefined) {
      return;
    }
    const target = locateDrop(readLayout(element, latest.current.sections), current.pointerY);
    const decision = target === undefined ? undefined : resolveDrop(latest.current.sections, current.itemId, target);
    current.target = decision?.kind === 'move' ? target : undefined;
    setDrop(current.target);
  }, []);

  useAutoscroll({ container, press, dragging, track });

  const finish = useCallback(() => {
    const current = press.current;
    press.current = undefined;
    setDragging(undefined);
    setDrop(undefined);
    if (current === undefined || !current.active) {
      return;
    }
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    if (current.cancelled || current.target === undefined) {
      return;
    }
    const decision = resolveDrop(latest.current.sections, current.itemId, current.target);
    if (decision.kind === 'move') {
      latest.current.onMove(decision.move);
    }
  }, []);

  useEffect(() => {
    if (dragging === undefined) {
      return undefined;
    }
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && press.current !== undefined) {
        press.current.cancelled = true;
        setDrop(undefined);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [dragging]);

  const itemProps = (itemId: string) => ({
    'data-drag-item': itemId,
    'data-dragging': dragging === itemId ? true : undefined,
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
      if (disabled || event.button !== 0) {
        return;
      }
      const control = (event.target instanceof Element ? event.target.closest(INTERACTIVE) : undefined) ?? undefined;
      if (control !== undefined && control !== event.currentTarget && !control.hasAttribute('data-drag-through')) {
        return;
      }
      const started: Press = { itemId, x: event.clientX, y: event.clientY, active: false, cancelled: false, pointerY: event.clientY, target: undefined };
      press.current = started;
      startPointerDrag(event, {
        onMove: (move) => {
          if (press.current !== started) {
            return;
          }
          if (!started.active) {
            if (Math.hypot(move.clientX - started.x, move.clientY - started.y) < DRAG_START_PX) {
              return;
            }
            started.active = true;
            setDragging(itemId);
          }
          started.pointerY = move.clientY;
          track();
        },
        onEnd: finish,
      });
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>): void => {
      if (swallowClick.current) {
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (disabled || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }
      // A key typed inside a nested field belongs to the field.
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]') !== null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target = stepTarget(latest.current.sections, itemId, event.key === 'ArrowUp' ? 'up' : 'down');
      const decision = target === undefined ? undefined : resolveDrop(latest.current.sections, itemId, target);
      if (decision?.kind === 'move') {
        focusAfterMove.current = itemId;
        latest.current.onMove(decision.move);
      }
    },
  });

  return {
    containerRef,
    /** The id of the item being dragged, while a drag is in progress. */
    dragging,
    /** Where the item would land now; undefined when the pointer is somewhere a drop would change nothing. */
    drop,
    itemProps,
    sectionProps: (sectionId: string) => ({ 'data-drag-section': sectionId }),
    isDropBefore: (itemId: string): boolean => drop?.beforeId === itemId,
    isDropAtEnd: (sectionId: string): boolean => drop !== undefined && drop.sectionId === sectionId && drop.beforeId === undefined,
  };
}

interface AutoscrollInput {
  readonly container: { readonly current: HTMLElement | undefined };
  readonly press: { readonly current: Press | undefined };
  readonly dragging: string | undefined;
  readonly track: () => void;
}

// While a drag runs, a pointer parked near an edge keeps scrolling the list; the drop is
// re-evaluated after each step because the rows moved under a still pointer.
function useAutoscroll({ container, press, dragging, track }: AutoscrollInput): void {
  useEffect(() => {
    if (dragging === undefined) {
      return undefined;
    }
    let frame = 0;
    let frames = 0;
    const step = (): void => {
      frames += 1;
      const element = container.current;
      const current = press.current;
      if (element !== undefined && current !== undefined) {
        const bounds = element.getBoundingClientRect();
        const delta = autoscrollDelta(current.pointerY, bounds.top, bounds.bottom);
        if (delta !== 0) {
          element.scrollTop += delta;
          track();
        }
      }
      if (frames < AUTOSCROLL_FRAMES_MAX) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragging, container, press, track]);
}

/** Pixels to scroll this frame: negative near the top edge, positive near the bottom, faster the closer to it. */
export function autoscrollDelta(pointerY: number, top: number, bottom: number): number {
  assert(bottom >= top, 'autoscrollDelta: bottom is not above top');
  const intoTop = top + AUTOSCROLL_EDGE_PX - pointerY;
  if (intoTop > 0) {
    return -Math.min(AUTOSCROLL_STEP_PX_MAX, Math.ceil((intoTop / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_STEP_PX_MAX));
  }
  const intoBottom = pointerY - (bottom - AUTOSCROLL_EDGE_PX);
  if (intoBottom > 0) {
    return Math.min(AUTOSCROLL_STEP_PX_MAX, Math.ceil((intoBottom / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_STEP_PX_MAX));
  }
  return 0;
}

function readLayout(root: HTMLElement, sections: readonly DragSection[]): readonly SectionBox[] {
  const boxes: SectionBox[] = [];
  for (const section of sections) {
    const element = root.querySelector<HTMLElement>(`[data-drag-section="${escapeAttribute(section.id)}"]`);
    if (element === null) {
      continue;
    }
    const bounds = element.getBoundingClientRect();
    const rows: RowBox[] = [];
    for (const itemId of section.itemIds) {
      const row = element.querySelector<HTMLElement>(`[data-drag-item="${escapeAttribute(itemId)}"]`);
      if (row !== null) {
        const rowBounds = row.getBoundingClientRect();
        rows.push({ id: itemId, top: rowBounds.top, bottom: rowBounds.bottom });
      }
    }
    boxes.push({ id: section.id, top: bounds.top, bottom: bounds.bottom, collapsed: section.collapsed, rows });
  }
  return boxes;
}

function escapeAttribute(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
