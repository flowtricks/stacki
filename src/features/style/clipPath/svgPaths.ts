// SVG shapes and paths as clip geometry: rectangles, ellipses, circles and
// polygons, path data tokens and commands, and arcs as cubic curves
// (ClipPath.tsx).

import { type Point, type SvgShapeCommand, type SvgShapeSubpath } from './clipPathTypes';
import { SVG_POINT_EPSILON, SVG_ARC_KAPPA } from './clipPathConstants';
import { clampValue } from './clipPathMeasure';
import { parseSvgNumber, parseSvgNumberList, svgAttribute, svgPointsAlmostEqual, simplifySvgContour, svgSubpathHasArea, closeSvgSubpath } from './svgElements';

export function parseSvgRectShape(element: Element) {
  const x = parseSvgNumber(svgAttribute(element, 'x')) || 0;
  const y = parseSvgNumber(svgAttribute(element, 'y')) || 0;
  const width = parseSvgNumber(svgAttribute(element, 'width'));
  const height = parseSvgNumber(svgAttribute(element, 'height'));
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return [];
  }

  const rawRx = parseSvgNumber(svgAttribute(element, 'rx'));
  const rawRy = parseSvgNumber(svgAttribute(element, 'ry'));
  const rx = Math.min(width / 2, Math.max(0, rawRx ?? rawRy ?? 0));
  const ry = Math.min(height / 2, Math.max(0, rawRy ?? rawRx ?? 0));
  const right = x + width;
  const bottom = y + height;

  if (rx <= SVG_POINT_EPSILON || ry <= SVG_POINT_EPSILON) {
    return [
      {
        start: { x, y },
        commands: [
          { kind: 'line' as const, to: { x: right, y } },
          { kind: 'line' as const, to: { x: right, y: bottom } },
          { kind: 'line' as const, to: { x, y: bottom } },
          { kind: 'close' as const },
        ],
      },
    ];
  }

  const kx = rx * SVG_ARC_KAPPA;
  const ky = ry * SVG_ARC_KAPPA;
  return [
    {
      start: { x: x + rx, y },
      commands: [
        { kind: 'line' as const, to: { x: right - rx, y } },
        {
          kind: 'curve' as const,
          to: { x: right, y: y + ry },
          control1: { x: right - rx + kx, y },
          control2: { x: right, y: y + ry - ky },
        },
        { kind: 'line' as const, to: { x: right, y: bottom - ry } },
        {
          kind: 'curve' as const,
          to: { x: right - rx, y: bottom },
          control1: { x: right, y: bottom - ry + ky },
          control2: { x: right - rx + kx, y: bottom },
        },
        { kind: 'line' as const, to: { x: x + rx, y: bottom } },
        {
          kind: 'curve' as const,
          to: { x, y: bottom - ry },
          control1: { x: x + rx - kx, y: bottom },
          control2: { x, y: bottom - ry + ky },
        },
        { kind: 'line' as const, to: { x, y: y + ry } },
        {
          kind: 'curve' as const,
          to: { x: x + rx, y },
          control1: { x, y: y + ry - ky },
          control2: { x: x + rx - kx, y },
        },
        { kind: 'close' as const },
      ],
    },
  ];
}

export function parseSvgEllipseShape(cx: number, cy: number, rx: number, ry: number) {
  if (rx <= 0 || ry <= 0) {
    return [];
  }

  const kx = rx * SVG_ARC_KAPPA;
  const ky = ry * SVG_ARC_KAPPA;
  return [
    {
      start: { x: cx + rx, y: cy },
      commands: [
        {
          kind: 'curve' as const,
          to: { x: cx, y: cy + ry },
          control1: { x: cx + rx, y: cy + ky },
          control2: { x: cx + kx, y: cy + ry },
        },
        {
          kind: 'curve' as const,
          to: { x: cx - rx, y: cy },
          control1: { x: cx - kx, y: cy + ry },
          control2: { x: cx - rx, y: cy + ky },
        },
        {
          kind: 'curve' as const,
          to: { x: cx, y: cy - ry },
          control1: { x: cx - rx, y: cy - ky },
          control2: { x: cx - kx, y: cy - ry },
        },
        {
          kind: 'curve' as const,
          to: { x: cx + rx, y: cy },
          control1: { x: cx + kx, y: cy - ry },
          control2: { x: cx + rx, y: cy - ky },
        },
        { kind: 'close' as const },
      ],
    },
  ];
}

export function parseSvgCircleShape(element: Element) {
  const cx = parseSvgNumber(svgAttribute(element, 'cx')) || 0;
  const cy = parseSvgNumber(svgAttribute(element, 'cy')) || 0;
  const radius = parseSvgNumber(svgAttribute(element, 'r')) || 0;
  return parseSvgEllipseShape(cx, cy, radius, radius);
}

export function parseSvgEllipseElementShape(element: Element) {
  const cx = parseSvgNumber(svgAttribute(element, 'cx')) || 0;
  const cy = parseSvgNumber(svgAttribute(element, 'cy')) || 0;
  const rx = parseSvgNumber(svgAttribute(element, 'rx')) || 0;
  const ry = parseSvgNumber(svgAttribute(element, 'ry')) || 0;
  return parseSvgEllipseShape(cx, cy, rx, ry);
}

export function parseSvgPolygonShape(element: Element, requireClosed = true) {
  const values = parseSvgNumberList(svgAttribute(element, 'points'));
  if (values.length < 6 || values.length % 2 !== 0) {
    return undefined;
  }

  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (requireClosed && (!firstPoint || !lastPoint || !svgPointsAlmostEqual(firstPoint, lastPoint))) {
    return undefined;
  }

  const simplified = simplifySvgContour(points);
  const [start, ...rest] = simplified;
  if (!start || rest.length < 2) {
    return [];
  }

  return [
    {
      start,
      commands: [...rest.map((point) => ({ kind: 'line' as const, to: point })), { kind: 'close' as const }],
    },
  ];
}

export function isSvgPathCommand(token: string) {
  return /^[a-z]$/i.test(token);
}

// The command letters and numbers of an element's `d` attribute, or undefined when it
// has none.
export function svgPathTokens(element: Element): string[] | undefined {
  const pathData = element.getAttribute('d');
  const tokens = pathData?.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  return tokens?.length ? tokens : undefined;
}

// Reads a path's tokens in order: a command letter, then the numbers after it.
export type SvgPathCursor = {
  done: () => boolean;
  // The next token when it is a command letter, consumed; undefined otherwise.
  takeCommand: () => string | undefined;
  hasNumber: () => boolean;
  readNumber: () => number | undefined;
  // `count` numbers, or undefined when any is missing or not finite.
  readNumbers: (count: number) => number[] | undefined;
};

export function svgPathCursor(tokens: readonly string[]): SvgPathCursor {
  let index = 0;
  const hasNumber = () => {
    const token = tokens[index];
    return token !== undefined && !isSvgPathCommand(token);
  };
  const readNumber = () => {
    if (!hasNumber()) {
      return undefined;
    }
    const value = Number(tokens[index] ?? '');
    index += 1;
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    done: () => index >= tokens.length,
    takeCommand: () => {
      const token = tokens[index];
      if (token !== undefined && isSvgPathCommand(token)) {
        index += 1;
        return token;
      }
      return undefined;
    },
    hasNumber,
    readNumber,
    readNumbers: (count) => {
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = readNumber();
        if (value === undefined) {
          return undefined;
        }
        values.push(value);
      }
      return values;
    },
  };
}

// The pen of a straight-edged path: where it is, where the path began, and the
// corners so far. The reader owns that state and changes it only through its own
// methods, so the command helpers below ask it to move instead of writing its fields.
export class SimpleSvgPathReader {
  #command = '';
  #current: Point = { x: 0, y: 0 };
  #start: Point | undefined = undefined;
  #closed = false;
  readonly #corners: Point[] = [];

  // The command whose numbers are being read; empty after a close-path.
  get command(): string {
    return this.#command;
  }

  get current(): Point {
    return this.#current;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get corners(): readonly Point[] {
    return this.#corners;
  }

  // Takes the next command letter when there is one; otherwise the numbers that
  // follow repeat the command before them.
  takeCommand(cursor: SvgPathCursor): string {
    this.#command = cursor.takeCommand() ?? this.#command;
    return this.#command;
  }

  // Starts the path at `point`. Numbers after a move-to are line-tos, relative when
  // the move was.
  moveTo(point: Point, { relative }: { relative: boolean }): void {
    this.#current = point;
    this.#start = point;
    this.#corners.push(point);
    this.#command = relative ? 'l' : 'L';
    this.#closed = false;
  }

  lineTo(point: Point): void {
    this.#current = point;
    this.#corners.push(point);
  }

  // Returns the pen to where the path began. False when the path never began.
  close(): boolean {
    if (!this.#start) {
      return false;
    }
    this.#current = this.#start;
    this.#closed = true;
    this.#command = '';
    return true;
  }
}

export function parseSimpleSvgPath(element: Element) {
  const tokens = svgPathTokens(element);
  if (!tokens) {
    return undefined;
  }
  const cursor = svgPathCursor(tokens);
  const reader = new SimpleSvgPathReader();
  while (!cursor.done()) {
    if (!reader.takeCommand(cursor)) {
      return undefined;
    }
    if (!applySimpleSvgCommand(reader, cursor)) {
      return undefined;
    }
  }

  const points = reader.corners;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!reader.closed && firstPoint && lastPoint && points.length > 1 && !svgPointsAlmostEqual(firstPoint, lastPoint)) {
    return undefined;
  }
  return simplifySvgContour(points);
}

// One command of a straight-edged path. False when the path is not one this reads.
export function applySimpleSvgCommand(reader: SimpleSvgPathReader, cursor: SvgPathCursor): boolean {
  const relative = reader.command === reader.command.toLowerCase();
  switch (reader.command.toUpperCase()) {
    case 'M':
      return simpleSvgMove(reader, cursor, { relative });
    case 'L':
      while (cursor.hasNumber()) {
        const numbers = cursor.readNumbers(2);
        if (!numbers) {
          return false;
        }
        reader.lineTo(offsetSvgPoint(reader.current, numbers, { relative }));
      }
      return true;
    case 'H':
      while (cursor.hasNumber()) {
        const x = cursor.readNumber();
        if (x === undefined) {
          return false;
        }
        const current = reader.current;
        reader.lineTo({ x: relative ? current.x + x : x, y: current.y });
      }
      return true;
    case 'V':
      while (cursor.hasNumber()) {
        const y = cursor.readNumber();
        if (y === undefined) {
          return false;
        }
        const current = reader.current;
        reader.lineTo({ x: current.x, y: relative ? current.y + y : y });
      }
      return true;
    case 'Z':
      return reader.close();
    default:
      return false;
  }
}

// A straight-edged path starts once: a second move-to is a second contour, which
// this reader does not take.
export function simpleSvgMove(reader: SimpleSvgPathReader, cursor: SvgPathCursor, { relative }: { relative: boolean }): boolean {
  if (reader.corners.length) {
    return false;
  }
  const numbers = cursor.readNumbers(2);
  if (!numbers) {
    return false;
  }
  reader.moveTo(offsetSvgPoint(reader.current, numbers, { relative }), { relative });
  return true;
}

// The point `[x, y]` names: as written, or from `current` for a relative command.
export function offsetSvgPoint(current: Point, [x = 0, y = 0]: readonly number[], { relative }: { relative: boolean }): Point {
  return relative ? { x: current.x + x, y: current.y + y } : { x, y };
}

export function transformSvgArcPoint(point: Point, cosPhi: number, sinPhi: number, center: Point) {
  return {
    x: cosPhi * point.x - sinPhi * point.y + center.x,
    y: sinPhi * point.x + cosPhi * point.y + center.y,
  };
}

export function svgVectorAngle(ux: number, uy: number, vx: number, vy: number) {
  const dot = ux * vx + uy * vy;
  const length = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(clampValue(dot / length, -1, 1));
}

export function svgArcToCubicCurves(
  from: Point,
  rawRx: number,
  rawRy: number,
  rotation: number,
  { largeArc, sweep }: { largeArc: boolean; sweep: boolean },
  to: Point,
) {
  if (svgPointsAlmostEqual(from, to)) {
    return [];
  }

  let rx = Math.abs(rawRx);
  let ry = Math.abs(rawRy);
  if (rx <= SVG_POINT_EPSILON || ry <= SVG_POINT_EPSILON) {
    return [{ kind: 'line' as const, to }];
  }

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const rotatedX = cosPhi * dx + sinPhi * dy;
  const rotatedY = -sinPhi * dx + cosPhi * dy;

  const radiusScale = (rotatedX * rotatedX) / (rx * rx) + (rotatedY * rotatedY) / (ry * ry);
  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const rotatedXSquared = rotatedX * rotatedX;
  const rotatedYSquared = rotatedY * rotatedY;
  const denominator = rx2 * rotatedYSquared + ry2 * rotatedXSquared;
  if (denominator === 0) {
    return [{ kind: 'line' as const, to }];
  }

  const sign = largeArc === sweep ? -1 : 1;
  const coefficient = sign * Math.sqrt(Math.max(0, (rx2 * ry2 - rx2 * rotatedYSquared - ry2 * rotatedXSquared) / denominator));
  const cxp = (coefficient * (rx * rotatedY)) / ry;
  const cyp = (coefficient * (-ry * rotatedX)) / rx;
  const center = {
    x: cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2,
    y: sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2,
  };
  const startVector = { x: (rotatedX - cxp) / rx, y: (rotatedY - cyp) / ry };
  const endVector = { x: (-rotatedX - cxp) / rx, y: (-rotatedY - cyp) / ry };
  const startAngle = svgVectorAngle(1, 0, startVector.x, startVector.y);
  let deltaAngle = svgVectorAngle(startVector.x, startVector.y, endVector.x, endVector.y);

  if (!sweep && deltaAngle > 0) {
    deltaAngle -= Math.PI * 2;
  }
  if (sweep && deltaAngle < 0) {
    deltaAngle += Math.PI * 2;
  }

  const curves = svgArcSegments({ rx, ry, cosPhi, sinPhi, center, startAngle, deltaAngle });
  const lastCurve = curves[curves.length - 1];
  if (lastCurve?.kind === 'curve') {
    lastCurve.to = to;
  }
  return curves;
}

// The arc from `startAngle` through `deltaAngle` on the ellipse (rx, ry) rotated by
// phi about `center`, as cubic curves of at most a quarter turn each.
export function svgArcSegments({
  rx,
  ry,
  cosPhi,
  sinPhi,
  center,
  startAngle: firstAngle,
  deltaAngle,
}: {
  rx: number;
  ry: number;
  cosPhi: number;
  sinPhi: number;
  center: Point;
  startAngle: number;
  deltaAngle: number;
}): SvgShapeCommand[] {
  const segments = Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2));
  const segmentAngle = deltaAngle / segments;
  const curves: SvgShapeCommand[] = [];
  let startAngle = firstAngle;

  for (let segment = 0; segment < segments; segment += 1) {
    const nextAngle = startAngle + segmentAngle;
    const alpha = (4 / 3) * Math.tan((nextAngle - startAngle) / 4);
    const arcEnd = { x: rx * Math.cos(nextAngle), y: ry * Math.sin(nextAngle) };
    const control1 = {
      x: rx * (Math.cos(startAngle) - alpha * Math.sin(startAngle)),
      y: ry * (Math.sin(startAngle) + alpha * Math.cos(startAngle)),
    };
    const control2 = {
      x: rx * (Math.cos(nextAngle) + alpha * Math.sin(nextAngle)),
      y: ry * (Math.sin(nextAngle) - alpha * Math.cos(nextAngle)),
    };

    curves.push({
      kind: 'curve',
      to: transformSvgArcPoint(arcEnd, cosPhi, sinPhi, center),
      control1: transformSvgArcPoint(control1, cosPhi, sinPhi, center),
      control2: transformSvgArcPoint(control2, cosPhi, sinPhi, center),
    });
    startAngle = nextAngle;
  }
  return curves;
}

// The pen of a curved path: where it is, the subpath it is drawing, the control
// points a smooth curve reflects, and the subpaths finished so far. The reader owns
// that state and changes it only through its own methods, so the command helpers
// below ask it to draw instead of writing its fields.
export class SvgShapePathReader {
  #command = '';
  #current: Point = { x: 0, y: 0 };
  #activeSubpath: SvgShapeSubpath | undefined = undefined;
  #previousCubicControl: Point | undefined = undefined;
  #previousQuadraticControl: Point | undefined = undefined;
  #previousCommand = '';
  readonly #subpaths: SvgShapeSubpath[] = [];

  // The command whose numbers are being read; empty after a close-path.
  get command(): string {
    return this.#command;
  }

  get current(): Point {
    return this.#current;
  }

  get previousCubicControl(): Point | undefined {
    return this.#previousCubicControl;
  }

  get previousQuadraticControl(): Point | undefined {
    return this.#previousQuadraticControl;
  }

  // The letter of the last command read, which decides whether a smooth curve
  // reflects a control point.
  get previousCommand(): string {
    return this.#previousCommand;
  }

  // Takes the next command letter when there is one; otherwise the numbers that
  // follow repeat the command before them.
  takeCommand(cursor: SvgPathCursor): string {
    this.#command = cursor.takeCommand() ?? this.#command;
    return this.#command;
  }

  // A move-to ends the subpath being drawn and starts the next at `point`. Numbers
  // after it are line-tos, relative when the move was.
  moveTo(point: Point, { relative }: { relative: boolean }): void {
    this.#finishSubpath();
    this.#current = point;
    this.#activeSubpath = { start: point, commands: [] };
    this.forgetControlPoints();
    this.#previousCommand = 'M';
    this.#command = relative ? 'l' : 'L';
  }

  lineTo(to: Point): void {
    this.#addCommand({ kind: 'line', to });
  }

  cubicTo(to: Point, control1: Point, control2: Point): void {
    this.#addCommand({ kind: 'curve', to, control1, control2 });
    this.#previousCubicControl = control2;
    this.#previousQuadraticControl = undefined;
  }

  quadraticTo(to: Point, control1: Point): void {
    this.#addCommand({ kind: 'curve', to, control1 });
    this.#previousQuadraticControl = control1;
    this.#previousCubicControl = undefined;
  }

  // An arc arrives as the cubic curves that approximate it; a smooth curve after it
  // reflects nothing.
  arcTo(curves: readonly SvgShapeCommand[]): void {
    for (const curve of curves) {
      this.#addCommand(curve);
    }
    this.forgetControlPoints();
  }

  forgetControlPoints(): void {
    this.#previousCubicControl = undefined;
    this.#previousQuadraticControl = undefined;
  }

  // Records the letter of a command once all its numbers are read.
  recordCommand(letter: string): void {
    this.#previousCommand = letter;
  }

  // A close-path returns the pen to the subpath's start and ends the subpath. False
  // when no subpath is being drawn.
  close(): boolean {
    const subpath = this.#activeSubpath;
    if (!subpath) {
      return false;
    }
    subpath.commands.push({ kind: 'close' });
    this.#current = subpath.start;
    this.#finishSubpath();
    this.forgetControlPoints();
    this.#previousCommand = 'Z';
    this.#command = '';
    return true;
  }

  // Ends the path: the subpath being drawn is finished, and the subpaths kept are
  // returned.
  finish(): SvgShapeSubpath[] {
    this.#finishSubpath();
    return this.#subpaths;
  }

  #addCommand(nextCommand: SvgShapeCommand): void {
    if (!this.#activeSubpath) {
      this.#activeSubpath = { start: this.#current, commands: [] };
    }
    this.#activeSubpath.commands.push(nextCommand);
    if (nextCommand.kind !== 'close') {
      this.#current = nextCommand.to;
    }
  }

  // Closes the subpath being drawn and keeps it when it encloses anything.
  #finishSubpath(): void {
    if (!this.#activeSubpath) {
      return;
    }
    const closed = closeSvgSubpath(this.#activeSubpath);
    if (svgSubpathHasArea(closed)) {
      this.#subpaths.push(closed);
    }
    this.#activeSubpath = undefined;
  }
}
