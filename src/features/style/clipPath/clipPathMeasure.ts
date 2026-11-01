// Numbers, units and space in the clip-path editor: formatting a percent, a
// unit value or a coordinate, snapping a point or a shape to guides, bounds,
// distances and segment intersections, and where a polygon handle is drawn
// (ClipPath.tsx).

import {
  type Point,
  type InsetShape,
  type CssUnitValue,
  type CssCoordinateValue,
  type CssCoordinatePoint,
  type ClipShape,
  type DragTarget,
  type CanvasHandleBounds,
  type BoundsSide,
  type PolygonDisplayEdge,
  type PolygonDisplayProjection,
  type SelectionRect,
  type SnapGuides,
  type SnapAxisResult,
  type SnapPointResult,
} from './clipPathTypes';
import { EDGE_SNAP_DISTANCE, SNAP_GUIDE_ALIGNMENT_EPSILON, DUPLICATE_POINT_OFFSET } from './clipPathConstants';

export function formatPercent(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

export function formatCssNumber(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

export function formatCssUnitValue(value: CssUnitValue) {
  return `${formatCssNumber(value.value)}${value.unit}`;
}

export function isCssUnitValue(value: CssCoordinateValue): value is CssUnitValue {
  return 'value' in value;
}

export function formatCssCoordinateValue(value: CssCoordinateValue) {
  return isCssUnitValue(value) ? formatCssUnitValue(value) : value.expression;
}

export function formatCssCoordinatePoint(point: CssCoordinatePoint) {
  return `${formatCssCoordinateValue(point.x)} ${formatCssCoordinateValue(point.y)}`;
}

export function formatCssScaleNumber(value: number) {
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatCqw(value: number) {
  return `${formatCssNumber(value)}cqw`;
}

export function sanitizeShapeScaleVariableName(value: string) {
  const trimmed = value.trim();
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Coerce free-text into a valid CSS custom-property name (e.g. "Element Size" -> "--element-size").
// An already-valid `--name` is left untouched so existing variables keep their casing.
export function formatShapeVariableName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^--[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  const body = trimmed
    .replace(/^-+/, '') // drop leading dashes (re-added as the -- prefix)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // camelCase -> kebab-case
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // spaces & other invalid chars -> hyphen
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  return body ? `--${body}` : '';
}

export function emptySnapGuides(): SnapGuides {
  return { x: [], y: [] };
}

export function addSnapGuide(guides: SnapGuides, axis: keyof SnapGuides, value: number) {
  if (guides[axis].some((guide) => Math.abs(guide - value) < 0.01)) {
    return;
  }
  guides[axis].push(value);
}

export function snapAxisToAnchors(value: number, anchors: number[], _startValue?: number): SnapAxisResult {
  let closest = value;
  let guide: number | undefined = undefined;
  let closestDistance = EDGE_SNAP_DISTANCE;

  anchors.forEach((anchor) => {
    const distance = Math.abs(value - anchor);
    if (distance <= closestDistance) {
      closest = anchor;
      guide = anchor;
      closestDistance = distance;
    }
  });

  return { value: closest, guide };
}

export function snapPointToAnchors(x: number, y: number, xAnchors: number[], yAnchors: number[], start?: Point): SnapPointResult {
  const snappedX = snapAxisToAnchors(x, xAnchors, start?.x);
  const snappedY = snapAxisToAnchors(y, yAnchors, start?.y);
  const guides = emptySnapGuides();

  if (snappedX.guide !== undefined) {
    addSnapGuide(guides, 'x', snappedX.guide);
  }
  if (snappedY.guide !== undefined) {
    addSnapGuide(guides, 'y', snappedY.guide);
  }

  return {
    point: { x: snappedX.value, y: snappedY.value },
    guides,
  };
}

export function pointAlignmentGuides(point: Point, xAnchors: number[], yAnchors: number[]) {
  const guides = emptySnapGuides();

  xAnchors.forEach((anchor) => {
    if (Math.abs(point.x - anchor) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, 'x', anchor);
    }
  });
  yAnchors.forEach((anchor) => {
    if (Math.abs(point.y - anchor) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, 'y', anchor);
    }
  });

  return guides;
}

export function mergeSnapGuides(...items: SnapGuides[]) {
  const merged = emptySnapGuides();

  items.forEach((guides) => {
    guides.x.forEach((value) => addSnapGuide(merged, 'x', value));
    guides.y.forEach((value) => addSnapGuide(merged, 'y', value));
  });

  return merged;
}

export function normalizeSnapGuides(guides: SnapGuides): SnapGuides | undefined {
  const x = guides.x.filter((value, index, values) => values.findIndex((item) => Math.abs(item - value) < 0.01) === index);
  const y = guides.y.filter((value, index, values) => values.findIndex((item) => Math.abs(item - value) < 0.01) === index);
  return x.length || y.length ? { x, y } : undefined;
}

export function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function rectFromPoints(start: Point, end: Point): SelectionRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.max(start.x, end.x) - left,
    height: Math.max(start.y, end.y) - top,
  };
}

export function pointInRect(point: Point, rect: SelectionRect) {
  return point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height;
}

export function addShapeSnapCandidate(
  candidates: Array<{ delta: number; distance: number; guide: number }>,
  current: number,
  next: number,
  target: number,
  delta: number,
  { sticky }: { sticky: boolean },
) {
  const distance = Math.abs(next - target);
  if (distance <= EDGE_SNAP_DISTANCE && (sticky || Math.abs(current - target) > SNAP_GUIDE_ALIGNMENT_EPSILON)) {
    candidates.push({ delta, distance, guide: target });
  }
}

export function addAlignedShapeGuide(guides: SnapGuides, axis: keyof SnapGuides, value: number, targets: number[]) {
  targets.forEach((target) => {
    if (Math.abs(value - target) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, axis, target);
    }
  });
}

export function shapeSnapGuidesForBounds(bounds: SelectionRect) {
  const guides = emptySnapGuides();
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;

  addAlignedShapeGuide(guides, 'x', bounds.left, [0]);
  addAlignedShapeGuide(guides, 'x', right, [100]);
  addAlignedShapeGuide(guides, 'x', centerX, [0, 50, 100]);
  addAlignedShapeGuide(guides, 'y', bounds.top, [0]);
  addAlignedShapeGuide(guides, 'y', bottom, [100]);
  addAlignedShapeGuide(guides, 'y', centerY, [0, 50, 100]);

  return guides;
}

export function snappedShapeMoveDelta(bounds: SelectionRect, dx: number, dy: number, options: { sticky?: boolean } = {}) {
  const sticky = options.sticky ?? false;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const xCandidates: Array<{ delta: number; distance: number; guide: number }> = [];
  const yCandidates: Array<{ delta: number; distance: number; guide: number }> = [];

  addShapeSnapCandidate(xCandidates, bounds.left, bounds.left + dx, 0, -bounds.left, { sticky });
  addShapeSnapCandidate(xCandidates, right, right + dx, 100, 100 - right, { sticky });
  [0, 50, 100].forEach((target) => {
    addShapeSnapCandidate(xCandidates, centerX, centerX + dx, target, target - centerX, { sticky });
  });

  addShapeSnapCandidate(yCandidates, bounds.top, bounds.top + dy, 0, -bounds.top, { sticky });
  addShapeSnapCandidate(yCandidates, bottom, bottom + dy, 100, 100 - bottom, { sticky });
  [0, 50, 100].forEach((target) => {
    addShapeSnapCandidate(yCandidates, centerY, centerY + dy, target, target - centerY, { sticky });
  });

  const closest = (candidates: Array<{ delta: number; distance: number; guide: number }>, fallback: number) =>
    candidates.sort((nearer, farther) => nearer.distance - farther.distance)[0] || {
      delta: fallback,
      distance: Infinity,
      guide: NaN,
    };
  const xSnap = closest(xCandidates, dx);
  const ySnap = closest(yCandidates, dy);
  const snappedBounds = {
    ...bounds,
    left: bounds.left + xSnap.delta,
    top: bounds.top + ySnap.delta,
  };
  const guides = shapeSnapGuidesForBounds(snappedBounds);

  return {
    dx: xSnap.delta,
    dy: ySnap.delta,
    guides,
  };
}

export function boundsClose(left: CanvasHandleBounds | undefined, right: CanvasHandleBounds) {
  return Boolean(
    left &&
    Math.abs(left.minX - right.minX) < 0.1 &&
    Math.abs(left.maxX - right.maxX) < 0.1 &&
    Math.abs(left.minY - right.minY) < 0.1 &&
    Math.abs(left.maxY - right.maxY) < 0.1,
  );
}

export function pointInBounds(point: Point, bounds: CanvasHandleBounds) {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

export function distanceSquared(from: Point, to: Point) {
  return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
}

export function pointsNearlyEqual(left: Point, right: Point) {
  return Math.abs(left.x - right.x) < 0.1 && Math.abs(left.y - right.y) < 0.1;
}

export function outsideBoundsSides(point: Point, bounds: CanvasHandleBounds) {
  const sides: BoundsSide[] = [];
  if (point.y < bounds.minY) {
    sides.push('top');
  }
  if (point.y > bounds.maxY) {
    sides.push('bottom');
  }
  if (point.x < bounds.minX) {
    sides.push('left');
  }
  if (point.x > bounds.maxX) {
    sides.push('right');
  }
  return sides;
}

export function addUniqueIntersection(intersections: Array<{ point: Point; side: BoundsSide }>, intersection: { point: Point; side: BoundsSide }) {
  if (
    intersections.some(
      (item) => item.side === intersection.side && Math.abs(item.point.x - intersection.point.x) < 0.01 && Math.abs(item.point.y - intersection.point.y) < 0.01,
    )
  ) {
    return;
  }
  intersections.push(intersection);
}

export function segmentBoundsIntersections(start: Point, end: Point, bounds: CanvasHandleBounds) {
  const intersections: Array<{ point: Point; side: BoundsSide }> = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const addAtFraction = (fraction: number, side: BoundsSide) => {
    if (fraction < 0 || fraction > 1) {
      return;
    }
    const point = { x: start.x + dx * fraction, y: start.y + dy * fraction };
    if (pointInBounds(point, bounds)) {
      addUniqueIntersection(intersections, { point, side });
    }
  };

  if (Math.abs(dx) > 0.0001) {
    addAtFraction((bounds.minX - start.x) / dx, 'left');
    addAtFraction((bounds.maxX - start.x) / dx, 'right');
  }
  if (Math.abs(dy) > 0.0001) {
    addAtFraction((bounds.minY - start.y) / dy, 'top');
    addAtFraction((bounds.maxY - start.y) / dy, 'bottom');
  }

  return intersections;
}

export function closestPolygonProjection(candidates: Array<{ point: Point; edge: PolygonDisplayEdge; side: BoundsSide }>, target: Point) {
  return candidates.reduce((closest, candidate) => (distanceSquared(candidate.point, target) < distanceSquared(closest.point, target) ? candidate : closest));
}

export function polygonHandleDisplayPoint(
  points: Point[],
  index: number,
  bounds: CanvasHandleBounds | undefined,
  preferred?: PolygonDisplayProjection,
): { point: Point; projection: PolygonDisplayProjection | undefined } {
  const point = points[index];
  if (!point) {
    return { point: { x: 0, y: 0 }, projection: undefined };
  }
  if (!bounds || pointInBounds(point, bounds)) {
    return { point, projection: undefined };
  }

  const previous = points[(index - 1 + points.length) % points.length] ?? point;
  const next = points[(index + 1) % points.length] ?? point;
  const sides = outsideBoundsSides(point, bounds);
  const incomingIntersections = segmentBoundsIntersections(previous, point, bounds);
  const outgoingIntersections = segmentBoundsIntersections(point, next, bounds);
  const candidatesForSide = (side: BoundsSide) => [
    ...incomingIntersections
      .filter((intersection) => intersection.side === side)
      .map((intersection) => ({ point: intersection.point, side, edge: 'prev' as const })),
    ...outgoingIntersections
      .filter((intersection) => intersection.side === side)
      .map((intersection) => ({ point: intersection.point, side, edge: 'next' as const })),
  ];

  if (preferred && sides.includes(preferred.side)) {
    const preferredCandidate = candidatesForSide(preferred.side).find((candidate) => candidate.edge === preferred.edge);
    if (preferredCandidate) {
      return { point: preferredCandidate.point, projection: preferred };
    }
  }

  for (const side of sides) {
    const candidates = candidatesForSide(side);
    if (candidates.length) {
      const closest = closestPolygonProjection(candidates, point);
      return { point: closest.point, projection: { side, edge: closest.edge } };
    }
  }

  const allCandidates = [
    ...incomingIntersections.map((intersection) => ({
      point: intersection.point,
      side: intersection.side,
      edge: 'prev' as const,
    })),
    ...outgoingIntersections.map((intersection) => ({
      point: intersection.point,
      side: intersection.side,
      edge: 'next' as const,
    })),
  ];
  if (allCandidates.length) {
    const closest = closestPolygonProjection(allCandidates, point);
    return { point: closest.point, projection: { side: closest.side, edge: closest.edge } };
  }

  return {
    point: {
      x: clampValue(point.x, bounds.minX, bounds.maxX),
      y: clampValue(point.y, bounds.minY, bounds.maxY),
    },
    projection: undefined,
  };
}

export function snapDragPointForTarget(shape: ClipShape, target: DragTarget, x: number, y: number): SnapPointResult {
  const start = target.dragOrigin?.handle;
  if (
    (target.kind === 'circle-center' && (shape.kind === 'circle' || (shape.kind === 'raw' && shape.editable?.kind === 'circle'))) ||
    (target.kind === 'ellipse-center' && (shape.kind === 'ellipse' || (shape.kind === 'raw' && shape.editable?.kind === 'ellipse')))
  ) {
    return snapPointToAnchors(x, y, [0, 50, 100], [0, 50, 100]);
  }

  if (shape.kind === 'inset' && target.kind === 'inset-radius') {
    const { x0, y0, x1, y1, width, height } = insetBox(shape);
    return snapPointToAnchors(x, y, [0, x0, x0 + width / 2, 50, x1, 100], [0, y0, y0 + height / 2, 50, y1, 100], start);
  }

  return snapPointToAnchors(x, y, [0, 50, 100], [0, 50, 100], start);
}

export function offsetDuplicatePoint(point: Point) {
  const dx = point.x + DUPLICATE_POINT_OFFSET <= 100 ? DUPLICATE_POINT_OFFSET : -DUPLICATE_POINT_OFFSET;
  const dy = point.y + DUPLICATE_POINT_OFFSET <= 100 ? DUPLICATE_POINT_OFFSET : -DUPLICATE_POINT_OFFSET;
  return {
    x: clampValue(point.x + dx, 0, 100),
    y: clampValue(point.y + dy, 0, 100),
  };
}

export function insetBox(shape: InsetShape) {
  const x0 = shape.left;
  const y0 = shape.top;
  const x1 = 100 - shape.right;
  const y1 = 100 - shape.bottom;
  return {
    x0,
    y0,
    x1,
    y1,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
}
