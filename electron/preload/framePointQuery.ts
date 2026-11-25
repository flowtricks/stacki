// What is under a point of the canvas, for a Stacki app dragging one of its
// overlay items (src/features/apps/overlayDrag.ts). The overlay layer holds the
// pointer during the drag, so the frame never sees it move; the editor asks
// with `{ type: 'avb:point-query', id, x, y }` (viewport CSS pixels) and the
// frame answers `{ type: 'avb:point-result', id, path, occurrence, box }` by
// the same hit test its own click uses. Desktop's preload (frameQueries.ts)
// and Studio's preview client both hand host messages here, each with its
// own hit test, since each names a path its own way.
//
// The answer also carries `layers`, every file's element under the point
// through the component instances it sits in (frameLayers.ts): a captured
// click asks for them the same way. A query that sends `chain` instead of a
// point asks the other way round: which copy a node ref's chain names now,
// answered in the same shape, so the editor measures and scrolls to it.
import type { Rect } from './frameBasics';
import { layersAtPoint, parseFrameChain, resolveChain } from './frameLayers';

/** The node under a point, as the frame's click would report it. */
export interface FramePointHit {
  readonly path: string;
  readonly occurrence: number;
  readonly box: Rect | undefined;
}

/** A viewport coordinate past this is not a point on any page (APP_RPC_LIMITS.coordinatePxMax). */
const COORDINATE_PX_MAX = 1_000_000;

/** Answers a point query; false when the message is not one. */
export function receivePointQuery(data: unknown, locate: (x: number, y: number) => FramePointHit | undefined, post: (message: unknown) => void): boolean {
  if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== 'avb:point-query') {
    return false;
  }
  const id: unknown = Reflect.get(data, 'id');
  const x = coordinateOf(Reflect.get(data, 'x'));
  const y = coordinateOf(Reflect.get(data, 'y'));
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    return true; // Ours, but malformed: the editor counts ids up from 1, so no one waits on this.
  }
  if (Reflect.get(data, 'chain') !== undefined) {
    const chain = parseFrameChain(Reflect.get(data, 'chain'));
    const found = chain === undefined ? undefined : resolveChain(chain);
    post({ type: 'avb:point-result', id, path: found?.path, occurrence: found?.occurrence ?? 0, box: found?.box, layers: [] });
    return true;
  }
  if (x === undefined || y === undefined) {
    post({ type: 'avb:point-result', id, path: undefined, occurrence: 0, box: undefined, layers: [] });
    return true;
  }
  const hit = locate(x, y);
  post({ type: 'avb:point-result', id, path: hit?.path, occurrence: hit?.occurrence ?? 0, box: hit?.box, layers: layersAtPoint(x, y) });
  return true;
}

function coordinateOf(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.abs(input) <= COORDINATE_PX_MAX ? input : undefined;
}
