import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Select from './components/Select'
import FieldLabel from './components/FieldLabel'
import useScrub from './components/useScrub'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import { SpacingFill, useSpacingBox } from './SpacingBox'
import { handleArrowStep } from './lib/number-step'
import type { ResolvedProp } from './lib/resolved'

// The Position section: a position-type dropdown (with a Custom escape hatch), an
// inset box (top/right/bottom/left, like the spacing box), a z-index field, and
// Float + Clear segmented controls (each with a chevron menu → Custom). All controls
// read the resolved model and write the picked selector, live as you type.

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
  onSelectSelector: (selector: string, prop?: string) => void
}

// ─────────────────────────── Icons (from Webflow) ───────────────────────────

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M8.70708 8.00004L12.3535 4.35359L11.6464 3.64648L7.99998 7.29293L4.35353 3.64648L3.64642 4.35359L7.29287 8.00004L3.64642 11.6465L4.35353 12.3536L7.99998 8.70714L11.6464 12.3536L12.3535 11.6465L8.70708 8.00004Z" fill="currentColor" /></svg>
}
function RelativeIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z" fill="currentColor" /></svg>
}
function AbsoluteIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M8 3V2H3C2.44772 2 2 2.44772 2 3V8H3V3H8Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z" fill="currentColor" /></svg>
}
function FixedIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M11 2H9V3H11V8H12V3H14V2H11ZM3 9H2V14H3V12H8V11H3V9ZM14 10C14 9.44772 13.5523 9 13 9H10C9.44772 9 9 9.44772 9 10V13C9 13.5523 9.44772 14 10 14H13C13.5523 14 14 13.5523 14 13V10Z" fill="currentColor" /><g opacity="0.4"><path d="M8 3V2H3C2.44772 2 2 2.44772 2 3V8H3V3H8Z" fill="currentColor" /><path d="M5.5 4.75C5.5 5.16421 5.16421 5.5 4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75Z" fill="currentColor" /><path d="M7.25 5.5C7.66421 5.5 8 5.16421 8 4.75C8 4.33579 7.66421 4 7.25 4C6.83579 4 6.5 4.33579 6.5 4.75C6.5 5.16421 6.83579 5.5 7.25 5.5Z" fill="currentColor" /></g></svg>
}
function StickyIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g opacity="0.4"><path d="M8 3H3L3 13H13V8H14V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H8V3Z" fill="currentColor" /><path d="M8 4.75C8 5.16421 7.66421 5.5 7.25 5.5C6.83579 5.5 6.5 5.16421 6.5 4.75C6.5 4.33579 6.83579 4 7.25 4C7.66421 4 8 4.33579 8 4.75Z" fill="currentColor" /><path d="M4.75 5.5C5.16421 5.5 5.5 5.16421 5.5 4.75C5.5 4.33579 5.16421 4 4.75 4C4.33579 4 4 4.33579 4 4.75C4 5.16421 4.33579 5.5 4.75 5.5Z" fill="currentColor" /></g><path d="M12 6.5C13.3807 6.5 14.5 5.38071 14.5 4C14.5 2.61929 13.3807 1.5 12 1.5C10.6193 1.5 9.5 2.61929 9.5 4C9.5 4.50954 9.65244 4.98348 9.9142 5.3787L6.14645 9.14645C5.95118 9.34171 5.95118 9.65829 6.14645 9.85355C6.34171 10.0488 6.65829 10.0488 6.85355 9.85355L10.6213 6.0858C11.0165 6.34756 11.4905 6.5 12 6.5Z" fill="currentColor" /></svg>
}
function FloatLeftIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M0.5 4C0.223858 4 0 4.22386 0 4.5V10.5C0 10.7761 0.223858 11 0.5 11H6.5C6.77614 11 7 10.7761 7 10.5V4.5C7 4.22386 6.77614 4 6.5 4H0.5Z" fill="currentColor" /><path d="M9 5H16V4H9V5Z" fill="currentColor" /><path d="M16 8H9V7H16V8Z" fill="currentColor" /><path d="M9 11H12.5V10H9V11Z" fill="currentColor" /></svg>
}
function FloatRightIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M0 5H7V4H0V5Z" fill="currentColor" /><path d="M9.5 4C9.22386 4 9 4.22386 9 4.5V10.5C9 10.7761 9.22386 11 9.5 11H15.5C15.7761 11 16 10.7761 16 10.5V4.5C16 4.22386 15.7761 4 15.5 4H9.5Z" fill="currentColor" /><path d="M7 8H0V7H7V8Z" fill="currentColor" /><path d="M0 11H3.5V10H0V11Z" fill="currentColor" /></svg>
}
function ClearLeftIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path opacity="0.3" d="M2 2.5C2 2.22386 2.22386 2 2.5 2H5.5C5.77614 2 6 2.22386 6 2.5V4.5C6 4.77614 5.77614 5 5.5 5H2.5C2.22386 5 2 4.77614 2 4.5V2.5Z" fill="currentColor" /><path d="M7.00008 2.5C7.00008 2.22386 7.22393 2 7.50008 2H13.5001C13.7762 2 14.0001 2.22386 14.0001 2.5V4.5C14.0001 4.77614 13.7762 5 13.5001 5H7.50008C7.22393 5 7.00008 4.77614 7.00008 4.5V2.5Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M5.20718 10.5L7.35363 8.35355L6.64652 7.64645L3.79297 10.5L6.64652 13.3536L7.35363 12.6464L5.20718 10.5Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M10.0001 6V8.5C10.0001 9.32843 9.3285 10 8.50008 10H4.50008V11H8.50008C9.88079 11 11.0001 9.88071 11.0001 8.5V6H10.0001Z" fill="currentColor" /></svg>
}
function ClearRightIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path opacity="0.3" d="M10 2.5C10 2.22386 10.2239 2 10.5 2H13.5C13.7761 2 14 2.22386 14 2.5V4.5C14 4.77614 13.7761 5 13.5 5H10.5C10.2239 5 10 4.77614 10 4.5V2.5Z" fill="currentColor" /><path d="M2 2.5C2 2.22386 2.22386 2 2.5 2H8.5C8.77614 2 9 2.22386 9 2.5V4.5C9 4.77614 8.77614 5 8.5 5H2.5C2.22386 5 2 4.77614 2 4.5V2.5Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M10.7929 10.5L8.64645 8.35355L9.35355 7.64645L12.2071 10.5L9.35355 13.3536L8.64645 12.6464L10.7929 10.5Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M6 6V8.5C6 9.32843 6.67157 10 7.5 10H11.5V11H7.5C6.11929 11 5 9.88071 5 8.5V6H6Z" fill="currentColor" /></svg>
}
function ClearBothIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.00011 2.5C3.00011 2.22386 3.22397 2 3.50011 2H13.5001C13.7763 2 14.0001 2.22386 14.0001 2.5V4.5C14.0001 4.77614 13.7763 5 13.5001 5H3.50011C3.22397 5 3.00011 4.77614 3.00011 4.5V2.5Z" fill="currentColor" /><path d="M3.70716 10L5.35363 8.35353L4.64652 7.64642L1.79297 10.5L4.64652 13.3535L5.35363 12.6464L3.70721 11H6.50011C7.31791 11 8.044 10.6073 8.50011 10.0002C8.95623 10.6073 9.68231 11 10.5001 11H13.293L11.6466 12.6464L12.3537 13.3535L15.2073 10.5L12.3537 7.64642L11.6466 8.35353L13.2931 10H10.5001C9.67169 10 9.00011 9.32843 9.00011 8.5V6H8.00011V8.5C8.00011 9.32843 7.32854 10 6.50011 10H3.70716Z" fill="currentColor" /></svg>
}
function ChevronIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

// ─────────────────────────── Helpers ───────────────────────────

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}
const joinImportant = (value: string, important: boolean) => (important ? `${value} !important` : value)

type Display = { present: boolean; value: string; important: boolean }
function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) return { present: false, value: '', important: false }
  const source = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return { present: true, value: source.value, important: source.important }
}
const effVal = (read: Read, prop: string) => displayOf(read(prop)).value.trim().toLowerCase()

// ─────────────────────────── Live text field ───────────────────────────

// A plain inline input that live-updates as you type/step and commits (or clears) on
// blur — shared by the inset sides and z-index.
function LiveField({ prop, placeholder, ariaLabel, read, busy, setProp, clearProp, liveSetProp }: {
  prop: string
  placeholder: string
  ariaLabel: string
} & Props) {
  const d = displayOf(read(prop))
  const external = d.present ? joinImportant(d.value, d.important) : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const parsed = parseImportant(trimmed)
    liveSetProp(prop, parsed.value, parsed.important)
  }
  const live = (text: string) => {
    cancel()
    timer.current = window.setTimeout(() => { timer.current = null; liveNow(text) }, 100)
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
    <VariableConnect ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
    <input
      {...scrub.input}
      className="u-input embed-editor_position-input"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      disabled={busy}
      onChange={(event) => { setDraft(event.target.value); live(event.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancel(); commit() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); return }
        const stepped = handleArrowStep(event)
        if (!stepped) return
        event.preventDefault()
        const el = event.currentTarget
        el.value = stepped.text
        el.setSelectionRange(stepped.caret, stepped.caret)
        setDraft(stepped.text)
        live(stepped.text)
      }}
      aria-label={ariaLabel}
    />
    </VariableConnect>
  )
}

// ─────────────────────────── Position dropdown ───────────────────────────

const POSITION_PRESETS: ReadonlyArray<{ value: string; label: string; icon: ReactNode }> = [
  { value: 'static', label: 'Static', icon: <CloseIcon /> },
  { value: 'relative', label: 'Relative', icon: <RelativeIcon /> },
  { value: 'absolute', label: 'Absolute', icon: <AbsoluteIcon /> },
  { value: 'fixed', label: 'Fixed', icon: <FixedIcon /> },
  { value: 'sticky', label: 'Sticky', icon: <StickyIcon /> },
]
const POSITION_PRESET_VALUES = new Set(POSITION_PRESETS.map((p) => p.value))
const CUSTOM = '__custom__'

// The editable field shown inside the position dropdown's trigger in custom mode.
function PositionCustomField({ read, busy, setProp }: { read: Read; busy: boolean; setProp: SetProp }) {
  const d = displayOf(read('position'))
  const external = d.present ? joinImportant(d.value, d.important) : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const commit = () => {
    const parsed = parseImportant(draft)
    if (parsed.value && (parsed.value !== d.value.trim() || parsed.important !== d.important)) setProp('position', parsed.value, parsed.important)
  }
  return (
    <VariableConnect ariaLabel="Connect Position to a variable" disabled={busy} prop="position" onPick={(binding) => setProp('position', binding, false)}>
    <input
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      placeholder="custom value"
      spellCheck={false}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      aria-label="Position value"
    />
    </VariableConnect>
  )
}

function PositionControl({ read, busy, setProp, liveSetProp }: { read: Read; busy: boolean; setProp: SetProp; liveSetProp: LiveSetProp }) {
  const current = effVal(read, 'position')
  const isPreset = POSITION_PRESET_VALUES.has(current)
  // Custom whenever position is a free value (var()/unset/…) or !important, or the user
  // explicitly entered custom (kept until a preset is picked).
  const [forceCustom, setForceCustom] = useState(false)
  const custom = forceCustom || (!!current && !isPreset) || displayOf(read('position')).important
  return (
    <Select
      className="embed-editor_position-select"
      value={custom ? CUSTOM : (current || 'static')}
      options={[
        ...POSITION_PRESETS.map((p) => ({ value: p.value, label: p.label, icon: p.icon })),
        { value: CUSTOM, label: 'Custom' },
      ]}
      customInput={custom ? <PositionCustomField read={read} busy={busy} setProp={setProp} /> : undefined}
      disabled={busy}
      onChange={(next) => {
        if (next === CUSTOM) { setForceCustom(true); setProp('position', 'unset', false) }
        else { setForceCustom(false); setProp('position', next, false) }
      }}
      onPreview={(next) => liveSetProp('position', next === CUSTOM ? null : next, false)}
      ariaLabel="Position"
    />
  )
}

// ─────────────────────────── Inset box (top/right/bottom/left) ───────────────────────────

// The inset box: Webflow's position frame (a single band, no nesting) driven by the
// shared SpacingBox — draggable side handles, click-to-edit labels, and a popover
// editor, exactly like the margin/padding box. Each side maps to the plain
// top/right/bottom/left property; unset reads "Auto".
function InsetBox(props: Props) {
  const { label, fillHandlers, editor } = useSpacingBox(props, { emptyLabel: 'Auto' })
  return (
    <div className="embed-editor_spacing">
      <div className="embed-editor_position-inset">
        <SpacingFill
          frame="position"
          propFor={(side) => side}
          read={props.read}
          busy={props.busy}
          setProp={props.setProp}
          liveSetProp={props.liveSetProp}
          {...fillHandlers}
        />
        {label('top', 'top')}
        {label('right', 'right')}
        {label('bottom', 'bottom')}
        {label('left', 'left')}
        <div className="embed-editor_spacing-content" />
      </div>
      {editor}
    </div>
  )
}

// ─────────────────────────── Float / Clear segmented controls ───────────────────────────

function MenuItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`} onClick={onClick}>
      {label}
    </button>
  )
}

type Seg = { value: string; icon: ReactNode; label: string }

// An icon segmented bar (Float / Clear) + a chevron menu whose only item enters a
// Custom free-value mode (var()/unset), and offers the presets to switch back —
// mirroring the Overflow / Display controls.
function SegmentedIconControl({ prop, ariaLabel, segments, current, busy, setProp, liveSetProp, clearProp }: {
  prop: string
  ariaLabel: string
  segments: readonly Seg[]
  current: string
} & Props & { read?: Read }) {
  const supported = new Set(segments.map((s) => s.value))
  const customMode = !supported.has(current)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)
  const [draft, setDraft] = useState('')
  const focused = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  useEffect(() => { if (customMode && !focused.current) setDraft(current) }, [customMode, current])
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) { wantFocus.current = false; inputRef.current?.focus(); inputRef.current?.select() }
  }, [customMode, busy])

  const pick = (next: string) => { setOpen(false); if (next !== current) setProp(prop, next, false) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; setProp(prop, 'unset', false) }
  const commitCustom = () => {
    const trimmed = draft.trim()
    if (!trimmed) { clearProp(prop); return }
    const parsed = parseImportant(trimmed)
    setProp(prop, parsed.value, parsed.important)
  }

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={ariaLabel}>
      {customMode ? (
        <VariableConnect ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
        <input
          ref={inputRef}
          className="embed-editor_value-input embed-editor_display-input"
          value={draft}
          placeholder="custom value"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => { setDraft(event.target.value); const t = event.target.value.trim(); if (t) { const p = parseImportant(t); liveSetProp(prop, p.value, p.important) } }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; commitCustom() }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          aria-label={`${ariaLabel} value`}
        />
        </VariableConnect>
      ) : (
        segments.map((seg) => (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={current === seg.value}
            className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
            disabled={busy}
            title={seg.label}
            aria-label={seg.label}
            onClick={() => pick(seg.value)}
          >
            {seg.icon}
          </button>
        ))
      )}
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More ${ariaLabel} options`}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode
            ? segments.map((seg) => <MenuItem key={seg.value} label={seg.label} selected={current === seg.value} onClick={() => pick(seg.value)} />)
            : <MenuItem label="Custom" selected={false} onClick={enterCustom} />}
        </div>
      ) : null}
    </div>
  )
}

const FLOAT_SEGS: readonly Seg[] = [
  { value: 'none', icon: <CloseIcon />, label: 'None' },
  { value: 'left', icon: <FloatLeftIcon />, label: 'Float left' },
  { value: 'right', icon: <FloatRightIcon />, label: 'Float right' },
]
const CLEAR_SEGS: readonly Seg[] = [
  { value: 'none', icon: <CloseIcon />, label: 'None' },
  { value: 'left', icon: <ClearLeftIcon />, label: 'Clear left' },
  { value: 'right', icon: <ClearRightIcon />, label: 'Clear right' },
  { value: 'both', icon: <ClearBothIcon />, label: 'Clear both' },
]

// ─────────────────────────── Section ───────────────────────────

// A row's label, driven by the resolved model like the Size/Layout labels: blue +
// clearable when the picked selector sets the prop, orange when another selector does,
// dim when unset. Reuses the shared size-label styling.
function RowLabel({ label, prop, read, busy, clearProp, onProvenance, onSelectSelector }: {
  label: string
  prop: string
  read: Read
  busy: boolean
  clearProp: ClearProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const resolved = read(prop)
  const isSelected = resolved?.source === 'selected'
  const contributors = resolved?.contributors ?? []
  // Set by ANOTHER selector → orange, click opens the provenance popover.
  if (resolved && !isSelected) {
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
  // Blue (picked selector sets it) or dim (unset). The clear menu also lists every
  // selector that sets this property and which one wins — click a row to jump to it.
  return (
    <FieldLabel
      className="embed-editor_size-label"
      active={!!isSelected}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Clear"
      menuNote={contributors.length ? (close) => <ProvenanceList contributors={contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} /> : undefined}
    >
      {label}
    </FieldLabel>
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="embed-editor_position-row">
      {label}
      {children}
    </div>
  )
}

export default function PositionSection(props: Props) {
  const { read } = props
  const position = effVal(read, 'position') || 'static'
  // The inset box is always shown (the offsets read "Auto" until set). z-index only
  // matters once the element is positioned (Webflow parity) — or is already set, so
  // an inherited/other value stays visible.
  const positioned = ['relative', 'absolute', 'fixed', 'sticky'].includes(position)
    || read('z-index') != null

  const rowLabel = (label: string, prop: string) => (
    <RowLabel label={label} prop={prop} read={read} busy={props.busy} clearProp={props.clearProp} onProvenance={props.onProvenance} onSelectSelector={props.onSelectSelector} />
  )

  return (
    <div className="embed-editor_position">
      <Row label={rowLabel('Position', 'position')}><PositionControl read={read} busy={props.busy} setProp={props.setProp} liveSetProp={props.liveSetProp} /></Row>

      <InsetBox {...props} />

      {positioned ? (
        <Row label={rowLabel('z-index', 'z-index')}><LiveField prop="z-index" placeholder="Auto" ariaLabel="z-index" {...props} /></Row>
      ) : null}

      <Row label={rowLabel('Float', 'float')}>
        <SegmentedIconControl prop="float" ariaLabel="Float" segments={FLOAT_SEGS} current={effVal(read, 'float') || 'none'} {...props} />
      </Row>
      <Row label={rowLabel('Clear', 'clear')}>
        <SegmentedIconControl prop="clear" ariaLabel="Clear" segments={CLEAR_SEGS} current={effVal(read, 'clear') || 'none'} {...props} />
      </Row>
    </div>
  )
}
