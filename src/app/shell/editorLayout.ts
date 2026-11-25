import { assert } from '../../../shared/core/assert';

// When the editor docks its side panels beside the canvas, and when it collapses them into
// overlays so the canvas takes the full width. Desktop owns the rule; Studio and the
// stacki.build demo read it through Studio's vendored copy of this file.
//
// The trigger is the width left for the canvas, not the window width. A window-width
// breakpoint ignores how wide the user dragged the panels: a 700px query kept an 825px
// window docked with a 260px Navigator and a 320px Style panel, which left a 375px canvas
// and a toolbar folded into its overflow menu.
export type EditorLayout = 'docked' | 'collapsed';

// Below 600px a desktop page is already drawn at a phone-like width and the canvas
// toolbar starts folding its controls into the overflow menu. 600px is still wider than
// a landscape phone (568px), so a page keeps a usable preview while the panels stay docked.
export const CANVAS_WIDTH_PX_MIN = 600;

// A collapsed editor docks again only once the canvas would get this much more than the
// minimum. Without the gap, a window held near the threshold, or a panel toggle that
// moves the canvas across it, would flip the layout back and forth on every pixel.
export const CANVAS_WIDTH_PX_HYSTERESIS = 48;

// Widths are CSS pixels; nothing an editor shows is wider than this.
const LAYOUT_WIDTH_PX_MAX = 100_000;

export interface EditorLayoutInput {
  readonly previous: EditorLayout;
  readonly viewportWidthPx: number;
  // The rail and every docked panel, at the widths the user set.
  readonly dockedWidthPx: number;
}

export function editorLayoutFor(input: EditorLayoutInput): EditorLayout {
  assertLayoutWidth(input.viewportWidthPx, 'Viewport width');
  assertLayoutWidth(input.dockedWidthPx, 'Docked panel width');
  const canvasWidthPx = input.viewportWidthPx - input.dockedWidthPx;
  switch (input.previous) {
    case 'docked':
      if (canvasWidthPx < CANVAS_WIDTH_PX_MIN) {
        return 'collapsed';
      }
      return 'docked';
    case 'collapsed':
      if (canvasWidthPx < CANVAS_WIDTH_PX_MIN + CANVAS_WIDTH_PX_HYSTERESIS) {
        return 'collapsed';
      }
      return 'docked';
    default: {
      const exhaustive: never = input.previous;
      throw new Error(`Assertion failed: unknown editor layout ${String(exhaustive)}`);
    }
  }
}

function assertLayoutWidth(widthPx: number, name: string): void {
  assert(Number.isFinite(widthPx), `${name} must be finite`);
  assert(widthPx >= 0, `${name} must not be negative`);
  assert(widthPx <= LAYOUT_WIDTH_PX_MAX, `${name} exceeds the layout limit`);
}
