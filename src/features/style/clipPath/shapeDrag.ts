// Dragging a handle: a polygon point, a circle or ellipse, an inset side or
// radius, and the raw forms of each (ClipPath.tsx).

import {
  type Point,
  type CornerName,
  type PolygonShape,
  type CircleShape,
  type EllipseShape,
  type InsetShape,
  type CssUnitValue,
  type CssCoordinatePoint,
  type RawEditableClipPath,
  type RawClipPathShape,
  type ClipShape,
  type InsetSide,
  type InsetSideMode,
  type InsetRadiusMode,
  type DragTarget,
} from './clipPathTypes';
import { CORNERS } from './clipPathConstants';
import { isCssUnitValue, insetBox } from './clipPathMeasure';
import { formatRawEditableClipPath, oppositeCorner, oppositeInsetSide, insetSideForHandle } from './clipPathHandles';
import { expandCssUnitValues } from './clipPathPreview';
import { cssUnitPx, cssUnitValueToCanvasPercent, canvasPercentToCssUnitValue, rawInsetBox } from './clipPathCanvasUnits';

// How a drag bends a shape: which sides and corners move together, whether the
// radii stay round, whether an ellipse keeps its proportions, and the canvas the
// raw CSS units are measured against.
export type ShapeDragOptions = {
  insetSideMode?: InsetSideMode;
  insetRadiusMode?: InsetRadiusMode;
  insetRadiusUnlocked?: boolean;
  ellipseScaleProportional?: boolean;
  canvas?: HTMLElement | undefined;
};
export type RawEditable<Kind extends RawEditableClipPath['kind']> = Extract<RawEditableClipPath, { kind: Kind }>;

export function updateShapeForDrag(shape: ClipShape, target: DragTarget, x: number, y: number, options: ShapeDragOptions = {}): ClipShape {
  if (shape.kind === 'none') {
    return shape;
  }
  if (shape.kind === 'raw' && shape.editable && options.canvas) {
    const next = updateRawShapeForDrag(shape, target, { x, y }, options, options.canvas);
    if (next) {
      return next;
    }
  }
  if (target.kind === 'polygon-point' && shape.kind === 'polygon') {
    return dragPolygonPoint(shape, target, x, y);
  }
  if (shape.kind === 'circle' || shape.kind === 'ellipse') {
    return dragRoundShape(shape, target, x, y, options);
  }
  if (shape.kind === 'inset') {
    return dragInset(shape, target, x, y, options);
  }
  return shape;
}

// A drag on a shape written in raw CSS units, converted through the canvas. Undefined
// when the handle is not one this shape has.
export function updateRawShapeForDrag(
  shape: RawClipPathShape,
  target: DragTarget,
  point: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape | undefined {
  const editable = shape.editable;
  if (target.kind === 'polygon-point' && editable?.kind === 'polygon') {
    return dragRawPolygonPoint(shape, editable, target, point, canvas);
  }
  if (editable?.kind === 'circle') {
    return dragRawCircle(shape, editable, target, point, canvas);
  }
  if (editable?.kind === 'ellipse') {
    return dragRawEllipse(shape, editable, target, point, options, canvas);
  }
  if (editable?.kind === 'inset') {
    const side = insetSideForHandle(target);
    if (side) {
      return dragRawInsetSide(shape, editable, side, point, options, canvas);
    }
    if (target.kind === 'inset-radius' && editable.radii) {
      return dragRawInsetRadius(shape, editable, target.corner, point, options, canvas);
    }
  }
  return undefined;
}

// The shape with its raw editable replaced, and its CSS rewritten to match.
export function withRawEditable(shape: RawClipPathShape, nextEditable: RawEditableClipPath): ClipShape {
  return { ...shape, editable: nextEditable, value: formatRawEditableClipPath(nextEditable) };
}

// Moves the dragged raw polygon point, and the other selected points with it.
export function dragRawPolygonPoint(
  shape: RawClipPathShape,
  editable: RawEditable<'polygon'>,
  target: DragTarget & { kind: 'polygon-point' },
  { x, y }: Point,
  canvas: HTMLElement,
): ClipShape {
  const selectedIndexes = new Set(target.polygonPointIndexes?.length ? target.polygonPointIndexes : [target.index]);
  const beforeEditable = target.before.kind === 'raw' && target.before.editable?.kind === 'polygon' ? target.before.editable : editable;
  const beforePoint = beforeEditable.points[target.index];
  if (!beforePoint) {
    return shape;
  }
  if (!isCssUnitValue(beforePoint.x) && !isCssUnitValue(beforePoint.y)) {
    return shape;
  }
  const beforeCanvasPoint = {
    x: isCssUnitValue(beforePoint.x) ? cssUnitValueToCanvasPercent(beforePoint.x, 'x', canvas) : x,
    y: isCssUnitValue(beforePoint.y) ? cssUnitValueToCanvasPercent(beforePoint.y, 'y', canvas) : y,
  };
  const dx = isCssUnitValue(beforePoint.x) ? x - beforeCanvasPoint.x : 0;
  const dy = isCssUnitValue(beforePoint.y) ? y - beforeCanvasPoint.y : 0;
  const nextEditable: RawEditableClipPath = {
    ...editable,
    points: editable.points.map((point, index) => {
      if (!selectedIndexes.has(index)) {
        return point;
      }
      return offsetRawPoint(point, beforeEditable.points[index] || point, { dx, dy }, canvas);
    }),
  };
  return withRawEditable(shape, nextEditable);
}

// A selected raw point moved by the drag: its coordinates that are plain units
// follow, measured from where the point was when the drag began.
export function offsetRawPoint(
  point: CssCoordinatePoint,
  beforeSelected: CssCoordinatePoint,
  { dx, dy }: { dx: number; dy: number },
  canvas: HTMLElement,
): CssCoordinatePoint {
  const beforeSelectedCanvas = {
    x: isCssUnitValue(beforeSelected.x) ? cssUnitValueToCanvasPercent(beforeSelected.x, 'x', canvas) : 0,
    y: isCssUnitValue(beforeSelected.y) ? cssUnitValueToCanvasPercent(beforeSelected.y, 'y', canvas) : 0,
  };
  return {
    x:
      isCssUnitValue(point.x) && isCssUnitValue(beforeSelected.x)
        ? canvasPercentToCssUnitValue(beforeSelectedCanvas.x + dx, 'x', point.x.unit, canvas)
        : point.x,
    y:
      isCssUnitValue(point.y) && isCssUnitValue(beforeSelected.y)
        ? canvasPercentToCssUnitValue(beforeSelectedCanvas.y + dy, 'y', point.y.unit, canvas)
        : point.y,
  };
}

// Moves a raw circle's centre, or sets its radius to the pointer's distance from it.
export function dragRawCircle(
  shape: RawClipPathShape,
  editable: RawEditable<'circle'>,
  target: DragTarget,
  { x, y }: Point,
  canvas: HTMLElement,
): ClipShape | undefined {
  if (target.kind === 'circle-center') {
    return withRawEditable(shape, {
      ...editable,
      cx: canvasPercentToCssUnitValue(x, 'x', editable.cx.unit, canvas),
      cy: canvasPercentToCssUnitValue(y, 'y', editable.cy.unit, canvas),
    });
  }
  if (target.kind !== 'circle-radius') {
    return undefined;
  }
  const center = {
    x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
    y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
  };
  const rect = canvas.getBoundingClientRect();
  const distancePx = Math.hypot(((x - center.x) / 100) * rect.width, ((y - center.y) / 100) * rect.height);
  const unitPx = cssUnitPx(editable.radius.unit, 'x', canvas);
  return withRawEditable(shape, {
    ...editable,
    radius: {
      value: unitPx > 0 ? distancePx / unitPx : editable.radius.value,
      unit: editable.radius.unit,
    },
  });
}

// Moves a raw ellipse's centre, or sets one radius (scaling the other with it when
// proportional).
export function dragRawEllipse(
  shape: RawClipPathShape,
  editable: RawEditable<'ellipse'>,
  target: DragTarget,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape | undefined {
  if (target.kind === 'ellipse-center') {
    return withRawEditable(shape, {
      ...editable,
      cx: canvasPercentToCssUnitValue(x, 'x', editable.cx.unit, canvas),
      cy: canvasPercentToCssUnitValue(y, 'y', editable.cy.unit, canvas),
    });
  }
  if (target.kind === 'ellipse-rx') {
    const centerX = cssUnitValueToCanvasPercent(editable.cx, 'x', canvas);
    const nextRxPercent = Math.abs(x - centerX);
    const nextEditable: RawEditableClipPath = {
      ...editable,
      rx: canvasPercentToCssUnitValue(nextRxPercent, 'x', editable.rx.unit, canvas),
    };
    if (options.ellipseScaleProportional) {
      const currentRxPercent = cssUnitValueToCanvasPercent(editable.rx, 'x', canvas);
      if (currentRxPercent > 0) {
        const scale = nextRxPercent / currentRxPercent;
        nextEditable.ry = { value: Math.max(0, editable.ry.value * scale), unit: editable.ry.unit };
      }
    }
    return withRawEditable(shape, nextEditable);
  }
  if (target.kind === 'ellipse-ry') {
    const centerY = cssUnitValueToCanvasPercent(editable.cy, 'y', canvas);
    const nextRyPercent = Math.abs(y - centerY);
    const nextEditable: RawEditableClipPath = {
      ...editable,
      ry: canvasPercentToCssUnitValue(nextRyPercent, 'y', editable.ry.unit, canvas),
    };
    if (options.ellipseScaleProportional) {
      const currentRyPercent = cssUnitValueToCanvasPercent(editable.ry, 'y', canvas);
      if (currentRyPercent > 0) {
        const scale = nextRyPercent / currentRyPercent;
        nextEditable.rx = { value: Math.max(0, editable.rx.value * scale), unit: editable.rx.unit };
      }
    }
    return withRawEditable(shape, nextEditable);
  }
  return undefined;
}

// Moves a raw inset edge — alone, with its opposite, or all four together.
export function dragRawInsetSide(
  shape: RawClipPathShape,
  editable: RawEditable<'inset'>,
  side: InsetSide,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape {
  const nextEditable: Extract<RawEditableClipPath, { kind: 'inset' }> = { ...editable };
  const setSide = (nextSide: InsetSide, value: CssUnitValue) => {
    nextEditable[nextSide] = value;
  };
  const sideValue =
    side === 'top'
      ? canvasPercentToCssUnitValue(y, 'y', editable.top.unit, canvas)
      : side === 'right'
        ? canvasPercentToCssUnitValue(100 - x, 'x', editable.right.unit, canvas)
        : side === 'bottom'
          ? canvasPercentToCssUnitValue(100 - y, 'y', editable.bottom.unit, canvas)
          : canvasPercentToCssUnitValue(x, 'x', editable.left.unit, canvas);
  const mode = options.insetSideMode || 'single';

  if (mode === 'all') {
    setSide('top', { ...sideValue, unit: editable.top.unit });
    setSide('right', { ...sideValue, unit: editable.right.unit });
    setSide('bottom', { ...sideValue, unit: editable.bottom.unit });
    setSide('left', { ...sideValue, unit: editable.left.unit });
  } else if (mode === 'opposite') {
    setSide(side, sideValue);
    const opposite = oppositeInsetSide(side);
    const oppositeUnit = editable[opposite].unit;
    setSide(opposite, { ...sideValue, unit: oppositeUnit });
  } else {
    setSide(side, sideValue);
  }
  return withRawEditable(shape, nextEditable);
}

// Sets a raw inset corner radius from the pointer — alone, with the opposite corner,
// or all four — round unless the radius is unlocked.
export function dragRawInsetRadius(
  shape: RawClipPathShape,
  editable: RawEditable<'inset'>,
  corner: CornerName,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape {
  const radii = editable.radii;
  if (!radii) {
    return shape;
  }
  const box = rawInsetBox(editable, canvas);
  const horizontal = expandCssUnitValues(radii.horizontal);
  const vertical = expandCssUnitValues(radii.vertical || radii.horizontal);
  const cornerIndex = CORNERS.indexOf(corner);
  const localXPercent = corner === 'topRight' || corner === 'bottomRight' ? Math.max(0, box.x1 - x) : Math.max(0, x - box.x0);
  const localYPercent = corner === 'bottomRight' || corner === 'bottomLeft' ? Math.max(0, box.y1 - y) : Math.max(0, y - box.y0);
  const currentHorizontal = horizontal[cornerIndex];
  const currentVertical = vertical[cornerIndex];
  if (!currentHorizontal || !currentVertical) {
    return shape;
  }
  const radiusX = canvasPercentToCssUnitValue(localXPercent, 'x', currentHorizontal.unit, canvas);
  const radiusY = canvasPercentToCssUnitValue(localYPercent, 'y', currentVertical.unit, canvas);
  const radius = options.insetRadiusUnlocked ? { x: radiusX, y: radiusY } : { x: radiusX, y: { value: radiusX.value, unit: currentVertical.unit } };
  const next = setRawInsetRadii({ horizontal, vertical }, { corner, cornerIndex, radius, mode: options.insetRadiusMode || 'single' });
  return withRawEditable(shape, { ...editable, radii: next });
}

// The radii with the dragged corner — and, by mode, its opposite or every corner —
// set to `radius`, each keeping its own unit.
export function setRawInsetRadii(
  { horizontal, vertical }: { horizontal: CssUnitValue[]; vertical: CssUnitValue[] },
  {
    corner,
    cornerIndex,
    radius,
    mode,
  }: {
    corner: CornerName;
    cornerIndex: number;
    radius: { x: CssUnitValue; y: CssUnitValue };
    mode: InsetRadiusMode;
  },
): { horizontal: CssUnitValue[]; vertical: CssUnitValue[] } {
  const nextHorizontal = [...horizontal];
  const nextVertical = [...vertical];
  const setRadius = (target: CornerName) => {
    const index = CORNERS.indexOf(target);
    const horizontalValue = nextHorizontal[index];
    const verticalValue = nextVertical[index];
    if (!horizontalValue || !verticalValue) {
      return;
    }
    nextHorizontal[index] = index === cornerIndex ? radius.x : { value: radius.x.value, unit: horizontalValue.unit };
    nextVertical[index] = index === cornerIndex ? radius.y : { value: radius.y.value, unit: verticalValue.unit };
  };
  if (mode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (mode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }
  return { horizontal: nextHorizontal, vertical: nextVertical };
}

// Moves the dragged polygon point; with several selected, all of them move by the
// same offset from where the drag began.
export function dragPolygonPoint(shape: PolygonShape, target: DragTarget & { kind: 'polygon-point' }, x: number, y: number): ClipShape {
  if (target.before.kind === 'polygon' && target.polygonPointIndexes?.length) {
    const beforePoint = target.before.points[target.index];
    if (!beforePoint) {
      return shape;
    }

    const selectedIndexes = new Set(target.polygonPointIndexes);
    const dx = x - beforePoint.x;
    const dy = y - beforePoint.y;

    return {
      kind: 'polygon',
      points: shape.points.map((point, index) => {
        const beforeSelectedPoint = target.before.kind === 'polygon' ? target.before.points[index] : undefined;
        return selectedIndexes.has(index) && beforeSelectedPoint ? { x: beforeSelectedPoint.x + dx, y: beforeSelectedPoint.y + dy } : point;
      }),
    };
  }

  return {
    kind: 'polygon',
    points: shape.points.map((point, index) => (index === target.index ? { x, y } : point)),
  };
}

// Moves a circle or ellipse's centre, or sets a radius from the pointer (an ellipse
// scaling its other radius with it when proportional).
export function dragRoundShape(shape: CircleShape | EllipseShape, target: DragTarget, x: number, y: number, options: ShapeDragOptions): ClipShape {
  if (shape.kind === 'circle') {
    if (target.kind === 'circle-center') {
      return { ...shape, cx: x, cy: y };
    }
    if (target.kind === 'circle-radius') {
      const radius = Math.sqrt((x - shape.cx) ** 2 + (y - shape.cy) ** 2);
      return { ...shape, radius: Math.max(0, radius) };
    }
    return shape;
  }
  if (target.kind === 'ellipse-center') {
    return { ...shape, cx: x, cy: y };
  }
  if (target.kind === 'ellipse-rx') {
    const nextRx = Math.max(0, Math.abs(x - shape.cx));
    if (options.ellipseScaleProportional && shape.rx > 0) {
      const scale = nextRx / shape.rx;
      return { ...shape, rx: nextRx, ry: Math.max(0, shape.ry * scale) };
    }
    return { ...shape, rx: nextRx };
  }
  if (target.kind === 'ellipse-ry') {
    const nextRy = Math.max(0, Math.abs(y - shape.cy));
    if (options.ellipseScaleProportional && shape.ry > 0) {
      const scale = nextRy / shape.ry;
      return { ...shape, ry: nextRy, rx: Math.max(0, shape.rx * scale) };
    }
    return { ...shape, ry: nextRy };
  }
  return shape;
}

// Moves an inset edge, or sets a corner radius from the pointer.
export function dragInset(shape: InsetShape, target: DragTarget, x: number, y: number, options: ShapeDragOptions): ClipShape {
  const insetSideByTarget: Partial<Record<DragTarget['kind'], InsetSide>> = {
    'inset-top': 'top',
    'inset-right': 'right',
    'inset-bottom': 'bottom',
    'inset-left': 'left',
  };
  const side = insetSideByTarget[target.kind];

  if (side) {
    const value = side === 'top' ? y : side === 'right' ? 100 - x : side === 'bottom' ? 100 - y : x;
    const oppositeSide = oppositeInsetSide(side);
    const mode = options.insetSideMode || 'single';
    const next: InsetShape = { ...shape };

    if (mode === 'all') {
      next.top = value;
      next.right = value;
      next.bottom = value;
      next.left = value;
    } else if (mode === 'opposite') {
      next[side] = value;
      next[oppositeSide] = value;
    } else {
      next[side] = value;
    }

    return next;
  }
  if (target.kind === 'inset-radius') {
    return dragInsetRadius(shape, target.corner, x, y, options);
  }
  return shape;
}

// Sets an inset corner radius from the pointer — alone, with the opposite corner,
// or all four — round unless the radius is unlocked.
export function dragInsetRadius(shape: InsetShape, corner: CornerName, x: number, y: number, options: ShapeDragOptions): ClipShape {
  const { width, height, x1: rightEdge, y1: bottomEdge } = insetBox(shape);
  const localX = corner === 'topRight' || corner === 'bottomRight' ? Math.max(0, rightEdge - x) : Math.max(0, x - shape.left);
  const localY = corner === 'bottomRight' || corner === 'bottomLeft' ? Math.max(0, bottomEdge - y) : Math.max(0, y - shape.top);
  const radiusX = width > 0 ? (localX / width) * 100 : 0;
  const radiusY = height > 0 ? (localY / height) * 100 : 0;
  const radiusValue = Math.max(0, (radiusX + radiusY) / 2);
  const radius = options.insetRadiusUnlocked ? { x: radiusX, y: radiusY } : { x: radiusValue, y: radiusValue };
  const nextRadii = { ...shape.radii };
  const setRadius = (target: CornerName) => {
    nextRadii[target] = { ...radius };
  };

  const insetRadiusMode = options.insetRadiusMode || 'single';

  if (insetRadiusMode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (insetRadiusMode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }

  return {
    ...shape,
    radii: nextRadii,
  };
}
