// Between CSS units and canvas percent: a unit's pixels, a coordinate or an
// expression on the canvas and back, and where a raw shape's handles sit
// (ClipPath.tsx).

import {
  type Point,
  type CornerRadius,
  type InsetShape,
  type CssUnitValue,
  type CssCoordinateValue,
  type CssCoordinatePoint,
  type RawEditableClipPath,
  type HandleTarget,
} from './clipPathTypes';
import { CORNERS } from './clipPathConstants';
import { formatCssUnitValue, isCssUnitValue, insetBox } from './clipPathMeasure';
import { previewUnitPx, previewCssCoordinateToken } from './clipPathFormat';
import { formatCssCoordinateValueForPreview, expandCssUnitValues } from './clipPathPreview';

export function cssUnitPx(unit: string, axis: 'x' | 'y', canvas: HTMLElement) {
  const rect = canvas.getBoundingClientRect();
  return previewUnitPx(unit, axis, { width: rect.width, height: rect.height });
}

export function cssUnitValueToCanvasPercent(value: CssUnitValue, axis: 'x' | 'y', canvas: HTMLElement) {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  if (axisSize <= 0) {
    return value.value;
  }
  return ((value.value * cssUnitPx(value.unit, axis, canvas)) / axisSize) * 100;
}

export function canvasPercentToCssUnitValue(percent: number, axis: 'x' | 'y', unit: string, canvas: HTMLElement): CssUnitValue {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  const unitPx = cssUnitPx(unit, axis, canvas);
  const value = unitPx > 0 ? ((percent / 100) * axisSize) / unitPx : percent;
  return { value, unit };
}

export function cssUnitValueToken(value: CssUnitValue) {
  return formatCssUnitValue(value);
}

export function cssUnitCalculationToken(left: CssUnitValue, operator: '+' | '-', right: CssUnitValue) {
  return `calc(${cssUnitValueToken(left)} ${operator} ${cssUnitValueToken(right)})`;
}

export function insetRadiusToCanvas(shape: InsetShape, radius: CornerRadius): CornerRadius {
  const { width, height } = insetBox(shape);
  return {
    x: Math.max(0, (radius.x / 100) * width),
    y: Math.max(0, (radius.y / 100) * height),
  };
}

export function cssCoordinateExpressionToCanvasPercent(expression: string, axis: 'x' | 'y', canvas: HTMLElement) {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  if (axisSize <= 0 || typeof document === 'undefined') {
    return undefined;
  }

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.pointerEvents = 'none';
  probe.style.visibility = 'hidden';
  if (axis === 'x') {
    probe.style.left = previewCssCoordinateToken(expression, axis, {
      width: rect.width,
      height: rect.height,
    });
    probe.style.top = '0';
  } else {
    probe.style.left = '0';
    probe.style.top = previewCssCoordinateToken(expression, axis, {
      width: rect.width,
      height: rect.height,
    });
  }

  canvas.appendChild(probe);
  const probeRect = probe.getBoundingClientRect();
  probe.remove();

  const offset = axis === 'x' ? probeRect.left - rect.left : probeRect.top - rect.top;
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return (offset / axisSize) * 100;
}

export function cssCoordinateValueToCanvasPercent(value: CssCoordinateValue, axis: 'x' | 'y', canvas: HTMLElement) {
  return isCssUnitValue(value) ? cssUnitValueToCanvasPercent(value, axis, canvas) : cssCoordinateExpressionToCanvasPercent(value.expression, axis, canvas);
}

export function partialCssCoordinatePointToCanvasPoint(point: CssCoordinatePoint, canvas: HTMLElement): Point | undefined {
  const x = cssCoordinateValueToCanvasPercent(point.x, 'x', canvas);
  const y = cssCoordinateValueToCanvasPercent(point.y, 'y', canvas);
  if (x === undefined && y === undefined) {
    return undefined;
  }
  return {
    x: x ?? 0,
    y: y ?? 0,
  };
}

export function rawInsetBox(shape: Extract<RawEditableClipPath, { kind: 'inset' }>, canvas: HTMLElement) {
  const left = cssUnitValueToCanvasPercent(shape.left, 'x', canvas);
  const top = cssUnitValueToCanvasPercent(shape.top, 'y', canvas);
  const right = 100 - cssUnitValueToCanvasPercent(shape.right, 'x', canvas);
  const bottom = 100 - cssUnitValueToCanvasPercent(shape.bottom, 'y', canvas);
  return {
    x0: left,
    y0: top,
    x1: right,
    y1: bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function rawEditableHandlePoint(editable: RawEditableClipPath, handle: HandleTarget, canvas: HTMLElement): Point | undefined {
  if (handle.kind === 'polygon-point' && editable.kind === 'polygon') {
    const point = editable.points[handle.index];
    return point ? partialCssCoordinatePointToCanvasPoint(point, canvas) : undefined;
  }

  if (editable.kind === 'circle') {
    if (handle.kind === 'circle-center') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'circle-radius') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas) + cssUnitValueToCanvasPercent(editable.radius, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
  }

  if (editable.kind === 'ellipse') {
    if (handle.kind === 'ellipse-center') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'ellipse-rx') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas) + cssUnitValueToCanvasPercent(editable.rx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'ellipse-ry') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas) + cssUnitValueToCanvasPercent(editable.ry, 'y', canvas),
      };
    }
  }

  if (editable.kind !== 'inset') {
    return undefined;
  }
  return rawInsetHandlePoint(editable, handle, canvas);
}

// Where a raw inset's edge or corner-radius handle sits on the canvas.
export function rawInsetHandlePoint(editable: Extract<RawEditableClipPath, { kind: 'inset' }>, handle: HandleTarget, canvas: HTMLElement): Point | undefined {
  const box = rawInsetBox(editable, canvas);
  if (handle.kind === 'inset-top') {
    return { x: box.x0 + box.width / 2, y: box.y0 };
  }
  if (handle.kind === 'inset-right') {
    return { x: box.x1, y: box.y0 + box.height / 2 };
  }
  if (handle.kind === 'inset-bottom') {
    return { x: box.x0 + box.width / 2, y: box.y1 };
  }
  if (handle.kind === 'inset-left') {
    return { x: box.x0, y: box.y0 + box.height / 2 };
  }

  if (handle.kind === 'inset-radius' && editable.radii) {
    const horizontal = expandCssUnitValues(editable.radii.horizontal);
    const vertical = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
    const index = CORNERS.indexOf(handle.corner);
    const horizontalRadius = horizontal[index];
    const verticalRadius = vertical[index];
    if (!horizontalRadius || !verticalRadius) {
      return undefined;
    }
    const radiusX = cssUnitValueToCanvasPercent(horizontalRadius, 'x', canvas);
    const radiusY = cssUnitValueToCanvasPercent(verticalRadius, 'y', canvas);
    if (handle.corner === 'topLeft') {
      return { x: box.x0 + radiusX, y: box.y0 + radiusY };
    }
    if (handle.corner === 'topRight') {
      return { x: box.x1 - radiusX, y: box.y0 + radiusY };
    }
    if (handle.corner === 'bottomRight') {
      return { x: box.x1 - radiusX, y: box.y1 - radiusY };
    }
    return { x: box.x0 + radiusX, y: box.y1 - radiusY };
  }

  return undefined;
}

export function rawEditableHandleCssPoint(editable: RawEditableClipPath, handle: HandleTarget): { x: string; y: string } | undefined {
  if (handle.kind === 'polygon-point' && editable.kind === 'polygon') {
    const point = editable.points[handle.index];
    return point
      ? {
          x: formatCssCoordinateValueForPreview(point.x),
          y: formatCssCoordinateValueForPreview(point.y),
        }
      : undefined;
  }

  if (editable.kind === 'circle') {
    if (handle.kind === 'circle-center') {
      return { x: cssUnitValueToken(editable.cx), y: cssUnitValueToken(editable.cy) };
    }
    if (handle.kind === 'circle-radius') {
      return {
        x: cssUnitCalculationToken(editable.cx, '+', editable.radius),
        y: cssUnitValueToken(editable.cy),
      };
    }
  }

  if (editable.kind === 'ellipse') {
    if (handle.kind === 'ellipse-center') {
      return { x: cssUnitValueToken(editable.cx), y: cssUnitValueToken(editable.cy) };
    }
    if (handle.kind === 'ellipse-rx') {
      return {
        x: cssUnitCalculationToken(editable.cx, '+', editable.rx),
        y: cssUnitValueToken(editable.cy),
      };
    }
    if (handle.kind === 'ellipse-ry') {
      return {
        x: cssUnitValueToken(editable.cx),
        y: cssUnitCalculationToken(editable.cy, '+', editable.ry),
      };
    }
  }

  if (editable.kind !== 'inset') {
    return undefined;
  }
  return rawInsetHandleCssPoint(editable, handle);
}

// Where a raw inset's edge or corner-radius handle sits, as CSS the preview resolves.
export function rawInsetHandleCssPoint(editable: Extract<RawEditableClipPath, { kind: 'inset' }>, handle: HandleTarget): { x: string; y: string } | undefined {
  const left = cssUnitValueToken(editable.left);
  const top = cssUnitValueToken(editable.top);
  const right = `calc(100% - ${cssUnitValueToken(editable.right)})`;
  const bottom = `calc(100% - ${cssUnitValueToken(editable.bottom)})`;
  if (handle.kind === 'inset-top') {
    return { x: `calc((${left} + ${right}) / 2)`, y: top };
  }
  if (handle.kind === 'inset-right') {
    return { x: right, y: `calc((${top} + ${bottom}) / 2)` };
  }
  if (handle.kind === 'inset-bottom') {
    return { x: `calc((${left} + ${right}) / 2)`, y: bottom };
  }
  if (handle.kind === 'inset-left') {
    return { x: left, y: `calc((${top} + ${bottom}) / 2)` };
  }

  if (handle.kind === 'inset-radius' && editable.radii) {
    const horizontal = expandCssUnitValues(editable.radii.horizontal);
    const vertical = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
    const index = CORNERS.indexOf(handle.corner);
    const radiusX = horizontal[index];
    const radiusY = vertical[index];
    if (!radiusX || !radiusY) {
      return undefined;
    }
    if (handle.corner === 'topLeft') {
      return {
        x: cssUnitCalculationToken(editable.left, '+', radiusX),
        y: cssUnitCalculationToken(editable.top, '+', radiusY),
      };
    }
    if (handle.corner === 'topRight') {
      return {
        x: `calc(100% - ${cssUnitValueToken(editable.right)} - ${cssUnitValueToken(radiusX)})`,
        y: cssUnitCalculationToken(editable.top, '+', radiusY),
      };
    }
    if (handle.corner === 'bottomRight') {
      return {
        x: `calc(100% - ${cssUnitValueToken(editable.right)} - ${cssUnitValueToken(radiusX)})`,
        y: `calc(100% - ${cssUnitValueToken(editable.bottom)} - ${cssUnitValueToken(radiusY)})`,
      };
    }
    return {
      x: cssUnitCalculationToken(editable.left, '+', radiusX),
      y: `calc(100% - ${cssUnitValueToken(editable.bottom)} - ${cssUnitValueToken(radiusY)})`,
    };
  }

  return undefined;
}
