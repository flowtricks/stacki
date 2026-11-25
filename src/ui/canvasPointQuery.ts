// Asking the canvas frame what is under a point (electron/preload/framePointQuery.ts),
// for a Stacki app dragging one of its overlay items: the overlay layer holds the
// pointer, so the frame cannot report the drag as it reports a click. The
// answer has a click's shape (canvasClickSlot.ts), so the Apps host resolves it
// to a node exactly as it resolves a captured click. Desktop's canvas
// (src/features/preview/previewRuntime.ts) and Studio's preview hand the
// frame's `avb:point-result` replies to `receiveCanvasPoint`.
import { assert } from '../../shared/core/assert';
import { tellCanvas } from '../editor/canvasQuery';
import { canvasClickBox, coordinateOf, type CanvasClickReport } from './canvasClickSlot';

export const CANVAS_POINT_LIMITS = {
  /** Layers one reply names, and steps one chain asks about (APP_RPC_LIMITS.nodeLayersMax). */
  layersMax: 32,
  /** A copy within the layer outside it (APP_RPC_LIMITS.nodeCopyMax). */
  copyMax: 100_000,
  /** Questions waiting at once: a drag asks one at a time, so more is a leak. */
  pendingMax: 8,
  /** How long a drag waits on the frame before it reports no element: a frame or two on a busy page. */
  timeoutMs: 250,
  /** A canvas path a reply names, as the frame's click reports it (LIMITS.attrCharsMax). */
  pathCharsMax: 4096,
  /** A copy of a repeated element: a loop renders at most this many. */
  occurrenceMax: 100_000,
} as const;

/** One layer under a point, as the frame names it (electron/preload/frameLayers.ts): innermost first. */
export interface CanvasLayer {
  /** The marked path, `<file>|` scope included for a component's markup. */
  readonly path: string;
  /** Which copy of the path on the page, as the canvas measures copies. */
  readonly occurrence: number;
  /** Which copy inside the layer outside it. */
  readonly copy: number;
}

/** A point report with the layers under it. */
export interface CanvasPointReport extends CanvasClickReport {
  readonly layers: readonly CanvasLayer[];
}

/** One step of a node ref's chain, as the frame reads it back: outermost first. */
export interface CanvasChainStep {
  readonly path: string;
  readonly copy: number;
}

interface PendingPoint {
  readonly resolve: (hit: CanvasPointReport | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly x: number | undefined;
  readonly y: number | undefined;
}

const pending = new Map<number, PendingPoint>();
let nextId = 1;

/**
 * What is under `x`, `y` (canvas viewport CSS pixels): the click report the frame
 * would send for a click there. Undefined when no frame answers in time, or when
 * one is not up; the report's `path` is undefined over markup no node owns.
 */
export function queryCanvasPoint(x: number, y: number): Promise<CanvasPointReport | undefined> {
  assert(Number.isFinite(x), 'A canvas point is finite across');
  assert(Number.isFinite(y), 'A canvas point is finite down');
  return ask({ x, y }, { type: 'avb:point-query', x, y });
}

/**
 * The copy a node ref's chain names on the canvas now (frameLayers.ts resolveChain):
 * its path, its copy as the canvas measures copies, and its box. The report's
 * `path` is undefined when the page has no such copy; the whole answer is
 * undefined when no frame answers in time.
 */
export function queryCanvasChain(chain: readonly CanvasChainStep[]): Promise<CanvasPointReport | undefined> {
  assert(chain.length > 0, 'A chain has a step');
  assert(chain.length <= CANVAS_POINT_LIMITS.layersMax, 'A chain is within the layer bound');
  return ask({ x: undefined, y: undefined }, { type: 'avb:point-query', chain });
}

// One question to the frame, answered by its `avb:point-result` with the same id or by the timeout.
function ask(
  asked: { readonly x: number | undefined; readonly y: number | undefined },
  message: Readonly<Record<string, unknown>>,
): Promise<CanvasPointReport | undefined> {
  if (pending.size >= CANVAS_POINT_LIMITS.pendingMax) {
    return Promise.resolve(undefined);
  }
  assert(Number.isSafeInteger(nextId), 'Canvas point ids stay safe integers');
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, CANVAS_POINT_LIMITS.timeoutMs);
    pending.set(id, { resolve, timer, x: asked.x, y: asked.y });
    if (!tellCanvas({ ...message, id })) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(undefined);
    }
  });
}

/** A frame's `avb:point-result`: frames run project code, so the reply is checked before it answers anyone. */
export function receiveCanvasPoint(input: unknown): void {
  if (typeof input !== 'object' || input === null) {
    return;
  }
  const id: unknown = Reflect.get(input, 'id');
  const entry = typeof id === 'number' ? pending.get(id) : undefined;
  if (typeof id !== 'number' || entry === undefined) {
    return; // Late (timed out), or not an id this window asked.
  }
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(parsePointReply(input, entry));
}

// The reply as a click report at the point asked; a path or copy out of bounds is no element.
export function parsePointReply(input: object, asked: { readonly x: number | undefined; readonly y: number | undefined }): CanvasPointReport {
  const path: unknown = Reflect.get(input, 'path');
  const occurrence: unknown = Reflect.get(input, 'occurrence');
  const named = typeof path === 'string' && path.length > 0 && path.length <= CANVAS_POINT_LIMITS.pathCharsMax ? path : undefined;
  const copy =
    typeof occurrence === 'number' && Number.isSafeInteger(occurrence) && occurrence >= 0 && occurrence <= CANVAS_POINT_LIMITS.occurrenceMax ? occurrence : 0;
  const report: CanvasPointReport = {
    path: named,
    occurrence: copy,
    x: asked.x === undefined ? undefined : coordinateOf(asked.x),
    y: asked.y === undefined ? undefined : coordinateOf(asked.y),
    box: named === undefined ? undefined : canvasClickBox(Reflect.get(input, 'box')),
    layers: parseCanvasLayers(Reflect.get(input, 'layers')),
  };
  assert(report.occurrence >= 0, 'A point names a copy from the first');
  assert(report.box === undefined || report.path !== undefined, 'A box belongs to the element the point is on');
  return report;
}

/**
 * The layers a frame named, innermost first: frames run project code, so a reply that
 * is not a bounded list of well-formed layers names none rather than some.
 */
export function parseCanvasLayers(input: unknown): readonly CanvasLayer[] {
  if (!Array.isArray(input) || input.length > CANVAS_POINT_LIMITS.layersMax) {
    return [];
  }
  const layers: CanvasLayer[] = [];
  for (const item of input) {
    const layer = parseCanvasLayer(item);
    if (layer === undefined) {
      return [];
    }
    layers.push(layer);
  }
  assert(layers.length <= CANVAS_POINT_LIMITS.layersMax, 'Layers are within their bound');
  return layers;
}

function parseCanvasLayer(input: unknown): CanvasLayer | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const path: unknown = Reflect.get(input, 'path');
  const occurrence: unknown = Reflect.get(input, 'occurrence');
  const copy: unknown = Reflect.get(input, 'copy');
  if (typeof path !== 'string' || path.length === 0 || path.length > CANVAS_POINT_LIMITS.pathCharsMax) {
    return undefined;
  }
  if (!wholeIn(occurrence, CANVAS_POINT_LIMITS.occurrenceMax)) {
    return undefined;
  }
  if (!wholeIn(copy, CANVAS_POINT_LIMITS.copyMax)) {
    return undefined;
  }
  return { path, occurrence, copy };
}

function wholeIn(input: unknown, maximum: number): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= maximum;
}
