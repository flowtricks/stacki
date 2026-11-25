// Snapping and the guides it draws, as Figma does: a moving box's edges and centre line up with its neighbours'
// and its parent's within a few pixels, the lines that matched are drawn, and the gaps to the nearest neighbour on
// each side are measured. Pure arithmetic over boxes in one frame's coordinates.

export interface Box {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

export type Axis = 'x' | 'y';

/** A line where two boxes line up: at `positionPx` on `axis`, spanning `fromPx` to `toPx` across it. */
export interface SnapGuide {
  readonly axis: Axis;
  readonly positionPx: number;
  readonly fromPx: number;
  readonly toPx: number;
}

/** The distance between the moving box and its nearest neighbour on one side, drawn at `atPx` across the gap. */
export interface GapHint {
  readonly axis: Axis;
  readonly fromPx: number;
  readonly toPx: number;
  readonly atPx: number;
  readonly distancePx: number;
}

export interface SnapResult {
  readonly dxPx: number;
  readonly dyPx: number;
  readonly guides: readonly SnapGuide[];
  readonly gaps: readonly GapHint[];
}

/** Neighbours a snap compares against at most: the parent and its children are rarely more. */
const TARGETS_MAX = 400;

function lines(box: Box, axis: Axis): readonly number[] {
  return axis === 'x' ? [box.xPx, box.xPx + box.widthPx / 2, box.xPx + box.widthPx] : [box.yPx, box.yPx + box.heightPx / 2, box.yPx + box.heightPx];
}

/** The smallest shift within `thresholdPx` that lines one of `values` up with one of `targets`, or undefined. */
export function nearestShift(values: readonly number[], targets: readonly number[], thresholdPx: number): number | undefined {
  if (thresholdPx < 0) {
    throw new Error('Assertion failed: nearestShift: a threshold is never negative');
  }
  let best: number | undefined;
  for (const value of values) {
    for (const target of targets) {
      const shift = target - value;
      if (Math.abs(shift) <= thresholdPx && (best === undefined || Math.abs(shift) < Math.abs(best))) {
        best = shift;
      }
    }
  }
  return best;
}

export function moveBox(box: Box, dxPx: number, dyPx: number): Box {
  return { xPx: box.xPx + dxPx, yPx: box.yPx + dyPx, widthPx: box.widthPx, heightPx: box.heightPx };
}

/** Where `moving` snaps among `targets` (its parent first, then its siblings), and what to draw. */
export function snapMove(moving: Box, targets: readonly Box[], thresholdPx: number): SnapResult {
  const compared = targets.slice(0, TARGETS_MAX);
  const dxPx =
    nearestShift(
      lines(moving, 'x'),
      compared.flatMap((target) => lines(target, 'x')),
      thresholdPx,
    ) ?? 0;
  const dyPx =
    nearestShift(
      lines(moving, 'y'),
      compared.flatMap((target) => lines(target, 'y')),
      thresholdPx,
    ) ?? 0;
  const snapped = moveBox(moving, dxPx, dyPx);
  return { dxPx, dyPx, guides: guidesFor(snapped, compared), gaps: gapsFor(snapped, compared) };
}

/** Lines the box now shares exactly (to a hundredth of a pixel) with a target. */
export function guidesFor(box: Box, targets: readonly Box[]): readonly SnapGuide[] {
  const guides: SnapGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    for (const value of lines(box, axis)) {
      for (const target of targets) {
        if (lines(target, axis).some((line) => Math.abs(line - value) < 0.01)) {
          const across: Axis = axis === 'x' ? 'y' : 'x';
          const span = [...extent(box, across), ...extent(target, across)];
          guides.push({ axis, positionPx: value, fromPx: Math.min(...span), toPx: Math.max(...span) });
        }
      }
    }
  }
  return guides;
}

function extent(box: Box, axis: Axis): readonly [number, number] {
  return axis === 'x' ? [box.xPx, box.xPx + box.widthPx] : [box.yPx, box.yPx + box.heightPx];
}

function overlaps(first: readonly [number, number], second: readonly [number, number]): boolean {
  return first[0] < second[1] && second[0] < first[1];
}

/** The gap to the nearest target on each of the four sides that overlaps the box across that axis. */
export function gapsFor(box: Box, targets: readonly Box[]): readonly GapHint[] {
  const gaps: GapHint[] = [];
  const [left, right] = extent(box, 'x');
  const [top, bottom] = extent(box, 'y');
  const horizontal = targets.filter((target) => overlaps(extent(target, 'y'), [top, bottom]));
  const vertical = targets.filter((target) => overlaps(extent(target, 'x'), [left, right]));
  const middleY = top + box.heightPx / 2;
  const middleX = left + box.widthPx / 2;
  const before = nearest(horizontal.map((target) => left - (target.xPx + target.widthPx)));
  const after = nearest(horizontal.map((target) => target.xPx - right));
  const above = nearest(vertical.map((target) => top - (target.yPx + target.heightPx)));
  const below = nearest(vertical.map((target) => target.yPx - bottom));
  if (before !== undefined) {
    gaps.push({ axis: 'x', fromPx: left - before, toPx: left, atPx: middleY, distancePx: before });
  }
  if (after !== undefined) {
    gaps.push({ axis: 'x', fromPx: right, toPx: right + after, atPx: middleY, distancePx: after });
  }
  if (above !== undefined) {
    gaps.push({ axis: 'y', fromPx: top - above, toPx: top, atPx: middleX, distancePx: above });
  }
  if (below !== undefined) {
    gaps.push({ axis: 'y', fromPx: bottom, toPx: bottom + below, atPx: middleX, distancePx: below });
  }
  return gaps;
}

/** The smallest positive distance, or undefined when there is none. */
function nearest(distances: readonly number[]): number | undefined {
  const positive = distances.filter((distance) => distance > 0.5);
  return positive.length === 0 ? undefined : Math.min(...positive);
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The box after dragging `handle` by (dx, dy), at least one pixel each way; `keepRatio` holds the aspect (Shift). */
export function resizeBox(start: Box, handle: ResizeHandle, dxPx: number, dyPx: number, keepRatio: 'free' | 'ratio'): Box {
  let left = start.xPx;
  let top = start.yPx;
  let right = start.xPx + start.widthPx;
  let bottom = start.yPx + start.heightPx;
  if (handle.includes('w')) {
    left += dxPx;
  }
  if (handle.includes('e')) {
    right += dxPx;
  }
  if (handle.includes('n')) {
    top += dyPx;
  }
  if (handle.includes('s')) {
    bottom += dyPx;
  }
  let widthPx = Math.max(1, right - left);
  let heightPx = Math.max(1, bottom - top);
  if (keepRatio === 'ratio' && start.widthPx > 0 && start.heightPx > 0) {
    const ratio = start.widthPx / start.heightPx;
    if (handle === 'n' || handle === 's') {
      widthPx = heightPx * ratio;
    } else {
      heightPx = widthPx / ratio;
    }
  }
  const xPx = handle.includes('w') ? start.xPx + start.widthPx - widthPx : start.xPx;
  const yPx = handle.includes('n') ? start.yPx + start.heightPx - heightPx : start.yPx;
  return { xPx, yPx, widthPx, heightPx };
}

/** A resize handle's side, in screen pixels. */
const HANDLE_SCREEN_PX = 8;
/** A selection narrower or lower than this on screen keeps its handles outside: three handles' room, so its middle stays free. */
const HANDLE_ROOM_SCREEN_PX = HANDLE_SCREEN_PX * 3;

/**
 * Where a handle is drawn, in canvas pixels: centred on its corner or side, so it stays the same size on screen at
 * any zoom. On a selection too small on screen for that, it sits just outside instead: centred ones would cover
 * the element, and a drag started on it would resize rather than move (a line of text at fit-all zoom).
 */
export function handlePlace(box: Box, handle: ResizeHandle, scale: number): Box {
  const size = HANDLE_SCREEN_PX / scale;
  const along = (startPx: number, lengthPx: number, side: -1 | 0 | 1): number => {
    const outside = lengthPx * scale < HANDLE_ROOM_SCREEN_PX ? (side * size) / 2 : 0;
    return startPx + (lengthPx * (side + 1)) / 2 + outside - size / 2;
  };
  const sideX = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sideY = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  return { xPx: along(box.xPx, box.widthPx, sideX), yPx: along(box.yPx, box.heightPx, sideY), widthPx: size, heightPx: size };
}
