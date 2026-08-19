import { useLayoutEffect, useRef, useState } from 'react'

// The selected segment of a segmented bar, as one pill that slides to it rather
// than a background on each segment taking its turn. The same thing moving is
// one control answering; four things blinking in turn is four controls.
//
// Eight controls in this panel are the same bar — Display, Direction, Overflow,
// Position, Size's two, Borders, Typography's, the flex-child one — sharing the
// `embed-editor_display` track and `embed-editor_display-seg` buttons, and
// differing only in what their segments say and in how each decides which one
// is on. So this reads the selection off the class they all already set,
// instead of asking eight components to compute an index and thread refs to
// their buttons. The shared class IS the contract between them; anything that
// marks a segment selected gets the pill for free, including the ones whose
// rule is odd (a panel toggle, a "mixed" state).
//
// Drop it inside the track as the first child. It measures its own siblings.
export default function SegmentPill() {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<{ x: number; width: number } | null>(null)
  const [animated, setAnimated] = useState(false)

  useLayoutEffect(() => {
    const track = ref.current?.parentElement
    if (!track) return
    const watched = new ResizeObserver(() => measure())
    function measure() {
      const track2 = ref.current?.parentElement
      if (!track2) return
      const segs = [...track2.querySelectorAll<HTMLElement>('.embed-editor_display-seg')]
      // Re-observed on every measure: which buttons exist changes with the
      // control (a custom value shows none at all), and observe() on one
      // already watched is a no-op.
      for (const seg of segs) watched.observe(seg)
      const selected = segs.find((seg) => seg.classList.contains('is-selected'))
      // Layout offsets, not getBoundingClientRect: under a CSS `zoom` ancestor a
      // rect comes back in scaled coordinates while the inline px below is
      // re-zoomed, which doubles the scaling. Offsets are zoom-independent.
      setBox(selected ? { x: selected.offsetLeft, width: selected.offsetWidth } : null)
    }
    measure()
    // A click changes which button carries `is-selected`; a value arriving from
    // the page can change the buttons themselves.
    const marks = new MutationObserver(() => measure())
    marks.observe(track, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true })
    watched.observe(track)
    // Only after the first placement, so the pill doesn't fly in from the left
    // on mount.
    const frame = window.requestAnimationFrame(() => setAnimated(true))
    return () => {
      marks.disconnect()
      watched.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <span
      ref={ref}
      className={`embed-editor_display-indicator${animated ? ' is-animated' : ''}`}
      aria-hidden="true"
      style={box ? { transform: `translateX(${box.x}px)`, width: `${box.width}px` } : { opacity: 0 }}
    />
  )
}
