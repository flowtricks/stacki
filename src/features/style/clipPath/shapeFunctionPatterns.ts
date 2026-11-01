// Reading a shape() coordinate: the patterns its numbers, sizes, scale and
// offset variables are written in, and turning a written coordinate into a
// point on the canvas (ClipPath.tsx).

import { type ShapeOffsetCoordinate, type ShapeCssPoint } from './clipPathTypes';

export const SHAPE_ABSOLUTE_NUMBER = '(?:\\d+\\.?\\d*|\\.\\d+)';
export const SHAPE_SIGNED_NUMBER = `[-+]?${SHAPE_ABSOLUTE_NUMBER}`;
export const SHAPE_CQW_COORDINATE_PATTERN = [
  'calc\\(\\s*(?:',
  `50%\\s*([+-])\\s*(${SHAPE_ABSOLUTE_NUMBER})cqw`,
  '|',
  `(${SHAPE_SIGNED_NUMBER})cqw\\s*\\+\\s*50%`,
  ')\\s*\\)',
].join('');
export const SHAPE_MIN_COORDINATE_PATTERN = [
  'calc\\(\\s*50%\\s*([+-])\\s*min\\(\\s*',
  `(${SHAPE_ABSOLUTE_NUMBER})cqw\\s*,\\s*${SHAPE_ABSOLUTE_NUMBER}cqh`,
  '\\s*\\)\\s*\\)',
].join('');
export const SHAPE_SCALE_COORDINATE_PATTERN = [
  'calc\\(\\s*50%\\s*([+-])\\s*',
  `(${SHAPE_ABSOLUTE_NUMBER})\\s*\\*\\s*var\\(\\s*([a-zA-Z0-9_-]+)\\s*,\\s*100cqw\\s*\\)`,
  '\\s*\\)',
].join('');
// New contain encoding, per axis. The size and offset terms are each either var(name, value)
// or a bare value:
//   x: calc(Ux * <size> + <offset> * (100cqw - WU * <size>))
//   y: calc(Uy * <size> + <offset> * (100cqh - HU * <size>))
// Capture groups: 1=u, 2=sizeVar, 3=S(var form), 4=S(raw form), 5=offsetVar,
//                 6=offset(var form), 7=offset(raw form), 8=span.
export const SHAPE_VAR_NAME = '([a-zA-Z0-9_-]+)';
// Size token: var(name, S cqw) or a bare S cqw (capturing name + both number forms).
export const SHAPE_SIZE_TOKEN = `(?:var\\(\\s*${SHAPE_VAR_NAME}\\s*,\\s*(${SHAPE_ABSOLUTE_NUMBER})cqw\\s*\\)` + `|(${SHAPE_ABSOLUTE_NUMBER})cqw)`;
// Second size occurrence inside the travel term — match either form, capture nothing.
export const SHAPE_SIZE_TOKEN_LOOSE = `(?:var\\(\\s*[a-zA-Z0-9_-]+\\s*,\\s*${SHAPE_ABSOLUTE_NUMBER}cqw\\s*\\)` + `|${SHAPE_ABSOLUTE_NUMBER}cqw)`;
export const buildShapeOffsetCoordinatePattern = (travelUnit: string) =>
  [
    'calc\\(\\s*',
    `(${SHAPE_SIGNED_NUMBER})\\s*\\*\\s*${SHAPE_SIZE_TOKEN}`,
    '\\s*\\+\\s*',
    `(?:var\\(\\s*${SHAPE_VAR_NAME}\\s*,\\s*(${SHAPE_SIGNED_NUMBER})\\s*\\)`,
    `|(${SHAPE_SIGNED_NUMBER}))`,
    `\\s*\\*\\s*\\(\\s*100${travelUnit}\\s*-\\s*`,
    `(${SHAPE_ABSOLUTE_NUMBER})\\s*\\*\\s*${SHAPE_SIZE_TOKEN_LOOSE}\\s*\\)`,
    '\\s*\\)',
  ].join('');
export const SHAPE_OFFSET_COORDINATE_PATTERN_X = buildShapeOffsetCoordinatePattern('cqw');
export const SHAPE_OFFSET_COORDINATE_PATTERN_Y = buildShapeOffsetCoordinatePattern('cqh');
export const SHAPE_OFFSET_COORDINATE_X_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_X}`, 'i');
export const SHAPE_OFFSET_COORDINATE_Y_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_Y}`, 'i');
export const SHAPE_OFFSET_COORDINATE_X_EXACT_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_X}$`, 'i');
export const SHAPE_OFFSET_COORDINATE_Y_EXACT_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_Y}$`, 'i');
export const SHAPE_OFFSET_LEFT_VARIABLE_NAME_RE = new RegExp(SHAPE_OFFSET_COORDINATE_PATTERN_X, 'i');
export const SHAPE_OFFSET_TOP_VARIABLE_NAME_RE = new RegExp(SHAPE_OFFSET_COORDINATE_PATTERN_Y, 'i');
// Offset patterns must come first so the longer, more specific match wins coordinate splitting.
export const SHAPE_CALCULATED_COORDINATE_RE = new RegExp(
  `^(?:${[
    SHAPE_OFFSET_COORDINATE_PATTERN_X,
    SHAPE_OFFSET_COORDINATE_PATTERN_Y,
    SHAPE_MIN_COORDINATE_PATTERN,
    SHAPE_SCALE_COORDINATE_PATTERN,
    SHAPE_CQW_COORDINATE_PATTERN,
  ].join('|')})`,
  'i',
);
export const SHAPE_CQW_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_CQW_COORDINATE_PATTERN}$`, 'i');
export const SHAPE_MIN_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_MIN_COORDINATE_PATTERN}$`, 'i');
export const SHAPE_SCALE_COORDINATE_RE = new RegExp(`^${SHAPE_SCALE_COORDINATE_PATTERN}`, 'i');
export const SHAPE_SCALE_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_SCALE_COORDINATE_PATTERN}$`, 'i');
export const SHAPE_SCALE_VARIABLE_NAME_RE = new RegExp(SHAPE_SCALE_COORDINATE_PATTERN, 'i');

export function parseShapeOffsetCoordinate(value: string, exact = false): ShapeOffsetCoordinate | undefined {
  const trimmed = value.trim();
  const xMatch = trimmed.match(exact ? SHAPE_OFFSET_COORDINATE_X_EXACT_RE : SHAPE_OFFSET_COORDINATE_X_RE);
  const match = xMatch || trimmed.match(exact ? SHAPE_OFFSET_COORDINATE_Y_EXACT_RE : SHAPE_OFFSET_COORDINATE_Y_RE);
  if (!match) {
    return undefined;
  }
  const position = Number(match[1]);
  const size = Number(match[3] ?? match[4]);
  const offset = Number(match[6] ?? match[7]);
  const span = Number(match[8]);
  if (![position, size, offset, span].every(Number.isFinite)) {
    return undefined;
  }
  return {
    axis: xMatch ? 'x' : 'y',
    u: position,
    size,
    offset,
    span,
    sizeVar: match[2] ?? '',
    offsetVar: match[5] ?? '',
  };
}

export function shapeOffsetCoordinateToCanvas(parsed: ShapeOffsetCoordinate) {
  return parsed.u * parsed.size + parsed.offset * (100 - parsed.span * parsed.size);
}

export function shapeOffsetVariableNamesFromValue(value: string) {
  const xMatch = value.match(SHAPE_OFFSET_LEFT_VARIABLE_NAME_RE);
  const yMatch = value.match(SHAPE_OFFSET_TOP_VARIABLE_NAME_RE);
  if (!xMatch && !yMatch) {
    return undefined;
  }
  return {
    sizeVar: xMatch?.[2] || yMatch?.[2] || undefined,
    offsetLeftVar: xMatch?.[5] || undefined,
    offsetTopVar: yMatch?.[5] || undefined,
  };
}

export function shapeCalculatedCoordinateOffset(value: string, exact = false) {
  const trimmed = value.trim();
  const offsetParsed = parseShapeOffsetCoordinate(trimmed, exact);
  if (offsetParsed) {
    const canvas = shapeOffsetCoordinateToCanvas(offsetParsed);
    return Number.isFinite(canvas) ? canvas - 50 : undefined;
  }

  const minMatch = trimmed.match(exact ? SHAPE_MIN_COORDINATE_EXACT_RE : new RegExp(`^${SHAPE_MIN_COORDINATE_PATTERN}`, 'i'));
  if (minMatch) {
    const offset = Number(minMatch[2]);
    if (!Number.isFinite(offset)) {
      return undefined;
    }
    return minMatch[1] === '-' ? -offset : offset;
  }

  const scaleMatch = trimmed.match(exact ? SHAPE_SCALE_COORDINATE_EXACT_RE : SHAPE_SCALE_COORDINATE_RE);
  if (scaleMatch) {
    const offset = Number(scaleMatch[2]) * 100;
    if (!Number.isFinite(offset)) {
      return undefined;
    }
    return scaleMatch[1] === '-' ? -offset : offset;
  }

  const match = trimmed.match(exact ? SHAPE_CQW_COORDINATE_EXACT_RE : new RegExp(`^${SHAPE_CQW_COORDINATE_PATTERN}`, 'i'));
  if (!match) {
    return undefined;
  }

  if (match[3] !== undefined) {
    const offset = Number(match[3]);
    return Number.isFinite(offset) ? offset : undefined;
  }

  const offset = Number(match[2]);
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return match[1] === '-' ? -offset : offset;
}

export function readShapeCssCoordinate(value: string) {
  const trimmed = value.trimStart();
  const percentMatch = trimmed.match(/^-?\d+(?:\.\d+)?%/i);
  if (percentMatch) {
    return {
      coordinate: percentMatch[0],
      rest: trimmed.slice(percentMatch[0].length).trimStart(),
    };
  }

  const calculatedMatch = trimmed.match(SHAPE_CALCULATED_COORDINATE_RE);
  if (calculatedMatch) {
    return {
      coordinate: calculatedMatch[0],
      rest: trimmed.slice(calculatedMatch[0].length).trimStart(),
    };
  }

  return undefined;
}

export function parseShapeCssPoint(value: string): ShapeCssPoint | undefined {
  const parsed = readShapeCssPoint(value);
  return parsed && !parsed.rest ? parsed.point : undefined;
}

export function hasContainerQueryUnit(value: string) {
  return /cq[wh]\b/i.test(value);
}

export function shapeScaleVariableNameFromValue(value: string) {
  const offsetNames = shapeOffsetVariableNamesFromValue(value);
  if (offsetNames?.sizeVar) {
    return offsetNames.sizeVar;
  }
  return value.match(SHAPE_SCALE_VARIABLE_NAME_RE)?.[3] || undefined;
}

export function readShapeCssPoint(value: string) {
  const x = readShapeCssCoordinate(value);
  if (!x) {
    return undefined;
  }

  const y = readShapeCssCoordinate(x.rest);
  if (!y) {
    return undefined;
  }

  return {
    point: { x: x.coordinate, y: y.coordinate },
    rest: y.rest,
  };
}
