import { useEffect, useRef, useState } from 'react'
import VariableConnect from '../VariableConnect'
import { handleArrowStep } from '../lib/number-step'
import { commitInPlace } from '../lib/commit-in-place'

// Two controls that turn up wherever a point on a box is being set: the gradient
// centre, a transform origin, a perspective origin. Shared so those stay the same
// control rather than three that drifted apart.

// 3×3 position picker: pick a corner/edge/center; the active cell is filled.
export function PositionGrid({ x, y, busy, ariaLabel = 'Position', onPick }: { x: string; y: string; busy: boolean; ariaLabel?: string; onPick: (px: string, py: string) => void }) {
  const cells = ['0%', '50%', '100%']
  const activeX = cells.indexOf(x)
  const activeY = cells.indexOf(y)
  return (
    <div className="embed-editor_grad-grid" role="group" aria-label={ariaLabel}>
      {cells.map((py, yi) => cells.map((px, xi) => {
        const active = xi === activeX && yi === activeY
        return (
          <button
            key={`${xi}-${yi}`}
            type="button"
            className={`embed-editor_grad-grid-cell ${active ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={`Position ${px} ${py}`}
            aria-pressed={active}
            onClick={() => onPick(px, py)}
          >
            <span className="embed-editor_grad-grid-dot" />
          </button>
        )
      }))}
    </div>
  )
}

// A number field with a unit suffix (used for Left/Top and a stop's position).
export function NumField({ value, unit, label, busy, prop = 'left', onLive, onCommit }: {
  value: string
  unit: string
  label: string
  busy: boolean
  /** Which property the variable picker offers bindings for. */
  prop?: string
  onLive: (v: string) => void
  onCommit: (v: string) => void
}) {
  const num = value.replace(/[a-z%]+$/i, '').trim()
  const [text, setText] = useState(num)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(num) }, [num])
  const withUnit = (t: string) => { const s = t.trim(); return s === '' ? '' : /[a-z%]$/i.test(s) ? s : `${s}${unit}` }
  return (
    <div className="embed-editor_grad-num">
      <VariableConnect code ariaLabel={`Connect ${label} to a variable`} disabled={busy} className="is-fill" prop={prop} onPick={(binding) => onCommit(binding)}>
        <input
          className="u-input embed-editor_grad-num-input"
          value={text}
          inputMode="decimal"
          spellCheck={false}
          disabled={busy}
          aria-label={label}
          onChange={(e) => { setText(e.target.value); onLive(withUnit(e.target.value)) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; onCommit(withUnit(text)) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
            const stepped = handleArrowStep(e)
            if (!stepped) return
            e.preventDefault()
            e.currentTarget.value = stepped.text
            e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
            setText(stepped.text)
            onLive(withUnit(stepped.text))
          }}
        />
      </VariableConnect>
      <span className="embed-editor_grad-num-unit">{unit}</span>
    </div>
  )
}
