// A clip shape as the canvas previews it — units resolved to pixels,
// variables given fallbacks — and the code view's token ranges and highlights
// (ClipPath.tsx).

import { type CodeEditorTokenHighlight } from '../components/CssCodeEditor';
import {
  type ShapeFunctionShape,
  type CssUnitValue,
  type CssCoordinateValue,
  type RawEditableClipPath,
  type ClipShape,
  type HandleTarget,
  type CanvasSize,
} from './clipPathTypes';
import { CORNERS } from './clipPathConstants';
import { formatCssUnitValue, formatCssCoordinateValue } from './clipPathMeasure';
import { HANDLE_COLOR_CLASSES, handleColorClass, polygonPointColorClass, shorthandGroups } from './clipPathHandles';
import { splitTopLevelWhitespace, splitTopLevelChar, splitTopLevelKeyword, splitShapeCommandList } from './clipPathParse';
import { formatShapeValueFromCssSubpaths, parseShapeCssSubpaths, mapShapeCssSubpathPoints } from './shapeFunctionModel';
import { addPreviewVariableFallbacks, previewCssCoordinateToken } from './clipPathFormat';

export function formatCssCoordinateValueForPreview(value: CssCoordinateValue, axis?: 'x' | 'y', size?: CanvasSize) {
  const formatted = formatCssCoordinateValue(value);
  return axis && size ? previewCssCoordinateToken(formatted, axis, size) : addPreviewVariableFallbacks(formatted);
}

export function formatCssUnitValueForPreview(value: CssUnitValue, axis: 'x' | 'y', size: CanvasSize) {
  return previewCssCoordinateToken(formatCssUnitValue(value), axis, size);
}

export function expandCssShorthandTokens(tokens: string[]) {
  const first = tokens[0] || '0%';
  return [first, tokens[1] || first, tokens[2] || first, tokens[3] || tokens[1] || first];
}

export function formatRawEditableClipPathForPreview(editable: RawEditableClipPath, size: CanvasSize) {
  if (editable.kind === 'polygon') {
    const prefix = editable.fillRule ? `${editable.fillRule}, ` : '';
    const points = editable.points
      .map((point) => `${formatCssCoordinateValueForPreview(point.x, 'x', size)} ` + formatCssCoordinateValueForPreview(point.y, 'y', size))
      .join(', ');
    return `polygon(${prefix}${points})`;
  }

  if (editable.kind === 'circle') {
    const radius = formatCssUnitValueForPreview(editable.radius, 'x', size);
    const centerX = formatCssUnitValueForPreview(editable.cx, 'x', size);
    const centerY = formatCssUnitValueForPreview(editable.cy, 'y', size);
    return [`circle(${radius}`, `at ${centerX} ${centerY})`].join(' ');
  }

  if (editable.kind === 'ellipse') {
    const radiusX = formatCssUnitValueForPreview(editable.rx, 'x', size);
    const radiusY = formatCssUnitValueForPreview(editable.ry, 'y', size);
    const centerX = formatCssUnitValueForPreview(editable.cx, 'x', size);
    const centerY = formatCssUnitValueForPreview(editable.cy, 'y', size);
    return [`ellipse(${radiusX} ${radiusY}`, `at ${centerX} ${centerY})`].join(' ');
  }

  const sides = [
    formatCssUnitValueForPreview(editable.top, 'y', size),
    formatCssUnitValueForPreview(editable.right, 'x', size),
    formatCssUnitValueForPreview(editable.bottom, 'y', size),
    formatCssUnitValueForPreview(editable.left, 'x', size),
  ].join(' ');
  if (!editable.radii) {
    return `inset(${sides})`;
  }

  const horizontalValues = expandCssUnitValues(editable.radii.horizontal);
  const verticalValues = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
  const horizontal = horizontalValues.map((value) => formatCssUnitValueForPreview(value, 'x', size)).join(' ');
  const vertical = verticalValues.map((value) => formatCssUnitValueForPreview(value, 'y', size)).join(' ');
  const verticalSuffix = horizontal === vertical ? '' : ` / ${vertical}`;
  return `inset(${sides} round ${horizontal}${verticalSuffix})`;
}

export function formatShapeFunctionForPreview(shape: ShapeFunctionShape, size: CanvasSize) {
  const subpaths = parseShapeCssSubpaths(shape.value);
  const prefix = shape.fillRule && shape.fillRule !== 'nonzero' ? `${shape.fillRule} ` : '';
  if (!subpaths) {
    return `shape(${prefix}${addPreviewVariableFallbacks(shape.value)})`;
  }

  const transformed = mapShapeCssSubpathPoints(subpaths, (point) => ({
    x: previewCssCoordinateToken(point.x, 'x', size),
    y: previewCssCoordinateToken(point.y, 'y', size),
  }));
  return `shape(${prefix}${formatShapeValueFromCssSubpaths(transformed)})`;
}

// A raw `x y` coordinate pair, each token given its preview fallbacks for its own axis.
export function previewCssCoordinatePair(xToken: string, yToken: string, size: CanvasSize) {
  return `${previewCssCoordinateToken(xToken, 'x', size)} ` + previewCssCoordinateToken(yToken, 'y', size);
}

export function formatRawClipPathStringForPreview(value: string, size: CanvasSize) {
  const polygonMatch = value.match(/^polygon\s*\((.*)\)$/is);
  if (polygonMatch?.[1]) {
    return previewRawPolygon(polygonMatch[1], size);
  }
  const circleMatch = value.match(/^circle\s*\((.*)\)$/is);
  if (circleMatch?.[1]) {
    return previewRawCircle(circleMatch[1], size);
  }
  const ellipseMatch = value.match(/^ellipse\s*\((.*)\)$/is);
  if (ellipseMatch?.[1]) {
    return previewRawEllipse(ellipseMatch[1], size);
  }
  const insetMatch = value.match(/^inset\s*\((.*)\)$/is);
  if (insetMatch?.[1]) {
    return previewRawInset(insetMatch[1], size);
  }
  return addPreviewVariableFallbacks(value);
}

// `polygon(…)`'s arguments with each coordinate resolved for the preview canvas.
export function previewRawPolygon(argument: string, size: CanvasSize) {
  const parts = splitShapeCommandList(argument);
  const fillRule = /^(evenodd|nonzero)$/i.test(parts[0] || '') ? parts[0] : undefined;
  const pointParts = fillRule ? parts.slice(1) : parts;
  const points = pointParts.map((part) => {
    const tokens = splitTopLevelWhitespace(part);
    return tokens.length === 2 ? previewCssCoordinatePair(tokens[0] ?? '', tokens[1] ?? '', size) : part;
  });
  return `polygon(${[fillRule, ...points].filter(Boolean).join(', ')})`;
}

// The ` at <x> <y>` of a circle or ellipse, resolved for the preview canvas.
export function previewCenterSuffix(centerPart: string | undefined, size: CanvasSize) {
  const centerTokens = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  if (centerTokens.length === 2) {
    return ` at ${previewCssCoordinatePair(centerTokens[0] ?? '', centerTokens[1] ?? '', size)}`;
  }
  return centerPart ? ` at ${centerPart}` : '';
}

export function previewRawCircle(argument: string, size: CanvasSize) {
  const [radiusPart, centerPart] = splitTopLevelKeyword(argument, 'at');
  const radiusTokens = splitTopLevelWhitespace(radiusPart);
  const radius = radiusTokens[0] ? previewCssCoordinateToken(radiusTokens[0], 'x', size) : radiusPart;
  return `circle(${radius}${previewCenterSuffix(centerPart, size)})`;
}

export function previewRawEllipse(argument: string, size: CanvasSize) {
  const [radiiPart, centerPart] = splitTopLevelKeyword(argument, 'at');
  const radii = splitTopLevelWhitespace(radiiPart);
  const previewRadii = radii.length === 2 ? previewCssCoordinatePair(radii[0] ?? '', radii[1] ?? '', size) : radiiPart;
  return `ellipse(${previewRadii}${previewCenterSuffix(centerPart, size)})`;
}

export function previewRawInset(argument: string, size: CanvasSize) {
  const [insetPart, roundPart] = splitTopLevelKeyword(argument, 'round');
  const sides = splitTopLevelWhitespace(insetPart);
  const previewSides =
    sides.length >= 1 && sides.length <= 4
      ? expandCssShorthandTokens(sides)
          .map((token, index) => previewCssCoordinateToken(token, index % 2 === 0 ? 'y' : 'x', size))
          .join(' ')
      : insetPart;
  if (!roundPart) {
    return `inset(${previewSides})`;
  }

  const radiusParts = splitTopLevelChar(roundPart, '/');
  const horizontalTokens = splitTopLevelWhitespace(radiusParts[0] || '');
  const verticalTokens = splitTopLevelWhitespace(radiusParts[1] || radiusParts[0] || '');
  const horizontal = expandCssShorthandTokens(horizontalTokens)
    .map((token) => previewCssCoordinateToken(token, 'x', size))
    .join(' ');
  const vertical = expandCssShorthandTokens(verticalTokens)
    .map((token) => previewCssCoordinateToken(token, 'y', size))
    .join(' ');
  const verticalSuffix = horizontal === vertical ? '' : ` / ${vertical}`;
  return `inset(${previewSides} round ${horizontal}${verticalSuffix})`;
}

export function formatClipPathForPreview(shape: ClipShape, css: string, size: CanvasSize | undefined) {
  if (shape.kind === 'none') {
    return 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
  }
  if (!size) {
    return addPreviewVariableFallbacks(css);
  }
  if (shape.kind === 'raw') {
    return shape.editable ? formatRawEditableClipPathForPreview(shape.editable, size) : formatRawClipPathStringForPreview(shape.value, size);
  }
  if (shape.kind === 'shape') {
    return formatShapeFunctionForPreview(shape, size);
  }
  return addPreviewVariableFallbacks(css);
}

export function tokenRangesFromParts(value: string, parts: string[]) {
  const ranges: Array<{ from: number; to: number }> = [];
  let searchFrom = 0;

  parts.forEach((part) => {
    const token = part.trim();
    if (!token) {
      return;
    }
    const index = value.indexOf(token, searchFrom);
    if (index < 0) {
      return;
    }
    ranges.push({ from: index, to: index + token.length });
    searchFrom = index + token.length;
  });

  return ranges;
}

export function functionContentRange(value: string) {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  return open >= 0 && close > open ? { from: open + 1, to: close, content: value.slice(open + 1, close) } : undefined;
}

export function splitPolygonCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const parts = splitShapeCommandList(range.content);
  const pointParts = /^(evenodd|nonzero)$/i.test(parts[0] || '') ? parts.slice(1) : parts;
  return pointParts.flatMap((part) => splitTopLevelWhitespace(part));
}

export function splitCircleCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const [radiusPart, centerPart] = splitTopLevelKeyword(range.content, 'at');
  return [...splitTopLevelWhitespace(radiusPart), ...(centerPart ? splitTopLevelWhitespace(centerPart) : [])];
}

export function splitEllipseCoordinateTokens(value: string) {
  return splitCircleCoordinateTokens(value);
}

export function splitInsetCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const [insetPart, roundPart] = splitTopLevelKeyword(range.content, 'round');
  const tokens = [...splitTopLevelWhitespace(insetPart)];
  if (!roundPart) {
    return tokens;
  }

  splitTopLevelChar(roundPart, '/').forEach((part) => {
    tokens.push(...splitTopLevelWhitespace(part));
  });
  return tokens;
}

export function clipPathValueTokenRanges(value: string, shape: ClipShape) {
  if (shape.kind === 'polygon' || (shape.kind === 'raw' && shape.editable?.kind === 'polygon')) {
    return tokenRangesFromParts(value, splitPolygonCoordinateTokens(value));
  }
  if (shape.kind === 'circle' || (shape.kind === 'raw' && shape.editable?.kind === 'circle')) {
    return tokenRangesFromParts(value, splitCircleCoordinateTokens(value));
  }
  if (shape.kind === 'ellipse' || (shape.kind === 'raw' && shape.editable?.kind === 'ellipse')) {
    return tokenRangesFromParts(value, splitEllipseCoordinateTokens(value));
  }
  if (shape.kind === 'inset' || (shape.kind === 'raw' && shape.editable?.kind === 'inset')) {
    return tokenRangesFromParts(value, splitInsetCoordinateTokens(value));
  }
  return [];
}

export function codeTokenClassName(colorClass: string) {
  return `clip-path_code-token ${colorClass}`;
}

export type ClipPathCodeHighlight = CodeEditorTokenHighlight & {
  colorClass: string;
  handles: HandleTarget[];
};

export function buildClipPathCodeHighlights(shape: ClipShape, value: string, polygonPointColors: string[] = []): ClipPathCodeHighlight[] {
  const ranges = clipPathValueTokenRanges(value, shape);
  const highlights: ClipPathCodeHighlight[] = [];
  const addHighlight: AddCodeHighlight = (range, handles, colorClass) => {
    const firstHandle = handles[0];
    if (!range || !firstHandle) {
      return;
    }
    const resolvedColorClass = colorClass ?? handleColorClass(firstHandle);
    highlights.push({
      ...range,
      handles,
      colorClass: resolvedColorClass,
      className: codeTokenClassName(resolvedColorClass),
    });
  };
  // A raw value is highlighted by the geometry it was parsed into, a shape by its own.
  const geometry = shape.kind === 'raw' ? shape.editable : shape;
  if (geometry?.kind === 'polygon') {
    geometry.points.forEach((_, index) => {
      const handle: HandleTarget = { kind: 'polygon-point', index };
      const colorClass = polygonPointColorClass(index, polygonPointColors);
      addHighlight(ranges[index * 2], [handle], colorClass);
      addHighlight(ranges[index * 2 + 1], [handle], colorClass);
    });
  } else if (geometry?.kind === 'circle') {
    const radiusHandle: HandleTarget = { kind: 'circle-radius' };
    const centerHandle: HandleTarget = { kind: 'circle-center' };
    addHighlight(ranges[0], [radiusHandle]);
    addHighlight(ranges[1], [centerHandle]);
    addHighlight(ranges[2], [centerHandle]);
  } else if (geometry?.kind === 'ellipse') {
    const rxHandle: HandleTarget = { kind: 'ellipse-rx' };
    const ryHandle: HandleTarget = { kind: 'ellipse-ry' };
    const centerHandle: HandleTarget = { kind: 'ellipse-center' };
    addHighlight(ranges[0], [rxHandle]);
    addHighlight(ranges[1], [ryHandle]);
    addHighlight(ranges[2], [centerHandle]);
    addHighlight(ranges[3], [centerHandle]);
  } else if (geometry?.kind === 'inset') {
    addInsetCodeHighlights(value, ranges, addHighlight);
  }
  return highlights;
}

// Records one highlighted code range and the handles it belongs to.
export type AddCodeHighlight = (range: { from: number; to: number } | undefined, handles: HandleTarget[], colorClass?: string) => void;

// An inset's code ranges: the side lengths before `round`, then the horizontal and
// vertical radii either side of the `/`, each shorthand token owning the handles it
// sets.
export function addInsetCodeHighlights(value: string, ranges: Array<{ from: number; to: number }>, addHighlight: AddCodeHighlight): void {
  const roundMatch = value.match(/\bround\b/i);
  const roundIndex = roundMatch?.index ?? -1;
  const sideRanges = roundIndex >= 0 ? ranges.filter((range) => range.from < roundIndex) : ranges;
  const radiusRanges = roundIndex >= 0 ? ranges.filter((range) => range.from > roundIndex) : [];
  const sideHandles: HandleTarget[] = [{ kind: 'inset-top' }, { kind: 'inset-right' }, { kind: 'inset-bottom' }, { kind: 'inset-left' }];
  shorthandGroups(sideHandles, sideRanges.length).forEach((handles, index) => {
    addHighlight(sideRanges[index], handles, HANDLE_COLOR_CLASSES[index % HANDLE_COLOR_CLASSES.length]);
  });

  const radiusHandles: HandleTarget[] = CORNERS.map((corner) => ({
    kind: 'inset-radius',
    corner,
  }));
  const slashIndex = roundIndex >= 0 ? value.indexOf('/', roundIndex) : -1;
  const horizontalRadiusRanges = slashIndex >= 0 ? radiusRanges.filter((range) => range.from < slashIndex) : radiusRanges;
  const verticalRadiusRanges = slashIndex >= 0 ? radiusRanges.filter((range) => range.from > slashIndex) : [];
  for (const radiusRangeList of [horizontalRadiusRanges, verticalRadiusRanges]) {
    shorthandGroups(radiusHandles, radiusRangeList.length).forEach((handles, index) => {
      addHighlight(radiusRangeList[index], handles, HANDLE_COLOR_CLASSES[(index + 4) % HANDLE_COLOR_CLASSES.length]);
    });
  }
}

export function expandCssUnitValues(
  values: CssUnitValue[],
  fallback: CssUnitValue = { value: 0, unit: '%' },
): [CssUnitValue, CssUnitValue, CssUnitValue, CssUnitValue] {
  const first = values[0] || fallback;
  return [first, values[1] || first, values[2] || first, values[3] || values[1] || first];
}
