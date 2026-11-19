import { assert } from '../../../shared/core/assert';

export const PREVIEW_WIDTH_LIMITS = { minimum: 280, maximum: 7_680 } as const;

export function parsePreviewWidth(input: string): number | undefined {
  if (!/^\d{3,4}$/.test(input.trim())) {
    return undefined;
  }
  const width = Number(input);
  if (width < PREVIEW_WIDTH_LIMITS.minimum || width > PREVIEW_WIDTH_LIMITS.maximum) {
    return undefined;
  }
  return width;
}

/**
 * How a fixed-width frame sits in the canvas. `framed` leaves a gutter around the page (the side handles live in it), as every
 * breakpoint narrower than the pane does. `flush` covers the whole canvas, the Desktop device: the page is scaled to the pane's
 * width, so it keeps its own width for media queries and no gutter is reserved.
 */
export type FrameFit = 'framed' | 'flush';

const FRAMED_GUTTER_PX = { side: 24, vertical: 32 } as const;

export function previewViewport(
  width: number | undefined,
  available: { readonly width: number; readonly height: number },
  height: number | undefined,
  fit: FrameFit,
) {
  assert(Number.isFinite(available.width), 'Preview container width must be finite');
  assert(Number.isFinite(available.height), 'Preview container height must be finite');
  const fixed = width !== undefined;
  const viewportWidth = fixed ? width : Math.max(1, available.width);
  assert(viewportWidth > 0, 'Preview width must be positive');
  const scale = fixed ? Math.min(1, Math.max(1, available.width - (fit === 'framed' ? FRAMED_GUTTER_PX.side : 0)) / viewportWidth) : 1;
  // Keep the requested CSS viewport for media queries and viewport units. The
  // iframe scales to fit; overlay geometry scales separately so its labels do not.
  const viewportHeight = height ?? Math.max(1, available.height - (fixed && fit === 'framed' ? FRAMED_GUTTER_PX.vertical : 0)) / scale;
  return { width: viewportWidth, height: viewportHeight, scale };
}

export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}
