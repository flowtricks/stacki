// Writing a clip shape back to CSS: the presets, polygon, shape() and path
// data from points and subpaths, SVG geometry mapped into the percent box,
// and contained and offset coordinates (ClipPath.tsx).

import {
  type Point,
  type ShapeFunctionShape,
  type ClipShape,
  type CanvasSize,
  type SvgViewBox,
  type SvgShapeCommand,
  type SvgShapeSubpath,
  type ShapeScaleOptions,
  type ShapeCssPoint,
  type ShapeCssSubpath,
  type SvgShapeBounds,
} from './clipPathTypes';
import {
  isDefined,
  DEFAULT_SHAPE_OFFSET_VALUE,
  DEFAULT_SHAPE_SCALE_OPTIONS,
  SVG_POINT_EPSILON,
  NONE_PRESET,
  CUSTOM_PRESET,
  NONE_SHAPE,
  CUSTOM_SHAPE,
  DEFAULT_SHAPE_PATH_DATA,
  DEFAULT_SHAPE_VALUE,
} from './clipPathConstants';
import { formatPercent, formatCssScaleNumber } from './clipPathMeasure';
import { makeInsetRadii, hasRoundedCorners, formatRadii, formatInsetSides, formatRawEditableClipPath } from './clipPathHandles';
import { formatShapeValueFromCssSubpaths, resolveShapeScaleVarNames, type ShapeOffsetBounds, formatShapeOffsetPoint } from './shapeFunctionModel';

export const PRESETS: Record<string, ClipShape> = {
  [NONE_PRESET]: NONE_SHAPE,
  Polygon: {
    kind: 'polygon',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  },
  Inset: { kind: 'inset', top: 12, right: 12, bottom: 12, left: 12, radii: makeInsetRadii(24) },
  Circle: { kind: 'circle', radius: 42, cx: 50, cy: 50 },
  Ellipse: { kind: 'ellipse', rx: 44, ry: 30, cx: 50, cy: 50 },
  Shape: { kind: 'shape', value: DEFAULT_SHAPE_VALUE, pathData: DEFAULT_SHAPE_PATH_DATA },
  [CUSTOM_PRESET]: CUSTOM_SHAPE,
};
export const PRESET_NAMES = Object.keys(PRESETS);

export function formatPolygon(points: Point[]) {
  const coords = points.map((point) => `${formatPercent(point.x)} ${formatPercent(point.y)}`).join(', ');
  return `polygon(${coords})`;
}

export function formatShapeValueFromPoints(points: Point[]) {
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) {
    return DEFAULT_SHAPE_VALUE;
  }

  return [
    `from ${formatPercent(firstPoint.x)} ${formatPercent(firstPoint.y)}`,
    ...restPoints.map((point) => `line to ${formatPercent(point.x)} ${formatPercent(point.y)}`),
    'close',
  ].join(', ');
}

export function mapShapeSubpathsToCss(subpaths: SvgShapeSubpath[], mapPoint: (point: Point) => ShapeCssPoint): ShapeCssSubpath[] {
  return subpaths.map((subpath) => ({
    start: mapPoint(subpath.start),
    commands: subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return { kind: 'line' as const, to: mapPoint(command.to) };
      }
      if (command.kind === 'curve') {
        return {
          kind: 'curve' as const,
          to: mapPoint(command.to),
          control1: mapPoint(command.control1),
          ...(command.control2 ? { control2: mapPoint(command.control2) } : {}),
        };
      }
      return command;
    }),
  }));
}

export function formatShapeValueFromSubpaths(subpaths: SvgShapeSubpath[]) {
  return formatShapeValueFromCssSubpaths(
    mapShapeSubpathsToCss(subpaths, (point) => ({
      x: formatPercent(point.x),
      y: formatPercent(point.y),
    })),
  );
}

export function formatPathDataFromPoints(points: Point[]) {
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) {
    return DEFAULT_SHAPE_PATH_DATA;
  }

  return [`M${firstPoint.x} ${firstPoint.y}`, ...restPoints.map((point) => `L${point.x} ${point.y}`), 'Z'].join('');
}

export function formatPathDataFromSubpaths(subpaths: SvgShapeSubpath[]) {
  const pathData = subpaths.flatMap((subpath) => [
    `M${subpath.start.x} ${subpath.start.y}`,
    ...subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return `L${command.to.x} ${command.to.y}`;
      }
      if (command.kind === 'curve') {
        return command.control2
          ? `C${command.control1.x} ${command.control1.y} ` + `${command.control2.x} ${command.control2.y} ` + `${command.to.x} ${command.to.y}`
          : `Q${command.control1.x} ${command.control1.y} ${command.to.x} ${command.to.y}`;
      }
      return 'Z';
    }),
  ]);

  return pathData.length ? pathData.join('') : DEFAULT_SHAPE_PATH_DATA;
}

export function shapeFromPolygonPoints(points: Point[]): ShapeFunctionShape {
  return {
    kind: 'shape',
    value: formatShapeValueFromPoints(points),
    pathData: formatPathDataFromPoints(points),
  };
}

export function shapeFromSvgSubpaths(subpaths: SvgShapeSubpath[], fillRule?: ShapeFunctionShape['fillRule']): ShapeFunctionShape {
  if (!subpaths.length) {
    return shapeFromPolygonPoints([]);
  }

  return {
    kind: 'shape',
    value: formatShapeValueFromSubpaths(subpaths),
    ...(fillRule ? { fillRule } : {}),
    pathData: formatPathDataFromSubpaths(subpaths),
  };
}

export function svgShapeCommandPoints(command: SvgShapeCommand) {
  if (command.kind === 'close') {
    return [];
  }
  if (command.kind === 'curve') {
    return [command.to, command.control1, command.control2].filter(isDefined);
  }
  return [command.to];
}

export function svgShapeSubpathPoints(subpaths: SvgShapeSubpath[]) {
  return subpaths.flatMap((subpath) => [subpath.start, ...subpath.commands.flatMap(svgShapeCommandPoints)]);
}

export function svgShapeSubpathBounds(subpaths: SvgShapeSubpath[]): SvgShapeBounds | undefined {
  const points = svgShapeSubpathPoints(subpaths);
  if (!points.length) {
    return undefined;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= SVG_POINT_EPSILON || height <= SVG_POINT_EPSILON) {
    return undefined;
  }

  return { minX, maxX, minY, maxY, width, height };
}

export function svgShapeBoundsFromViewBox(viewBox: SvgViewBox): SvgShapeBounds | undefined {
  if (viewBox.width <= SVG_POINT_EPSILON || viewBox.height <= SVG_POINT_EPSILON) {
    return undefined;
  }
  return {
    minX: viewBox.x,
    maxX: viewBox.x + viewBox.width,
    minY: viewBox.y,
    maxY: viewBox.y + viewBox.height,
    width: viewBox.width,
    height: viewBox.height,
  };
}

export function mapSvgShapeCommandPoints(command: SvgShapeCommand, mapper: (point: Point) => Point): SvgShapeCommand {
  if (command.kind === 'close') {
    return command;
  }
  if (command.kind === 'line') {
    return { ...command, to: mapper(command.to) };
  }
  return {
    kind: 'curve',
    to: mapper(command.to),
    control1: mapper(command.control1),
    ...(command.control2 ? { control2: mapper(command.control2) } : {}),
  };
}

export function fitShapeSubpathsToPercentBox(subpaths: SvgShapeSubpath[], preferredBounds?: SvgShapeBounds | undefined) {
  const bounds = preferredBounds || svgShapeSubpathBounds(subpaths);
  if (!bounds) {
    return undefined;
  }

  const fitPoint = (point: Point) => ({
    x: ((point.x - bounds.minX) / bounds.width) * 100,
    y: ((point.y - bounds.minY) / bounds.height) * 100,
  });

  return subpaths.map((subpath) => ({
    start: fitPoint(subpath.start),
    commands: subpath.commands.map((command) => mapSvgShapeCommandPoints(command, fitPoint)),
  }));
}

export function containShapeSubpathsToCss(
  subpaths: SvgShapeSubpath[],
  preferredBounds?: SvgShapeBounds | undefined,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
) {
  const bounds = preferredBounds || svgShapeSubpathBounds(subpaths);
  if (!bounds) {
    return undefined;
  }

  const names = resolveShapeScaleVarNames(options);
  const centerX = bounds.minX + bounds.width / 2;
  const centerY = bounds.minY + bounds.height / 2;
  // A freshly fitted SVG is normalized to its own bounds: x spans ±0.5 (WU = 1), y spans the aspect
  // ratio, centered (OL = OT = 0.5).
  const offsetBounds: ShapeOffsetBounds = {
    minAx: -0.5,
    minAy: -bounds.height / (2 * bounds.width),
    wu: 1,
    hu: bounds.height / bounds.width,
    size: 100,
    ol: DEFAULT_SHAPE_OFFSET_VALUE,
    ot: DEFAULT_SHAPE_OFFSET_VALUE,
  };

  return mapShapeSubpathsToCss(subpaths, (point) =>
    formatShapeOffsetPoint(
      {
        x: 50 + ((point.x - centerX) / bounds.width) * 100,
        y: 50 + ((point.y - centerY) / bounds.width) * 100,
      },
      offsetBounds,
      names,
    ),
  );
}

export function formatClipPath(shape: ClipShape) {
  if (shape.kind === 'none') {
    return 'none';
  }
  if (shape.kind === 'raw') {
    return shape.editable ? formatRawEditableClipPath(shape.editable) : shape.value;
  }
  if (shape.kind === 'polygon') {
    return formatPolygon(shape.points);
  }
  if (shape.kind === 'shape') {
    const prefix = shape.fillRule && shape.fillRule !== 'nonzero' ? `${shape.fillRule} ` : '';
    return `shape(${prefix}${shape.value})`;
  }
  if (shape.kind === 'circle') {
    const center = `${formatPercent(shape.cx)} ${formatPercent(shape.cy)}`;
    return `circle(${formatPercent(shape.radius)} at ${center})`;
  }
  if (shape.kind === 'ellipse') {
    const radii = `${formatPercent(shape.rx)} ${formatPercent(shape.ry)}`;
    const center = `${formatPercent(shape.cx)} ${formatPercent(shape.cy)}`;
    return `ellipse(${radii} at ${center})`;
  }
  const sides = formatInsetSides(shape);
  return hasRoundedCorners(shape.radii) ? `inset(${sides} round ${formatRadii(shape.radii)})` : `inset(${sides})`;
}

export function formatCodeValue(shape: ClipShape) {
  return shape.kind === 'none' ? '' : formatClipPath(shape);
}

export function addPreviewVariableFallbacks(value: string) {
  return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, 'var($1, 1rem)');
}

export function previewAxisSize(axis: 'x' | 'y', size: CanvasSize) {
  return axis === 'x' ? size.width : size.height;
}

// Absolute lengths are drawn at their real size: a CSS pixel is a screen pixel
// in the preview, a rem the 16px root font size. The preview used to stand for
// a 1600px element and make a rem 1% of the box, so `round 2rem` drew 7px
// corners and read as square: the shape has to look like what it will be.
const PREVIEW_ROOT_FONT_PX = 16;

export function previewUnitPx(unit: string, axis: 'x' | 'y', size: CanvasSize) {
  const axisSize = previewAxisSize(axis, size);
  const normalized = unit.toLowerCase();
  const pxUnit = 1;

  if (normalized === '%') {
    return axisSize / 100;
  }
  if (normalized === 'px') {
    return pxUnit;
  }
  if (normalized === 'em' || normalized === 'rem') {
    return PREVIEW_ROOT_FONT_PX;
  }
  if (normalized === 'lh' || normalized === 'rlh') {
    return PREVIEW_ROOT_FONT_PX * 1.5; // A normal line height.
  }
  if (normalized === 'ch' || normalized === 'ex') {
    return PREVIEW_ROOT_FONT_PX / 2;
  }
  if (normalized === 'vw' || normalized === 'svw' || normalized === 'lvw' || normalized === 'dvw') {
    return size.width / 100;
  }
  if (normalized === 'vh' || normalized === 'svh' || normalized === 'lvh' || normalized === 'dvh') {
    return size.height / 100;
  }
  if (normalized === 'vmin' || normalized === 'svmin' || normalized === 'lvmin' || normalized === 'dvmin') {
    return Math.min(size.width, size.height) / 100;
  }
  if (normalized === 'vmax' || normalized === 'svmax' || normalized === 'lvmax' || normalized === 'dvmax') {
    return Math.max(size.width, size.height) / 100;
  }
  if (normalized === 'cqw' || normalized === 'cqi') {
    return size.width / 100;
  }
  if (normalized === 'cqh' || normalized === 'cqb') {
    return size.height / 100;
  }
  if (normalized === 'cqmin') {
    return Math.min(size.width, size.height) / 100;
  }
  if (normalized === 'cqmax') {
    return Math.max(size.width, size.height) / 100;
  }
  if (normalized === 'in') {
    return 96 * pxUnit;
  }
  if (normalized === 'cm') {
    return (96 / 2.54) * pxUnit;
  }
  if (normalized === 'mm') {
    return (96 / 25.4) * pxUnit;
  }
  if (normalized === 'q') {
    return (96 / 101.6) * pxUnit;
  }
  if (normalized === 'pt') {
    return (96 / 72) * pxUnit;
  }
  if (normalized === 'pc') {
    return 16 * pxUnit;
  }
  return axisSize / 100;
}

export function previewCssLengthPercentageToken(token: string, axis: 'x' | 'y', size: CanvasSize) {
  const match = token.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)$/i);
  if (!match) {
    return token;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return token;
  }

  const unit = match[2];
  if (unit === undefined) {
    return token;
  }
  const axisSize = previewAxisSize(axis, size);
  if (axisSize <= 0) {
    return token;
  }
  const percent = unit === '%' ? value : ((value * previewUnitPx(unit, axis, size)) / axisSize) * 100;
  return `${formatCssScaleNumber(percent)}%`;
}

export function addPreviewVariableFallbacksForAxis(value: string, axis: 'x' | 'y', size: CanvasSize) {
  const fallback = previewCssLengthPercentageToken('1rem', axis, size);
  return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, `var($1, ${fallback})`);
}

export function previewCssCoordinateToken(value: string, axis: 'x' | 'y', size: CanvasSize) {
  const withFallbacks = addPreviewVariableFallbacksForAxis(value, axis, size);
  return withFallbacks.replace(
    /([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)\b/gi,
    (match, number: string, unit: string, offset: number, source: string) => {
      const previous = source[offset - 1];
      if (previous && /[a-zA-Z0-9_-]/.test(previous)) {
        return match;
      }
      return previewCssLengthPercentageToken(`${number}${unit}`, axis, size);
    },
  );
}
