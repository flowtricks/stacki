import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { panelBounds } from '../lib/panel-box'
import { useHoverTip } from './PropTip'
import type { ScrubHandlers } from './useScrub'

type Props = {
  children: ReactNode
  /** When true the label highlights (blue) and opens a reset menu on click. */
  active: boolean
  /** Clears the field. Called from the menu or an Option/Alt-click. */
  onReset: () => void
  /** Menu item text. Defaults to "Reset". */
  resetLabel?: string
  /** When true the label is inert (no menu, no reset) — e.g. during a save. */
  disabled?: boolean
  /** Native title tooltip for the label. */
  title?: string
  /** Optional content rendered inside the menu, below the reset item — e.g. a note
   *  naming the more specific selector that overrides this value. A function form
   *  receives a `close` callback so an action inside the note can dismiss the menu. */
  menuNote?: ReactNode | ((close: () => void) => ReactNode)
  /** Forwarded to the label so it can double as a drag handle (a drag suppresses
   *  the click, so mousedown-to-drag and click-to-open-menu coexist). */
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
  /** Pointer handlers from useScrub, making the label a drag handle for the number in
   *  the field it captions. Same coexistence rule as onMouseDown: a drag eats the click,
   *  a press that stays put still opens the reset menu. Inert while the field is empty —
   *  the dim caption doesn't take pointer events, and there'd be nothing to drag. */
  scrubProps?: ScrubHandlers
  className?: string
  /** Shown in a hover tooltip after a short delay, in every state (blue or dim) —
   *  the panel uses it to name the CSS property this label writes. When given, it
   *  replaces the native `title`, which becomes a note line inside the tooltip. */
  tooltip?: ReactNode
}

/**
 * A field caption that mirrors the clip-path label: dim when the field is empty,
 * a blue pill when it has a value. Clicking the active label opens a small menu
 * to reset the field; Option/Alt-clicking it resets immediately. Reusable across
 * tools for any "clearable" input.
 */
export default function FieldLabel({ children, active, onReset, resetLabel = 'Reset', disabled = false, title, menuNote, onMouseDown, scrubProps, className, tooltip }: Props) {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  // The hover tooltip anchors to whichever element this state renders (the dim
  // caption's span or the active pill's wrapper) and swallows the native `title`.
  const hoverTip = useHoverTip<HTMLSpanElement>(
    tooltip ? <>{tooltip}{title ? <div className="u-prop-tip-note">{title}</div> : null}</> : null,
  )
  const nativeTitle = tooltip ? undefined : title

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onDown = (event: globalThis.MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // If the field is cleared elsewhere, drop back to the plain caption.
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  // Once open, keep the menu inside the panel. The menu is right-anchored (right:0) to
  // the label, so its natural box is [labelRight - width, labelRight]; a left-column
  // label pushes the left edge off-screen. Derive the shift from the LABEL (stable) +
  // the menu's own width — NOT the just-mounted menu's rect, which measured wrong on the
  // first open (correcting only on a later re-measure). Applied imperatively so it's in
  // place before the first paint (no visible jump). Bounds = the app's scroll container
  // (the panel can be a sub-region of a much wider Designer window).
  useLayoutEffect(() => {
    const el = menuRef.current
    const root = rootRef.current
    if (!open || !el || !root) return
    const margin = 8
    const bounds = panelBounds(root)
    const rootRect = root.getBoundingClientRect()
    const naturalRight = rootRect.right
    const naturalLeft = rootRect.right - el.offsetWidth
    const leftLimit = bounds.left + margin
    const rightLimit = bounds.right - margin
    const next = naturalLeft < leftLimit ? leftLimit - naturalLeft
      : naturalRight > rightLimit ? rightLimit - naturalRight
        : 0
    el.style.transform = next ? `translateX(${next}px)` : ''
    // Vertical flip: if opening below would overflow the container's bottom and
    // there's more room above (a bottom-row label), open the menu above the label.
    const overflowsBelow = rootRect.bottom + el.offsetHeight + margin > bounds.bottom
    const spaceAbove = rootRect.top - bounds.top
    const spaceBelow = bounds.bottom - rootRect.bottom
    setDropUp(overflowsBelow && spaceAbove > spaceBelow)
  }, [open])

  if (!active) {
    return (
      // A dim caption is normally click-through (it can sit over the field it
      // labels); one with a tooltip takes pointer events so it can be hovered.
      // `scrubProps` is the drag that changes the value it labels.
      <span
        ref={hoverTip.ref}
        className={['u-field-label', tooltip ? 'is-hoverable' : '', className].filter(Boolean).join(' ')}
        title={nativeTitle}
        onMouseDown={onMouseDown}
        {...scrubProps}
        {...hoverTip.hoverProps}
      >
        {children}
        {hoverTip.tip}
      </span>
    )
  }

  const reset = () => {
    onReset()
    setOpen(false)
  }

  const onLabelClick = (event: MouseEvent<HTMLButtonElement>) => {
    // preventDefault so this works even when nested in a <label>.
    event.preventDefault()
    hoverTip.hide()
    if (disabled) return
    if (event.altKey) {
      reset()
      return
    }
    setOpen((value) => !value)
  }

  return (
    <span
      ref={(el) => { rootRef.current = el; hoverTip.ref.current = el }}
      className={['u-field-label-wrap', className].filter(Boolean).join(' ')}
      {...hoverTip.hoverProps}
    >
      <button
        type="button"
        className="u-field-label is-active"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={nativeTitle}
        onMouseDown={onMouseDown}
        {...scrubProps}
        onClick={onLabelClick}
      >
        {children}
      </button>
      {open ? (
        <div
          id={menuId}
          ref={menuRef}
          className={['u-field-label-menu', dropUp ? 'is-up' : ''].filter(Boolean).join(' ')}
          role="menu"
        >
          <button
            type="button"
            className="u-field-label-menu-item"
            role="menuitem"
            onClick={(event) => {
              // preventDefault so this works even when nested in a <label>.
              event.preventDefault()
              reset()
            }}
          >
            <svg className="u-field-label-menu-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.2 5.2H2.2V2.2" />
              <path d="M2.6 5.2A5.5 5.5 0 1 1 4 12.2" />
            </svg>
            <span>{resetLabel}</span>
            <span className="u-field-label-menu-shortcut">Option + click</span>
          </button>
          {menuNote ? (
            <div className="u-field-label-menu-note">
              {typeof menuNote === 'function' ? menuNote(() => setOpen(false)) : menuNote}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Portaled to <body>, so nesting it here costs nothing but keeps it with
          the element it's anchored to. */}
      {hoverTip.tip}
    </span>
  )
}
