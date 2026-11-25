// Where the panel ends.
//
// Popovers in this panel are absolutely positioned and right-anchored to their
// label, so a field in the left column pushes the menu's left edge past the
// panel edge. Every one of them clamps itself back inside — but they were
// written against moden, where `.app_body` is both the visible panel and the
// scroll container, and this app has neither: the panel is `.style-panel-host`
// wrapping `.embed-editor_root`, and that root is the scroller (overflow-y:
// auto, overflow-x: clip — see styles.css).
//
// Falling back to `document.documentElement` there was the bug: the menus were
// clamped to the WINDOW, so no shift was ever applied, and the panel's
// overflow-x clipped whatever hung past its edge.

import { assert } from '../../../../shared/core/assert';

/** The panel's visible box — what a popover must stay inside. */
export function panelBox(anchor: Element): HTMLElement | undefined {
  // `.app_body` first (moden), where `.embed-editor_root` is an inner box and
  // the wrong answer; `closest` on both at once would pick the nearer root.
  return anchor.closest<HTMLElement>('.app_body') ?? anchor.closest<HTMLElement>('.embed-editor_root') ?? undefined;
}

/** That box's rect, or the window when the panel isn't found. */
export function panelBounds(anchor: Element): DOMRect {
  const box = panelBox(anchor);
  return (box ?? document.documentElement).getBoundingClientRect();
}

/**
 * The horizontal span a body-portaled popup should occupy.
 *
 * Several of these popups were written as `left: 0; right: 0` — full window,
 * which in moden WAS the panel. Here the panel is a right-hand column, so they
 * have to measure it. An anchor inside another portal (a control in a modal)
 * has no panel ancestor to walk to; the host publishes the panel's box as CSS
 * variables for that case (see StylePanel.tsx).
 */
export function panelSpan(anchor: Element): { left: number; width: number } {
  const box = panelBox(anchor);
  if (box) {
    const bounds = box.getBoundingClientRect();
    return { left: bounds.left, width: bounds.width };
  }
  const root = getComputedStyle(document.documentElement);
  const left = parseFloat(root.getPropertyValue('--style-panel-left'));
  const width = parseFloat(root.getPropertyValue('--style-panel-width'));
  if (Number.isFinite(left) && Number.isFinite(width) && width > 0) {
    return { left, width };
  }
  return { left: 0, width: window.innerWidth };
}

/** The gap a menu keeps from each side of the panel. */
export const MENU_EDGE_MARGIN_PX = 8;

/**
 * Where a left-anchored menu goes so it sits whole inside the panel.
 *
 * The menu is capped at the panel's width less a margin on each side: a menu
 * wider than the panel was shifted until its right edge fit, which pushed its
 * left edge past the panel, and the panel's overflow clip cut its left padding
 * away (the search field and rows looked flush left while the right kept its
 * inset). With the cap, the right-edge shift can never push the left edge out;
 * the left check still runs, so an anchor left of the panel pulls the menu in.
 */
export function menuPlacement(input: {
  readonly anchorLeftPx: number;
  readonly menuWidthPx: number;
  readonly boundsLeftPx: number;
  readonly boundsRightPx: number;
}): { readonly shiftPx: number } {
  assert(Number.isFinite(input.anchorLeftPx), 'menuPlacement: the anchor has a position');
  assert(input.menuWidthPx >= 0, 'menuPlacement: a menu width is not negative');
  assert(input.boundsLeftPx <= input.boundsRightPx, 'menuPlacement: the panel has a width');
  const leftLimitPx = input.boundsLeftPx + MENU_EDGE_MARGIN_PX;
  const rightLimitPx = input.boundsRightPx - MENU_EDGE_MARGIN_PX;
  const naturalRightPx = input.anchorLeftPx + input.menuWidthPx;
  const pullLeftPx = naturalRightPx > rightLimitPx ? rightLimitPx - naturalRightPx : 0;
  // The left edge wins over the right: a clipped left side hides the search
  // field's start, a clipped right side only the end of a long label.
  const shiftPx = input.anchorLeftPx + pullLeftPx < leftLimitPx ? leftLimitPx - input.anchorLeftPx : pullLeftPx;
  assert(Number.isFinite(shiftPx), 'menuPlacement: the shift is a number');
  return { shiftPx };
}

/** The widest a menu may be and still keep the edge margin on both sides. */
export function menuWidthMaxPx(bounds: { readonly left: number; readonly right: number }): number {
  assert(bounds.left <= bounds.right, 'menuWidthMaxPx: the panel has a width');
  const widthPx = Math.max(0, bounds.right - bounds.left - 2 * MENU_EDGE_MARGIN_PX);
  assert(widthPx >= 0, 'menuWidthMaxPx: a width is not negative');
  return widthPx;
}
