import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HoverTooltip } from './SegmentedControl'
import { useComputedMeta } from '../lib/computed-style'

// The style panel's labels are friendly names ("Align", "Gap", "Y") for CSS
// properties. Hovering one for a beat shows which property (or properties) it
// writes — in every state, blue / orange / unset — so the mapping is discoverable
// without clicking. Shares the segmented control's body-portaled popup.

const TIP_DELAY_MS = 500

// What the page computes for one property, under its name. This is the value an
// unset control highlights, so seeing it here says where that highlight came from —
// and names the element it was read off when that isn't the one selected.
function OnThePage({ prop }: { prop: string }) {
  const { value, tag, mismatch } = useComputedMeta(prop)
  if (mismatch) return <div className="u-prop-tip-note">the page resolves this node to &lt;{tag}&gt; — ignoring its computed values</div>
  if (!value) return null
  return <div className="u-prop-tip-note">on the page: {value}{tag ? ` (<${tag}>)` : ''}</div>
}

/** The tooltip body: the CSS property names, plus an optional note beneath them. */
export function PropTip({ props, note }: { props: readonly string[]; note?: ReactNode }) {
  return (
    <>
      <span className="u-prop-tip">{props.join(', ')}</span>
      {props.map((prop) => <OnThePage key={prop} prop={prop} />)}
      {note ? <div className="u-prop-tip-note">{note}</div> : null}
    </>
  )
}

/**
 * Delayed hover tooltip for a single element. Spread `hoverProps` onto the element
 * and give it `ref`; render `tip` next to it (it portals to <body>, so it doesn't
 * matter where). `hide` dismisses it early — e.g. when a click opens a menu.
 */
export function useHoverTip<T extends HTMLElement>(content: ReactNode) {
  const ref = useRef<T | null>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])

  const hide = () => { cancel(); setOpen(false) }
  const hoverProps = content
    ? {
      onMouseEnter: () => { cancel(); timer.current = window.setTimeout(() => { timer.current = null; setOpen(true) }, TIP_DELAY_MS) },
      onMouseLeave: hide,
    }
    : {}

  // onMouseLeave alone leaves tooltips stranded. A label re-renders as a different
  // element while the pointer is over it (the dim caption and the blue pill are not
  // the same node), a menu opens on top of it, the panel scrolls under it, the window
  // loses focus — in each case no leave event ever reaches the element that opened
  // this, and the tooltip stays up. So while one is open, watch for the pointer being
  // anywhere but on the anchor (or the anchor being gone) and drop it.
  useEffect(() => {
    if (!open) return undefined
    const away = (event: Event) => {
      const el = ref.current
      if (!el || !el.isConnected || !el.contains(event.target as Node)) hide()
    }
    const close = () => hide()
    document.addEventListener('pointermove', away, true)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointermove', away, true)
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [open])

  return {
    ref,
    hoverProps,
    hide,
    tip: open && content && ref.current ? <HoverTooltip anchor={ref.current}>{content}</HoverTooltip> : null,
  }
}

/**
 * The orange label state: the property is set, but through a selector other than
 * the picked one — the button opens the provenance popover. Shared by every section
 * (Size, Typography, Borders, Background, Effects, Position, …) so they all get the
 * same hover tooltip naming the property.
 */
export function ProvenanceLabel({ label, props, className = 'embed-editor_size-label', busy, anchorProp, onProvenance, note = 'Set through another selector — click to see all' }: {
  label: ReactNode
  /** Properties this label covers — shown in the tooltip. */
  props: readonly string[]
  className?: string
  busy: boolean
  /** The property whose provenance the click opens (defaults to the first). */
  anchorProp?: string
  onProvenance: (prop: string, anchor: DOMRect) => void
  note?: ReactNode
}) {
  const { ref, hoverProps, hide, tip } = useHoverTip<HTMLButtonElement>(<PropTip props={props} note={note} />)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${className} embed-editor_prop-orange`}
        disabled={busy}
        {...hoverProps}
        onClick={(event) => { hide(); onProvenance(anchorProp ?? props[0], event.currentTarget.getBoundingClientRect()) }}
      >
        {label}
      </button>
      {tip}
    </>
  )
}
