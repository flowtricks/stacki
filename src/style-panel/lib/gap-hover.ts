import { useEffect, useRef } from 'react'
import { getHost } from './host'

// Lighting up the gaps a field controls, while you point at it.
//
// Hovering `padding-top` already draws the strip of the element that padding
// holds open. Gap had nothing: the number changed and the only way to see what
// it had done was to look at the page and compare. But a gap is easier to show
// than padding, not harder — it is the space between things, and the canvas
// knows exactly where that is.
//
// Two fields in two files own gap (the layout section's and the grid one's),
// so the behaviour lives here rather than being written twice and drifting.
//
// Hover and focus both light it, and it goes out only when NEITHER holds: a
// field can be pointed at and typed into at once, and leaving on either one
// would take down an outline the other still wants.

export type GapAxis = 'row' | 'column'

export function useGapHover(axes: GapAxis[], value: string) {
  const hovering = useRef(false)
  const holding = useRef(false)
  // Read at the moment of reporting rather than captured, so a value typed
  // while the bands are up relabels them instead of showing what was there
  // when the pointer arrived.
  const latest = useRef(value)
  latest.current = value

  const show = (text?: string) => {
    const shown = (text ?? latest.current).trim() || '0'
    getHost().onSpacingHover?.({
      kind: 'gap',
      sides: axes,
      labels: Object.fromEntries(axes.map((a) => [a, shown])),
    })
  }

  const hide = () => {
    if (hovering.current || holding.current) return
    getHost().onSpacingHover?.(null)
  }

  // A field that unmounts while lit — the panel changing selection, the link
  // toggling one field into two — would otherwise leave its bands on the
  // canvas with nothing left to take them down.
  useEffect(
    () => () => {
      getHost().onSpacingHover?.(null)
    },
    []
  )

  return {
    /** Spread onto the input. */
    handlers: {
      onMouseEnter: () => {
        hovering.current = true
        show()
      },
      onMouseLeave: () => {
        hovering.current = false
        hide()
      },
    },
    /** Called alongside the field's own focus/blur/change work. */
    onFocus: () => {
      holding.current = true
      show()
    },
    onBlur: () => {
      holding.current = false
      hide()
    },
    /** Relabel while typing, but only if the bands are actually up. */
    onValue: (text: string) => {
      if (hovering.current || holding.current) show(text)
    },
  }
}
