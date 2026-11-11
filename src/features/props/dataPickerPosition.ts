import { assert } from '../../../shared/core/assert';
import { DATA_TREE_HEIGHT_PX_MAX, DATA_TREE_WIDTH_PX_MIN } from '../../ui/DataTree';
import type { FieldPosition } from './bindingTypes';

// Where the data picker opens under the field it was opened from. Every row
// carries a name and the value it holds side by side, so a picker as narrow as
// a sidebar field cuts both short; it is wider than the field and slides left
// as far as it must to stay inside the window, since fields sit in the right
// sidebar and a wider popup would otherwise run off the window's right edge.

// Every data tree's size (ui/DataTree.tsx), so the page template's sample tree opens as wide.
export const DATA_PICKER_WIDTH_PX_MIN = DATA_TREE_WIDTH_PX_MIN;
export const DATA_PICKER_HEIGHT_PX_MAX = DATA_TREE_HEIGHT_PX_MAX;
const VIEWPORT_GUTTER_PX = 8;
// The picker is never pushed higher than this, so it stays clear of the toolbar.
const TOP_PX_MIN = 60;

export interface AnchorBounds {
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
}
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export function dataPickerPosition(
  anchor: AnchorBounds,
  options: { readonly heightPxMax?: number; readonly widthPxMin?: number; readonly viewport?: ViewportSize } = {},
): Required<FieldPosition> {
  const viewport = options.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const heightPxMax = options.heightPxMax ?? DATA_PICKER_HEIGHT_PX_MAX;
  assert(Number.isFinite(anchor.left), 'dataPickerPosition: anchor left must be finite');
  assert(anchor.width >= 0, 'dataPickerPosition: anchor width must not be negative');
  assert(heightPxMax > 0, 'dataPickerPosition: height must be positive');
  const widthPxRoom = Math.max(0, viewport.width - VIEWPORT_GUTTER_PX * 2);
  const width = Math.min(Math.max(anchor.width, options.widthPxMin ?? DATA_PICKER_WIDTH_PX_MIN), widthPxRoom);
  const leftPxMax = viewport.width - VIEWPORT_GUTTER_PX - width;
  const left = Math.max(VIEWPORT_GUTTER_PX, Math.min(anchor.left, leftPxMax));
  // Below the field, or above it when the field sits near the bottom of the
  // window; the popup is fixed, so it would otherwise run off-screen.
  const top = Math.min(anchor.bottom + 4, Math.max(TOP_PX_MIN, viewport.height - heightPxMax));
  assert(width <= widthPxRoom, 'dataPickerPosition: picker wider than the window');
  return { left, top, width };
}
