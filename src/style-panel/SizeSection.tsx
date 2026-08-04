import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import FieldLabel from './components/FieldLabel'
import { type SegmentedOption, HoverTooltip } from './components/SegmentedControl'
import Select, { type SelectOption } from './components/Select'
import useScrub, { type ScrubHandlers } from './components/useScrub'
import { handleArrowStep } from './lib/number-step'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import type { Contributor, ResolvedProp } from './lib/resolved'
import { splitTopLevelSpaces } from './lib/background'

// The Size section of the style panel. Every control is always rendered (Webflow
// parity), driven by the resolved model: a property is blue when the picked
// selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type
// (liveSetProp) and run the authoritative commit on blur. All writes target the
// picked selector (creating its rule on first edit, handled by the parent).

type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type LiveSetProp = (prop: string, value: string | null, important: boolean) => void
type Read = (prop: string) => ResolvedProp | undefined

type Props = {
  read: Read
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  /** Switch the panel's pick to the given selector (click the override note tag). */
  onSelectSelector: (selector: string, prop?: string) => void
}

type Display = { present: boolean; isSelected: boolean; overridden: boolean; winnerSelector: string; value: string; important: boolean }

function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) return { present: false, isSelected: false, overridden: false, winnerSelector: '', value: '', important: false }
  const isSelected = resolved.source === 'selected'
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return {
    present: true,
    isSelected,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
    value: source.value,
    important: source.important,
  }
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

// A size control's label: blue (picked selector sets it) → FieldLabel with a
// clear menu; orange (another selector) → a button opening provenance; unset →
// a dim caption. When the picked selector sets it but a more specific selector
// wins, the label goes red + struck through and its menu names the winner.
function SizeLabel({ label, prop, d, contributors, busy, scrubProps, onClear, onProvenance, onSelectSelector }: {
  label: string
  prop: string
  d: Display
  contributors: Contributor[]
  busy: boolean
  scrubProps?: ScrubHandlers
  onClear: () => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  if (d.present && !d.isSelected) {
    return (
      <button
        type="button"
        className="embed-editor_size-label embed-editor_prop-orange"
        disabled={busy}
        title="Set through another selector — click to see all"
        onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}
      >
        {label}
      </button>
    )
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${d.overridden ? 'is-overridden' : ''}`}
      active={d.isSelected}
      disabled={busy}
      onReset={onClear}
      resetLabel="Clear"
      title={d.overridden ? `Overridden by ${d.winnerSelector}` : undefined}
      menuNote={(close) => <ProvenanceList contributors={contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
      scrubProps={scrubProps}
    >
      {label}
    </FieldLabel>
  )
}

// ─────────────────── Live text field (plain input) ───────────────────

function LivePropField({ prop, label, placeholder, read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  prop: string
  label: string
  placeholder: string
} & Props) {
  const d = displayOf(read(prop))
  const external = d.present ? (d.important ? `${d.value} !important` : d.value) : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)

  useEffect(() => { if (!focused.current) setDraft(external) }, [external])

  const cancelLive = () => {
    if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null }
  }
  useEffect(() => cancelLive, [])

  // Undelayed live write for the scrub, which does its own throttling — a debounce reset
  // by every mouse move would never fire mid-drag.
  const liveNow = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const parsed = parseImportant(trimmed)
    liveSetProp(prop, parsed.value, parsed.important)
  }

  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => { liveTimer.current = null; liveNow(text) }, 100)
  }

  const commit = (text = draft) => {
    const trimmed = text.trim()
    if (!trimmed) { clearProp(prop); return }
    const parsed = parseImportant(trimmed)
    setProp(prop, parsed.value, parsed.important)
  }

  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => { setDraft(text); commit(text) },
  })

  return (
    <>
      <SizeLabel label={label} prop={prop} d={d} contributors={read(prop)?.contributors ?? []} busy={busy} scrubProps={scrub.label} onClear={() => clearProp(prop)} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      <VariableConnect ariaLabel={`Connect ${label} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        data-prop={prop}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; cancelLive(); commit() }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.currentTarget.blur(); return }
          const stepped = handleArrowStep(event)
          if (!stepped) return
          event.preventDefault()
          const el = event.currentTarget
          el.value = stepped.text
          el.setSelectionRange(stepped.caret, stepped.caret)
          setDraft(stepped.text)
          scheduleLive(stepped.text)
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
      </VariableConnect>
    </>
  )
}

const LENGTH_FIELDS: ReadonlyArray<{ prop: string; label: string; placeholder: string }> = [
  { prop: 'width', label: 'Width', placeholder: 'Auto' },
  { prop: 'height', label: 'Height', placeholder: 'Auto' },
  { prop: 'min-width', label: 'Min W', placeholder: '0px' },
  { prop: 'min-height', label: 'Min H', placeholder: '0px' },
  { prop: 'max-width', label: 'Max W', placeholder: 'None' },
  { prop: 'max-height', label: 'Max H', placeholder: 'None' },
]

// ─────────────────────────── Overflow ───────────────────────────

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function ShowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 9.5C8.82843 9.5 9.5 8.82843 9.5 8C9.5 7.17157 8.82843 6.5 8 6.5C7.17157 6.5 6.5 7.17157 6.5 8C6.5 8.82843 7.17157 9.5 8 9.5Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M8.00004 4C5.37598 4 3.11613 5.55492 2.08964 7.79148C2.02887 7.92388 2.02888 8.07621 2.08965 8.20861C3.11615 10.4451 5.37597 12 8.00001 12C10.6241 12 12.8839 10.4451 13.9104 8.20852C13.9712 8.07612 13.9712 7.92379 13.9104 7.79139C12.8839 5.55488 10.6241 4 8.00004 4ZM8.00001 11C5.86346 11 4.01048 9.78173 3.09961 8.00004C4.01047 6.21831 5.86347 5 8.00004 5C10.1366 5 11.9896 6.21827 12.9004 7.99996C11.9896 9.78169 10.1366 11 8.00001 11Z" fill="currentColor" />
    </svg>
  )
}
function HideIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M10.705 11.4122L13.6465 14.3536L14.3536 13.6465L2.35356 1.64648L1.64645 2.35359L4.3881 5.09524C3.39355 5.76124 2.5932 6.69436 2.08965 7.79152C2.02888 7.92392 2.02888 8.07624 2.08965 8.20865C3.11616 10.4452 5.37598 12 8.00001 12C8.9654 12 9.8815 11.7896 10.705 11.4122ZM9.94073 10.6479L5.11152 5.81865C4.25765 6.3466 3.55888 7.10172 3.09962 8.00007C4.01049 9.78177 5.86347 11 8.00001 11C8.68308 11 9.33716 10.8755 9.94073 10.6479Z" fill="currentColor" />
      <path d="M13.9104 8.20856C13.5777 8.93353 13.1154 9.58688 12.5531 10.1389L11.846 9.43184C12.2702 9.01685 12.6276 8.5337 12.9004 8C11.9896 6.21831 10.1366 5.00004 8.00005 5.00004C7.81174 5.00004 7.62562 5.0095 7.44217 5.02798L6.57167 4.15749C7.03127 4.05443 7.50929 4.00004 8.00005 4.00004C10.6241 4.00004 12.8839 5.55491 13.9104 7.79143C13.9712 7.92383 13.9712 8.07616 13.9104 8.20856Z" fill="currentColor" />
    </svg>
  )
}
function CropIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 12C12.5523 12 13 11.5523 13 11V5H15.5V4H13V1.5H12V4H5C4.44772 4 4 4.44772 4 5V11H1.5V12H4V14.5H5V12H12ZM5 11H12V5H5V11Z" fill="currentColor" />
    </svg>
  )
}
function ScrollIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.3" d="M3 3H8V11H3V3Z" fill="currentColor" />
      <g opacity="0.67">
        <path d="M1 2H15V3L1 3V2Z" fill="currentColor" />
        <path d="M1 11H8V12H1V11Z" fill="currentColor" />
        <path d="M12 11.2929L10.3536 9.64645L9.64645 10.3536L12.5 13.2071L15.3536 10.3536L14.6464 9.64645L13 11.2929V5H12V11.2929Z" fill="currentColor" />
      </g>
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

// Icon segments matching Webflow's overflow control (Auto is text). Reuses the
// display control's segmented-bar CSS.
const OVERFLOW_SEGS: ReadonlyArray<{ value: string; icon?: ReactNode; label: string }> = [
  { value: 'visible', icon: <ShowIcon />, label: 'Visible' },
  { value: 'hidden', icon: <HideIcon />, label: 'Hidden' },
  { value: 'clip', icon: <CropIcon />, label: 'Clip' },
  { value: 'scroll', icon: <ScrollIcon />, label: 'Scroll' },
  { value: 'auto', label: 'Auto' },
]
const OVERFLOW_SUPPORTED = new Set(OVERFLOW_SEGS.map((seg) => seg.value))

// Editable free-value field (unset, var(), …) shown in the overflow bar's custom mode.
function OverflowCustomInput({ value, busy, inputRef, onCommit, onLiveCommit, onClear, ariaLabel = 'Overflow value', placeholder = 'custom value' }: {
  value: string
  busy: boolean
  inputRef: React.RefObject<HTMLInputElement>
  onCommit: (value: string, important: boolean) => void
  onLiveCommit: (value: string, important: boolean) => void
  onClear: () => void
  ariaLabel?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancelLive = () => { if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null } }
  useEffect(() => cancelLive, [])
  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      const trimmed = text.trim()
      if (!trimmed) return
      const parsed = parseImportant(trimmed)
      onLiveCommit(parsed.value, parsed.important)
    }, 100)
  }
  const commit = () => {
    const trimmed = draft.trim()
    if (!trimmed) { onClear(); return }
    const parsed = parseImportant(trimmed)
    onCommit(parsed.value, parsed.important)
  }
  return (
    <input
      ref={inputRef}
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancelLive(); commit() }}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  )
}

// Delayed hover tooltips per overflow value (reuses the segmented-control tooltip CSS).
const TOOLTIP_DELAY_MS = 500
const OVERFLOW_TOOLTIPS: Record<string, ReactNode> = {
  visible: <><strong>Visible</strong> shows content that overflows its container.</>,
  hidden: <><strong>Hidden</strong> hides overflowing content without adding a scrollbar.</>,
  clip: <><strong>Clip</strong> clips content to the element's padding box, similar to <strong>hidden</strong>, but it also prevents any scrolling of the overflowed content, including programmatic scrolling.</>,
  scroll: <><strong>Scroll</strong> always displays a scrollbar for overflowing content.</>,
  auto: <><strong>Auto</strong> only displays a scrollbar when content overflows.</>,
}

// Segmented icon bar (visible/hidden/clip/scroll/auto) + a dropdown arrow whose
// menu offers Custom; a free value shows the editable field. Mirrors DisplayControl.
function OverflowBar({ value, busy, onCommit, onLiveCommit, onClear }: {
  value: string
  busy: boolean
  onCommit: (value: string, important: boolean) => void
  onLiveCommit: (value: string, important: boolean) => void
  onClear: () => void
}) {
  // No overflow set → CSS defaults to `visible`, so show that segment as active.
  const current = value.trim().toLowerCase() || 'visible'
  const customMode = !OVERFLOW_SUPPORTED.has(current)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const pick = (next: string) => { setOpen(false); if (next !== current) onCommit(next, false) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; onCommit('unset', false) }

  // Delayed hover tooltip, right-anchored with a down-arrow to the hovered segment.
  const [hoveredValue, setHoveredValue] = useState<string | null>(null)
  const [arrowRight, setArrowRight] = useState(0)
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = () => { if (hoverTimer.current != null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null } }
  useEffect(() => clearHoverTimer, [])
  const startHover = (segValue: string, el: HTMLElement) => {
    if (!OVERFLOW_TOOLTIPS[segValue]) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      const root = rootRef.current
      if (root) {
        const trackRect = root.getBoundingClientRect()
        const buttonRect = el.getBoundingClientRect()
        setArrowRight(trackRect.right - (buttonRect.left + buttonRect.width / 2))
      }
      setHoveredValue(segValue)
    }, TOOLTIP_DELAY_MS)
  }
  const endHover = () => { clearHoverTimer(); setHoveredValue(null) }

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Overflow">
      {customMode ? (
        <OverflowCustomInput value={value} busy={busy} inputRef={inputRef} onCommit={onCommit} onLiveCommit={onLiveCommit} onClear={onClear} />
      ) : (
        OVERFLOW_SEGS.map((seg) => (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={current === seg.value}
            className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
            disabled={busy}
            aria-label={seg.label}
            onClick={() => { endHover(); pick(seg.value) }}
            onMouseEnter={(event) => startHover(seg.value, event.currentTarget)}
            onMouseLeave={endHover}
          >
            {seg.icon ?? seg.label}
          </button>
        ))
      )}
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More overflow options"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode
            ? OVERFLOW_SEGS.map((seg) => <MenuItem key={seg.value} label={seg.label} selected={current === seg.value} onClick={() => pick(seg.value)} />)
            : <MenuItem label="Custom" selected={false} onClick={enterCustom} />}
        </div>
      ) : null}

      {hoveredValue && OVERFLOW_TOOLTIPS[hoveredValue] ? (
        <div className="u-segmented-tooltip" role="tooltip" style={{ '--tip-arrow-right': `${arrowRight}px` } as CSSProperties}>
          {OVERFLOW_TOOLTIPS[hoveredValue]}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}

// One overflow control row bound to a single property. `fallback` is the value it
// shows when its own longhand isn't set (the main `overflow` value), so Overflow
// X / Y mirror the shorthand until overridden.
function OverflowRow({ label, prop, d, contributors, fallback, toggle, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  label: string
  prop: string
  d: Display
  contributors: Contributor[]
  fallback: string
  /** Optional disclosure control rendered next to the label (main row only). */
  toggle?: ReactNode
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const value = d.present ? d.value.toLowerCase() : fallback
  const labelEl = (
    <SizeLabel
      label={label}
      prop={prop}
      d={{ ...d, value, important: false }}
      contributors={contributors}
      busy={busy}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  )
  return (
    <div className="embed-editor_size-row">
      {toggle ? <div className="embed-editor_overflow-head">{labelEl}{toggle}</div> : labelEl}
      <OverflowBar
        value={value}
        busy={busy}
        onCommit={(next, important) => setProp(prop, next, important)}
        onLiveCommit={(next, important) => liveSetProp(prop, next, important)}
        onClear={() => clearProp(prop)}
      />
    </div>
  )
}

function OverflowField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const shorthand = displayOf(read('overflow'))
  const x = displayOf(read('overflow-x'))
  const y = displayOf(read('overflow-y'))
  // The main overflow value drives Overflow X / Y until they're individually set.
  const mainValue = shorthand.present ? shorthand.value.toLowerCase() : ''
  const rowProps = { busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }

  // Overflow X / Y hide behind a disclosure, opened by default when either is set.
  const [expanded, setExpanded] = useState(x.present || y.present)
  useEffect(() => { if (x.present || y.present) setExpanded(true) }, [x.present, y.present])

  const toggle = (
    <button
      type="button"
      className={`embed-editor_overflow-toggle ${expanded ? 'is-open' : ''}`}
      onClick={() => setExpanded((open) => !open)}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide overflow X and Y' : 'Show overflow X and Y'}
      title="Per-axis overflow (X / Y)"
    >
      <ChevronIcon />
    </button>
  )

  return (
    <>
      <OverflowRow label="Overflow" prop="overflow" d={shorthand} contributors={read('overflow')?.contributors ?? []} fallback="" toggle={toggle} {...rowProps} />
      {expanded ? (
        <>
          <OverflowRow label="Overflow X" prop="overflow-x" d={x} contributors={read('overflow-x')?.contributors ?? []} fallback={mainValue} {...rowProps} />
          <OverflowRow label="Overflow Y" prop="overflow-y" d={y} contributors={read('overflow-y')?.contributors ?? []} fallback={mainValue} {...rowProps} />
        </>
      ) : null}
    </>
  )
}

// ─────────────────────────── Box sizing ───────────────────────────

function BorderBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M4 5C3.44772 5 3 5.44772 3 6V10C3 10.5523 3.44772 11 4 11H12C12.5523 11 13 10.5523 13 10V6C13 5.44772 12.5523 5 12 5H4ZM12 6H4V10H12V6Z" fill="currentColor" />
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M4 2C3.44772 2 3 2.44772 3 3V13C3 13.5523 3.44772 14 4 14H12C12.5523 14 13 13.5523 13 13V3C13 2.44772 12.5523 2 12 2H4ZM12 3H4V13H12V3Z" fill="currentColor" />
    </svg>
  )
}
function ContentBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M3 5C2.44772 5 2 5.44772 2 6V10C2 10.5523 2.44772 11 3 11H13C13.5523 11 14 10.5523 14 10V6C14 5.44772 13.5523 5 13 5H3ZM13 6H3L3 10H13V6Z" fill="currentColor" />
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M3 2C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H10C10.5523 14 11 13.5523 11 13V3C11 2.44772 10.5523 2 10 2H3ZM10 3H3L3 13H10V3Z" fill="currentColor" />
    </svg>
  )
}

const BOX_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  {
    value: 'border-box',
    label: <BorderBoxIcon />,
    ariaLabel: 'Border box',
    tooltip: (
      <><strong>Border-box</strong> makes the width and height of the element include the content, padding, and border. The overall dimensions of the box do not increase regardless of padding and border sizes.</>
    ),
  },
  {
    value: 'content-box',
    label: <ContentBoxIcon />,
    ariaLabel: 'Content box',
    tooltip: (
      <><strong>Content-box</strong> makes the width and height of the element include only the content. Padding and border sizes are added to the outside of the box's dimensions.</>
    ),
  },
]
// box-sizing keywords the segmented bar shows; anything else drops to the custom field.
const BOX_SUPPORTED = new Set(BOX_OPTIONS.map((o) => o.value))
const BOX_TOOLTIPS: Record<string, ReactNode> = Object.fromEntries(BOX_OPTIONS.map((o) => [o.value, o.tooltip]))

// Segmented icon bar (border-box / content-box) + a dropdown arrow whose menu offers
// Custom; a free value (`inherit`, `unset`, var(…)…) shows the editable field. Mirrors
// OverflowBar so box-sizing matches the Overflow / Display controls.
function BoxSizingBar({ value, busy, onCommit, onLiveCommit, onClear }: {
  value: string
  busy: boolean
  onCommit: (value: string, important: boolean) => void
  onLiveCommit: (value: string, important: boolean) => void
  onClear: () => void
}) {
  // No box-sizing set → Webflow assumes border-box, so show that segment active.
  const current = value.trim().toLowerCase() || 'border-box'
  const customMode = !BOX_SUPPORTED.has(current)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const pick = (next: string) => { setOpen(false); if (next !== current) onCommit(next, false) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; onCommit('unset', false) }

  // Delayed hover tooltip, right-anchored with a down-arrow to the hovered segment.
  const [hoveredValue, setHoveredValue] = useState<string | null>(null)
  const [arrowRight, setArrowRight] = useState(0)
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = () => { if (hoverTimer.current != null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null } }
  useEffect(() => clearHoverTimer, [])
  const startHover = (segValue: string, el: HTMLElement) => {
    if (!BOX_TOOLTIPS[segValue]) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      const root = rootRef.current
      if (root) {
        const trackRect = root.getBoundingClientRect()
        const buttonRect = el.getBoundingClientRect()
        setArrowRight(trackRect.right - (buttonRect.left + buttonRect.width / 2))
      }
      setHoveredValue(segValue)
    }, TOOLTIP_DELAY_MS)
  }
  const endHover = () => { clearHoverTimer(); setHoveredValue(null) }

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Box sizing">
      {customMode ? (
        <OverflowCustomInput value={value} busy={busy} inputRef={inputRef} onCommit={onCommit} onLiveCommit={onLiveCommit} onClear={onClear} ariaLabel="Box sizing value" />
      ) : (
        BOX_OPTIONS.map((seg) => (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={current === seg.value}
            className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
            disabled={busy}
            aria-label={seg.ariaLabel}
            onClick={() => { endHover(); pick(seg.value) }}
            onMouseEnter={(event) => startHover(seg.value, event.currentTarget)}
            onMouseLeave={endHover}
          >
            {seg.label}
          </button>
        ))
      )}
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More box-sizing options"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode
            ? BOX_OPTIONS.map((seg) => <MenuItem key={seg.value} label={seg.ariaLabel ?? seg.value} selected={current === seg.value} onClick={() => pick(seg.value)} />)
            : <MenuItem label="Custom" selected={false} onClick={enterCustom} />}
        </div>
      ) : null}

      {hoveredValue && BOX_TOOLTIPS[hoveredValue] ? (
        <div className="u-segmented-tooltip" role="tooltip" style={{ '--tip-arrow-right': `${arrowRight}px` } as CSSProperties}>
          {BOX_TOOLTIPS[hoveredValue]}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────── Aspect ratio ───────────────────────────

const RATIO_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '2.39 / 1', label: 'Anamorphic (2.39:1)' },
  { value: '2 / 1', label: 'Univisium/Netflix (2:1)' },
  { value: '16 / 9', label: 'Widescreen (16:9)' },
  { value: '3 / 2', label: 'Landscape (3:2)' },
  { value: '2 / 3', label: 'Portrait (2:3)' },
  { value: '1 / 1', label: 'Square (1:1)' },
]

// Parse an aspect-ratio value into width/height numbers (single number → n/1).
function parseRatio(value: string): { w: string; h: string } | null {
  const v = value.trim().toLowerCase()
  if (!v || v === 'auto') return null
  if (v.includes('/')) {
    const [w, h] = v.split('/').map((part) => part.trim())
    if (w && /^[\d.]+$/.test(w) && (!h || /^[\d.]+$/.test(h))) return { w, h: h || '1' }
    return null
  }
  return /^[\d.]+$/.test(v) ? { w: v, h: '1' } : null
}

// Which dropdown option the value represents: 'auto', a preset value, 'custom'
// (a non-preset numeric ratio → the W:H pair) or 'other' (a free value like
// unset / var(--x) / calc(…) → the plain text field).
function ratioKeyOf(value: string): string {
  const v = value.trim().toLowerCase()
  if (!v || v === 'auto') return 'auto'
  const parsed = parseRatio(value)
  if (!parsed) return 'other'
  const match = RATIO_PRESETS.find((preset) => preset.value === `${parsed.w} / ${parsed.h}`)
  return match ? match.value : 'custom'
}

// A number-only field (no unit) that live-updates as you type and on ↑/↓.
function RatioNumberInput({ value, busy, ariaLabel, onLive, onCommit }: {
  value: string
  busy: boolean
  ariaLabel: string
  onLive: (value: string) => void
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const sanitize = (raw: string) => raw.replace(/[^\d.]/g, '')
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: (text) => { setDraft(text); onCommit(text) },
  })

  return (
    <input
      {...scrub.input}
      className="u-input embed-editor_ratio-input"
      value={draft}
      inputMode="decimal"
      onChange={(event) => { const next = sanitize(event.target.value); setDraft(next); onLive(next) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; onCommit(draft) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); return }
        const stepped = handleArrowStep(event)
        if (!stepped) return
        event.preventDefault()
        const el = event.currentTarget
        el.value = stepped.text
        el.setSelectionRange(stepped.caret, stepped.caret)
        setDraft(stepped.text)
        onLive(stepped.text)
      }}
      disabled={busy}
      spellCheck={false}
      aria-label={ariaLabel}
    />
  )
}

// Free-text value field for the Ratio "Other" mode — mirrors the Display/Overflow
// custom fields. Any value (unset, var(--x), calc(…), …) live-updates as you type
// and commits on blur; emptying it clears the property. Focuses itself when the
// mode is first entered (once the seeding write clears `busy`).
function RatioOtherInput({ value, busy, onCommit, onLiveCommit, onClear, ariaLabel = 'Aspect ratio value', placeholder = 'unset, var(--x)…' }: {
  value: string
  busy: boolean
  onCommit: (value: string, important: boolean) => void
  onLiveCommit: (value: string, important: boolean) => void
  onClear: () => void
  ariaLabel?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const didFocus = useRef(false)

  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancelLive = () => { if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null } }
  useEffect(() => cancelLive, [])

  useEffect(() => {
    if (didFocus.current || busy) return
    didFocus.current = true
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [busy])

  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      const trimmed = text.trim()
      if (!trimmed) return
      const parsed = parseImportant(trimmed)
      onLiveCommit(parsed.value, parsed.important)
    }, 100)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (!trimmed) { onClear(); return }
    const parsed = parseImportant(trimmed)
    onCommit(parsed.value, parsed.important)
  }

  return (
    <input
      ref={inputRef}
      className="u-select-custom-input"
      value={draft}
      onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancelLive(); commit() }}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  )
}

function AspectRatioField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const d = displayOf(read('aspect-ratio'))
  const current = d.present ? d.value : ''
  const derivedKey = d.present ? ratioKeyOf(current) : 'auto'
  // Custom (W:H pair) and Other (free text) stick once chosen — even when the
  // value happens to match a preset (1 / 1 vs Square) — until a preset/Auto is
  // picked. Everything else derives straight from the value.
  const [forced, setForced] = useState<'custom' | 'other' | null>(null)
  const key = forced ?? derivedKey
  const parsed = parseRatio(current) ?? { w: '1', h: '1' }

  const options: SelectOption<string>[] = [
    { value: 'auto', label: 'Auto' },
    ...RATIO_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
    { value: 'custom', label: 'Custom' },
    { value: 'other', label: 'Other' },
  ]

  const onSelect = (choice: string) => {
    // "Auto" writes the explicit `aspect-ratio: auto` (the CSS initial value);
    // removing the property is the label's Clear action, not this.
    if (choice === 'auto') { setForced(null); setProp('aspect-ratio', 'auto', false); return }
    if (choice === 'custom') {
      setForced('custom')
      const p = parseRatio(current)
      setProp('aspect-ratio', p ? `${p.w} / ${p.h}` : '1 / 1', false)
      return
    }
    if (choice === 'other') {
      setForced('other')
      // Keep an existing free value; otherwise seed with `unset` to type over.
      if (ratioKeyOf(current) !== 'other') setProp('aspect-ratio', 'unset', false)
      return
    }
    setForced(null)
    setProp('aspect-ratio', choice, false)
  }

  const write = (w: string, h: string, live: boolean) => {
    const value = `${w || '0'} / ${h || '0'}`
    if (live) liveSetProp('aspect-ratio', value, false)
    else setProp('aspect-ratio', value, false)
  }

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel label="Ratio" prop="aspect-ratio" d={{ ...d, value: current }} contributors={read('aspect-ratio')?.contributors ?? []} busy={busy} onClear={() => { setForced(null); clearProp('aspect-ratio') }} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <Select
          className="embed-editor_ratio-select"
          value={key}
          options={options}
          ariaLabel="Aspect ratio"
          disabled={busy}
          onChange={onSelect}
          onPreview={(choice) => liveSetProp('aspect-ratio', choice === 'custom' || choice === 'other' ? null : choice, false)}
          customInput={key === 'other' ? (
            <RatioOtherInput
              value={d.present ? (d.important ? `${current} !important` : current) : ''}
              busy={busy}
              onCommit={(value, important) => setProp('aspect-ratio', value, important)}
              onLiveCommit={(value, important) => liveSetProp('aspect-ratio', value, important)}
              onClear={() => { setForced(null); clearProp('aspect-ratio') }}
            />
          ) : undefined}
        />
      </div>
      {key === 'custom' ? (
        <div className="embed-editor_ratio-custom">
          <div className="embed-editor_ratio-pair">
            <div className="embed-editor_ratio-cell">
              <RatioNumberInput value={parsed.w} busy={busy} ariaLabel="Ratio width" onLive={(w) => write(w, parsed.h, true)} onCommit={(w) => write(w, parsed.h, false)} />
              <span className="embed-editor_ratio-caption">Width</span>
            </div>
            <span className="embed-editor_ratio-colon">:</span>
            <div className="embed-editor_ratio-cell">
              <RatioNumberInput value={parsed.h} busy={busy} ariaLabel="Ratio height" onLive={(h) => write(parsed.w, h, true)} onCommit={(h) => write(parsed.w, h, false)} />
              <span className="embed-editor_ratio-caption">Height</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function BoxSizingField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const d = displayOf(read('box-sizing'))
  return (
    <div className="embed-editor_size-row">
      <SizeLabel label="Box size" prop="box-sizing" d={d} contributors={read('box-sizing')?.contributors ?? []} busy={busy} onClear={() => clearProp('box-sizing')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      <BoxSizingBar
        value={d.present ? d.value : ''}
        busy={busy}
        onCommit={(next, important) => setProp('box-sizing', next, important)}
        onLiveCommit={(next, important) => liveSetProp('box-sizing', next, important)}
        onClear={() => clearProp('box-sizing')}
      />
    </div>
  )
}

// ─────────────────────── Image fit (object-fit / object-position) ───────────────────────

const FIT_OPTIONS: SelectOption<string>[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
]
const FIT_CUSTOM = '__custom__'

const OBJ_POS_PCT = ['0%', '50%', '100%']
// Which of the 3 grid columns/rows a position token lands on (−1 = a custom offset).
// Empty → center: object-position's initial value is 50% 50%, so an unset position
// reads as centered (unlike background-position, which defaults to the top-left).
function objPosAxis(token: string): number {
  const t = token.trim().toLowerCase()
  if (t === '' || t === 'center' || t === '50%') return 1
  if (t === 'left' || t === 'top' || t === '0' || t === '0%' || t === '0px') return 0
  if (t === 'right' || t === 'bottom' || t === '100%') return 2
  return -1
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.5" cy="8" r="1.35" />
    </svg>
  )
}

// A position offset field: the input holds the RAW value, so any unit works (10px,
// 50%, unset, var(--x)…). A "%" hint sits INSIDE the field, shown only while the value
// is a bare number (or empty) — a bare number commits as a percentage.
function PosInput({ value, busy, label, onLive, onCommit }: {
  value: string; busy: boolean; label: string; onLive: (v: string) => void; onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const isBareNum = (s: string) => /^-?[\d.]+$/.test(s.trim())
  const norm = (t: string) => { const s = t.trim(); return s === '' ? '' : isBareNum(s) ? `${s}%` : s }
  const showPct = draft.trim() === '' || isBareNum(draft)
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => onLive(norm(text)),
    onCommit: (text) => { setDraft(text); onCommit(norm(text)) },
  })
  return (
    <div className={`embed-editor_imgfit-num ${busy ? 'is-disabled' : ''}`}>
      <input
        {...scrub.input}
        className="embed-editor_imgfit-input"
        value={draft}
        placeholder="50"
        aria-label={label}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => { setDraft(e.target.value); onLive(norm(e.target.value)) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; onCommit(norm(draft)) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); return }
          const stepped = handleArrowStep(e)
          if (!stepped) return
          e.preventDefault()
          const el = e.currentTarget
          el.value = stepped.text
          el.setSelectionRange(stepped.caret, stepped.caret)
          setDraft(stepped.text)
          onLive(norm(stepped.text))
        }}
      />
      {showPct ? <span className="embed-editor_imgfit-unit" aria-hidden="true">%</span> : null}
    </div>
  )
}

// Popup shell over the panel — the same darkening backdrop the transform / shadow
// editors use; closes on backdrop click or Escape.
function PositionModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="embed-editor_bg-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="embed-editor_bg-modal embed-editor_pos-modal u-surface-surface" role="dialog" aria-modal="true" aria-label="Object position">
        {children}
      </div>
    </div>,
    document.body,
  )
}

function ImageFitField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const fit = displayOf(read('object-fit'))
  const posD = displayOf(read('object-position'))
  const [posOpen, setPosOpen] = useState(false)
  const [forceCustom, setForceCustom] = useState(false)
  // Delayed hover tooltip on the "…" button (same rich popup the segmented controls use).
  const moreRef = useRef<HTMLButtonElement>(null)
  const [tipOpen, setTipOpen] = useState(false)
  const tipTimer = useRef<number | null>(null)
  const clearTip = () => { if (tipTimer.current != null) { window.clearTimeout(tipTimer.current); tipTimer.current = null } }
  useEffect(() => clearTip, [])
  const startTip = () => { clearTip(); tipTimer.current = window.setTimeout(() => { tipTimer.current = null; setTipOpen(true) }, 400) }
  const endTip = () => { clearTip(); setTipOpen(false) }

  // "Custom" as the last option: seed `unset` and reveal a free-text field for any
  // value (a var()/keyword/etc. Webflow doesn't offer in the preset list).
  const fitValue = fit.value.trim().toLowerCase()
  const knownFit = FIT_OPTIONS.some((o) => o.value === fitValue)
  const fitCustom = forceCustom || (fit.present && fitValue !== '' && !knownFit)
  const pickFit = (v: string) => {
    if (v === FIT_CUSTOM) { setForceCustom(true); setProp('object-fit', 'unset', false); return }
    setForceCustom(false)
    setProp('object-fit', v, false)
  }

  const posRaw = posD.present ? posD.value.trim() : ''
  const posParts = splitTopLevelSpaces(posRaw).filter(Boolean)
  const px = posParts[0] ?? ''
  const py = posParts[1] ?? ''
  const posSet = posRaw !== '' && posRaw.toLowerCase() !== 'unset'
  const activeCol = objPosAxis(px)
  const activeRow = objPosAxis(py)

  const writePos = (value: string, live: boolean) => {
    if (live) { if (value) liveSetProp('object-position', value, false); return }
    if (value) setProp('object-position', value, false); else clearProp('object-position')
  }

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel label="Image fit" prop="object-fit" d={fit} contributors={read('object-fit')?.contributors ?? []} busy={busy} onClear={() => clearProp('object-fit')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <div className="embed-editor_imgfit-controls">
          <Select
            className="embed-editor_imgfit-select"
            value={fitCustom ? FIT_CUSTOM : (fit.present ? fitValue : 'fill')}
            options={[...FIT_OPTIONS, { value: FIT_CUSTOM, label: 'Custom' }]}
            ariaLabel="Object fit"
            disabled={busy}
            onChange={pickFit}
            onPreview={(v) => liveSetProp('object-fit', v === FIT_CUSTOM ? null : v, false)}
            customInput={fitCustom ? (
              <RatioOtherInput
                value={fit.present ? (fit.important ? `${fit.value} !important` : fit.value) : ''}
                busy={busy}
                ariaLabel="Object fit value"
                onCommit={(v, important) => setProp('object-fit', v, important)}
                onLiveCommit={(v, important) => liveSetProp('object-fit', v, important)}
                onClear={() => { setForceCustom(false); clearProp('object-fit') }}
              />
            ) : undefined}
          />
          <button
            ref={moreRef}
            type="button"
            className={`embed-editor_icon-btn embed-editor_imgfit-more ${posSet ? 'is-active' : ''}`}
            disabled={busy}
            aria-haspopup="dialog"
            aria-expanded={posOpen}
            aria-label="Object position settings"
            onClick={() => { endTip(); setPosOpen((o) => !o) }}
            onMouseEnter={startTip}
            onMouseLeave={endTip}
          >
            <DotsIcon />
          </button>
          {tipOpen && moreRef.current && !posOpen ? (
            <HoverTooltip anchor={moreRef.current}>Object position settings</HoverTooltip>
          ) : null}
        </div>
      </div>
      {posOpen ? (
        <PositionModal onClose={() => setPosOpen(false)}>
          <div className="embed-editor_imgfit-pos">
            <FieldLabel
              className="embed-editor_imgfit-pos-label"
              active={posSet}
              disabled={busy}
              onReset={() => clearProp('object-position')}
              resetLabel="Clear"
            >
              Position
            </FieldLabel>
            <div className="embed-editor_bg-position">
            <div className="embed-editor_bg-posgrid" role="group" aria-label="Object position preset">
              {[0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  className={`embed-editor_bg-poscell ${activeCol === col && activeRow === row ? 'is-active' : ''}`}
                  disabled={busy}
                  aria-label={`${['Left', 'Center', 'Right'][col]} ${['top', 'center', 'bottom'][row]}`}
                  onClick={() => writePos(`${OBJ_POS_PCT[col]} ${OBJ_POS_PCT[row]}`, false)}
                />
              )))}
            </div>
            <div className="embed-editor_bg-posfields">
              <label className="embed-editor_bg-posfield">
                <span className="embed-editor_bg-posfield-cap">Left</span>
                <PosInput value={px} busy={busy} label="Object position left"
                  onLive={(v) => writePos(`${v || '50%'} ${py || '50%'}`, true)}
                  onCommit={(v) => writePos((v || py) ? `${v || '50%'} ${py || '50%'}` : '', false)} />
              </label>
              <label className="embed-editor_bg-posfield">
                <span className="embed-editor_bg-posfield-cap">Top</span>
                <PosInput value={py} busy={busy} label="Object position top"
                  onLive={(v) => writePos(`${px || '50%'} ${v || '50%'}`, true)}
                  onCommit={(v) => writePos((px || v) ? `${px || '50%'} ${v || '50%'}` : '', false)} />
              </label>
            </div>
          </div>
          </div>
        </PositionModal>
      ) : null}
    </>
  )
}

// ─────────────────────────── Section ───────────────────────────

export default function SizeSection(props: Props) {
  return (
    <div className="embed-editor_size">
      <div className="embed-editor_size-grid">
        {LENGTH_FIELDS.map((field) => (
          <Fragment key={field.prop}>
            <LivePropField prop={field.prop} label={field.label} placeholder={field.placeholder} {...props} />
          </Fragment>
        ))}
      </div>
      <OverflowField {...props} />
      <AspectRatioField {...props} />
      <BoxSizingField {...props} />
      <ImageFitField {...props} />
    </div>
  )
}
