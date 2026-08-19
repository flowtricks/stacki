import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

export type SegmentedOption<T extends string> = {
  value: T
  label: ReactNode
  /** Accessible label when `label` is an icon or otherwise not descriptive text. */
  ariaLabel?: string
  /** Rich tooltip shown after a short hover (with a down-arrow to this segment). */
  tooltip?: ReactNode
}

const TOOLTIP_DELAY_MS = 500

type Props<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
  /** Extra class on the container — e.g. to constrain width in a toolbar. */
  className?: string
  /**
   * 'fill' (default) stretches every segment to equal width. 'hug' lets each
   * segment size to its own content and packs them to the start; the sliding
   * indicator then animates to the active segment's actual width.
   */
  widthMode?: 'fill' | 'hug'
  /** Dim and block interaction while still showing the current value — e.g. a
   *  source toggle on a selector that only the embed can style. */
  disabled?: boolean
}

/**
 * Segmented tab control with a sliding indicator (the Clip Path "Scale / Stretch"
 * toggle, extracted for reuse). The indicator is measured from the active button's
 * real geometry, so it lands correctly whether segments are equal-width ('fill')
 * or content-width ('hug'). Fills its container width; constrain via `className`.
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  widthMode = 'fill',
  disabled = false,
}: Props<T>) {
  // -1 when nothing matches (an unset control) → the indicator hides.
  const selectedIndex = options.findIndex((option) => option.value === value)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([])
  const [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null)
  const [animated, setAnimated] = useState(false)

  // Measure the active button and park the indicator over it. Re-runs on selection
  // change and observes both the track and the button so it keeps up with layout
  // shifts (container resize, font load, label change).
  useLayoutEffect(() => {
    const root = rootRef.current
    const button = selectedIndex >= 0 ? buttonsRef.current[selectedIndex] : null
    if (!root || !button) { setIndicator(null); return }
    // Use layout offsets (offsetLeft/Width), not getBoundingClientRect: under a CSS
    // `zoom` ancestor, rects come back in scaled coords but the inline px styles below
    // are re-zoomed, which double-scales the indicator. offsets are zoom-independent.
    const measure = () => {
      setIndicator({ x: button.offsetLeft, width: button.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(button)
    return () => observer.disconnect()
  }, [selectedIndex, options.length, widthMode])

  // Enable the slide transition only after the first placement, so the indicator
  // doesn't fly in from the origin on mount.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setAnimated(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  // Delayed hover tooltip: after TOOLTIP_DELAY_MS on a segment that has one, show it
  // as a popup (portaled to <body>, positioned above the segment) so it can't be
  // clipped by an ancestor's overflow and always lines up with the hovered button.
  const [hovered, setHovered] = useState<number | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = () => {
    if (hoverTimer.current != null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null }
  }
  useEffect(() => clearHoverTimer, [])
  const startHover = (index: number) => {
    if (!options[index]?.tooltip) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setHovered(index)
    }, TOOLTIP_DELAY_MS)
  }
  const endHover = () => { clearHoverTimer(); setHovered(null) }

  const hoveredButton = hovered != null ? buttonsRef.current[hovered] : null
  const activeTooltip = hovered != null ? options[hovered]?.tooltip : null

  return (
    <div
      ref={rootRef}
      className={['u-segmented', widthMode === 'hug' ? 'is-hug' : '', disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      <span
        className={`u-segmented-indicator${animated ? ' is-animated' : ''}`}
        aria-hidden="true"
        style={
          indicator
            ? { transform: `translateX(${indicator.x}px)`, width: `${indicator.width}px` }
            : { opacity: 0 }
        }
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => { buttonsRef.current[index] = el }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.ariaLabel}
          className={`u-segmented-button${option.value === value ? ' is-selected' : ''}`}
          disabled={disabled}
          onClick={() => { endHover(); onChange(option.value) }}
          onMouseEnter={() => startHover(index)}
          onMouseLeave={endHover}
        >
          {option.label}
        </button>
      ))}

      {activeTooltip && hoveredButton ? (
        <HoverTooltip anchor={hoveredButton}>{activeTooltip}</HoverTooltip>
      ) : null}
    </div>
  )
}

// The hover tooltip as a body-portaled popup: fixed-positioned, horizontally
// centered over the anchor element and placed above it (flipping below when there
// isn't room), with the arrow pointing at the anchor's center. Portaling escapes
// any `overflow: hidden` ancestor; re-measures on scroll/resize so it tracks the
// anchor. Measured hidden first, then revealed, so there's no first-paint jump.
// Exported for reuse by any control that wants the same rich hover tooltip.
export function HoverTooltip({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
  const [arrow, setArrow] = useState<{ left: number; above: boolean }>({ left: 0, above: true })

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!el) return
      const margin = 8
      const gap = 8
      const a = anchor.getBoundingClientRect()
      const { width, height } = el.getBoundingClientRect()
      const centerX = a.left + a.width / 2
      const left = Math.max(margin, Math.min(centerX - width / 2, window.innerWidth - margin - width))
      const fitsAbove = a.top - gap - height >= margin
      const top = fitsAbove ? a.top - gap - height : a.bottom + gap
      const arrowLeft = Math.max(12, Math.min(centerX - left, width - 12))
      setArrow({ left: arrowLeft, above: fitsAbove })
      setStyle({ position: 'fixed', top, left, visibility: 'visible' })
    }
    place()
    // Re-place whenever the tooltip's own size changes. A property tooltip grows a
    // line once the page answers what it computes for that property (see PropTip),
    // and a box placed ABOVE its anchor grows downward — over the very label it
    // describes — unless it's measured again.
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(() => place()) : null
    if (ref.current) ro?.observe(ref.current)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className={`u-segmented-popup ${arrow.above ? 'is-above' : 'is-below'}`}
      role="tooltip"
      style={{ ...style, '--tip-arrow-left': `${arrow.left}px` } as CSSProperties}
    >
      {children}
      <span className="u-segmented-popup-arrow" aria-hidden="true" />
    </div>,
    document.body,
  )
}
