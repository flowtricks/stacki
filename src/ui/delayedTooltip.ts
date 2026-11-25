import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { assert } from '../../shared/core/assert';

// A tooltip that waits for a resting pointer, then sits centred under what it
// names. Drawn with `.rail-tooltip.below`, the app's dark tip with an arrow
// pointing up at the control. The wait keeps a pointer passing over a row of
// buttons from flashing a tip at every one of them.

// How long the pointer rests on a control before its tip appears.
export const TOOLTIP_DELAY_MS = 500;

// The control a tip names: its box in viewport coordinates. The tip is placed (and kept inside the window) from this
// box once the tip's own size is measured (FittedTooltip), so every caller stores the control's box, not a point.
export type TooltipAnchor = Pick<DOMRect, 'left' | 'width' | 'top' | 'bottom'>;

// Gap between the control's edge and the tip's arrow.
const TOOLTIP_GAP_PX = 8;
// The same gap for a tip beside its control (the rail's labels), where the arrow sticks out a little further.
const TOOLTIP_SIDE_GAP_PX = 10;

export function useDelayedTooltip(): {
  readonly value: TooltipAnchor | undefined;
  readonly show: (event: React.MouseEvent<HTMLElement>) => void;
  readonly hide: () => void;
} {
  const [value, setValue] = useState<TooltipAnchor | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(tooltipAnchor(rect)), TOOLTIP_DELAY_MS);
  }, []);
  const hide = useCallback((): void => {
    clearTimeout(timer.current);
    setValue(undefined);
  }, []);
  return { value, show, hide };
}

/**
 * Where a tip is drawn for the control `from`. A modal dialog sits in the browser's top layer, which paints above
 * every element outside it whatever its z-index, so a tip appended to the body is hidden behind Settings and every
 * other modal. Inside an open dialog the tip is a child of that dialog instead (Popup does the same for menus). Its
 * position is `fixed`, and the dialog has no transform, so the viewport coordinates the hooks compute still hold.
 */
export function tooltipHost(from: Element | undefined): HTMLElement {
  return from?.closest<HTMLElement>('dialog[open]') ?? document.body;
}

// The part of a control's box a tip needs.
export function tooltipAnchor(rect: TooltipAnchor): TooltipAnchor {
  return { left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom };
}

/**
 * The same wait, for a tip that is not drawn under its control: `place` turns the resting element into
 * whatever the tip needs to be drawn (a side and a point, for the menu's info mark). `showNow` is for
 * keyboard focus, which needs no wait.
 */
export function useDelayedPlacement<T>(place: (element: HTMLElement) => T): {
  readonly value: T | undefined;
  readonly show: (element: HTMLElement) => void;
  readonly showNow: (element: HTMLElement) => void;
  readonly hide: () => void;
} {
  const [value, setValue] = useState<T | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(
    (element: HTMLElement): void => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setValue(place(element)), TOOLTIP_DELAY_MS);
    },
    [place],
  );
  const showNow = useCallback(
    (element: HTMLElement): void => {
      clearTimeout(timer.current);
      setValue(place(element));
    },
    [place],
  );
  const hide = useCallback((): void => {
    clearTimeout(timer.current);
    setValue(undefined);
  }, []);
  return { value, show, showNow, hide };
}

// The space a fitted tip keeps between itself and the window's edge, so it never touches or crosses it.
export const TOOLTIP_EDGE_MARGIN_PX = 8;

// The arrow stays this far from the tip's rounded corners, so it never sits on the curve.
const TOOLTIP_ARROW_INSET_PX = 14;

export type TooltipSide = 'below' | 'above' | 'right' | 'left';

export interface TooltipFitInput {
  readonly anchor: TooltipAnchor;
  readonly tip: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  // The side tried first; the opposite side is used only when the preferred one does not fit and the opposite has more room.
  readonly preferred: TooltipSide;
}

export interface TooltipFit {
  readonly side: TooltipSide;
  // The tip's physical left and top edges in viewport coordinates (physical, so right-to-left needs no mirroring).
  readonly left: number;
  readonly top: number;
  // Where the arrow sits along the tip's edge that faces the control, measured from the tip's left edge (below, above)
  // or its top edge (right, left). It follows the control's centre after the tip is shifted to stay inside the window.
  readonly arrowOffset: number;
}

/**
 * Where a tip of a known size goes so it stays inside the window: the one placement every tooltip shares. On its
 * preferred side it is centred on the control along the other axis, then shifted until both edges clear the margin;
 * when the preferred side lacks room and the opposite has more, it flips. Why measured and not CSS-only: a tip's
 * size depends on its text, so only a measured size can be clamped. A centred `translateX(-50%)` tip in a narrow
 * left panel ran off the window's left edge, and a tip under a control at the bottom was cut off by the window.
 */
export function fitTooltip(input: TooltipFitInput): TooltipFit {
  const { anchor, tip, viewport, preferred } = input;
  assert(tip.width >= 0, 'fitTooltip: the tip width is not negative');
  assert(tip.height >= 0, 'fitTooltip: the tip height is not negative');
  assert(viewport.width > 0, 'fitTooltip: the viewport has a width');
  assert(viewport.height > 0, 'fitTooltip: the viewport has a height');
  const vertical = preferred === 'below' || preferred === 'above';
  if (vertical) {
    const spaceBelow = viewport.height - anchor.bottom - TOOLTIP_GAP_PX - TOOLTIP_EDGE_MARGIN_PX;
    const spaceAbove = anchor.top - TOOLTIP_GAP_PX - TOOLTIP_EDGE_MARGIN_PX;
    const side = chooseSide(preferred, 'below', 'above', tip.height, spaceBelow, spaceAbove);
    const along = centredWithin(anchor.left + anchor.width / 2, tip.width, viewport.width);
    const top = side === 'below' ? anchor.bottom + TOOLTIP_GAP_PX : anchor.top - TOOLTIP_GAP_PX - tip.height;
    return { side, left: along.start, top, arrowOffset: along.arrow };
  }
  const spaceRight = viewport.width - anchor.left - anchor.width - TOOLTIP_SIDE_GAP_PX - TOOLTIP_EDGE_MARGIN_PX;
  const spaceLeft = anchor.left - TOOLTIP_SIDE_GAP_PX - TOOLTIP_EDGE_MARGIN_PX;
  const side = chooseSide(preferred, 'right', 'left', tip.width, spaceRight, spaceLeft);
  const along = centredWithin((anchor.top + anchor.bottom) / 2, tip.height, viewport.height);
  const left = side === 'right' ? anchor.left + anchor.width + TOOLTIP_SIDE_GAP_PX : anchor.left - TOOLTIP_SIDE_GAP_PX - tip.width;
  return { side, left, top: along.start, arrowOffset: along.arrow };
}

// The preferred side when the tip fits there, else the opposite one when it has more room, else the preferred side.
function chooseSide<T extends TooltipSide>(preferred: TooltipSide, first: T, second: T, size: number, spaceFirst: number, spaceSecond: number): T {
  const preferredSpace = preferred === first ? spaceFirst : spaceSecond;
  const otherSpace = preferred === first ? spaceSecond : spaceFirst;
  const other = preferred === first ? second : first;
  const own = preferred === first ? first : second;
  if (size <= preferredSpace) {
    return own;
  }
  return otherSpace > preferredSpace ? other : own;
}

// A span of `size` centred on `centre`, shifted to keep the margin inside `extent`; and where the arrow then sits in it.
// A span longer than the window keeps its start edge at the margin, which is where reading begins.
function centredWithin(centre: number, size: number, extent: number): { readonly start: number; readonly arrow: number } {
  const margin = TOOLTIP_EDGE_MARGIN_PX;
  const startMax = extent - margin - size;
  const start = startMax < margin ? margin : Math.min(Math.max(centre - size / 2, margin), startMax);
  const arrowMax = Math.max(size - TOOLTIP_ARROW_INSET_PX, TOOLTIP_ARROW_INSET_PX);
  return { start, arrow: Math.min(Math.max(centre - start, TOOLTIP_ARROW_INSET_PX), arrowMax) };
}
