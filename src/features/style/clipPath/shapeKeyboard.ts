// Moving a handle from the keyboard: arrow steps for each kind of handle,
// with locked or unlocked radii (ClipPath.tsx).

import {
  type Point,
  type CornerName,
  type CornerRadius,
  type PolygonShape,
  type CircleShape,
  type EllipseShape,
  type InsetShape,
  type RawEditableClipPath,
  type RawClipPathShape,
  type ClipShape,
  type InsetSide,
  type InsetSideMode,
  type InsetRadiusMode,
  type ArrowKey,
  type HandleTarget,
  type DragTarget,
} from './clipPathTypes';
import { KEYBOARD_STEP, CORNERS } from './clipPathConstants';
import { oppositeCorner, oppositeInsetSide, insetSideForHandle, isPolygonPointHandle } from './clipPathHandles';
import { rawEditableHandlePoint } from './clipPathCanvasUnits';
import { updateShapeForDrag } from './shapeDrag';

export function isSpaceKey(key: string, code?: string) {
  return key === ' ' || key === 'Spacebar' || code === 'Space';
}

export function isRadiusUnlockKey(key: string, code?: string) {
  return key.toLowerCase() === 'u' || code === 'KeyU';
}

export function stopKeyboardEvent(event: React.KeyboardEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
}

export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

export function arrowDelta(key: string, step = KEYBOARD_STEP) {
  if (key === 'ArrowLeft') {
    return { x: -step, y: 0 };
  }
  if (key === 'ArrowRight') {
    return { x: step, y: 0 };
  }
  if (key === 'ArrowUp') {
    return { x: 0, y: -step };
  }
  if (key === 'ArrowDown') {
    return { x: 0, y: step };
  }
  return undefined;
}

export function ellipseRadiusValueDelta(handle: Extract<HandleTarget, { kind: 'ellipse-rx' | 'ellipse-ry' }>, key: string, step = KEYBOARD_STEP) {
  if (handle.kind === 'ellipse-rx') {
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowLeft' || key === 'ArrowDown') {
      return -step;
    }
  }

  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return step;
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return -step;
  }
  return 0;
}

export function insetValueDelta(side: InsetSide, key: string, step = KEYBOARD_STEP) {
  if (side === 'top') {
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      return step;
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      return -step;
    }
  } else if (side === 'right') {
    if (key === 'ArrowLeft' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowRight' || key === 'ArrowDown') {
      return -step;
    }
  } else if (side === 'bottom') {
    if (key === 'ArrowUp' || key === 'ArrowRight') {
      return step;
    }
    if (key === 'ArrowDown' || key === 'ArrowLeft') {
      return -step;
    }
  } else if (side === 'left') {
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowLeft' || key === 'ArrowDown') {
      return -step;
    }
  }
  return 0;
}

export function cornerRadiusDelta(corner: CornerName, key: string, step = KEYBOARD_STEP) {
  const delta = { x: 0, y: 0 };
  const horizontalSign = corner === 'topRight' || corner === 'bottomRight' ? -1 : 1;
  const verticalSign = corner === 'bottomRight' || corner === 'bottomLeft' ? -1 : 1;

  if (key === 'ArrowRight') {
    delta.x = step * horizontalSign;
  }
  if (key === 'ArrowLeft') {
    delta.x = -step * horizontalSign;
  }
  if (key === 'ArrowDown') {
    delta.y = step * verticalSign;
  }
  if (key === 'ArrowUp') {
    delta.y = -step * verticalSign;
  }

  return delta;
}

export function lockedRadiusValue(radius: CornerRadius) {
  return Math.max(0, (radius.x + radius.y) / 2);
}

// How an arrow key bends a shape: the drag options, plus the circle's radius angle,
// the selected polygon points, and the step.
export type ShapeKeyboardOptions = {
  canvas?: HTMLElement | undefined;
  insetSideMode?: InsetSideMode;
  insetRadiusMode?: InsetRadiusMode;
  insetRadiusUnlocked?: boolean;
  ellipseScaleProportional?: boolean;
  circleRadiusAngle?: number;
  polygonPointIndexes?: number[];
  step?: number;
};
// The shape after a key, and the circle radius handle's new angle when it moved.
export type ShapeKeyboardResult = { shape: ClipShape; circleRadiusAngle?: number };

export function updateShapeForKeyboard(shape: ClipShape, handle: HandleTarget, key: string, options: ShapeKeyboardOptions = {}): ShapeKeyboardResult {
  const step = options.step || KEYBOARD_STEP;
  const delta = arrowDelta(key, step);
  if (!delta || shape.kind === 'none') {
    return { shape };
  }
  if (shape.kind === 'raw' && shape.editable && options.canvas) {
    return keyRawShape(shape, shape.editable, handle, delta, options, options.canvas);
  }
  if (handle.kind === 'polygon-point' && shape.kind === 'polygon') {
    return keyPolygonPoints(shape, handle.index, delta, options);
  }
  if (shape.kind === 'circle') {
    return keyCircle(shape, handle, delta, options);
  }
  if (shape.kind === 'ellipse') {
    return keyEllipse(shape, handle, { key, step, delta }, options);
  }
  if (shape.kind === 'inset') {
    return keyInset(shape, handle, { key, step }, options);
  }
  return { shape };
}

// A key on a shape written in raw CSS units: the drag the key amounts to, from the
// handle's current place.
export function keyRawShape(
  shape: RawClipPathShape,
  editable: RawEditableClipPath,
  handle: HandleTarget,
  delta: Point,
  options: ShapeKeyboardOptions,
  canvas: HTMLElement,
): ShapeKeyboardResult {
  const currentPoint = rawEditableHandlePoint(editable, handle, canvas);
  if (!currentPoint) {
    return { shape };
  }
  const target: DragTarget = {
    ...handle,
    before: shape,
    ...(isPolygonPointHandle(handle) && options.polygonPointIndexes ? { polygonPointIndexes: options.polygonPointIndexes } : {}),
  };
  const dragOptions = {
    canvas,
    ...(options.insetRadiusMode ? { insetRadiusMode: options.insetRadiusMode } : {}),
    ...(options.insetRadiusUnlocked !== undefined ? { insetRadiusUnlocked: options.insetRadiusUnlocked } : {}),
    ...(options.insetSideMode ? { insetSideMode: options.insetSideMode } : {}),
    ...(options.ellipseScaleProportional !== undefined ? { ellipseScaleProportional: options.ellipseScaleProportional } : {}),
  };
  return {
    shape: updateShapeForDrag(shape, target, currentPoint.x + delta.x, currentPoint.y + delta.y, dragOptions),
  };
}

// Moves the selected polygon points (or the one with the key) by the key's step.
export function keyPolygonPoints(shape: PolygonShape, index: number, delta: Point, options: ShapeKeyboardOptions): ShapeKeyboardResult {
  const point = shape.points[index];
  if (!point) {
    return { shape };
  }
  const selectedIndexes = new Set(options.polygonPointIndexes?.length ? options.polygonPointIndexes : [index]);
  return {
    shape: {
      kind: 'polygon' as const,
      points: shape.points.map((item, itemIndex) => (selectedIndexes.has(itemIndex) ? { x: item.x + delta.x, y: item.y + delta.y } : item)),
    },
  };
}

// Moves a circle's centre, or its radius handle around and away from the centre.
export function keyCircle(shape: CircleShape, handle: HandleTarget, delta: Point, options: ShapeKeyboardOptions): ShapeKeyboardResult {
  if (handle.kind === 'circle-center') {
    return { shape: { ...shape, cx: shape.cx + delta.x, cy: shape.cy + delta.y } };
  }
  if (handle.kind !== 'circle-radius') {
    return { shape };
  }
  const angle = options.circleRadiusAngle ?? 0;
  const x = shape.cx + Math.cos(angle) * shape.radius + delta.x;
  const y = shape.cy + Math.sin(angle) * shape.radius + delta.y;
  const radius = Math.max(0, Math.sqrt((x - shape.cx) ** 2 + (y - shape.cy) ** 2));
  return {
    shape: { ...shape, radius },
    circleRadiusAngle: radius > 0 ? Math.atan2(y - shape.cy, x - shape.cx) : angle,
  };
}

// Moves an ellipse's centre, or grows a radius (scaling the other with it when
// proportional).
export function keyEllipse(
  shape: EllipseShape,
  handle: HandleTarget,
  { key, step, delta }: { key: string; step: number; delta: Point },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  if (handle.kind === 'ellipse-center') {
    return { shape: { ...shape, cx: shape.cx + delta.x, cy: shape.cy + delta.y } };
  }
  if (handle.kind === 'ellipse-rx') {
    const radiusDelta = ellipseRadiusValueDelta(handle, key, step);
    if (!radiusDelta) {
      return { shape };
    }
    const nextRx = Math.max(0, shape.rx + radiusDelta);
    if (options.ellipseScaleProportional && shape.rx > 0) {
      const scale = nextRx / shape.rx;
      return { shape: { ...shape, rx: nextRx, ry: Math.max(0, shape.ry * scale) } };
    }
    return { shape: { ...shape, rx: nextRx } };
  }
  if (handle.kind === 'ellipse-ry') {
    const radiusDelta = ellipseRadiusValueDelta(handle, key, step);
    if (!radiusDelta) {
      return { shape };
    }
    const nextRy = Math.max(0, shape.ry + radiusDelta);
    if (options.ellipseScaleProportional && shape.ry > 0) {
      const scale = nextRy / shape.ry;
      return { shape: { ...shape, ry: nextRy, rx: Math.max(0, shape.rx * scale) } };
    }
    return { shape: { ...shape, ry: nextRy } };
  }
  return { shape };
}

// Moves an inset edge (alone, with its opposite, or all four), or grows a corner
// radius.
export function keyInset(
  shape: InsetShape,
  handle: HandleTarget,
  { key, step }: { key: string; step: number },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  const side = insetSideForHandle(handle);
  if (side) {
    const mode = options.insetSideMode || 'single';
    const next: InsetShape = { ...shape };
    const valueDelta = insetValueDelta(side, key, step);
    if (!valueDelta) {
      return { shape };
    }
    if (mode === 'all') {
      const value = next[side] + valueDelta;
      next.top = value;
      next.right = value;
      next.bottom = value;
      next.left = value;
      return { shape: next };
    }
    if (mode === 'opposite') {
      const oppositeSide = oppositeInsetSide(side);
      next[side] += valueDelta;
      next[oppositeSide] += valueDelta;
      return { shape: next };
    }
    next[side] += valueDelta;
    return { shape: next };
  }
  if (handle.kind === 'inset-radius') {
    return keyInsetRadius(shape, handle.corner, { key, step }, options);
  }
  return { shape };
}

// Grows an inset corner radius — alone, with the opposite corner, or all four —
// round unless the radius is unlocked.
export function keyInsetRadius(
  shape: InsetShape,
  corner: CornerName,
  { key, step }: { key: string; step: number },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  const mode = options.insetRadiusMode || 'single';
  const radiusDelta = cornerRadiusDelta(corner, key, step);
  if (!radiusDelta.x && !radiusDelta.y) {
    return { shape };
  }
  const nextRadii = { ...shape.radii };
  const activeRadius = shape.radii[corner];
  const radiusDeltaValue = radiusDelta.x || radiusDelta.y;
  const lockedValue = Math.max(0, lockedRadiusValue(activeRadius) + radiusDeltaValue);
  const nextRadius = options.insetRadiusUnlocked
    ? {
        x: Math.max(0, activeRadius.x + radiusDelta.x),
        y: Math.max(0, activeRadius.y + radiusDelta.y),
      }
    : { x: lockedValue, y: lockedValue };
  const setRadius = (target: CornerName) => {
    nextRadii[target] = { ...nextRadius };
  };

  if (mode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (mode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }

  return { shape: { ...shape, radii: nextRadii } };
}
