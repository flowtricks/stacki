import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { panelSpan } from './lib/panel-box'

// A layer editor anchored directly below the row it edits (flips above when there's no
// room to drop down), spanning the panel's full width — measured, since the panel is a
// column of the window here rather than the whole of it. Portaled to <body> so it
// overlays everything — but the panel body renders at a 0.75 `zoom` (see
// .app_root.is-compact .app_body) which a body-portaled element escapes, so the content
// re-applies that zoom (via .embed-editor_layer-popover-box) to match the panel's scale.
// The outer wrapper is unzoomed so its fixed-position coordinates stay in real screen
// pixels. Closes on
// outside click / Escape / scroll; the anchor row is excluded from the outside-click so
// clicking it toggles the popover shut instead of instantly reopening.
export default function LayerPopover({ anchorEl, onClose, ariaLabel, children }: {
  anchorEl: HTMLElement
  onClose: () => void
  ariaLabel?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
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
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorEl.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onScroll = () => onClose()
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
      <div className="embed-editor_layer-popover-box u-surface-surface">{children}</div>
    </div>,
    document.body,
  )
}
