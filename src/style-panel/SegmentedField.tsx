import { useEffect, useRef, useState } from 'react'
import { useComputedChoice } from './lib/computed-style'
import type { ReactNode } from 'react'
import SegmentPill from './components/SegmentPill'

// A segmented button-list with a trailing dropdown arrow whose menu offers a
// "Custom" escape hatch (writes `unset` and reveals a focused text field), and —
// while custom — the built-in values to switch back. Mirrors DisplayControl's
// bar/menu/custom pattern (and reuses its CSS) so any button list gets the same
// custom affordance. Applying a value WRITES it (so the label stays blue) rather
// than clearing — clearing lives on the field label.

export type SegOption = { value: string; label: ReactNode; menuLabel: string; ariaLabel?: string }

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}
const joinImportant = (value: string, important: boolean) => (important ? `${value} !important` : value)

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MenuItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`} onClick={onClick}>
      {label}
    </button>
  )
}

// Editable text field for a custom value (defaults to `unset` when just entered).
function CustomField({ value, important, busy, inputRef, onCommit }: {
  value: string
  important: boolean
  busy: boolean
  inputRef: React.RefObject<HTMLInputElement>
  onCommit: (value: string, important: boolean) => void
}) {
  const [draft, setDraft] = useState(joinImportant(value, important))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(joinImportant(value, important)) }, [value, important])
  const commit = () => {
    const parsed = parseImportant(draft)
    if (parsed.value && (parsed.value !== value.trim() || parsed.important !== important)) onCommit(parsed.value, parsed.important)
  }
  return (
    <input
      ref={inputRef}
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={busy}
      spellCheck={false}
      aria-label="Value"
      placeholder="custom value"
    />
  )
}

export default function SegmentedField({ value, important, options, prop, fallback, busy, onCommit, ariaLabel }: {
  value: string
  important: boolean
  options: readonly SegOption[]
  /** The CSS property this bar edits — when nothing is authored, the page's own
   *  computed value is highlighted (inherited, a `*` rule, a UA default). */
  prop?: string
  /** Value selected/shown when the property is unset and the page can't be asked. */
  fallback: string
  busy: boolean
  onCommit: (value: string, important: boolean) => void
  ariaLabel?: string
}) {
  const current = value.trim().toLowerCase()
  const supported = new Set(options.map((o) => o.value))
  // The bar represents a listed value with no !important; anything else is custom.
  const customMode = !((supported.has(current) || !current) && !important)
  const computed = useComputedChoice(current || !prop ? '' : prop, options.map((o) => o.value))
  const active = current || computed || fallback

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Focus the field after switching to Custom, once its `unset` write settles.
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const pick = (next: string) => { setOpen(false); if (next !== current || important) onCommit(next, false) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; onCommit('unset', false) }

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={ariaLabel}>
      <SegmentPill />
      {customMode ? (
        <CustomField value={value} important={important} busy={busy} inputRef={inputRef} onCommit={onCommit} />
      ) : (
        options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active === o.value}
            aria-label={o.ariaLabel ?? o.menuLabel}
            className={`embed-editor_display-seg ${active === o.value ? 'is-selected' : ''}`}
            disabled={busy}
            onClick={() => pick(o.value)}
          >
            {o.label}
          </button>
        ))
      )}

      <button type="button" className="embed-editor_display-arrow" aria-haspopup="menu" aria-expanded={open} aria-label="More options" disabled={busy} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode ? (
            options.map((o) => <MenuItem key={o.value} label={o.menuLabel} selected={current === o.value} onClick={() => pick(o.value)} />)
          ) : (
            <MenuItem label="Custom" selected={false} onClick={enterCustom} />
          )}
        </div>
      ) : null}
    </div>
  )
}
