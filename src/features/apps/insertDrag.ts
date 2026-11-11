// Drag to insert (docs/apps.md, "Drag to insert"): an app drags a new element or
// component from its own UI onto the canvas. A native drag out of a sandboxed
// frame is unreliable, so the app's frame keeps the pointer (the browser sends a
// pressed pointer's moves to the frame it went down in, wherever it goes) and its
// SDK reports each move here (`canvas.insertDrag`); Stacki works out the place
// under the pointer and draws it, and the drop inserts there through `node.insert`'s
// own path, one undo step.
//
// Where a drop lands is the canvas's own hit test in the open file's scope, so an
// element inside a closed component is never a target: the pointer over one names
// the instance, and an instance only takes a drop before or after it. An element
// takes it before (its top quarter), after (its bottom quarter) or inside, last
// (between); a void element, text and an expression take it before or after.
//
// One drag at a time, owned by the app that started it; Escape, the app stopping
// or a newer drag ends it. Pure state over callbacks, so tests drive it without
// frames; the runtime (appsRuntime.ts) owns the one instance.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppInsert, type AppInsertPlace, type AppNodeView, type AppRect } from '../../../shared/properties/appsRpc';

/** What is under a canvas point for a drop: the open file's element there and its box. */
export interface InsertDragHit {
  readonly node: AppNodeView;
  readonly box: AppRect;
}

/** Where the drop goes, and what the canvas draws for it. */
export interface InsertDragTarget {
  readonly place: Exclude<AppInsertPlace, { readonly kind: 'selection' } | { readonly kind: 'replace' }>;
  /** A line above or below the box, or the box itself for a drop inside. */
  readonly line: 'before' | 'after' | 'inside';
  readonly box: AppRect;
}

/** A drag under way, as the overlay draws it. */
export interface InsertDragView {
  readonly appId: string;
  readonly preview: string;
  /** The pointer in the canvas viewport's CSS pixels; undefined until the first move, and off the canvas. */
  readonly pointer: { readonly x: number; readonly y: number } | undefined;
  readonly target: InsertDragTarget | undefined;
}

export interface InsertDragDeps {
  /** A point of the editor window (client pixels) as a point of the canvas viewport, or undefined off the canvas. */
  readonly toCanvas: (x: number, y: number) => { readonly x: number; readonly y: number } | undefined;
  /** The open file's element under a canvas point. */
  readonly locate: (x: number, y: number) => Promise<InsertDragHit | undefined>;
  readonly running: (appId: string) => boolean;
}

/** What a drop asks of the dispatcher: the item, where, and its undo label. */
export type InsertDragDrop =
  | { readonly kind: 'insert'; readonly item: AppInsert; readonly label: string | undefined; readonly place: InsertDragTarget['place'] }
  | { readonly kind: 'refused'; readonly reason: string };

export interface InsertDrag {
  readonly start: (appId: string, drag: { readonly item: AppInsert; readonly label: string | undefined; readonly preview: string | undefined }) => void;
  /** A move, at the pointer in the editor window's client pixels: true when it is over a place that takes the drop. */
  readonly move: (appId: string, x: number, y: number) => Promise<boolean>;
  /** The drop: the place to insert at, or why there is none. Ends the drag either way. */
  readonly drop: (appId: string, x: number, y: number) => Promise<InsertDragDrop>;
  /** Ends the drag; false when none was under way. */
  readonly cancel: () => boolean;
  /** The running apps changed: a drag whose app stopped ends. */
  readonly changed: () => void;
  readonly view: () => InsertDragView | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

interface DragState {
  readonly appId: string;
  readonly item: AppInsert;
  readonly label: string | undefined;
  readonly view: InsertDragView;
}

/** Tags with no children: a drop on one goes before or after it. */
const VOID_TAGS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** The share of an element's height, at its top and its bottom, that puts a drop before or after it rather than inside. */
const EDGE_SHARE = 0.25;

export function createInsertDrag(deps: InsertDragDeps): InsertDrag {
  let state: DragState | undefined;
  const listeners = new Set<() => void>();
  const become = (next: DragState | undefined): void => {
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  // Where the pointer is and what takes the drop there; the state moves only while the same drag lasts.
  const aim = async (appId: string, x: number, y: number): Promise<DragState | undefined> => {
    const owned = state;
    if (owned?.appId !== appId) {
      return undefined;
    }
    const pointer = deps.toCanvas(x, y);
    const hit = pointer === undefined ? undefined : await deps.locate(pointer.x, pointer.y);
    const target = pointer === undefined || hit === undefined ? undefined : dropTarget(hit, pointer.y);
    if (state !== owned) {
      return undefined; // Cancelled or replaced while the canvas answered.
    }
    const next = { ...owned, view: { ...owned.view, pointer, target } };
    become(next);
    return next;
  };
  return {
    start: (appId, drag) => {
      assert(deps.running(appId), 'Only a running app starts a drag to insert');
      const preview = drag.preview ?? (drag.item.kind === 'element' ? `<${drag.item.tag}>` : drag.item.name);
      become({
        appId,
        item: drag.item,
        label: drag.label,
        view: { appId, preview: preview.slice(0, APP_RPC_LIMITS.labelCharsMax), pointer: undefined, target: undefined },
      });
    },
    move: async (appId, x, y) => (await aim(appId, x, y))?.view.target !== undefined,
    drop: async (appId, x, y) => {
      if (state?.appId !== appId) {
        return { kind: 'refused', reason: 'The drag was cancelled' };
      }
      const aimed = await aim(appId, x, y);
      if (aimed === undefined) {
        return { kind: 'refused', reason: 'The drag was cancelled' };
      }
      become(undefined);
      const target = aimed.view.target;
      if (target === undefined) {
        return { kind: 'refused', reason: 'Nothing on the canvas there takes the drop' };
      }
      assert(state === undefined, 'A drop ends the drag');
      return { kind: 'insert', item: aimed.item, label: aimed.label, place: target.place };
    },
    cancel: () => {
      if (state === undefined) {
        return false;
      }
      become(undefined);
      return true;
    },
    changed: () => {
      if (state !== undefined && !deps.running(state.appId)) {
        become(undefined);
      }
    },
    view: () => state?.view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Where a drop at `pointerY` on `hit` goes: see the module comment. */
export function dropTarget(hit: InsertDragHit, pointerY: number): InsertDragTarget {
  const { node, box } = hit;
  const height = Math.max(0, box.height);
  const offset = Math.min(height, Math.max(0, pointerY - box.y));
  const container = node.kind === 'element' && !VOID_TAGS.has(node.name);
  if (container && offset >= height * EDGE_SHARE && offset <= height * (1 - EDGE_SHARE)) {
    return { place: { kind: 'inside', anchor: node.id, index: undefined }, line: 'inside', box };
  }
  // A closed component, a void element, text: beside it, by which half the pointer is in.
  const before = container ? offset < height * EDGE_SHARE : offset < height / 2;
  const target: InsertDragTarget = before
    ? { place: { kind: 'before', anchor: node.id }, line: 'before', box }
    : { place: { kind: 'after', anchor: node.id }, line: 'after', box };
  assert(target.place.anchor === node.id, 'A drop is placed by the element under the pointer');
  return target;
}
