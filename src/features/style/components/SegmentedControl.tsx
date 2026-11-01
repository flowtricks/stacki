import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, MutableRefObject, ReactNode, RefObject } from 'react';

function tooltipStyle(style: CSSProperties, arrowLeft: number): CSSProperties & { readonly '--tip-arrow-left': string } {
  return { ...style, '--tip-arrow-left': `${arrowLeft}px` };
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Accessible label when `label` is an icon or otherwise not descriptive text. */
  ariaLabel?: string;
  /** Rich tooltip shown after a short hover (with a down-arrow to this segment). */
  tooltip?: ReactNode;
};

const TOOLTIP_DELAY_MS = 500;

type Props<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** Extra class on the container — e.g. to constrain width in a toolbar. */
  className?: string;
  /**
   * 'fill' (default) stretches every segment to equal width. 'hug' lets each
   * segment size to its own content and packs them to the start; the sliding
   * indicator then animates to the active segment's actual width.
   */
  widthMode?: 'fill' | 'hug';
  /** Dim and block interaction while still showing the current value — e.g. a
   *  source toggle on a selector that only the embed can style. */
  disabled?: boolean;
};

/**
 * Segmented tab control with a sliding indicator (the Clip Path "Scale / Stretch"
 * toggle, extracted for reuse). The indicator is measured from the active button's
 * real geometry, so it lands correctly whether segments are equal-width ('fill')
 * or content-width ('hug'). Fills its container width; constrain via `className`.
 */
export default function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, className, widthMode = 'fill', disabled = false }: Props<T>) {
  // -1 when nothing matches (an unset control) → the indicator hides.
  const selectedIndex = options.findIndex((option) => option.value === value);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | undefined>>([]);
  const { indicator, animated } = useSegmentIndicator({
    rootRef,
    buttonsRef,
    selectedIndex,
    optionCount: options.length,
    widthMode,
  });
  const { hovered, startHover, endHover } = useSegmentHover(options);
  const hoveredButton = hovered !== undefined ? buttonsRef.current[hovered] : undefined;
  const activeTooltip = hovered !== undefined ? options[hovered]?.tooltip : undefined;

  return (
    <div
      ref={rootRef}
      className={segmentedClass({ widthMode, disabled, className })}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      <span
        className={`u-segmented-indicator${animated ? ' is-animated' : ''}`}
        aria-hidden="true"
        style={indicator ? { transform: `translateX(${indicator.x}px)`, width: `${indicator.width}px` } : { opacity: 0 }}
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttonsRef.current[index] = element ?? undefined;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.ariaLabel}
          className={`u-segmented-button${option.value === value ? ' is-selected' : ''}`}
          disabled={disabled}
          onClick={() => {
            endHover();
            onChange(option.value);
          }}
          onMouseEnter={() => startHover(index)}
          onMouseLeave={endHover}
        >
          {option.label}
        </button>
      ))}

      {activeTooltip && hoveredButton ? <HoverTooltip anchor={hoveredButton}>{activeTooltip}</HoverTooltip> : undefined}
    </div>
  );
}

function segmentedClass({
  widthMode,
  disabled,
  className,
}: {
  readonly widthMode: 'fill' | 'hug';
  readonly disabled: boolean;
  readonly className: string | undefined;
}): string {
  return ['u-segmented', widthMode === 'hug' ? 'is-hug' : '', disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ');
}

type IndicatorInput = {
  readonly rootRef: RefObject<HTMLDivElement>;
  readonly buttonsRef: MutableRefObject<Array<HTMLButtonElement | undefined>>;
  readonly selectedIndex: number;
  readonly optionCount: number;
  readonly widthMode: 'fill' | 'hug';
};

// Measure the active button and park the indicator over it. Re-runs on selection
// change and observes both the track and the button so it keeps up with layout
// shifts (container resize, font load, label change).
function useSegmentIndicator({ rootRef, buttonsRef, selectedIndex, optionCount, widthMode }: IndicatorInput) {
  const [indicator, setIndicator] = useState<{ x: number; width: number } | undefined>(undefined);
  const [animated, setAnimated] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const button = selectedIndex >= 0 ? buttonsRef.current[selectedIndex] : undefined;
    if (!root || !button) {
      setIndicator(undefined);
      return;
    }
    // Use layout offsets (offsetLeft/Width), not getBoundingClientRect: under a CSS
    // `zoom` ancestor, rects come back in scaled coords but the inline px styles below
    // are re-zoomed, which double-scales the indicator. offsets are zoom-independent.
    const measure = () => {
      setIndicator({ x: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(button);
    return () => observer.disconnect();
  }, [rootRef, buttonsRef, selectedIndex, optionCount, widthMode]);

  // Enable the slide transition only after the first placement, so the indicator
  // doesn't fly in from the origin on mount.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setAnimated(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  return { indicator, animated };
}

// Delayed hover tooltip: after TOOLTIP_DELAY_MS on a segment that has one, show it
// as a popup (portaled to <body>, positioned above the segment) so it can't be
// clipped by an ancestor's overflow and always lines up with the hovered button.
function useSegmentHover<T extends string>(options: ReadonlyArray<SegmentedOption<T>>) {
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const hoverTimer = useRef<number | undefined>(undefined);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  }, []);
  useEffect(() => clearHoverTimer, [clearHoverTimer]);
  const startHover = (index: number) => {
    if (!options[index]?.tooltip) {
      return;
    }
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      setHovered(index);
    }, TOOLTIP_DELAY_MS);
  };
  const endHover = () => {
    clearHoverTimer();
    setHovered(undefined);
  };
  return { hovered, startHover, endHover };
}

// The hover tooltip as a body-portaled popup: fixed-positioned, horizontally
// centered over the anchor element and placed above it (flipping below when there
// isn't room), with the arrow pointing at the anchor's center. Portaling escapes
// any `overflow: hidden` ancestor; re-measures on scroll/resize so it tracks the
// anchor. Measured hidden first, then revealed, so there's no first-paint jump.
// Exported for reuse by any control that wants the same rich hover tooltip.
export function HoverTooltip({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: 0,
    left: 0,
    visibility: 'hidden',
  });
  const [arrow, setArrow] = useState<{ left: number; above: boolean }>({ left: 0, above: true });

  useLayoutEffect(() => {
    const place = () => {
      const element = ref.current;
      if (!element) {
        return;
      }
      const margin = 8;
      const gap = 8;
      const anchorRect = anchor.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const centerX = anchorRect.left + anchorRect.width / 2;
      const left = Math.max(margin, Math.min(centerX - width / 2, window.innerWidth - margin - width));
      const fitsAbove = anchorRect.top - gap - height >= margin;
      const top = fitsAbove ? anchorRect.top - gap - height : anchorRect.bottom + gap;
      const arrowLeft = Math.max(12, Math.min(centerX - left, width - 12));
      setArrow({ left: arrowLeft, above: fitsAbove });
      setStyle({ position: 'fixed', top, left, visibility: 'visible' });
    };
    place();
    // Re-place whenever the tooltip's own size changes. A property tooltip grows a
    // line once the page answers what it computes for that property (see PropTip),
    // and a box placed ABOVE its anchor grows downward — over the very label it
    // describes — unless it's measured again.
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(() => place()) : undefined;
    if (ref.current) {
      ro?.observe(ref.current);
    }
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={`u-segmented-popup ${arrow.above ? 'is-above' : 'is-below'}`} role="tooltip" style={tooltipStyle(style, arrow.left)}>
      {children}
      <span className="u-segmented-popup-arrow" aria-hidden="true" />
    </div>,
    document.body,
  );
}
