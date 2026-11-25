// Reading clip-path CSS: top-level token splitting, lengths, percentages and
// coordinates, and the basic shapes — polygon, circle, ellipse, inset — strict
// and raw (ClipPath.tsx).

import {
  type Point,
  type CornerRadii,
  type CircleShape,
  type EllipseShape,
  type InsetShape,
  type ShapeFunctionShape,
  type CssUnitValue,
  type CssCoordinateValue,
  type CssCoordinatePoint,
  type RawClipPathShape,
} from './clipPathTypes';
import { isDefined, parseFillRule, CUSTOM_PRESET, CSS_GLOBAL_CLIP_PATH_VALUES, CSS_GEOMETRY_BOX_CLIP_PATH_VALUES } from './clipPathConstants';
import { makeInsetRadii } from './clipPathHandles';

export function parsePercent(value: string): number | undefined {
  if (value.trim() === '0') {
    return 0;
  }
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  return match?.[1] ? parseFloat(match[1]) : undefined;
}

export function splitTopLevelWhitespace(value: string) {
  const tokens: string[] = [];
  let depth = 0;
  let start: number | undefined = undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }

    if (char !== undefined && /\s/.test(char) && depth === 0) {
      if (start !== undefined) {
        tokens.push(value.slice(start, index));
        start = undefined;
      }
    } else if (start === undefined) {
      start = index;
    }
  }

  if (start !== undefined) {
    tokens.push(value.slice(start));
  }
  return tokens.map((token) => token.trim()).filter(Boolean);
}

export function splitTopLevelChar(value: string, separator: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (char === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

export function splitTopLevelKeyword(value: string, keyword: string) {
  let depth = 0;
  const lowerValue = value.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (depth !== 0 || lowerValue.slice(index, index + lowerKeyword.length) !== lowerKeyword) {
      continue;
    }

    const before = value[index - 1];
    const after = value[index + lowerKeyword.length];
    if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) {
      continue;
    }

    return [value.slice(0, index).trim(), value.slice(index + lowerKeyword.length).trim()] as const;
  }

  return [value.trim(), undefined] as const;
}

export function hasBalancedParens(value: string) {
  let depth = 0;
  for (const char of value) {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function isCssLengthPercentageToken(value: string) {
  const token = value.trim();
  if (!token) {
    return false;
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(token)) {
    return Number(token) === 0;
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|[a-z][a-z0-9]*)$/i.test(token)) {
    return true;
  }
  if (/^[a-z_][a-z0-9_-]*\(.*\)$/i.test(token)) {
    return hasBalancedParens(token);
  }
  return false;
}

export function parseCssUnitValue(value: string): CssUnitValue | undefined {
  const token = value.trim();
  const match = token.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)?$/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const unit = match[2] || (parsed === 0 ? '%' : '');
  return unit ? { value: parsed, unit } : undefined;
}

export function parseCssCoordinateValue(value: string): CssCoordinateValue | undefined {
  const unitValue = parseCssUnitValue(value);
  if (unitValue) {
    return unitValue;
  }
  return isCssLengthPercentageToken(value) ? { expression: value.trim() } : undefined;
}

export function parseCssUnitList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  if (tokens.length < min || tokens.length > max) {
    return undefined;
  }
  const values = tokens.map(parseCssUnitValue);
  return values.every(isDefined) ? values.filter(isDefined) : undefined;
}

export function validLengthPercentageList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  return tokens.length >= min && tokens.length <= max && tokens.every(isCssLengthPercentageToken);
}

export function validRawCenter(value: string | undefined) {
  return !value || validLengthPercentageList(value, 2, 2);
}

export function parsePolygon(value: string): Point[] | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/polygon\s*\(([^)]+)\)/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const parts = content.split(',');
  const points: Point[] = [];
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length !== 2) {
      return undefined;
    }
    const x = parsePercent(tokens[0] ?? '');
    const y = parsePercent(tokens[1] ?? '');
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }
  return points.length >= 3 ? points : undefined;
}

export function parseCenter(value: string): Point | undefined {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length !== 2) {
    return undefined;
  }
  const x = parsePercent(tokens[0] ?? '');
  const y = parsePercent(tokens[1] ?? '');
  return x === undefined || y === undefined ? undefined : { x, y };
}

export function parseCircle(value: string): CircleShape | undefined {
  const match = value.match(/^circle\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [radiusPart = '', centerPart] = content.split(/\s+at\s+/i).map((part) => part.trim());
  const radius = parsePercent(radiusPart);
  if (radius === undefined) {
    return undefined;
  }
  const center = centerPart ? parseCenter(centerPart) : { x: 50, y: 50 };
  return center ? { kind: 'circle', radius, cx: center.x, cy: center.y } : undefined;
}

export function parseEllipse(value: string): EllipseShape | undefined {
  const match = value.match(/^ellipse\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [radiiPart = '', centerPart] = content.split(/\s+at\s+/i).map((part) => part.trim());
  const radii = radiiPart.split(/\s+/);
  if (radii.length !== 2) {
    return undefined;
  }
  const rx = parsePercent(radii[0] ?? '');
  const ry = parsePercent(radii[1] ?? '');
  if (rx === undefined || ry === undefined) {
    return undefined;
  }
  const center = centerPart ? parseCenter(centerPart) : { x: 50, y: 50 };
  return center ? { kind: 'ellipse', rx, ry, cx: center.x, cy: center.y } : undefined;
}

export function expandRadiusValues(values: number[]): [number, number, number, number] | undefined {
  if (values.length < 1 || values.length > 4) {
    return undefined;
  }
  const topLeft = values[0];
  if (topLeft === undefined) {
    return undefined;
  }
  const topRight = values[1] ?? topLeft;
  const bottomRight = values[2] ?? topLeft;
  const bottomLeft = values[3] ?? values[1] ?? topLeft;
  return [topLeft, topRight, bottomRight, bottomLeft];
}

export function parseRadiusList(value: string): [number, number, number, number] | undefined {
  const values = value.trim().split(/\s+/).filter(Boolean).map(parsePercent);
  if (values.length < 1 || values.length > 4 || values.some((item) => item === undefined)) {
    return undefined;
  }
  return expandRadiusValues(values.filter(isDefined));
}

export function parseInsetRadii(value: string | undefined): CornerRadii | undefined {
  if (!value) {
    return makeInsetRadii(0);
  }
  const parts = value.split(/\s*\/\s*/);
  if (parts.length > 2) {
    return undefined;
  }
  const horizontal = parseRadiusList(parts[0] ?? '');
  if (!horizontal) {
    return undefined;
  }
  const vertical = parts[1] ? parseRadiusList(parts[1]) : horizontal;
  if (!vertical) {
    return undefined;
  }

  return {
    topLeft: { x: horizontal[0], y: vertical[0] },
    topRight: { x: horizontal[1], y: vertical[1] },
    bottomRight: { x: horizontal[2], y: vertical[2] },
    bottomLeft: { x: horizontal[3], y: vertical[3] },
  };
}

export function parseInset(value: string): InsetShape | undefined {
  const match = value.match(/^inset\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [insetPart = '', roundPart] = content.split(/\s+round\s+/i);
  const values = insetPart.trim().split(/\s+/).map(parsePercent);
  if (values.length < 1 || values.length > 4 || values.some((item) => item === undefined)) {
    return undefined;
  }
  const nums = values.filter(isDefined);
  const top = nums[0];
  if (top === undefined) {
    return undefined;
  }
  const right = nums[1] ?? top;
  const bottom = nums[2] ?? top;
  const left = nums[3] ?? nums[1] ?? top;
  const radii = parseInsetRadii(roundPart);
  return radii ? { kind: 'inset', top, right, bottom, left, radii } : undefined;
}

export function isCssRadiusToken(value: string) {
  return isCssLengthPercentageToken(value) || /^(closest-side|farthest-side)$/i.test(value.trim());
}

export function validRawRadiusList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  return tokens.length >= min && tokens.length <= max && tokens.every(isCssRadiusToken);
}

export function validRawInsetRadii(value: string | undefined) {
  if (!value) {
    return true;
  }
  const parts = splitTopLevelChar(value, '/');
  return parts.length >= 1 && parts.length <= 2 && validLengthPercentageList(parts[0] ?? '', 1, 4) && (!parts[1] || validLengthPercentageList(parts[1], 1, 4));
}

export function parseRawPolygon(value: string): RawClipPathShape | undefined {
  const match = value.match(/^polygon\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const parts = splitShapeCommandList(content);
  const fillRule = parseFillRule(parts[0]);
  const pointParts = fillRule ? parts.slice(1) : parts;
  if (pointParts.length < 3) {
    return undefined;
  }

  const parsedPoints: CssCoordinatePoint[] = [];
  const valid = pointParts.every((part) => {
    const tokens = splitTopLevelWhitespace(part);
    const x = parseCssCoordinateValue(tokens[0] || '');
    const y = parseCssCoordinateValue(tokens[1] || '');
    if (tokens.length === 2 && x && y) {
      parsedPoints.push({ x, y });
      return true;
    }
    return tokens.length === 2 && tokens.every(isCssLengthPercentageToken);
  });

  if (!valid) {
    return undefined;
  }
  const editable =
    parsedPoints.length === pointParts.length ? { kind: 'polygon' as const, points: parsedPoints, ...(fillRule ? { fillRule } : {}) } : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Polygon', // i18n-ignore: preset id.
    ...(editable ? { editable } : {}),
  };
}

export function parseRawCircle(value: string): RawClipPathShape | undefined {
  const match = value.match(/^circle\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [radiusPart, centerPart] = splitTopLevelKeyword(content, 'at');
  const radiusTokens = splitTopLevelWhitespace(radiusPart);
  const validRadius = radiusTokens.length === 1 && isCssRadiusToken(radiusTokens[0] ?? '');
  if (!validRadius || !validRawCenter(centerPart)) {
    return undefined;
  }

  const centerTokens = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  const radius = parseCssUnitValue(radiusTokens[0] ?? '');
  const cx = centerPart ? parseCssUnitValue(centerTokens[0] || '') : { value: 50, unit: '%' };
  const cy = centerPart ? parseCssUnitValue(centerTokens[1] || '') : { value: 50, unit: '%' };
  const editable = radius && cx && cy ? { kind: 'circle' as const, radius, cx, cy } : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Circle', // i18n-ignore: preset id.
    ...(editable ? { editable } : {}),
  };
}

export function parseRawEllipse(value: string): RawClipPathShape | undefined {
  const match = value.match(/^ellipse\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [radiiPart, centerPart] = splitTopLevelKeyword(content, 'at');
  if (!validRawRadiusList(radiiPart, 2, 2) || !validRawCenter(centerPart)) {
    return undefined;
  }

  const radii = splitTopLevelWhitespace(radiiPart);
  const center = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  const rx = parseCssUnitValue(radii[0] || '');
  const ry = parseCssUnitValue(radii[1] || '');
  const cx = centerPart ? parseCssUnitValue(center[0] || '') : { value: 50, unit: '%' };
  const cy = centerPart ? parseCssUnitValue(center[1] || '') : { value: 50, unit: '%' };
  const editable = rx && ry && cx && cy ? { kind: 'ellipse' as const, rx, ry, cx, cy } : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Ellipse', // i18n-ignore: preset id.
    ...(editable ? { editable } : {}),
  };
}

export function parseRawInset(value: string): RawClipPathShape | undefined {
  const match = value.match(/^inset\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [insetPart, roundPart] = splitTopLevelKeyword(content, 'round');
  if (!validLengthPercentageList(insetPart, 1, 4) || !validRawInsetRadii(roundPart)) {
    return undefined;
  }

  const sideValues = parseCssUnitList(insetPart, 1, 4);
  const top = sideValues?.[0];
  const right = sideValues?.[1] ?? sideValues?.[0];
  const bottom = sideValues?.[2] ?? sideValues?.[0];
  const left = sideValues?.[3] ?? sideValues?.[1] ?? sideValues?.[0];
  const radiusParts = roundPart ? splitTopLevelChar(roundPart, '/') : [];
  const horizontal = radiusParts[0] ? parseCssUnitList(radiusParts[0], 1, 4) : undefined;
  const vertical = radiusParts[1] ? parseCssUnitList(radiusParts[1], 1, 4) : undefined;
  const editable =
    top && right && bottom && left && (!roundPart || horizontal)
      ? {
          kind: 'inset' as const,
          top,
          right,
          bottom,
          left,
          ...(horizontal ? { radii: { horizontal, ...(vertical ? { vertical } : {}) } } : {}),
        }
      : undefined;

  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Inset', // i18n-ignore: preset id.
    ...(editable ? { editable } : {}),
  };
}

export function parseRawBasicClipPath(value: string): RawClipPathShape | undefined {
  return parseRawPolygon(value) || parseRawCircle(value) || parseRawEllipse(value) || parseRawInset(value);
}

export function parseCustomClipPath(value: string): RawClipPathShape | undefined {
  const trimmed = value.trim().replace(/;$/, '');
  const lowerValue = trimmed.toLowerCase();
  if (!trimmed || lowerValue === 'none') {
    return undefined;
  }
  if (CSS_GLOBAL_CLIP_PATH_VALUES.has(lowerValue)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  if (CSS_GEOMETRY_BOX_CLIP_PATH_VALUES.has(lowerValue)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  if (/^[a-z][a-z0-9-]*\s*\(/is.test(trimmed) && hasBalancedParens(trimmed)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  return undefined;
}

export function parseShape(value: string): ShapeFunctionShape | undefined {
  const match = value.match(/^shape\s*\((.*)\)$/is);
  const initialContent = match?.[1];
  if (!initialContent) {
    return undefined;
  }

  let content = initialContent.trim();
  let fillRule: ShapeFunctionShape['fillRule'];
  const fillRuleMatch = content.match(/^(evenodd|nonzero)\s+(from\b.*)$/is);
  if (fillRuleMatch) {
    fillRule = parseFillRule(fillRuleMatch[1]);
    content = fillRuleMatch[2]?.trim() ?? '';
  }

  return /^from\b/i.test(content) ? { kind: 'shape', value: content, ...(fillRule ? { fillRule } : {}) } : undefined;
}

export function splitShapeCommandList(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
