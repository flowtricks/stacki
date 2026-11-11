// Dragging an app's overlay item (docs/apps.md, "Dragging"): a `draggable` box
// or label, pressed and moved, sends its app `overlay.drag` with the geometry
// of a canvas click for the point under the pointer, so a comment pin moves the
// way pins move in every design tool. Stacki never moves the item: the app
// redraws it with `overlay.set` on each `move` and writes once on `end`, so a
// drag is one undo step and the app decides where an item may go.
//
// The rules follow canvas capture's (canvasCapture.ts):
// - Only the app that drew the item hears it, and one drag runs at a time.
// - A press that moves less than APP_RPC_LIMITS.dragThresholdPx is a click: an
//   `interactive` item sends `overlay.click`, so clicking a pin stays reliable.
// - Escape, a lost pointer, the app stopping, or the item leaving its app's
//   overlay (or no longer being draggable) ends the drag with `cancelled: true`.
// - Every drag the app heard start ends exactly once, and `start` comes first.
// - `move` goes at most once per animation frame, and only after the frame
//   said what is under the previous point: one question in flight at a time,
//   the latest point wins, so a slow page drops moves rather than queueing them.
//
// Pure state over injected callbacks (the frame clock and the canvas hit test
// included), so tests drive it without a canvas; the runtime (appsRuntime.ts)
// owns the one instance and the overlay layer (AppOverlayLayer.tsx) feeds it
// pointer events.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppCanvasClick, type AppDragPhase, type AppEventData, type AppEventName } from '../../../shared/properties/appsRpc';

/** Where the pointer is, in the two spaces a drag needs. */
export interface DragPoint {
  /** In overlay-layer pixels (after the canvas's zoom): the click threshold is measured here, as the hand moves. */
  readonly layerX: number;
  readonly layerY: number;
  /** In the canvas viewport's CSS pixels (before the zoom): what the app hears, as for `canvas.click`. */
  readonly x: number;
  readonly y: number;
}

/** A press on a draggable item. */
export interface OverlayDragPress {
  readonly appId: string;
  readonly itemId: string;
  /** The element the item is on, for the `overlay.click` a short press sends. */
  readonly nodeId: string | undefined;
  /** Whether a press that does not become a drag sends `overlay.click`. */
  readonly interactive: boolean;
  readonly point: DragPoint;
}

/** The item a press or a drag holds: the layer keeps it out of count bubbles and shows the grabbing cursor. */
export interface OverlayDragHeld {
  readonly appId: string;
  readonly itemId: string;
  readonly phase: 'pressed' | 'dragging';
}

export interface OverlayDragDeps {
  /** Sends one app's frames an event; returns how many frames it reached. */
  readonly emit: <E extends AppEventName>(appId: string, event: E, data: AppEventData[E]) => number;
  readonly running: (appId: string) => boolean;
  /** Whether the app's overlay still holds a draggable item with this id. */
  readonly holds: (appId: string, itemId: string) => boolean;
  /** What is under a canvas point; always settles, with no element when the canvas cannot say. */
  readonly locate: (x: number, y: number) => Promise<AppCanvasClick>;
  /** Runs `step` before the next paint; returns what cancels it. */
  readonly frame: (step: () => void) => () => void;
}

export interface OverlayDrag {
  /** A pointer went down on a draggable item; false while another press or drag runs, or the item is gone. */
  readonly press: (press: OverlayDragPress) => boolean;
  readonly move: (point: DragPoint) => void;
  /** The pointer came up: a click when it never moved past the threshold, else the drag's `end`. */
  readonly release: (point: DragPoint) => void;
  /** Escape or a lost pointer: ends the press or the drag, telling the app when it heard `start`. False when none ran. */
  readonly cancel: () => boolean;
  /** The running apps or their overlays changed: a drag whose app stopped, or whose item went, is cancelled. */
  readonly changed: () => void;
  readonly held: () => OverlayDragHeld | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

// One drag past the threshold. Mutable, but only this module's control flow touches it.
interface ActiveDrag {
  readonly kind: 'dragging';
  readonly appId: string;
  readonly itemId: string;
  /** The newest pointer position; the next question asks about it. */
  latest: DragPoint;
  /** Where the pointer came up; the drag then ends at it. */
  release: DragPoint | undefined;
  /** Whether the app heard `start`: only then does it hear an `end`. */
  started: boolean;
  /** What the app last heard, for an `end` a cancel sends without asking the canvas. */
  last: AppCanvasClick | undefined;
  /** A question to the canvas is in flight. */
  asking: boolean;
  /** Cancels the frame a question waits for; undefined when none is scheduled. */
  cancelFrame: (() => void) | undefined;
}

type DragState = { readonly kind: 'idle' } | { readonly kind: 'pressed'; readonly press: OverlayDragPress } | ActiveDrag;

const IDLE: DragState = { kind: 'idle' };

export function createOverlayDrag(deps: OverlayDragDeps): OverlayDrag {
  let state: DragState = IDLE;
  // Kept between changes, so a store reading it (useSyncExternalStore) sees the same value until it changes.
  let heldView: OverlayDragHeld | undefined;
  const listeners = new Set<() => void>();
  const become = (next: DragState): void => {
    state = next;
    heldView = heldOf(next);
    for (const listener of [...listeners]) {
      listener();
    }
  };
  // What the app hears; the caller records what it heard on the drag it owns.
  const send = (drag: ActiveDrag, phase: AppDragPhase, where: AppCanvasClick, outcome: { readonly cancelled: boolean }): void => {
    assert(phase === 'start' || drag.started, 'A drag starts before it moves or ends');
    assert(!outcome.cancelled || phase === 'end', 'Only an end is cancelled');
    deps.emit(drag.appId, 'overlay.drag', {
      itemId: drag.itemId,
      phase,
      nodeId: where.nodeId,
      at: where.at,
      x: where.x,
      y: where.y,
      layers: where.layers,
      cancelled: outcome.cancelled,
    });
  };
  // The drop: ask once more where the pointer came up, then end there.
  const finish = (point: DragPoint): void => {
    const drag = state;
    assert(drag.kind === 'dragging', 'Only a drag drops');
    assert(!drag.asking, 'A drop asks the canvas only when nothing else is asking');
    drag.cancelFrame?.();
    drag.cancelFrame = undefined;
    drag.asking = true;
    void deps.locate(point.x, point.y).then((where) => {
      drag.asking = false;
      if (state !== drag) {
        return; // Cancelled while asking: the cancel already ended it.
      }
      if (!drag.started) {
        send(drag, 'start', where, { cancelled: false });
        drag.started = true;
      }
      send(drag, 'end', where, { cancelled: false });
      become(IDLE);
    });
  };
  // One question for the latest point, before the next paint; a question in flight or waiting covers it.
  const schedule = (): void => {
    const drag = state;
    assert(drag.kind === 'dragging', 'Only a drag asks the canvas');
    if (drag.asking || drag.cancelFrame !== undefined) {
      return;
    }
    drag.cancelFrame = deps.frame(() => {
      drag.cancelFrame = undefined;
      if (state === drag) {
        ask();
      }
    });
  };
  const ask = (): void => {
    const drag = state;
    assert(drag.kind === 'dragging', 'Only a drag asks the canvas');
    assert(drag.release === undefined, 'A drop is asked about by finish');
    const point = drag.latest;
    drag.asking = true;
    void deps.locate(point.x, point.y).then((where) => {
      drag.asking = false;
      if (state !== drag) {
        return; // Cancelled while asking.
      }
      send(drag, drag.started ? 'move' : 'start', where, { cancelled: false });
      drag.started = true;
      drag.last = where;
      if (drag.release !== undefined) {
        finish(drag.release);
      } else if (drag.latest !== point) {
        schedule();
      }
    });
  };
  const end = (): boolean => {
    const current = state;
    switch (current.kind) {
      case 'idle':
        return false;
      case 'pressed':
        become(IDLE);
        return true;
      case 'dragging':
        if (current.release !== undefined) {
          return false; // Already dropped: the drop stands.
        }
        current.cancelFrame?.();
        current.cancelFrame = undefined;
        become(IDLE);
        if (current.started && current.last !== undefined) {
          send(current, 'end', current.last, { cancelled: true });
        }
        return true;
      default: {
        const exhaustive: never = current;
        return exhaustive;
      }
    }
  };
  return {
    press: (press) => {
      if (state.kind !== 'idle') {
        return false;
      }
      if (!deps.running(press.appId) || !deps.holds(press.appId, press.itemId)) {
        return false;
      }
      become({ kind: 'pressed', press });
      assert(heldView?.itemId === press.itemId, 'A press holds its item');
      return true;
    },
    move: (point) => {
      const current = state;
      if (current.kind === 'pressed') {
        const { layerX, layerY } = current.press.point;
        if (Math.hypot(point.layerX - layerX, point.layerY - layerY) < APP_RPC_LIMITS.dragThresholdPx) {
          return; // Still a click.
        }
        const drag: ActiveDrag = {
          kind: 'dragging',
          appId: current.press.appId,
          itemId: current.press.itemId,
          latest: point,
          release: undefined,
          started: false,
          last: undefined,
          asking: false,
          cancelFrame: undefined,
        };
        become(drag);
        schedule();
        return;
      }
      if (current.kind === 'dragging' && current.release === undefined) {
        current.latest = point;
        schedule();
      }
    },
    release: (point) => {
      const current = state;
      if (current.kind === 'pressed') {
        become(IDLE);
        const { press } = current;
        if (press.interactive) {
          deps.emit(press.appId, 'overlay.click', { itemId: press.itemId, nodeId: press.nodeId });
        }
        return;
      }
      if (current.kind === 'dragging' && current.release === undefined) {
        current.latest = point;
        current.release = point;
        // A question in flight finishes the drop when it answers (ask), so `start` and any `move` land first.
        if (!current.asking) {
          finish(point);
        }
      }
    },
    cancel: end,
    changed: () => {
      const current = state;
      if (current.kind === 'idle') {
        return;
      }
      const owner = current.kind === 'pressed' ? current.press : current;
      if (!deps.running(owner.appId) || !deps.holds(owner.appId, owner.itemId)) {
        end();
      }
    },
    held: () => heldView,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function heldOf(state: DragState): OverlayDragHeld | undefined {
  switch (state.kind) {
    case 'idle':
      return undefined;
    case 'pressed':
      return { appId: state.press.appId, itemId: state.press.itemId, phase: 'pressed' };
    case 'dragging':
      return { appId: state.appId, itemId: state.itemId, phase: 'dragging' };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
