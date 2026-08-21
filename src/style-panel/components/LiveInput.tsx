import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import VariableConnect from '../VariableConnect'
import { handleArrowStep } from '../lib/number-step'
import { commitInPlace } from '../lib/commit-in-place'

// The panel's value field.
//
// Every row that takes a typed value works the same way: it shows the value as
// code (so a `var(--x)` reads as one), writes as you type and again on blur,
// steps numbers with the arrow keys, and offers the variable picker for the
// property it edits. That behaviour was written out per section, and the copies
// drifted — the one in the position popup ended up on smaller type and tighter
// padding than the field two rows above it. This is the one of them.
//
// A field can carry a `suffix` (a unit that is part of the field rather than
// part of the value: `%`, `DEG`). The focus ring then belongs to the box around
// both, not to the input alone — a ring drawn around the input cuts the unit
// out of the field it belongs to.

export default function LiveInput({
  value, busy, readOnly = false, ariaLabel, placeholder, prop, suffix, min, wrapClassName = 'embed-editor_field',
  onLive, onCommit, onVariablePick,
}: {
  value: string
  busy: boolean
  readOnly?: boolean
  ariaLabel: string
  placeholder?: string
  /** The CSS property being edited — filters the variable picker (a colour
   *  property offers Color variables; a length offers sizes). */
  prop: string
  /** A unit shown inside the field, after the value (`%`, `deg`). */
  suffix?: ReactNode
  /** A floor the arrow keys stop at, for a property that refuses to go below it. */
  min?: number
  /** The box the field lives in — sections that lay their fields out differently
   *  pass their own. It owns the focus ring. */
  wrapClassName?: string
  onLive: (value: string) => void
  onCommit: (value: string) => void
  onVariablePick?: (binding: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancelLive = () => { if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null } }
  useEffect(() => cancelLive, [])
  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => { liveTimer.current = null; onLive(text) }, 100)
  }
  return (
    <div className={wrapClassName}>
      <VariableConnect code className="is-fill" ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop={prop} onPick={(binding) => (onVariablePick ?? onCommit)(binding)}>
        <input
          className="u-input embed-editor_size-input"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; cancelLive(); onCommit(draft) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { commitInPlace(event.currentTarget); return }
            const stepped = handleArrowStep(event, min)
            if (!stepped) return
            event.preventDefault()
            const el = event.currentTarget
            el.value = stepped.text
            el.setSelectionRange(stepped.caret, stepped.caret)
            setDraft(stepped.text)
            scheduleLive(stepped.text)
          }}
          disabled={busy}
          readOnly={readOnly}
          spellCheck={false}
          placeholder={placeholder ?? '0'}
          aria-label={ariaLabel}
        />
      </VariableConnect>
      {suffix != null ? <span className="embed-editor_field-suffix">{suffix}</span> : null}
    </div>
  )
}
