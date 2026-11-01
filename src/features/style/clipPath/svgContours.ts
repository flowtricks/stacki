// From SVG to one clip shape: path commands applied, contours traced and
// joined, axis-aligned outlines unioned on a grid, and the document read into
// a shape() or polygon (ClipPath.tsx).

import {
  type Point,
  type PolygonShape,
  type ShapeFunctionShape,
  type SvgViewBox,
  type SvgBoundaryEdge,
  type SvgLoopPair,
  type SvgLoopPoint,
  type SvgClipPathOutline,
  type SvgShapeSubpath,
  type ShapeFitMode,
  type ShapeScaleOptions,
} from './clipPathTypes';
import { DEFAULT_SHAPE_SCALE_OPTIONS, SVG_PARSE_CELL_LIMIT, SVG_POINT_EPSILON, NONE_SHAPE } from './clipPathConstants';
import { distanceSquared } from './clipPathMeasure';
import { formatShapeValueFromCssSubpaths, parseClipPathInput } from './shapeFunctionModel';
import {
  formatPathDataFromSubpaths,
  shapeFromSvgSubpaths,
  svgShapeSubpathPoints,
  svgShapeBoundsFromViewBox,
  fitShapeSubpathsToPercentBox,
  containShapeSubpathsToCss,
  formatClipPath,
} from './clipPathFormat';
import {
  extractSvgMarkup,
  svgTagName,
  inheritedSvgAttribute,
  isRenderableSvgElement,
  isInsideSkippedSvgElement,
  hasSvgTransform,
  svgAttribute,
  parseSvgViewBox,
  simplifySvgContour,
  parseSvgPoints,
  parseClosedSvgPolyline,
  parseSvgRect,
} from './svgElements';
import {
  parseSvgRectShape,
  parseSvgCircleShape,
  parseSvgEllipseElementShape,
  parseSvgPolygonShape,
  svgPathTokens,
  type SvgPathCursor,
  svgPathCursor,
  parseSimpleSvgPath,
  offsetSvgPoint,
  svgArcToCubicCurves,
  SvgShapePathReader,
} from './svgPaths';

export function parseSvgPathShape(element: Element) {
  const tokens = svgPathTokens(element);
  if (!tokens) {
    return undefined;
  }
  const cursor = svgPathCursor(tokens);
  const reader = new SvgShapePathReader();
  while (!cursor.done()) {
    if (!reader.takeCommand(cursor)) {
      return undefined;
    }
    if (!applySvgShapeCommand(reader, cursor)) {
      return undefined;
    }
  }
  return reader.finish();
}

// One command of a curved path. False when the path is not one this reads.
export function applySvgShapeCommand(reader: SvgShapePathReader, cursor: SvgPathCursor): boolean {
  const relative = reader.command === reader.command.toLowerCase();
  const letter = reader.command.toUpperCase();
  switch (letter) {
    case 'M':
      return svgShapeMove(reader, cursor, { relative });
    case 'L':
    case 'H':
    case 'V':
      return svgShapeLines(reader, cursor, { relative, letter });
    case 'C':
    case 'S':
      return svgShapeCubics(reader, cursor, { relative, smooth: letter === 'S' });
    case 'Q':
    case 'T':
      return svgShapeQuadratics(reader, cursor, { relative, smooth: letter === 'T' });
    case 'A':
      return svgShapeArcs(reader, cursor, { relative });
    case 'Z':
      return reader.close();
    default:
      return false;
  }
}

export function svgShapeTo(reader: SvgShapePathReader, x: number, y: number, { relative }: { relative: boolean }): Point {
  const current = reader.current;
  return relative ? { x: current.x + x, y: current.y + y } : { x, y };
}

// A move-to ends the subpath being drawn and starts the next; numbers after it are
// line-tos.
export function svgShapeMove(reader: SvgShapePathReader, cursor: SvgPathCursor, { relative }: { relative: boolean }): boolean {
  const numbers = cursor.readNumbers(2);
  if (!numbers) {
    return false;
  }
  reader.moveTo(offsetSvgPoint(reader.current, numbers, { relative }), { relative });
  return true;
}

// Line-tos: to a point (L), along x (H), or along y (V).
export function svgShapeLines(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative, letter }: { relative: boolean; letter: 'L' | 'H' | 'V' },
): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(letter === 'L' ? 2 : 1);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const [first = 0] = numbers;
    const to =
      letter === 'L'
        ? offsetSvgPoint(current, numbers, { relative })
        : letter === 'H'
          ? { x: relative ? current.x + first : first, y: current.y }
          : { x: current.x, y: relative ? current.y + first : first };
    reader.lineTo(to);
  }
  reader.forgetControlPoints();
  reader.recordCommand(letter);
  return true;
}

// Cubic curves (C); a smooth one (S) reflects the previous curve's second control
// point for its first.
export function svgShapeCubics(reader: SvgShapePathReader, cursor: SvgPathCursor, { relative, smooth }: { relative: boolean; smooth: boolean }): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(smooth ? 4 : 6);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const previous = reader.previousCubicControl;
    const [x1 = 0, y1 = 0] = numbers;
    const control1: Point = !smooth
      ? svgShapeTo(reader, x1, y1, { relative })
      : previous && ['C', 'S'].includes(reader.previousCommand)
        ? { x: current.x * 2 - previous.x, y: current.y * 2 - previous.y }
        : current;
    const [x2 = 0, y2 = 0, x = 0, y = 0] = smooth ? numbers : numbers.slice(2);
    const control2 = svgShapeTo(reader, x2, y2, { relative });
    const to = svgShapeTo(reader, x, y, { relative });
    reader.cubicTo(to, control1, control2);
  }
  reader.recordCommand(smooth ? 'S' : 'C');
  return true;
}

// Quadratic curves (Q); a smooth one (T) reflects the previous curve's control point.
export function svgShapeQuadratics(reader: SvgShapePathReader, cursor: SvgPathCursor, { relative, smooth }: { relative: boolean; smooth: boolean }): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(smooth ? 2 : 4);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const previous = reader.previousQuadraticControl;
    const [x1 = 0, y1 = 0] = numbers;
    const control1: Point = !smooth
      ? svgShapeTo(reader, x1, y1, { relative })
      : previous && ['Q', 'T'].includes(reader.previousCommand)
        ? { x: current.x * 2 - previous.x, y: current.y * 2 - previous.y }
        : current;
    const [x = 0, y = 0] = smooth ? numbers : numbers.slice(2);
    const to = svgShapeTo(reader, x, y, { relative });
    reader.quadraticTo(to, control1);
  }
  reader.recordCommand(smooth ? 'T' : 'Q');
  return true;
}

// Elliptical arcs, drawn as the cubic curves that approximate them.
export function svgShapeArcs(reader: SvgShapePathReader, cursor: SvgPathCursor, { relative }: { relative: boolean }): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(7);
    if (!numbers) {
      return false;
    }
    const [rx = 0, ry = 0, rotation = 0, largeArc = 0, sweep = 0, x = 0, y = 0] = numbers;
    const to = svgShapeTo(reader, x, y, { relative });
    const arcCommands = svgArcToCubicCurves(reader.current, rx, ry, rotation, { largeArc: largeArc !== 0, sweep: sweep !== 0 }, to);
    reader.arcTo(arcCommands);
  }
  reader.recordCommand('A');
  return true;
}

export function isAxisAlignedSvgContour(points: Point[]) {
  return points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    return next !== undefined && (Math.abs(point.x - next.x) < SVG_POINT_EPSILON || Math.abs(point.y - next.y) < SVG_POINT_EPSILON);
  });
}

export function polygonArea(points: Point[]) {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return next ? area + point.x * next.y - next.x * point.y : area;
    }, 0) / 2
  );
}

export function pointInsidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (!current || !previous) {
      continue;
    }
    const crossesY = current.y > point.y !== previous.y > point.y;
    if (!crossesY) {
      continue;
    }

    const x = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (point.x < x) {
      inside = !inside;
    }
  }

  return inside;
}

export function sortedUniqueSvgValues(values: number[]) {
  return [...new Set(values.map((value) => Math.round(value * 100000) / 100000))].sort((left, right) => left - right);
}

export function svgGridPointKey(point: Point) {
  return `${point.x},${point.y}`;
}

export function traceSvgBoundary(edges: SvgBoundaryEdge[]) {
  const outgoing = new Map<string, SvgBoundaryEdge[]>();
  edges.forEach((edge) => {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge]);
  });

  const unused = new Set(edges);
  const loops: Point[][] = [];

  while (unused.size) {
    const first = unused.values().next();
    if (first.done) {
      break;
    }
    let edge: SvgBoundaryEdge | undefined = first.value;

    const startKey = edge.from;
    const loop: Point[] = [edge.fromPoint];

    while (edge) {
      unused.delete(edge);
      loop.push(edge.toPoint);
      if (edge.to === startKey) {
        break;
      }

      edge = (outgoing.get(edge.to) || []).find((candidate) => unused.has(candidate));
      if (!edge) {
        return undefined;
      }
    }

    const simplified = simplifySvgContour(loop);
    if (simplified.length >= 3 && Math.abs(polygonArea(simplified)) > SVG_POINT_EPSILON) {
      loops.push(simplified);
    }
  }

  return loops;
}

export function svgContourBounds(points: Point[]) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
  };
}

export function rotateClosedSvgContour(points: Point[], startIndex: number) {
  const rotated = [...points.slice(startIndex), ...points.slice(0, startIndex)];
  const firstPoint = rotated[0];
  return firstPoint ? [...rotated, firstPoint] : [];
}

export function closestSvgLoopPair(source: Point[], targets: Point[][]): SvgLoopPair | undefined {
  let best: SvgLoopPair | undefined = undefined;

  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const sourcePoint = source[sourceIndex];
    if (!sourcePoint) {
      continue;
    }
    for (let targetLoopIndex = 0; targetLoopIndex < targets.length; targetLoopIndex += 1) {
      const target = targets[targetLoopIndex];
      if (!target) {
        continue;
      }
      for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
        const targetPoint = target[targetIndex];
        if (!targetPoint) {
          continue;
        }
        const distance = distanceSquared(sourcePoint, targetPoint);
        if (!best || distance < best.distance) {
          best = { sourceIndex, targetLoopIndex, targetIndex, distance };
        }
      }
    }
  }

  return best;
}

export function closestSvgPointToLoop(point: Point, targets: Point[][]): SvgLoopPoint | undefined {
  let best: SvgLoopPoint | undefined = undefined;

  for (let targetLoopIndex = 0; targetLoopIndex < targets.length; targetLoopIndex += 1) {
    const target = targets[targetLoopIndex];
    if (!target) {
      continue;
    }
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      const targetPoint = target[targetIndex];
      if (!targetPoint) {
        continue;
      }
      const distance = distanceSquared(point, targetPoint);
      if (!best || distance < best.distance) {
        best = { targetLoopIndex, targetIndex, distance };
      }
    }
  }

  return best;
}

export function connectSvgBoundaryLoops(loops: Point[][]) {
  if (!loops.length) {
    return undefined;
  }
  if (loops.length === 1) {
    return loops[0];
  }

  const sortedLoops = [...loops].sort((left, right) => {
    const leftBounds = svgContourBounds(left);
    const rightBounds = svgContourBounds(right);
    return leftBounds.minY - rightBounds.minY || leftBounds.minX - rightBounds.minX;
  });
  const [firstLoop, ...restLoops] = sortedLoops;
  if (!firstLoop) {
    return undefined;
  }
  const firstBridge = closestSvgLoopPair(firstLoop, restLoops);
  if (!firstBridge) {
    return undefined;
  }

  const connected = rotateClosedSvgContour(firstLoop, firstBridge.sourceIndex);
  let currentLoop = restLoops[firstBridge.targetLoopIndex];
  let currentIndex = firstBridge.targetIndex;
  restLoops.splice(firstBridge.targetLoopIndex, 1);

  while (currentLoop) {
    connected.push(...rotateClosedSvgContour(currentLoop, currentIndex));
    if (!restLoops.length) {
      break;
    }

    const currentPoint = currentLoop[currentIndex];
    if (!currentPoint) {
      return undefined;
    }
    const nextBridge = closestSvgPointToLoop(currentPoint, restLoops);
    if (!nextBridge) {
      return undefined;
    }

    currentLoop = restLoops[nextBridge.targetLoopIndex];
    currentIndex = nextBridge.targetIndex;
    restLoops.splice(nextBridge.targetLoopIndex, 1);
  }

  return connected;
}

export function unionAxisAlignedSvgContours(contours: Point[][]): SvgClipPathOutline | undefined {
  const xs = sortedUniqueSvgValues(contours.flatMap((contour) => contour.map((point) => point.x)));
  const ys = sortedUniqueSvgValues(contours.flatMap((contour) => contour.map((point) => point.y)));
  if (xs.length < 2 || ys.length < 2) {
    return undefined;
  }
  if ((xs.length - 1) * (ys.length - 1) > SVG_PARSE_CELL_LIMIT) {
    return undefined;
  }

  const filled = filledSvgGridCells(xs, ys, contours);
  if (!filled?.size) {
    return undefined;
  }
  const edges = svgGridBoundaryEdges(xs, ys, filled);
  if (!edges) {
    return undefined;
  }
  const loops = traceSvgBoundary(edges);
  if (!loops) {
    return undefined;
  }

  const connectedPoints = connectSvgBoundaryLoops(loops);
  return connectedPoints ? { points: connectedPoints, loops } : undefined;
}

export const svgGridCellKey = (xIndex: number, yIndex: number) => `${xIndex}:${yIndex}`;

// The cell between grid lines (xIndex, yIndex): its corners, or undefined when a
// line is missing.
export function svgGridCell(xs: number[], ys: number[], xIndex: number, yIndex: number) {
  const xStart = xs[xIndex];
  const xEnd = xs[xIndex + 1];
  const yStart = ys[yIndex];
  const yEnd = ys[yIndex + 1];
  if (xStart === undefined || xEnd === undefined || yStart === undefined || yEnd === undefined) {
    return undefined;
  }
  return { xStart, xEnd, yStart, yEnd };
}

// The grid cells (by key) whose centres fall inside any of the contours. Undefined
// when the grid is malformed.
export function filledSvgGridCells(xs: number[], ys: number[], contours: Point[][]): Set<string> | undefined {
  const filled = new Set<string>();
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const cell = svgGridCell(xs, ys, xIndex, yIndex);
      if (!cell) {
        return undefined;
      }
      const center = { x: (cell.xStart + cell.xEnd) / 2, y: (cell.yStart + cell.yEnd) / 2 };
      if (contours.some((contour) => pointInsidePolygon(center, contour))) {
        filled.add(svgGridCellKey(xIndex, yIndex));
      }
    }
  }
  return filled;
}

// The outline of the filled cells: every cell side that has no filled neighbour
// across it, oriented clockwise. Undefined when the grid is malformed.
export function svgGridBoundaryEdges(xs: number[], ys: number[], filled: Set<string>): SvgBoundaryEdge[] | undefined {
  const isFilled = (xIndex: number, yIndex: number) => filled.has(svgGridCellKey(xIndex, yIndex));
  const edges: SvgBoundaryEdge[] = [];
  const addEdge = (fromPoint: Point, toPoint: Point) => {
    edges.push({
      from: svgGridPointKey(fromPoint),
      to: svgGridPointKey(toPoint),
      fromPoint,
      toPoint,
    });
  };

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      if (!isFilled(xIndex, yIndex)) {
        continue;
      }
      const cell = svgGridCell(xs, ys, xIndex, yIndex);
      if (!cell) {
        return undefined;
      }
      const topLeft = { x: cell.xStart, y: cell.yStart };
      const topRight = { x: cell.xEnd, y: cell.yStart };
      const bottomRight = { x: cell.xEnd, y: cell.yEnd };
      const bottomLeft = { x: cell.xStart, y: cell.yEnd };

      if (!isFilled(xIndex, yIndex - 1)) {
        addEdge(topLeft, topRight);
      }
      if (!isFilled(xIndex + 1, yIndex)) {
        addEdge(topRight, bottomRight);
      }
      if (!isFilled(xIndex, yIndex + 1)) {
        addEdge(bottomRight, bottomLeft);
      }
      if (!isFilled(xIndex - 1, yIndex)) {
        addEdge(bottomLeft, topLeft);
      }
    }
  }
  return edges;
}

export function parseSvgElementContour(element: Element) {
  const tagName = svgTagName(element);
  if (tagName === 'rect') {
    return parseSvgRect(element);
  }
  if (tagName === 'polygon') {
    return parseSvgPoints(svgAttribute(element, 'points'));
  }
  if (tagName === 'polyline') {
    return parseClosedSvgPolyline(svgAttribute(element, 'points'));
  }
  if (tagName === 'path') {
    return parseSimpleSvgPath(element);
  }
  return undefined;
}

export function parseSvgElementShape(element: Element) {
  const tagName = svgTagName(element);
  if (tagName === 'rect') {
    return parseSvgRectShape(element);
  }
  if (tagName === 'circle') {
    return parseSvgCircleShape(element);
  }
  if (tagName === 'ellipse') {
    return parseSvgEllipseElementShape(element);
  }
  if (tagName === 'polygon') {
    return parseSvgPolygonShape(element, false);
  }
  if (tagName === 'polyline') {
    return parseSvgPolygonShape(element, true);
  }
  if (tagName === 'path') {
    return parseSvgPathShape(element);
  }
  return undefined;
}

export function svgShapeFillRule(svg: Element, elements: Element[]): ShapeFunctionShape['fillRule'] | undefined {
  const values = [svg, ...elements].map((element) => inheritedSvgAttribute(element, 'fill-rule') || inheritedSvgAttribute(element, 'clip-rule'));
  return values.some((value) => value?.trim().toLowerCase() === 'evenodd') ? 'evenodd' : undefined;
}

export function normalizeSvgContourToPercent(points: Point[], viewBox: SvgViewBox) {
  const normalized = points.map((point) => ({
    x: ((point.x - viewBox.x) / viewBox.width) * 100,
    y: ((point.y - viewBox.y) / viewBox.height) * 100,
  }));

  return normalized.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) && normalized.length >= 3 ? normalized : undefined;
}

export function parseSvgDocument(value: string) {
  const markup = extractSvgMarkup(value);
  if (!markup || typeof DOMParser === 'undefined') {
    return undefined;
  }

  const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (document.querySelector('parsererror')) {
    return undefined;
  }

  const svg = svgTagName(document.documentElement) === 'svg' ? document.documentElement : document.querySelector('svg');
  return svg ? { document, svg } : undefined;
}

export function parseSvgClipPathOutline(value: string): SvgClipPathOutline | undefined {
  const parsedDocument = parseSvgDocument(value);
  if (!parsedDocument) {
    return undefined;
  }
  const { svg } = parsedDocument;

  const supportedElements = Array.from(svg.querySelectorAll('rect, polygon, polyline, path'));
  const unsupportedElements = Array.from(svg.querySelectorAll('circle, ellipse, line')).filter(
    (element) => !isInsideSkippedSvgElement(element) && isRenderableSvgElement(element),
  );
  if (unsupportedElements.length) {
    return undefined;
  }

  const contours: Point[][] = [];
  for (const element of supportedElements) {
    if (isInsideSkippedSvgElement(element) || !isRenderableSvgElement(element)) {
      continue;
    }
    if (hasSvgTransform(element)) {
      return undefined;
    }

    const contour = parseSvgElementContour(element);
    if (contour === undefined) {
      return undefined;
    }
    if (contour.length >= 3) {
      contours.push(simplifySvgContour(contour));
    }
  }

  if (!contours.length) {
    return undefined;
  }

  const outline =
    contours.length === 1
      ? contours[0]
        ? { points: contours[0], loops: [contours[0]] }
        : undefined
      : contours.every(isAxisAlignedSvgContour)
        ? unionAxisAlignedSvgContours(contours)
        : undefined;
  if (!outline?.points.length) {
    return undefined;
  }

  const viewBox = parseSvgViewBox(svg, contours);
  if (!viewBox) {
    return undefined;
  }

  const points = normalizeSvgContourToPercent(outline.points, viewBox);
  const loops = outline.loops.map((loop) => normalizeSvgContourToPercent(loop, viewBox)).filter((loop): loop is Point[] => Boolean(loop?.length));
  return points && loops.length ? { points, loops } : undefined;
}

export function parseSvgClipPathShape(
  value: string,
  fitMode: ShapeFitMode = 'stretch',
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): ShapeFunctionShape | undefined {
  const parsedDocument = parseSvgDocument(value);
  if (!parsedDocument) {
    return undefined;
  }
  const { svg } = parsedDocument;

  const supportedElements = Array.from(svg.querySelectorAll('rect, circle, ellipse, polygon, polyline, path'));
  const unsupportedElements = Array.from(svg.querySelectorAll('image, text, use, line')).filter(
    (element) => !isInsideSkippedSvgElement(element) && isRenderableSvgElement(element),
  );
  if (unsupportedElements.length) {
    return undefined;
  }

  const renderedElements: Element[] = [];
  const subpaths: SvgShapeSubpath[] = [];
  for (const element of supportedElements) {
    if (isInsideSkippedSvgElement(element) || !isRenderableSvgElement(element)) {
      continue;
    }
    if (hasSvgTransform(element)) {
      return undefined;
    }

    const elementSubpaths = parseSvgElementShape(element);
    if (elementSubpaths === undefined) {
      return undefined;
    }
    if (elementSubpaths.length) {
      renderedElements.push(element);
      subpaths.push(...elementSubpaths);
    }
  }

  const viewBox = parseSvgViewBox(svg, [svgShapeSubpathPoints(subpaths)]);
  const viewBoxBounds = viewBox ? svgShapeBoundsFromViewBox(viewBox) : undefined;
  const fitted = fitShapeSubpathsToPercentBox(subpaths, viewBoxBounds);
  if (!fitted) {
    return undefined;
  }

  const fillRule = svgShapeFillRule(svg, renderedElements);
  if (fitMode === 'contain') {
    const contained = containShapeSubpathsToCss(subpaths, viewBoxBounds, options);
    return contained
      ? {
          kind: 'shape',
          value: formatShapeValueFromCssSubpaths(contained),
          ...(fillRule ? { fillRule } : {}),
          pathData: formatPathDataFromSubpaths(fitted),
        }
      : undefined;
  }

  return shapeFromSvgSubpaths(fitted, fillRule);
}

export function parseSvgClipPathPolygon(value: string): PolygonShape | undefined {
  const outline = parseSvgClipPathOutline(value);
  return outline ? { kind: 'polygon', points: outline.points } : undefined;
}

export function isNoneClipPathValue(value: string | undefined) {
  return !value || value.trim().toLowerCase() === 'none';
}

export function normalizeClipPathValue(value: string | undefined) {
  if (isNoneClipPathValue(value)) {
    return { shape: NONE_SHAPE, css: 'none' };
  }

  const parsed = parseClipPathInput(value || '');
  return {
    shape: parsed || NONE_SHAPE,
    css: parsed ? formatClipPath(parsed) : 'none',
  };
}
