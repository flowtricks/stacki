import { useRef, useState } from 'react'
import ColorPicker from './ColorPicker'
import { useResolvedColor } from '../lib/computed-color'
import { useLiveColor } from '../lib/live-color'

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
  // The colour being dragged, not the one the model still holds: a drag writes
  // to the canvas and deliberately doesn't rebuild the panel's model, so `value`
  // only catches up on release — and the swatch is the thing that has to keep up
  // with the picker above it. Kept here so every colour field in the panel gets
  // it rather than each row remembering to (see live-color.ts).
  const [shown, noteLive] = useLiveColor(value)
  // What that value looks like where it is used. A variable means nothing in
  // this panel's document — painted here it came out transparent — so a value
  // that leans on one is resolved by the page, against the selected element.
  // The picker still gets the raw value: editing works on the text.
  const fill = useResolvedColor(shown)
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
        <ColorPicker
          value={value}
          anchor={anchor}
          trigger={ref.current}
          onChange={(color, live) => { noteLive(live ? color : null); onChange(color, live) }}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  )
}
