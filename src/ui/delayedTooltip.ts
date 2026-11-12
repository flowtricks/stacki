import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

// A tooltip that waits for a resting pointer, then sits centred under what it
// names. Drawn with `.rail-tooltip.below`, the app's dark tip with an arrow
// pointing up at the control. The wait keeps a pointer passing over a row of
// buttons from flashing a tip at every one of them.

// How long the pointer rests on a control before its tip appears.
export const TOOLTIP_DELAY_MS = 500;

// Where the tip's arrow sits: the horizontal centre of the control, just under it.
export interface TooltipPoint {
  readonly left: number;
  readonly top: number;
}

// Gap between the control's bottom edge and the tip's arrow.
const TOOLTIP_GAP_PX = 8;

export function useDelayedTooltip(): {
  readonly value: TooltipPoint | undefined;
  readonly show: (event: React.MouseEvent<HTMLElement>) => void;
  readonly hide: () => void;
} {
  const [value, setValue] = useState<TooltipPoint | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(tooltipPointBelow(rect)), TOOLTIP_DELAY_MS);
  }, []);
  const hide = useCallback((): void => {
    clearTimeout(timer.current);
    setValue(undefined);
  }, []);
  return { value, show, hide };
}

// The arrow's point for a tip under `rect`.
export function tooltipPointBelow(rect: Pick<DOMRect, 'left' | 'width' | 'bottom'>): TooltipPoint {
  return { left: rect.left + rect.width / 2, top: rect.bottom + TOOLTIP_GAP_PX };
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
