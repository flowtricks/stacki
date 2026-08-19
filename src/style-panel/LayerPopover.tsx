import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { panelSpan } from './lib/panel-box'
import { inOwnedPopup } from './lib/popup-layer'

// A layer editor anchored directly below the row it edits (flips above when there's no
// room to drop down), spanning the panel's full width — measured, since the panel is a
// column of the window here rather than the whole of it. Portaled to <body> so it
// overlays everything, and rendered at the panel's own scale: it used to re-apply
// moden's compact 0.75 `zoom`, a wrapper this app doesn't render, which left every
// control in here a quarter smaller than the same control in the panel behind it.
// Closes on outside click / Escape / scroll; the anchor row is excluded from the
// outside-click so clicking it toggles the popover shut instead of instantly reopening.
export default function LayerPopover({ anchorEl, onClose, ariaLabel, children }: {
  anchorEl: HTMLElement
  onClose: () => void
  ariaLabel?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  // Whether the box has to be a scroll container. It is one so a tall layer
  // editor can't run off the screen — and a scroll container clips, which took
  // out the one thing in here that is *meant* to escape: a dropdown's menu. With
  // no room below (there rarely is, this far down the panel) the menu opens
  // upward, lands outside the box, and is clipped away — so the click that meant
  // to pick an option went through to the panel behind and read as a click
  // outside, closing the popover. These editors are three or four rows; the
  // scrolling is for a case that does not happen, and it stays available for the
  // case that does.
  const [scrolls, setScrolls] = useState(false)
  // Read once, at mount, so the popover has its real width for the very first
  // layout — the flip decision below measures a height that depends on it.
  const [span] = useState(() => panelSpan(anchorEl))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchorEl.getBoundingClientRect()
    const gap = 6
    const h = el.offsetHeight // rendered height (the zoomed content already collapsed it)
    const below = a.bottom + gap + h <= window.innerHeight
    setTop(below ? a.bottom + gap : Math.max(gap, a.top - gap - h))
  }, [anchorEl])

  // Measured rather than assumed, and re-measured when the content changes size
  // (a layer editor grows a row, a gradient editor opens): only a box that truly
  // outgrows the screen clips.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const measure = () => setScrolls(box.scrollHeight > window.innerHeight * 0.94)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  useEffect(() => {
    // The press that dismisses this popover is spent dismissing it. Without
    // that, clicking a control outside to get rid of the popover also pressed
    // the control: aiming at "Events: Auto" to close the transform editor set
    // pointer-events on the element. One press, one thing.
    const swallowNextClick = () => {
      const eat = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation() }
      document.addEventListener('click', eat, { capture: true, once: true })
      // A press that never becomes a click (a drag away, a right-click) must not
      // leave this armed for whatever is clicked next.
      window.setTimeout(() => document.removeEventListener('click', eat, true), 400)
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // A popup this one opened (the colour picker from a swatch in here) is drawn
      // through a portal, so `contains` says outside — see lib/popup-layer.
      if (inOwnedPopup(t, ref.current)) return
      if (ref.current?.contains(t) || anchorEl.contains(t)) return
      // The anchor row is excluded above: pressing it toggles the popover shut
      // through its own handler, which is a press meant for it.
      swallowNextClick()
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Closing on scroll is about the page moving out from under a popover that is
    // pinned to a rectangle it can no longer see. A list scrolling INSIDE it is
    // not that — and a dropdown scrolls itself the moment it opens, to bring the
    // selected option into view, which shut the editor as soon as you opened the
    // one control most of these editors lead with.
    const onScroll = (e: Event) => {
      const t = e.target
      if (t instanceof Node && ref.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true) }
  }, [onClose, anchorEl])
  return createPortal(
    <div
      ref={ref}
      className="embed-editor_layer-popover"
      role="dialog"
      aria-label={ariaLabel}
      style={{ position: 'fixed', left: span.left, width: span.width, top: top ?? 0, visibility: top == null ? 'hidden' : 'visible' }}
    >
      <div ref={boxRef} className={`embed-editor_layer-popover-box u-surface-surface${scrolls ? ' is-scrolling' : ''}`}>{children}</div>
    </div>,
    document.body,
  )
}
