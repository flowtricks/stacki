// Inset radii and sides, the handles a shape is edited by — which one a
// drag target is, its colour, its label — and comparing shapes, points and
// radii (ClipPath.tsx).

import {
  type Point,
  type CornerName,
  type CornerRadii,
  type InsetShape,
  type CssUnitValue,
  type RawEditableClipPath,
  type ClipShape,
  type InsetSide,
  type InsetModifierMode,
  type KeyboardModifiers,
  type HandleTarget,
  type DragTarget,
} from './clipPathTypes';
import { assert } from '../../../../shared/core/assert';
import { CORNERS } from './clipPathConstants';
import { formatPercent, formatCssUnitValue, formatCssCoordinatePoint } from './clipPathMeasure';

// The most parts a box list (inset sides, corner radii) has.
const BOX_PARTS_MAX = 4;

export function makeInsetRadii(radius: number): CornerRadii {
  return {
    topLeft: { x: radius, y: radius },
    topRight: { x: radius, y: radius },
    bottomRight: { x: radius, y: radius },
    bottomLeft: { x: radius, y: radius },
  };
}

export function radiusValuesClose(left: number, right: number) {
  return Math.abs(left - right) < 1;
}

export function radiiClose(left: CornerRadii, right: CornerRadii) {
  return CORNERS.every((corner) => radiusValuesClose(left[corner].x, right[corner].x) && radiusValuesClose(left[corner].y, right[corner].y));
}

export function hasRoundedCorners(radii: CornerRadii) {
  return CORNERS.some((corner) => radii[corner].x > 0 || radii[corner].y > 0);
}

export function formatRadiusList(values: number[]) {
  return shortestBoxForm(values.map(formatPercent));
}

// The parts of a four-part box list — inset sides (top right bottom left) or
// border radii (top-left top-right bottom-right bottom-left) — written out to
// all four, as CSS fills them: a missing part copies the one two places back,
// or the first. Clip paths list sides and corners in the same clockwise order,
// so one rule serves both.
export function expandBoxParts(parts: readonly string[]): readonly [string, string, string, string] {
  assert(parts.length >= 1, 'expandBoxParts: a box list has at least one part');
  assert(parts.length <= BOX_PARTS_MAX, 'expandBoxParts: a box list has at most four parts');
  const first = parts[0] ?? '';
  const second = parts[1] ?? first;
  return [first, second, parts[2] ?? first, parts[3] ?? second];
}

// A box list in its shortest equivalent form, as margin, padding and
// border-radius are written by hand: four equal parts are one, top = bottom
// with left = right is two, left = right alone is three. The parts compare as
// written text, so `0` and `0px` stay apart; that only ever keeps a longer
// form, never changes the value.
export function shortestBoxForm(parts: readonly string[]): string {
  const [top, right, bottom, left] = expandBoxParts(parts);
  const shortest = shortestBoxParts(top, right, bottom, left);
  const expanded = expandBoxParts(shortest);
  assert(expanded[0] === top, 'shortestBoxForm: the short form keeps the first part');
  assert(expanded[1] === right, 'shortestBoxForm: the short form keeps the second part');
  assert(expanded[2] === bottom, 'shortestBoxForm: the short form keeps the third part');
  assert(expanded[3] === left, 'shortestBoxForm: the short form keeps the fourth part');
  return shortest.join(' ');
}

// The fewest parts that expand back to these four.
function shortestBoxParts(top: string, right: string, bottom: string, left: string): readonly string[] {
  if (right === left) {
    if (top === bottom) {
      if (top === right) {
        return [top];
      }
      return [top, right];
    }
    return [top, right, bottom];
  }
  return [top, right, bottom, left];
}

export function formatRadii(radii: CornerRadii) {
  const horizontal = CORNERS.map((corner) => radii[corner].x);
  const vertical = CORNERS.map((corner) => radii[corner].y);
  const horizontalPart = formatRadiusList(horizontal);
  const verticalPart = formatRadiusList(vertical);
  return horizontalPart === verticalPart ? horizontalPart : `${horizontalPart} / ${verticalPart}`;
}

export function formatInsetSides(shape: InsetShape) {
  return formatRadiusList([shape.top, shape.right, shape.bottom, shape.left]);
}

export function formatRawEditableClipPath(editable: RawEditableClipPath) {
  if (editable.kind === 'polygon') {
    const prefix = editable.fillRule ? `${editable.fillRule}, ` : '';
    return `polygon(${prefix}${editable.points.map(formatCssCoordinatePoint).join(', ')})`;
  }

  if (editable.kind === 'circle') {
    const radius = formatCssUnitValue(editable.radius);
    const center = `${formatCssUnitValue(editable.cx)} ${formatCssUnitValue(editable.cy)}`;
    return `circle(${radius} at ${center})`;
  }

  if (editable.kind === 'ellipse') {
    const radii = `${formatCssUnitValue(editable.rx)} ${formatCssUnitValue(editable.ry)}`;
    const center = `${formatCssUnitValue(editable.cx)} ${formatCssUnitValue(editable.cy)}`;
    return `ellipse(${radii} at ${center})`;
  }

  // Shortest forms, as the sides and radii are written by hand: a drag of one
  // handle must not spell `inset(0.5rem round 2rem)` out to four sides, four
  // radii and a `/` of the same four again.
  const sides = shortestBoxForm([editable.top, editable.right, editable.bottom, editable.left].map(formatCssUnitValue));
  if (!editable.radii) {
    return `inset(${sides})`;
  }
  return `inset(${sides} round ${formatRawInsetRadii(editable.radii)})`;
}

// An inset's `round` radii, shortest first; the `/ vertical` half only when it
// differs from the horizontal one, since CSS reads a missing half as equal.
export function formatRawInsetRadii(radii: { horizontal: CssUnitValue[]; vertical?: CssUnitValue[] }): string {
  const horizontalParts = radii.horizontal.map(formatCssUnitValue);
  const horizontal = shortestBoxForm(horizontalParts);
  if (!radii.vertical) {
    return horizontal;
  }
  const vertical = shortestBoxForm(radii.vertical.map(formatCssUnitValue));
  assert(horizontal.length > 0, 'formatRawInsetRadii: the horizontal radii are written');
  return vertical === horizontal ? horizontal : `${horizontal} / ${vertical}`;
}

export function oppositeCorner(corner: CornerName): CornerName {
  if (corner === 'topLeft') {
    return 'bottomRight';
  }
  if (corner === 'topRight') {
    return 'bottomLeft';
  }
  if (corner === 'bottomRight') {
    return 'topLeft';
  }
  return 'topRight';
}

export function oppositeInsetSide(side: InsetSide): InsetSide {
  if (side === 'top') {
    return 'bottom';
  }
  if (side === 'right') {
    return 'left';
  }
  if (side === 'bottom') {
    return 'top';
  }
  return 'right';
}

export function insetSideForHandle(handle: HandleTarget): InsetSide | undefined {
  if (handle.kind === 'inset-top') {
    return 'top';
  }
  if (handle.kind === 'inset-right') {
    return 'right';
  }
  if (handle.kind === 'inset-bottom') {
    return 'bottom';
  }
  if (handle.kind === 'inset-left') {
    return 'left';
  }
  return undefined;
}

export function insetModifierModeFromKeys(modifiers: KeyboardModifiers): InsetModifierMode {
  return modifiers.shiftKey ? 'all' : modifiers.altKey ? 'opposite' : 'single';
}

export function isInsetHandle(handle: HandleTarget | undefined) {
  return Boolean(handle && (handle.kind === 'inset-radius' || insetSideForHandle(handle)));
}

export function isInsetHandleAffected(activeHandle: HandleTarget | undefined, candidate: HandleTarget, mode: InsetModifierMode) {
  if (mode === 'single' || !activeHandle || handlesMatch(activeHandle, candidate)) {
    return false;
  }

  if (activeHandle.kind === 'inset-radius' && candidate.kind === 'inset-radius') {
    return mode === 'all' || candidate.corner === oppositeCorner(activeHandle.corner);
  }

  const activeSide = insetSideForHandle(activeHandle);
  const candidateSide = insetSideForHandle(candidate);
  if (!activeSide || !candidateSide) {
    return false;
  }

  return mode === 'all' || candidateSide === oppositeInsetSide(activeSide);
}

export function cornerLabel(corner: CornerName) {
  if (corner === 'topLeft') {
    return 'top left';
  }
  if (corner === 'topRight') {
    return 'top right';
  }
  if (corner === 'bottomRight') {
    return 'bottom right';
  }
  return 'bottom left';
}

export function pointsClose(left: Point[], right: Point[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => {
    const other = right[index];
    return other !== undefined && Math.abs(point.x - other.x) < 1 && Math.abs(point.y - other.y) < 1;
  });
}

export function shapesClose(left: ClipShape, right: ClipShape) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' && right.kind === 'none') {
    return true;
  }
  if (left.kind === 'raw' && right.kind === 'raw') {
    return left.value === right.value;
  }
  if (left.kind === 'polygon' && right.kind === 'polygon') {
    return pointsClose(left.points, right.points);
  }
  if (left.kind === 'circle' && right.kind === 'circle') {
    return Math.abs(left.radius - right.radius) < 1 && Math.abs(left.cx - right.cx) < 1 && Math.abs(left.cy - right.cy) < 1;
  }
  if (left.kind === 'ellipse' && right.kind === 'ellipse') {
    return Math.abs(left.rx - right.rx) < 1 && Math.abs(left.ry - right.ry) < 1 && Math.abs(left.cx - right.cx) < 1 && Math.abs(left.cy - right.cy) < 1;
  }
  if (left.kind === 'inset' && right.kind === 'inset') {
    return (
      Math.abs(left.top - right.top) < 1 &&
      Math.abs(left.right - right.right) < 1 &&
      Math.abs(left.bottom - right.bottom) < 1 &&
      Math.abs(left.left - right.left) < 1 &&
      radiiClose(left.radii, right.radii)
    );
  }
  if (left.kind === 'shape' && right.kind === 'shape') {
    return left.value === right.value && (left.fillRule || 'nonzero') === (right.fillRule || 'nonzero');
  }
  return false;
}

export function pointsEqual(left: Point[], right: Point[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => {
    const other = right[index];
    return other !== undefined && point.x === other.x && point.y === other.y;
  });
}

export function radiiEqual(left: CornerRadii, right: CornerRadii) {
  return CORNERS.every((corner) => left[corner].x === right[corner].x && left[corner].y === right[corner].y);
}

export function shapesEqual(left: ClipShape, right: ClipShape) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' && right.kind === 'none') {
    return true;
  }
  if (left.kind === 'raw' && right.kind === 'raw') {
    return left.value === right.value;
  }
  if (left.kind === 'polygon' && right.kind === 'polygon') {
    return pointsEqual(left.points, right.points);
  }
  if (left.kind === 'circle' && right.kind === 'circle') {
    return left.radius === right.radius && left.cx === right.cx && left.cy === right.cy;
  }
  if (left.kind === 'ellipse' && right.kind === 'ellipse') {
    return left.rx === right.rx && left.ry === right.ry && left.cx === right.cx && left.cy === right.cy;
  }
  if (left.kind === 'inset' && right.kind === 'inset') {
    return (
      left.top === right.top && left.right === right.right && left.bottom === right.bottom && left.left === right.left && radiiEqual(left.radii, right.radii)
    );
  }
  if (left.kind === 'shape' && right.kind === 'shape') {
    return left.value === right.value && (left.fillRule || 'nonzero') === (right.fillRule || 'nonzero') && (left.pathData || '') === (right.pathData || '');
  }
  return false;
}

export function handlesMatch(left: HandleTarget | undefined, right: HandleTarget) {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'polygon-point' && right.kind === 'polygon-point') {
    return left.index === right.index;
  }
  if (left.kind === 'inset-radius' && right.kind === 'inset-radius') {
    return left.corner === right.corner;
  }
  return left.kind !== 'polygon-point' && left.kind !== 'inset-radius';
}

export function isPolygonPointHandle(handle: HandleTarget | undefined): handle is Extract<HandleTarget, { kind: 'polygon-point' }> {
  return handle?.kind === 'polygon-point';
}

export function handleListIncludes(handles: HandleTarget[], handle: HandleTarget) {
  return handles.some((item) => handlesMatch(item, handle));
}

export function uniqueHandles(handles: HandleTarget[]) {
  return handles.reduce<HandleTarget[]>((unique, handle) => {
    if (!handleListIncludes(unique, handle)) {
      unique.push(handle);
    }
    return unique;
  }, []);
}

export function previousSurvivingPolygonIndex(pointCount: number, deletedIndexes: Set<number>, referenceIndex: number) {
  for (let offset = 1; offset <= pointCount; offset += 1) {
    const index = (referenceIndex - offset + pointCount) % pointCount;
    if (!deletedIndexes.has(index)) {
      return index;
    }
  }
  return undefined;
}

export function remapPolygonIndexAfterDelete(index: number, deletedIndexes: Set<number>) {
  let deletedBefore = 0;
  deletedIndexes.forEach((deletedIndex) => {
    if (deletedIndex < index) {
      deletedBefore += 1;
    }
  });
  return index - deletedBefore;
}

export function handleKey(handle: HandleTarget) {
  if (handle.kind === 'polygon-point') {
    return `${handle.kind}:${handle.index}`;
  }
  if (handle.kind === 'inset-radius') {
    return `${handle.kind}:${handle.corner}`;
  }
  return handle.kind;
}

export function handleFromDragTarget(target: DragTarget): HandleTarget {
  if (target.kind === 'polygon-point') {
    return { kind: target.kind, index: target.index };
  }
  if (target.kind === 'inset-radius') {
    return { kind: target.kind, corner: target.corner };
  }
  return { kind: target.kind };
}

export const HANDLE_COLOR_CLASSES: readonly [string, string, string, string, string, string, string, string] = [
  'clip-path_color-a',
  'clip-path_color-b',
  'clip-path_color-c',
  'clip-path_color-d',
  'clip-path_color-e',
  'clip-path_color-f',
  'clip-path_color-g',
  'clip-path_color-h',
];

export function handleColorClass(handle: HandleTarget) {
  if (handle.kind === 'polygon-point') {
    return HANDLE_COLOR_CLASSES[handle.index % HANDLE_COLOR_CLASSES.length] ?? 'clip-path_color-a';
  }
  if (handle.kind === 'circle-center' || handle.kind === 'ellipse-center') {
    return 'clip-path_color-center';
  }
  if (handle.kind === 'circle-radius' || handle.kind === 'ellipse-rx' || handle.kind === 'inset-top') {
    return 'clip-path_color-a';
  }
  if (handle.kind === 'ellipse-ry' || handle.kind === 'inset-right') {
    return 'clip-path_color-b';
  }
  if (handle.kind === 'inset-bottom') {
    return 'clip-path_color-c';
  }
  if (handle.kind === 'inset-left') {
    return 'clip-path_color-d';
  }
  if (handle.kind === 'inset-radius') {
    return HANDLE_COLOR_CLASSES[(CORNERS.indexOf(handle.corner) + 4) % HANDLE_COLOR_CLASSES.length] ?? 'clip-path_color-a';
  }
  return 'clip-path_color-a';
}

export function polygonPointColorClass(index: number, colorClasses: string[] = []) {
  return colorClasses[index] || HANDLE_COLOR_CLASSES[index % HANDLE_COLOR_CLASSES.length] || 'clip-path_color-a';
}

export function normalizePolygonPointColors(count: number, colors: string[] = []) {
  return Array.from({ length: count }, (_, index) => polygonPointColorClass(index, colors));
}

export function nextPolygonPointColor(colors: string[], insertIndex: number) {
  const blocked = new Set([colors[insertIndex - 1], colors[insertIndex]].filter(Boolean));
  const unusedColor = HANDLE_COLOR_CLASSES.find((colorClass) => !colors.includes(colorClass) && !blocked.has(colorClass));
  if (unusedColor) {
    return unusedColor;
  }
  return HANDLE_COLOR_CLASSES.find((colorClass) => !blocked.has(colorClass)) || HANDLE_COLOR_CLASSES[0];
}

export function shorthandGroups<T>(items: T[], count = items.length) {
  const first = items[0];
  if (first === undefined) {
    return [];
  }
  const second = items[1] ?? first;
  const third = items[2] ?? first;
  const fourth = items[3] ?? second;
  if (count <= 1) {
    return [[first, second, third, fourth]];
  }
  if (count === 2) {
    return [
      [first, third],
      [second, fourth],
    ];
  }
  if (count === 3) {
    return [[first], [second, fourth], [third]];
  }
  return [[first], [second], [third], [fourth]];
}
