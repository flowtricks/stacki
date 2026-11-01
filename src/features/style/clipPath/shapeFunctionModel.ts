// The shape() model: its subpaths read from CSS, the contain model a scaled
// shape is edited through — moved, resized and written back — converting
// between stretch and contain, and parsing clip-path input as a whole
// (ClipPath.tsx).

import {
  type Point,
  type ShapeFunctionShape,
  type ClipShape,
  type SelectionRect,
  type ShapeResizeCorner,
  type ShapeFitMode,
  type ShapeScaleOptions,
  type ShapeContainModel,
  type ShapeCssPoint,
  type ShapeCssCommand,
  type ShapeCssSubpath,
  type PastedShapeSvgCache,
} from './clipPathTypes';
import {
  isDefined,
  DEFAULT_SHAPE_OFFSET_VALUE,
  SHAPE_OFFSET_TRAVEL_EPSILON,
  DEFAULT_SHAPE_SCALE_OPTIONS,
  SVG_POINT_EPSILON,
  NONE_SHAPE,
  DEFAULT_SHAPE_VALUE,
} from './clipPathConstants';
import { formatPercent, formatCssNumber, formatCssScaleNumber, formatCqw, sanitizeShapeScaleVariableName } from './clipPathMeasure';
import { oppositeCorner } from './clipPathHandles';
import {
  parsePercent,
  parsePolygon,
  parseCircle,
  parseEllipse,
  parseInset,
  parseRawBasicClipPath,
  parseCustomClipPath,
  parseShape,
  splitShapeCommandList,
} from './clipPathParse';
import {
  parseShapeOffsetCoordinate,
  shapeCalculatedCoordinateOffset,
  parseShapeCssPoint,
  hasContainerQueryUnit,
  readShapeCssPoint,
} from './shapeFunctionPatterns';

export function formatShapeCssPoint(point: ShapeCssPoint) {
  return `${point.x} ${point.y}`;
}

export function formatShapeValueFromCssSubpaths(subpaths: ShapeCssSubpath[]) {
  const [firstSubpath, ...restSubpaths] = subpaths;
  if (!firstSubpath) {
    return DEFAULT_SHAPE_VALUE;
  }

  const commandToShapeValue = (command: ShapeCssCommand) => {
    if (command.kind === 'line') {
      return `line to ${formatShapeCssPoint(command.to)}`;
    }
    if (command.kind === 'curve') {
      const control2 = command.control2 ? ` / ${formatShapeCssPoint(command.control2)}` : '';
      return [`curve to ${formatShapeCssPoint(command.to)}`, `with ${formatShapeCssPoint(command.control1)}${control2}`].join(' ');
    }
    return 'close';
  };
  // The first subpath opens `from` its start; each later one opens with a `move to`.
  const subpathCommands = (subpath: ShapeCssSubpath, opening: 'from' | 'move to') => [
    `${opening} ${formatShapeCssPoint(subpath.start)}`,
    ...subpath.commands.map(commandToShapeValue),
  ];

  return [...subpathCommands(firstSubpath, 'from'), ...restSubpaths.flatMap((subpath) => subpathCommands(subpath, 'move to'))].join(', ');
}

export function formatShapeContainCoordinate(offset: number, options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS) {
  const sign = offset < 0 ? '-' : '+';
  const amount = Math.abs(offset);
  if (options.useVariable) {
    const variableName = sanitizeShapeScaleVariableName(options.variableName);
    if (variableName) {
      const amountScale = formatCssScaleNumber(amount / 100);
      return `calc(50% ${sign} ${amountScale} * var(${variableName}, 100cqw))`;
    }
  }
  return `calc(50% ${sign} ${formatCqw(amount)})`;
}

export function resolveShapeScaleVarNames(options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS) {
  // Any empty name stays empty -> the coordinate emits the raw value instead of a var() wrapper.
  return {
    sizeVar: sanitizeShapeScaleVariableName(options.variableName || ''),
    offsetLeftVar: sanitizeShapeScaleVariableName(options.offsetLeftVariableName || ''),
    offsetTopVar: sanitizeShapeScaleVariableName(options.offsetTopVariableName || ''),
  };
}

// The span is WU (x) or HU (y); size = S (cqw); offset = OL/OT. See
// SHAPE_OFFSET_COORDINATE_PATTERN.
export function formatShapeOffsetCoordinate(position: number, span: number, size: number, offset: number, sizeVar: string, offsetVar: string, axis: 'x' | 'y') {
  const travelUnit = axis === 'x' ? 'cqw' : 'cqh';
  // No variable -> emit the raw value (100cqw / 0.5) instead of a var(name, value) wrapper.
  const sizeToken = sizeVar ? `var(${sizeVar}, ${formatCssNumber(size)}cqw)` : `${formatCssNumber(size)}cqw`;
  const offsetToken = offsetVar ? `var(${offsetVar}, ${formatCssScaleNumber(offset)})` : formatCssScaleNumber(offset);
  const positionTerm = `${formatCssScaleNumber(position)} * ${sizeToken}`;
  const spanTerm = `${formatCssScaleNumber(span)} * ${sizeToken}`;
  return `calc(${positionTerm} + ${offsetToken} * (100${travelUnit} - ${spanTerm}))`;
}

export type ShapeOffsetBounds = {
  minAx: number;
  minAy: number;
  wu: number;
  hu: number;
  size: number;
  ol: number;
  ot: number;
};

// Decompose a set of canvas points (0..100, 50 = center) into the offset model: size stays 100
// (the shape's width lives in WU), with OL/OT derived from the shape's near-edge position so the
// on-canvas appearance is preserved.
export function shapeOffsetBoundsFromCanvasPoints(points: Point[]): ShapeOffsetBounds | undefined {
  if (!points.length) {
    return undefined;
  }
  const axs = points.map((point) => (point.x - 50) / 100);
  const ays = points.map((point) => (point.y - 50) / 100);
  const minAx = Math.min(...axs);
  const minAy = Math.min(...ays);
  const wu = Math.max(...axs) - minAx;
  const hu = Math.max(...ays) - minAy;
  const size = 100;
  const travelX = 100 - wu * size;
  const travelY = 100 - hu * size;
  // |travel| ~ 0 means the shape fills the axis; OL/OT are then indeterminate, so default to
  // centered.
  const ol = Math.abs(travelX) > SHAPE_OFFSET_TRAVEL_EPSILON ? (50 + minAx * 100) / travelX : DEFAULT_SHAPE_OFFSET_VALUE;
  const ot = Math.abs(travelY) > SHAPE_OFFSET_TRAVEL_EPSILON ? (50 + minAy * 100) / travelY : DEFAULT_SHAPE_OFFSET_VALUE;
  return { minAx, minAy, wu, hu, size, ol, ot };
}

export function formatShapeOffsetPoint(
  point: Point,
  bounds: ShapeOffsetBounds,
  names: { sizeVar: string; offsetLeftVar: string; offsetTopVar: string },
): ShapeCssPoint {
  return {
    x: formatShapeOffsetCoordinate((point.x - 50) / 100 - bounds.minAx, bounds.wu, bounds.size, bounds.ol, names.sizeVar, names.offsetLeftVar, 'x'),
    y: formatShapeOffsetCoordinate((point.y - 50) / 100 - bounds.minAy, bounds.hu, bounds.size, bounds.ot, names.sizeVar, names.offsetTopVar, 'y'),
  };
}

export function shapeCoordinateOffset(value: string) {
  const percent = parsePercent(value);
  if (percent !== undefined) {
    return percent - 50;
  }

  return shapeCalculatedCoordinateOffset(value, true);
}

export function shapeCssPointToCanvasPoint(point: ShapeCssPoint): Point | undefined {
  const xOffset = shapeCoordinateOffset(point.x);
  const yOffset = shapeCoordinateOffset(point.y);
  return xOffset === undefined || yOffset === undefined ? undefined : { x: 50 + xOffset, y: 50 + yOffset };
}

export function shapeCssBounds(shape: ShapeFunctionShape): SelectionRect | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  const points = collectShapeCssPoints(subpaths)
    .map(shapeCssPointToCanvasPoint)
    .filter((point): point is Point => Boolean(point));
  if (!points.length) {
    return undefined;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

export function parseShapeCssSubpaths(value: string): ShapeCssSubpath[] | undefined {
  const subpaths: ShapeCssSubpath[] = [];
  let activeSubpath: ShapeCssSubpath | undefined = undefined;

  for (const command of splitShapeCommandList(value)) {
    const moveMatch = command.match(/^(from|move\s+to)\s+(.+)$/i);
    if (moveMatch?.[2]) {
      const start = parseShapeCssPoint(moveMatch[2]);
      if (!start) {
        return undefined;
      }
      activeSubpath = { start, commands: [] };
      subpaths.push(activeSubpath);
      continue;
    }

    if (!activeSubpath) {
      return undefined;
    }

    const lineMatch = command.match(/^line\s+to\s+(.+)$/i);
    if (lineMatch?.[1]) {
      const to = parseShapeCssPoint(lineMatch[1]);
      if (!to) {
        return undefined;
      }
      activeSubpath.commands.push({ kind: 'line', to });
      continue;
    }

    const curveMatch = command.match(/^curve\s+to\s+(.+)$/i);
    if (curveMatch?.[1]) {
      const to = readShapeCssPoint(curveMatch[1]);
      if (!to) {
        return undefined;
      }

      const withMatch = to.rest.match(/^with\s+(.+)$/i);
      if (!withMatch?.[1]) {
        return undefined;
      }

      const control1 = readShapeCssPoint(withMatch[1]);
      if (!control1) {
        return undefined;
      }

      const controlRest = control1.rest.trim();
      if (!controlRest) {
        activeSubpath.commands.push({ kind: 'curve', to: to.point, control1: control1.point });
        continue;
      }

      const control2Match = controlRest.match(/^\/\s*(.+)$/);
      const control2 = control2Match?.[1] ? parseShapeCssPoint(control2Match[1]) : undefined;
      if (!control2) {
        return undefined;
      }

      activeSubpath.commands.push({
        kind: 'curve',
        to: to.point,
        control1: control1.point,
        control2,
      });
      continue;
    }

    if (/^close$/i.test(command)) {
      activeSubpath.commands.push({ kind: 'close' });
      continue;
    }

    return undefined;
  }

  return subpaths.length ? subpaths : undefined;
}

export function collectShapeCssPoints(subpaths: ShapeCssSubpath[]) {
  return subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.commands.flatMap((command) => {
      if (command.kind === 'close') {
        return [];
      }
      if (command.kind === 'line') {
        return [command.to];
      }
      return [command.to, command.control1, command.control2].filter(isDefined);
    }),
  ]);
}

export function mapShapeCssSubpathPoints(subpaths: ShapeCssSubpath[], mapper: (point: ShapeCssPoint) => ShapeCssPoint): ShapeCssSubpath[] {
  return subpaths.map((subpath) => ({
    start: mapper(subpath.start),
    commands: subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return { kind: 'line' as const, to: mapper(command.to) };
      }
      if (command.kind === 'curve') {
        return {
          kind: 'curve' as const,
          to: mapper(command.to),
          control1: mapper(command.control1),
          ...(command.control2 ? { control2: mapper(command.control2) } : {}),
        };
      }
      return command;
    }),
  }));
}

// Re-emit a set of CSS subpaths in the offset encoding, decomposing each point's canvas position
// into the shared size/offset model. Used for stretch->contain conversion and legacy upgrades.
export function emitContainCssFromSubpaths(subpaths: ShapeCssSubpath[], options: ShapeScaleOptions): ShapeCssSubpath[] | undefined {
  const canvasPoints = collectShapeCssPoints(subpaths)
    .map(shapeCssPointToCanvasPoint)
    .filter((point): point is Point => Boolean(point));
  const bounds = shapeOffsetBoundsFromCanvasPoints(canvasPoints);
  if (!bounds) {
    return undefined;
  }
  const names = resolveShapeScaleVarNames(options);
  return mapShapeCssSubpathPoints(subpaths, (point) => {
    const canvas = shapeCssPointToCanvasPoint(point);
    return canvas ? formatShapeOffsetPoint(canvas, bounds, names) : point;
  });
}

// Parse a contain shape that is already in the offset encoding into its structured model.
// Returns null if any coordinate is not in the new format (legacy/foreign shapes).
export function containModelFromShape(shape: ShapeFunctionShape): ShapeContainModel | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }
  const cssPoints = collectShapeCssPoints(subpaths);
  if (!cssPoints.length) {
    return undefined;
  }

  const points: Array<{ ux: number; uy: number }> = [];
  let header: Omit<ShapeContainModel, 'points'> | undefined = undefined;
  for (const point of cssPoints) {
    const px = parseShapeOffsetCoordinate(point.x, true);
    const py = parseShapeOffsetCoordinate(point.y, true);
    if (!px || px.axis !== 'x' || !py || py.axis !== 'y') {
      return undefined;
    }
    points.push({ ux: px.u, uy: py.u });
    if (!header) {
      header = {
        wu: px.span,
        hu: py.span,
        size: px.size,
        ol: px.offset,
        ot: py.offset,
        sizeVar: px.sizeVar,
        offsetLeftVar: px.offsetVar,
        offsetTopVar: py.offsetVar,
      };
    }
  }
  if (!header) {
    return undefined;
  }
  return { points, ...header };
}

// Re-emit a contain shape keeping every point's own Ux/Uy but applying the model's
// size/offset/names.
export function shapeFromContainModel(shape: ShapeFunctionShape, model: ShapeContainModel): ShapeFunctionShape {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return shape;
  }
  const remapped = mapShapeCssSubpathPoints(subpaths, (point) => {
    const px = parseShapeOffsetCoordinate(point.x, true);
    const py = parseShapeOffsetCoordinate(point.y, true);
    if (!px || !py) {
      return point;
    }
    return {
      x: formatShapeOffsetCoordinate(px.u, model.wu, model.size, model.ol, model.sizeVar, model.offsetLeftVar, 'x'),
      y: formatShapeOffsetCoordinate(py.u, model.hu, model.size, model.ot, model.sizeVar, model.offsetTopVar, 'y'),
    };
  });
  return { ...shape, value: formatShapeValueFromCssSubpaths(remapped) };
}

// Translate a contain shape by a canvas-space delta by folding it into OL/OT (the geometry is
// fixed).
// Offsets are left unclamped so the shape can be moved partially off the container, as before.
export function moveContainModel(model: ShapeContainModel, dx: number, dy: number): ShapeContainModel {
  const travelX = 100 - model.wu * model.size;
  const travelY = 100 - model.hu * model.size;
  return {
    ...model,
    // |travel| ~ 0 means the shape fills the axis and can't be repositioned along it.
    ol: Math.abs(travelX) > SHAPE_OFFSET_TRAVEL_EPSILON ? model.ol + dx / travelX : model.ol,
    ot: Math.abs(travelY) > SHAPE_OFFSET_TRAVEL_EPSILON ? model.ot + dy / travelY : model.ot,
  };
}

// Uniformly scale a contain shape by writing --size, recomputing OL/OT so the anchor canvas point
// (opposite corner, or shape center on alt) stays fixed. The shape may grow larger than the
// container (travel goes negative — the offset then controls which side overflows).
export function resizeContainModel(model: ShapeContainModel, anchor: Point, scale: number): ShapeContainModel {
  const size = Math.max(0, model.size * scale);

  const bboxWidth = model.wu * model.size;
  const bboxHeight = model.hu * model.size;
  // Anchor's fractional position within the bbox (0 = near edge, 0.5 = center, 1 = far edge).
  const fx = bboxWidth > SHAPE_OFFSET_TRAVEL_EPSILON ? (anchor.x - model.ol * (100 - bboxWidth)) / bboxWidth : DEFAULT_SHAPE_OFFSET_VALUE;
  const fy = bboxHeight > SHAPE_OFFSET_TRAVEL_EPSILON ? (anchor.y - model.ot * (100 - bboxHeight)) / bboxHeight : DEFAULT_SHAPE_OFFSET_VALUE;

  const newTravelX = 100 - model.wu * size;
  const newTravelY = 100 - model.hu * size;
  return {
    ...model,
    size,
    ol: Math.abs(newTravelX) > SHAPE_OFFSET_TRAVEL_EPSILON ? (anchor.x - fx * model.wu * size) / newTravelX : model.ol,
    ot: Math.abs(newTravelY) > SHAPE_OFFSET_TRAVEL_EPSILON ? (anchor.y - fy * model.hu * size) / newTravelY : model.ot,
  };
}

export function convertShapeFitMode(
  shape: ShapeFunctionShape,
  fitMode: ShapeFitMode,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): ShapeFunctionShape | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  if (fitMode === 'contain') {
    const contained = emitContainCssFromSubpaths(subpaths, options);
    if (!contained) {
      return undefined;
    }
    return {
      ...shape,
      value: formatShapeValueFromCssSubpaths(contained),
    };
  }

  const xOffsets = collectShapeCssPoints(subpaths)
    .map((point) => shapeCoordinateOffset(point.x))
    .filter((offset): offset is number => offset !== undefined);
  const yOffsets = collectShapeCssPoints(subpaths)
    .map((point) => shapeCoordinateOffset(point.y))
    .filter((offset): offset is number => offset !== undefined);
  if (!xOffsets.length || !yOffsets.length) {
    return undefined;
  }

  const minXOffset = Math.min(...xOffsets);
  const maxXOffset = Math.max(...xOffsets);
  const minYOffset = Math.min(...yOffsets);
  const maxYOffset = Math.max(...yOffsets);
  const xOffsetRange = maxXOffset - minXOffset;
  const yOffsetRange = maxYOffset - minYOffset;
  if (xOffsetRange <= SVG_POINT_EPSILON || yOffsetRange <= SVG_POINT_EPSILON) {
    return undefined;
  }

  const stretched = mapShapeCssSubpathPoints(subpaths, (point) => {
    const xOffset = shapeCoordinateOffset(point.x);
    const yOffset = shapeCoordinateOffset(point.y);
    return {
      x: xOffset === undefined ? point.x : formatPercent(((xOffset - minXOffset) / xOffsetRange) * 100),
      y: yOffset === undefined ? point.y : formatPercent(((yOffset - minYOffset) / yOffsetRange) * 100),
    };
  });

  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(stretched),
  };
}

export function cacheFromShapeFitVariants(
  shape: ShapeFunctionShape,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): PastedShapeSvgCache | undefined {
  const isContain = hasContainerQueryUnit(shape.value);
  const stretch = isContain ? convertShapeFitMode(shape, 'stretch', options) : shape;
  const contain = isContain ? normalizeContainShapeCoordinates(shape, options) : convertShapeFitMode(shape, 'contain', options);

  return stretch && contain ? { source: 'shape()', stretch, contain } : undefined;
}

export function normalizeContainShapeCoordinates(shape: ShapeFunctionShape, options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS): ShapeFunctionShape {
  // Already in the offset encoding: preserve geometry/size/offset, only apply (possibly renamed)
  // vars.
  const model = containModelFromShape(shape);
  if (model) {
    const names = resolveShapeScaleVarNames(options);
    return shapeFromContainModel(shape, {
      ...model,
      sizeVar: names.sizeVar,
      offsetLeftVar: names.offsetLeftVar,
      offsetTopVar: names.offsetTopVar,
    });
  }

  // Legacy contain (or any parseable coordinates): upgrade to the offset encoding in place.
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return shape;
  }
  const upgraded = emitContainCssFromSubpaths(subpaths, options);
  if (!upgraded) {
    return shape;
  }
  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(upgraded),
  };
}

export function normalizeShapeFitCache(cache: PastedShapeSvgCache | undefined, options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS) {
  if (!cache) {
    return undefined;
  }
  const stretch = hasContainerQueryUnit(cache.stretch.value) ? convertShapeFitMode(cache.stretch, 'stretch', options) || cache.stretch : cache.stretch;
  const contain = normalizeContainShapeCoordinates(cache.contain, options);

  return { ...cache, stretch, contain };
}

export function formatShapeCanvasPoint(point: Point, fitMode: ShapeFitMode, options: ShapeScaleOptions): ShapeCssPoint {
  if (fitMode === 'contain') {
    return {
      x: formatShapeContainCoordinate(point.x - 50, options),
      y: formatShapeContainCoordinate(point.y - 50, options),
    };
  }

  return {
    x: formatPercent(point.x),
    y: formatPercent(point.y),
  };
}

export function transformShapeCanvasPoints(
  shape: ShapeFunctionShape,
  fitMode: ShapeFitMode,
  options: ShapeScaleOptions,
  transform: (point: Point) => Point,
): ShapeFunctionShape | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  const transformed = mapShapeCssSubpathPoints(subpaths, (point) => {
    const canvasPoint = shapeCssPointToCanvasPoint(point);
    return canvasPoint ? formatShapeCanvasPoint(transform(canvasPoint), fitMode, options) : point;
  });

  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(transformed),
  };
}

export function shapeResizeCornerPoint(bounds: SelectionRect, corner: ShapeResizeCorner): Point {
  if (corner === 'topLeft') {
    return { x: bounds.left, y: bounds.top };
  }
  if (corner === 'topRight') {
    return { x: bounds.left + bounds.width, y: bounds.top };
  }
  if (corner === 'bottomRight') {
    return { x: bounds.left + bounds.width, y: bounds.top + bounds.height };
  }
  return { x: bounds.left, y: bounds.top + bounds.height };
}

export function oppositeShapeResizeCorner(corner: ShapeResizeCorner): ShapeResizeCorner {
  return oppositeCorner(corner);
}

export function shapeFromPastedSvgCache(cache: PastedShapeSvgCache, fitMode: ShapeFitMode) {
  return fitMode === 'contain' ? cache.contain : cache.stretch;
}

export function parseClipPath(value: string): ClipShape | undefined {
  if (value.trim().toLowerCase() === 'none') {
    return NONE_SHAPE;
  }
  const shape = parseShape(value);
  if (shape) {
    return shape;
  }
  const polygon = parsePolygon(value);
  if (polygon) {
    return { kind: 'polygon', points: polygon };
  }
  return parseCircle(value) || parseEllipse(value) || parseInset(value) || parseRawBasicClipPath(value) || parseCustomClipPath(value);
}

export function parseClipPathInput(value: string): ClipShape | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const declarationMatch = trimmed.match(/(?:^|[;{\s])(?:-webkit-)?clip-path\s*:\s*([^;}]+)/i);
  const clipPathValue = declarationMatch?.[1] ?? trimmed;
  return parseClipPath(clipPathValue.trim().replace(/;$/, ''));
}
