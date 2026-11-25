import { assert } from '../../shared/core/assert';

// Geometry for a floating editor that the user moves by its header. The editor
// is placed by its own CSS (centred over the panel it belongs to); a drag only
// adds an offset on top of that placement, so the offset is all this tracks.

export interface FloatingOffset {
  readonly x: number;
  readonly y: number;
}
export interface FloatingBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface FloatingViewport {
  readonly width: number;
  readonly height: number;
}

export const FLOATING_OFFSET_NONE: FloatingOffset = { x: 0, y: 0 };
// The gap kept between a dragged editor and the window edge, matching the
// docked tool windows (windowGeometry.ts), so nothing can be dragged out of reach.
export const FLOATING_EDGE_PX = 8;
// A press on one of these inside the header is that control's, not a drag:
// the close button must still close and a field must still take focus.
export const FLOATING_DRAG_IGNORE_SELECTOR = 'button, input, select, textarea, a, [contenteditable], [role=button]';
// The header that moves its editor carries this attribute; everything else in
// the editor (a bezier graph's handles, a preset grid) keeps its own pointer use.
export const FLOATING_DRAG_HANDLE_ATTRIBUTE = 'data-floating-drag-handle';

/**
 * The offset to apply for a drag that wants `desired`, given the box as it is
 * measured now (at `current` offset). The box keeps `FLOATING_EDGE_PX` from every
 * window edge; a box larger than the window pins its top-left corner, because the
 * header that drags it lives there and must stay reachable.
 */
export function clampFloatingOffset(box: FloatingBox, current: FloatingOffset, desired: FloatingOffset, viewport: FloatingViewport): FloatingOffset {
  assert(Number.isFinite(viewport.width), 'Floating viewport width must be finite');
  assert(Number.isFinite(viewport.height), 'Floating viewport height must be finite');
  assert(box.width >= 0, 'Floating box width must not be negative');
  assert(box.height >= 0, 'Floating box height must not be negative');
  assert(Number.isFinite(desired.x), 'Floating horizontal offset must be finite');
  assert(Number.isFinite(desired.y), 'Floating vertical offset must be finite');
  // Where the box would sit with no offset at all: the placement its CSS gives it.
  const baseLeft = box.left - current.x;
  const baseTop = box.top - current.y;
  const x = clampAxis(baseLeft + desired.x, box.width, viewport.width) - baseLeft;
  const y = clampAxis(baseTop + desired.y, box.height, viewport.height) - baseTop;
  return { x: Math.round(x), y: Math.round(y) };
}

function clampAxis(start: number, size: number, room: number): number {
  const startMin = FLOATING_EDGE_PX;
  const startMax = room - size - FLOATING_EDGE_PX;
  if (startMin < startMax) {
    return Math.min(Math.max(start, startMin), startMax);
  }
  // Too big for the window: the leading edge, where the header is, stays in view.
  return startMin;
}
