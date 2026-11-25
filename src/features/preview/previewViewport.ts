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

/** A fluid frame's CSS width, and its overlay layer's: both centred, so the outlines and guides sit exactly on the page. */
export const FLUID_FRAME_WIDTH = `calc(100% - ${FLUID_GUTTER_PX.side}px)`;

/** The widths a filling frame may draw the page at (Desktop's range). The all-breakpoints canvas has none. */
export interface FillBounds {
  /** Never narrower, while the pane itself is this wide: the gutters give way first, so the page stays in range. */
  readonly widthPxMin: number;
  /** Never wider: past it the frame is centred, still flush and unframed. */
  readonly widthPxMax: number | undefined;
}

export const FILL_UNBOUNDED: FillBounds = { widthPxMin: 0, widthPxMax: undefined };

/** The style of a filling frame and of its overlay layer: the same bounds as fluidFrameWidthPx, said in CSS, so a
 *  panel drag follows them before any measure. */
export function fluidFrameStyle(bounds: FillBounds): { readonly width: string; readonly minWidth?: string; readonly maxWidth?: string } {
  assert(bounds.widthPxMax === undefined || bounds.widthPxMax >= bounds.widthPxMin, 'fluidFrameStyle: the bounds are ordered');
  return {
    width: FLUID_FRAME_WIDTH,
    ...(bounds.widthPxMin > 0 ? { minWidth: `min(100%, ${bounds.widthPxMin}px)` } : {}),
    ...(bounds.widthPxMax === undefined ? {} : { maxWidth: `${bounds.widthPxMax}px` }),
  };
}

/** The width a fluid frame draws the page at in a pane this wide: the pane less its gutters, held within `bounds`
 *  as far as the pane allows; 0 for an unmeasured pane. */
export function fluidFrameWidthPx(paneWidthPx: number, bounds: FillBounds): number {
  assert(Number.isFinite(paneWidthPx), 'fluidFrameWidthPx: the pane width is finite');
  const guttered = Math.max(0, paneWidthPx - FLUID_GUTTER_PX.side);
  const floored = Math.max(guttered, Math.min(Math.max(0, paneWidthPx), bounds.widthPxMin));
  const widthPx = bounds.widthPxMax === undefined ? floored : Math.min(floored, bounds.widthPxMax);
  assert(widthPx <= Math.max(0, paneWidthPx), 'fluidFrameWidthPx: the frame never outgrows its pane');
  return widthPx;
}

export function previewViewport(
  width: number | undefined,
  available: { readonly width: number; readonly height: number },
  height: number | undefined,
  bounds: FillBounds = FILL_UNBOUNDED,
) {
  assert(Number.isFinite(available.width), 'Preview container width must be finite');
  assert(Number.isFinite(available.height), 'Preview container height must be finite');
  const fixed = width !== undefined;
  const viewportWidth = fixed ? width : Math.max(1, fluidFrameWidthPx(available.width, bounds));
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
