import { useEffect, useRef, useState } from 'react'
import DragSlider from './components/DragSlider'
import ColorSwatch from './components/ColorSwatch'
import useScrub from './components/useScrub'
import VariableConnect from './VariableConnect'
import { handleArrowStep } from './lib/number-step'

// Shared building blocks for the shadow editors (text-shadow + box-shadow): a labelled
// length row (drag slider + number field) and the full-width popup modal. Both editors
// compose these so the two controls behave identically — only their per-layer field set
// differs (box-shadow adds Type + Size).

// Coarse drag ranges for the shadow sliders (px); the number field always allows a
// precise value outside the range.
export const SHADOW_RANGE: Record<string, { min: number; max: number }> = {
  X: { min: -50, max: 50 },
  Y: { min: -50, max: 50 },
  Blur: { min: 0, max: 50 },
  Size: { min: -50, max: 50 },
}

// Split "2px" → { num: 2, unit: 'px' } (a bare number defaults to px); null when the
// value isn't a plain length (var()/calc()/…), so the slider is disabled.
export function parseLen(value: string): { num: number; unit: string } | null {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i)
  if (!match) return null
  return { num: parseFloat(match[1]), unit: match[2] || 'px' }
}

// A live text field for a shadow sub-value (length or color): live on type
// (debounced), commit on blur, arrow-step, and clear → a caller-defined value. Kept
// minimal — shadows never carry !important.
function ShadowTextInput({ value, busy, ariaLabel, placeholder, className, prop, onCommit, onLive, onClear }: {
  value: string
  busy: boolean
  ariaLabel: string
  placeholder: string
  className: string
  /** The CSS property this sub-value maps to — filters the variable picker
   *  (a length for X/Y/Blur/Size, `color` for the color row). */
  prop: string
  onCommit: (v: string) => void
  onLive: (v: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const liveNow = (text: string) => { const t = text.trim(); if (t) onLive(t) }
  const live = (text: string) => { cancel(); timer.current = window.setTimeout(() => liveNow(text), 100) }
  const commit = (text = draft) => { const t = text.trim(); if (!t) { onClear(); return } onCommit(t) }
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => { setDraft(text); commit(text) },
  })
  return (
    <VariableConnect ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} className="is-fill" prop={prop} onPick={(binding) => onCommit(binding)}>
      <input
        {...scrub.input}
        className={className}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; cancel(); commit() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); return }
          const stepped = handleArrowStep(e)
          if (!stepped) return
          e.preventDefault()
          e.currentTarget.value = stepped.text
          e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
          setDraft(stepped.text)
          live(stepped.text)
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </VariableConnect>
  )
}

// One shadow length (X / Y / Blur / Size): a draggable slider (coarse) beside a
// number field (precise). The slider drives the numeric part and re-attaches the
// value's unit; a non-length value keeps the field but disables the slider.
export function ShadowNum({ label, value, busy, onCommit, onLive, range, defaultUnit = 'px' }: {
  label: string
  value: string
  busy: boolean
  onCommit: (v: string) => void
  onLive: (v: string) => void
  /** Override the coarse slider range (defaults to the SHADOW_RANGE for `label`). */
  range?: { min: number; max: number }
  /** Unit shown/re-attached when there's no length yet, and on clear (defaults to px).
   *  The number field keeps whatever unit the value carries (em/rem/%/…). */
  defaultUnit?: string
}) {
  const parsed = parseLen(value)
  const r = range ?? SHADOW_RANGE[label] ?? { min: -50, max: 50 }
  const unit = parsed?.unit ?? defaultUnit
  // While the slider is dragged, show its live value in the number field (the model
  // `value` only catches up on commit). Cleared whenever `value` actually changes, so
  // after a commit the field falls back to the model with no flash.
  const [live, setLive] = useState<string | null>(null)
  useEffect(() => { setLive(null) }, [value])
  // A bare typed number gets the current/default unit ("150" → "150%", "5" → "5px");
  // a value that already carries a unit (em/rem/%/var()/…) passes through untouched.
  const withUnit = (v: string): string => (/^-?[\d.]+$/.test(v.trim()) ? `${v.trim()}${unit}` : v)
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">{label}</span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={parsed?.num ?? 0}
          min={r.min}
          max={r.max}
          disabled={busy || !parsed}
          ariaLabel={label}
          onPreview={(n) => setLive(`${n}${unit}`)}
          onInput={(n) => onLive(`${n}${unit}`)}
          onCommit={(n) => onCommit(`${n}${unit}`)}
        />
        <ShadowTextInput value={live ?? value} busy={busy} ariaLabel={label} placeholder={`0${defaultUnit}`} className="u-input embed-editor_size-input embed-editor_shadow-num" prop="width"
          onCommit={(v) => onCommit(withUnit(v))} onLive={(v) => onLive(withUnit(v))} onClear={() => onCommit(`0${defaultUnit}`)} />
      </div>
    </div>
  )
}

// The Color row shared by both shadow editors: a swatch beside a live text field.
export function ShadowColorRow({ color, busy, onChange }: {
  color: string
  busy: boolean
  onChange: (color: string, live: boolean) => void
}) {
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
      <div className="embed-editor_type-field">
        <ColorSwatch value={color} busy={busy} ariaLabel="Shadow color" onChange={(c, live) => onChange(c, live)} />
        <ShadowTextInput value={color} busy={busy} ariaLabel="Shadow color" placeholder="rgba(0, 0, 0, 0.2)" className="u-input embed-editor_size-input" prop="color"
          onCommit={(c) => onChange(c, false)} onLive={(c) => onChange(c, true)} onClear={() => onChange('', false)} />
      </div>
    </div>
  )
}
