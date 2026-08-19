import { useRef, useState } from 'react'
import ColorPicker from './ColorPicker'
import { useResolvedColor } from '../lib/computed-color'

// A clickable color swatch (checkerboard behind a transparent fill) that opens the
// color picker anchored under it. Drop-in for any color field: pass the current
// value and an onChange that routes live drags vs. committed changes.
export default function ColorSwatch({ value, busy, onChange, ariaLabel = 'Choose color' }: {
  value: string
  busy?: boolean
  onChange: (color: string, live: boolean) => void
  ariaLabel?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  // What the value looks like where it is used. A variable means nothing in
  // this panel's document — painted here it came out transparent — so a value
  // that leans on one is resolved by the page, against the selected element.
  // The picker still gets the raw value: editing works on the text.
  const fill = useResolvedColor(value)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="u-color-swatch"
        disabled={busy}
        aria-label={ariaLabel}
        onClick={() => setAnchor((a) => (a ? null : ref.current?.getBoundingClientRect() ?? null))}
      >
        <span className="u-color-swatch-fill" style={{ background: fill.trim() || 'transparent' }} />
      </button>
      {anchor ? (
        <ColorPicker value={value} anchor={anchor} trigger={ref.current} onChange={onChange} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  )
}
