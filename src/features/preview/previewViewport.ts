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

// A fixed-width frame sits in the canvas with a gutter around it (the side handles live in it). A fluid frame (Desktop and the
// all-breakpoints canvas) has no width to give here: it covers the canvas edge to edge at the pane's own width, scale 1.
const FRAMED_GUTTER_PX = { side: 24, vertical: 32 } as const;

export function previewViewport(width: number | undefined, available: { readonly width: number; readonly height: number }, height: number | undefined) {
  assert(Number.isFinite(available.width), 'Preview container width must be finite');
  assert(Number.isFinite(available.height), 'Preview container height must be finite');
  const fixed = width !== undefined;
  const viewportWidth = fixed ? width : Math.max(1, available.width);
  assert(viewportWidth > 0, 'Preview width must be positive');
  const scale = fixed ? Math.min(1, Math.max(1, available.width - FRAMED_GUTTER_PX.side) / viewportWidth) : 1;
  // Keep the requested CSS viewport for media queries and viewport units. The
  // iframe scales to fit; overlay geometry scales separately so its labels do not.
  const viewportHeight = height ?? Math.max(1, available.height - (fixed ? FRAMED_GUTTER_PX.vertical : 0)) / scale;
  return { width: viewportWidth, height: viewportHeight, scale };
}

export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}
