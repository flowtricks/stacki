// Reading an SVG's elements: numbers and lists, markup, tags, styles and
// inherited attributes, which elements render, the view box, and polylines,
// rectangles and simplified contours (ClipPath.tsx).

import { type Point, type SvgViewBox, type SvgShapeSubpath } from './clipPathTypes';
import { SVG_POINT_EPSILON } from './clipPathConstants';
import { svgShapeCommandPoints } from './clipPathFormat';

export function parseSvgNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const match = value.trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSvgNumberList(value: string | undefined) {
  if (!value) {
    return [];
  }
  return Array.from(value.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi), (match) => Number(match[0])).filter(Number.isFinite);
}

export function extractSvgMarkup(value: string) {
  return value.match(/<svg\b[\s\S]*<\/svg>/i)?.[0] || undefined;
}

export function svgTagName(element: Element) {
  return element.tagName.toLowerCase();
}

export function svgStyleValue(element: Element, property: string) {
  const style = element.getAttribute('style');
  if (!style) {
    return undefined;
  }

  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim() || undefined;
}

export function inheritedSvgAttribute(element: Element, attribute: string) {
  let current: Element | undefined = element;
  while (current) {
    const styleValue = svgStyleValue(current, attribute);
    if (styleValue) {
      return styleValue;
    }

    const value = current.getAttribute(attribute);
    if (value !== null) {
      return value;
    }

    current = current.parentElement ?? undefined;
  }

  return undefined;
}

export function isRenderableSvgElement(element: Element) {
  const display = inheritedSvgAttribute(element, 'display')?.trim().toLowerCase();
  const visibility = inheritedSvgAttribute(element, 'visibility')?.trim().toLowerCase();
  const fill = inheritedSvgAttribute(element, 'fill')?.trim().toLowerCase();
  const opacity = inheritedSvgAttribute(element, 'opacity')?.trim();
  const fillOpacity = inheritedSvgAttribute(element, 'fill-opacity')?.trim();

  return display !== 'none' && visibility !== 'hidden' && visibility !== 'collapse' && fill !== 'none' && opacity !== '0' && fillOpacity !== '0';
}

export function isInsideSkippedSvgElement(element: Element) {
  let current = element.parentElement;
  while (current) {
    const tagName = svgTagName(current);
    if (tagName === 'defs' || tagName === 'clippath' || tagName === 'mask' || tagName === 'pattern' || tagName === 'symbol') {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

export function hasSvgTransform(element: Element) {
  let current: Element | undefined = element;
  while (current && svgTagName(current) !== 'svg') {
    const transform = current.getAttribute('transform');
    if (transform && transform.trim()) {
      return true;
    }
    current = current.parentElement ?? undefined;
  }

  return false;
}

// An SVG attribute's text, or undefined when the element doesn't carry it (the
// DOM's own answer for that is null).
export function svgAttribute(element: Element, name: string): string | undefined {
  return element.getAttribute(name) ?? undefined;
}

export function parseSvgViewBox(svg: Element, contours: Point[][]): SvgViewBox | undefined {
  const viewBoxValues = parseSvgNumberList(svgAttribute(svg, 'viewBox'));
  const [x, y, widthViewBox, heightViewBox] = viewBoxValues;
  if (
    x !== undefined &&
    y !== undefined &&
    widthViewBox !== undefined &&
    heightViewBox !== undefined &&
    viewBoxValues.length === 4 &&
    widthViewBox > 0 &&
    heightViewBox > 0
  ) {
    return { x, y, width: widthViewBox, height: heightViewBox };
  }

  const width = parseSvgNumber(svgAttribute(svg, 'width'));
  const height = parseSvgNumber(svgAttribute(svg, 'height'));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { x: 0, y: 0, width, height };
  }

  const points = contours.flat();
  if (!points.length) {
    return undefined;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  if (maxX <= minX || maxY <= minY) {
    return undefined;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function svgPointsAlmostEqual(left: Point, right: Point) {
  return Math.abs(left.x - right.x) < SVG_POINT_EPSILON && Math.abs(left.y - right.y) < SVG_POINT_EPSILON;
}

export function isSvgPointCollinear(first: Point, second: Point, third: Point) {
  const area = (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  return Math.abs(area) < SVG_POINT_EPSILON;
}

export function simplifySvgContour(points: readonly Point[]) {
  const withoutDuplicates = points.reduce<Point[]>((unique, point) => {
    const previous = unique[unique.length - 1];
    if (!previous || !svgPointsAlmostEqual(previous, point)) {
      unique.push(point);
    }
    return unique;
  }, []);

  const firstPoint = withoutDuplicates[0];
  const lastPoint = withoutDuplicates[withoutDuplicates.length - 1];
  if (firstPoint && lastPoint && withoutDuplicates.length > 1 && svgPointsAlmostEqual(firstPoint, lastPoint)) {
    withoutDuplicates.pop();
  }

  let simplified = withoutDuplicates;
  let changed = true;
  while (changed && simplified.length >= 3) {
    changed = false;
    simplified = simplified.filter((point, index, list) => {
      const previous = list[(index - 1 + list.length) % list.length];
      const next = list[(index + 1) % list.length];
      const keep = previous !== undefined && next !== undefined ? !isSvgPointCollinear(previous, point, next) : false;
      if (!keep) {
        changed = true;
      }
      return keep;
    });
  }

  return simplified.length >= 3 ? simplified : [];
}

export function parseSvgPoints(value: string | undefined) {
  const values = parseSvgNumberList(value);
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

  return simplifySvgContour(points);
}

export function parseClosedSvgPolyline(value: string | undefined) {
  const values = parseSvgNumberList(value);
  if (values.length < 8 || values.length % 2 !== 0) {
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
  if (!firstPoint || !lastPoint || !svgPointsAlmostEqual(firstPoint, lastPoint)) {
    return undefined;
  }

  return simplifySvgContour(points);
}

export function parseSvgRect(element: Element) {
  const rx = parseSvgNumber(svgAttribute(element, 'rx')) || 0;
  const ry = parseSvgNumber(svgAttribute(element, 'ry')) || 0;
  if (rx > 0 || ry > 0) {
    return undefined;
  }

  const x = parseSvgNumber(svgAttribute(element, 'x')) || 0;
  const y = parseSvgNumber(svgAttribute(element, 'y')) || 0;
  const width = parseSvgNumber(svgAttribute(element, 'width'));
  const height = parseSvgNumber(svgAttribute(element, 'height'));
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return [];
  }

  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function svgSubpathHasArea(subpath: SvgShapeSubpath) {
  const points = [subpath.start, ...subpath.commands.flatMap(svgShapeCommandPoints)];
  if (points.length < 3) {
    return false;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return maxX - minX > SVG_POINT_EPSILON && maxY - minY > SVG_POINT_EPSILON;
}

export function closeSvgSubpath(subpath: SvgShapeSubpath) {
  const lastCommand = subpath.commands[subpath.commands.length - 1];
  return lastCommand?.kind === 'close' ? subpath : { ...subpath, commands: [...subpath.commands, { kind: 'close' as const }] };
}
