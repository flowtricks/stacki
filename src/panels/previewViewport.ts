import { assert } from '../../shared/assert';

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

export function previewViewport(
  width: number | null | undefined,
  available: { readonly width: number; readonly height: number },
  height: number | null,
) {
  assert(Number.isFinite(available.width), 'Preview container width must be finite');
  assert(Number.isFinite(available.height), 'Preview container height must be finite');
  const fixed = width !== null && width !== undefined;
  const viewportWidth = fixed ? width : Math.max(1, available.width);
  assert(viewportWidth > 0, 'Preview width must be positive');
  const scale = fixed ? Math.min(1, Math.max(1, available.width - 24) / viewportWidth) : 1;
  // Scale the frame and its overlays together, retaining the requested CSS viewport
  // so media queries and viewport units use the simulated screen size.
  const viewportHeight = height ?? Math.max(1, available.height - (fixed ? 32 : 0)) / scale;
  return { width: viewportWidth, height: viewportHeight, scale };
}
