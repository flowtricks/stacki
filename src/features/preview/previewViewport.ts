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
// all-breakpoints canvas) has no width to give here: it fills the pane's height and its width less a narrow gutter on each
// side, at scale 1. The right gutter holds the canvas's scrollbar (CanvasScrollbar.tsx), so the bar sits beside the page,
// never over it, as on a framed device; the left one keeps the frame centred.
const FRAMED_GUTTER_PX = { side: 24, vertical: 32 } as const;
export const FLUID_GUTTER_PX = { side: 18 } as const;

/** The width a fluid frame draws the page at in a pane this wide: the pane less its gutters, 0 for an unmeasured pane. */
export function fluidFrameWidthPx(paneWidthPx: number): number {
  assert(Number.isFinite(paneWidthPx), 'fluidFrameWidthPx: the pane width is finite');
  const widthPx = Math.max(0, paneWidthPx - FLUID_GUTTER_PX.side);
  assert(widthPx <= Math.max(0, paneWidthPx), 'fluidFrameWidthPx: the frame never outgrows its pane');
  return widthPx;
}

export function previewViewport(width: number | undefined, available: { readonly width: number; readonly height: number }, height: number | undefined) {
  assert(Number.isFinite(available.width), 'Preview container width must be finite');
  assert(Number.isFinite(available.height), 'Preview container height must be finite');
  const fixed = width !== undefined;
  const viewportWidth = fixed ? width : Math.max(1, fluidFrameWidthPx(available.width));
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
