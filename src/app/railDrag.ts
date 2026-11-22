// Press-and-drag for the rail's buttons and for the Settings panel's root rows (LeftRail.tsx, SettingsRailRows.tsx).
//
// A press becomes a drag only after RAIL_DRAG_THRESHOLD_PX of movement, so a click still opens its panel.
// The pressed element captures the pointer, so the drag keeps going wherever the pointer is and ends in one place:
// release over a slot drops there, release elsewhere, Escape, a lost capture or a blur cancels.
// The item keeps its place, dimmed, and a ghost follows the pointer; the ghost moves by a direct style
// write, and React renders again only when the slot under the pointer changes. The rail is measured once per
// drag (it holds still until the drop), so moving the pointer never reads its layout.
//
// The two surfaces are one drag: whichever starts it, the view (which item, which slot) is shared through a
// module store, so the rail draws its line when a Settings row is dragged over it and the Settings list draws its
// line when a rail button is dragged over it. The Settings list may not be on screen when a rail drag starts:
// resting on the Settings button for RAIL_SPRING_MS opens it (`onSpring`), and the list is measured the first
// time a move finds it, then held, like the rail.
import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { assert } from '../../shared/core/assert';
import { exceedsThreshold, slotAt, type RailMeasure, type RailPoint, type RailRow, type RailSettingsZone, type RailSlot } from './railDragModel';
import { RAIL_GROUPS, type RailGroup } from './railOrder';

/** How long the pointer rests on the Settings button, mid-drag, before the Settings panel opens to drop between its rows. */
export const RAIL_SPRING_MS = 500;

/** Which surface a drag started on: that surface draws the ghost. */
export type RailDragOrigin = 'rail' | 'settings';

/** What the rail and the Settings list draw while a drag is on. */
export interface RailDragView {
  readonly id: string;
  readonly origin: RailDragOrigin;
  /** The slot under the pointer, or undefined while it is over no target (a release there cancels). */
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
  readonly origin: RailDragOrigin;
  /** The rail, when the caller holds it; the Settings list finds it in the document. */
  readonly railRef: RefObject<HTMLElement> | undefined;
  /** Whether the item may go into Settings: false for the items fixed to the rail. */
  readonly canEnterSettings: (id: string) => boolean;
  /** Called once when a press becomes a drag, before anything is drawn for it. */
  readonly onStart: () => void;
  /** Called after the pointer rests on the Settings button: the caller opens the Settings panel. */
  readonly onSpring: () => void;
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
  spring: ReturnType<typeof setTimeout> | undefined;
}

export interface RailDrag {
  /** The drag on now, from either surface. */
  readonly view: RailDragView | undefined;
  /** The ghost element's ref: the hook moves it, the surface the drag started on draws it. */
  readonly ghostRef: RefObject<HTMLDivElement>;
  readonly handlersFor: (id: string) => RailDragHandlers;
  /** True once after a drag ends: the click that follows its release is not a choice of the panel. */
  readonly takeSuppressedClick: () => boolean;
}

// The one drag of the window. Two surfaces subscribe (the rail and, while it is open, the Settings list); a
// few more for tests.
let sharedView: RailDragView | undefined;
const viewListeners = new Set<() => void>();
const VIEW_LISTENERS_MAX = 16;

function readView(): RailDragView | undefined {
  return sharedView;
}

function subscribeView(listener: () => void): () => void {
  assert(viewListeners.size < VIEW_LISTENERS_MAX, 'Rail drag listeners are bounded');
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

function writeView(next: RailDragView | undefined): void {
  if (sameView(sharedView, next)) {
    return;
  }
  sharedView = next;
  for (const listener of viewListeners) {
    listener();
  }
}

export function useRailDrag(options: RailDragOptions): RailDrag {
  const view = useSyncExternalStore(subscribeView, readView, readView);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<Press | undefined>(undefined);
  const suppressRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback((): void => {
    const press = pressRef.current;
    pressRef.current = undefined;
    if (press === undefined) {
      return;
    }
    clearTimeout(press.spring);
    if (press.dragging) {
      writeView(undefined);
      // The click that follows a release on the same element comes in the same task; a timer clears the flag if none does.
      suppressRef.current = true;
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    }
  }, []);

  // Escape and a window blur cancel while this surface's drag is on.
  const dragging = view !== undefined && view.origin === options.origin;
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
  // A surface that unmounts mid-drag (the rail button that moved into Settings) ends its own press.
  useEffect(() => finish, [finish]);

  const handlersFor = useCallback(
    (id: string): RailDragHandlers => ({
      onPointerDown: (event) => {
        // One drag at a time across both surfaces.
        if (event.button !== 0 || !event.isPrimary || pressRef.current !== undefined || sharedView !== undefined) {
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
          spring: undefined,
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* noop: a pointer that cannot be captured still drags while it stays over its surface */
        }
      },
      onPointerMove: (event) => {
        const press = pressRef.current;
        if (press === undefined || press.pointerId !== event.pointerId) {
          return;
        }
        const point = { x: event.clientX, y: event.clientY };
        const current = optionsRef.current;
        if (!press.dragging) {
          if (!exceedsThreshold(press.start, point)) {
            return;
          }
          press.dragging = true;
          current.onStart();
          // Drawn at once, so the placeholder of an empty bottom list exists when the rows are measured.
          flushSync(() => writeView({ id: press.id, origin: current.origin, slot: undefined, railTop: 0 }));
          press.measure = measureRail(railOf(current.railRef), current.canEnterSettings(press.id) ? press.id : undefined);
        }
        moveGhost(ghostRef.current ?? undefined, point, press.offset);
        if (press.measure !== undefined && press.measure.settings === undefined && current.canEnterSettings(press.id)) {
          press.measure = withSettingsZone(press.measure);
        }
        const measure = press.measure;
        if (measure === undefined) {
          return;
        }
        const slot = slotAt(measure, point);
        // Resting on the Settings button opens the panel once; moving off it before the delay forgets the rest.
        if (slot?.group !== 'settingsButton') {
          clearTimeout(press.spring);
          press.spring = undefined;
        } else if (press.spring === undefined) {
          press.spring = setTimeout(() => {
            if (pressRef.current === press && press.dragging) {
              optionsRef.current.onSpring();
            }
          }, RAIL_SPRING_MS);
        }
        writeView({ id: press.id, origin: current.origin, slot, railTop: measure.rail.top });
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

function railOf(railRef: RefObject<HTMLElement> | undefined): HTMLElement | undefined {
  if (railRef !== undefined) {
    return railRef.current ?? undefined;
  }
  return document.querySelector<HTMLElement>('.rail') ?? undefined;
}

// The Settings list is measured the first move that finds it on screen (it may open mid-drag), then held.
function withSettingsZone(measure: RailMeasure): RailMeasure {
  const list = document.querySelector<HTMLElement>('[data-rail-settings-list]') ?? undefined;
  return list === undefined ? measure : { ...measure, settings: measureSettings(list) };
}

// The zone reaches up into the lower half of the panel header, so the band above the first row (the body's 2px top
// padding, and the header just over it, where a person aims for "above the first row") drops before that row; and
// down to the list's foot, so the empty area under the rows appends. A sibling that is not above the list is ignored.
function measureSettings(list: HTMLElement): RailSettingsZone {
  const box = list.getBoundingClientRect();
  const header = list.previousElementSibling?.getBoundingClientRect();
  const top = header === undefined || header.bottom > box.top || header.bottom <= header.top ? box.top : Math.floor((header.top + header.bottom) / 2);
  const rows: RailRow[] = [];
  for (const row of list.querySelectorAll<HTMLElement>('[data-rail-group="settings"]')) {
    const rect = row.getBoundingClientRect();
    rows.push({ id: row.dataset['railId'] ?? '', top: rect.top, bottom: rect.bottom });
  }
  return { left: box.left, right: box.right, top, bottom: box.bottom, rows };
}

function moveGhost(ghost: HTMLElement | undefined, point: RailPoint, offset: RailPoint): void {
  if (ghost !== undefined) {
    ghost.style.setProperty('transform', `translate(${point.x - offset.x}px, ${point.y - offset.y}px)`);
  }
}

function sameView(left: RailDragView | undefined, right: RailDragView | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.id === right.id && left.origin === right.origin && left.railTop === right.railTop && sameSlot(left.slot, right.slot);
}

function sameSlot(left: RailSlot | undefined, right: RailSlot | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.group === 'settingsButton' || right.group === 'settingsButton') {
    return left.group === right.group;
  }
  return left.group === right.group && left.beforeId === right.beforeId && left.lineY === right.lineY;
}

// Reads the rail once: each list's draggable buttons and the two zones' edges. The bottom zone starts at its
// first button or, for an empty list, at its placeholder (`.rail-slot-empty`), which the rail draws for a drag.
// `intoSettingsId` is the dragged item when it may go into Settings: the Settings button is then a target too.
function measureRail(rail: HTMLElement | undefined, intoSettingsId: string | undefined): RailMeasure | undefined {
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
  const settingsRow = intoSettingsId === undefined ? undefined : [...rows.top, ...rows.bottom].find((row) => row.id === 'projectSettings');
  return {
    rail: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
    rows,
    topEndY: Math.min(topEndY, bottomStartY),
    bottomStartY,
    settingsButton: settingsRow === undefined || settingsRow.bottom <= settingsRow.top ? undefined : { top: settingsRow.top, bottom: settingsRow.bottom },
  };
}
