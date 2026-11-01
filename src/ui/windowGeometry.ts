import { assert } from '../../shared/core/assert';

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}
export interface WindowRectangle extends WindowSize {
  readonly x: number;
  readonly y: number;
}
export const WINDOW_EDGES = ['n', 's', 'e', 'w', 'se', 'sw', 'ne', 'nw'] as const;
export type WindowEdge = (typeof WINDOW_EDGES)[number];
const TOP_PX = 42;
const MARGIN_PX = 8;

export function initialWindowRectangle(viewport: WindowSize, minimum: WindowSize): WindowRectangle {
  const width = Math.max(minimum.width, Math.min(1040, Math.round(viewport.width * 0.52)));
  const height = Math.max(minimum.height, Math.round(viewport.height * 0.78));
  return fitWindowRectangle(
    {
      x: Math.round((viewport.width - width) / 2),
      y: Math.round((viewport.height - height) / 2),
      width,
      height,
    },
    viewport,
    minimum,
  );
}

export function fitWindowRectangle(rectangle: WindowRectangle, viewport: WindowSize, minimum: WindowSize): WindowRectangle {
  assert(Number.isFinite(viewport.width), 'Window viewport width must be finite');
  assert(viewport.width > 0, 'Window viewport width must be positive');
  assert(Number.isFinite(viewport.height), 'Window viewport height must be finite');
  assert(viewport.height > 0, 'Window viewport height must be positive');
  const top = Math.min(TOP_PX, Math.max(0, viewport.height - MARGIN_PX - 36));
  const left = Math.min(MARGIN_PX, Math.max(0, viewport.width - 1));
  const available = {
    width: Math.max(1, viewport.width - left - MARGIN_PX),
    height: Math.max(1, viewport.height - top - MARGIN_PX),
  };
  const width = clamp(rectangle.width, Math.min(minimum.width, available.width), available.width);
  const height = clamp(rectangle.height, Math.min(minimum.height, available.height), available.height);
  return {
    x: clamp(rectangle.x, left, Math.max(left, viewport.width - width - MARGIN_PX)),
    y: clamp(rectangle.y, top, Math.max(top, viewport.height - height - MARGIN_PX)),
    width,
    height,
  };
}

export function resizeWindowRectangle(
  start: WindowRectangle,
  edge: WindowEdge,
  delta: { readonly x: number; readonly y: number },
  viewport: WindowSize,
  minimum: WindowSize,
): WindowRectangle {
  assert(Number.isFinite(delta.x), 'Window horizontal resize delta must be finite');
  assert(Number.isFinite(delta.y), 'Window vertical resize delta must be finite');
  const fitted = fitWindowRectangle(start, viewport, minimum);
  const widthMin = Math.min(minimum.width, fitted.width);
  const heightMin = Math.min(minimum.height, fitted.height);
  const right = fitted.x + fitted.width;
  const bottom = fitted.y + fitted.height;
  const x = edge.includes('w') ? clamp(fitted.x + delta.x, MARGIN_PX, right - widthMin) : fitted.x;
  const y = edge.includes('n') ? clamp(fitted.y + delta.y, fitted.y < TOP_PX ? 0 : TOP_PX, bottom - heightMin) : fitted.y;
  const width = edge.includes('e') ? clamp(fitted.width + delta.x, widthMin, viewport.width - fitted.x - MARGIN_PX) : right - x;
  const height = edge.includes('s') ? clamp(fitted.height + delta.y, heightMin, viewport.height - fitted.y - MARGIN_PX) : bottom - y;
  return fitWindowRectangle({ x, y, width, height }, viewport, minimum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, minimum), maximum));
}
