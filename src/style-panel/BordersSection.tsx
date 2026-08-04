import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import FieldLabel from './components/FieldLabel'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import ColorSwatch from './components/ColorSwatch'
import useScrub from './components/useScrub'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import { GroupLabel } from './TypographySection'
import { handleArrowStep } from './lib/number-step'
import type { ResolvedProp } from './lib/resolved'
import { splitTopLevelSpaces } from './lib/background'

// The Borders section: a corner-radius control (linked / per-corner) and a border
// control scoped to a side (all / top / right / bottom / left) with style, width,
// and color. Driven by the resolved model like the Size/Spacing sections — blue
// when the picked selector sets it, orange when another does, dim when unset.

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

type Display = { present: boolean; isSelected: boolean; overridden: boolean; winnerSelector: string; value: string; important: boolean }

function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) return { present: false, isSelected: false, overridden: false, winnerSelector: '', value: '', important: false }
  const isSelected = resolved.source === 'selected'
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return { present: true, isSelected, overridden: resolved.overridden, winnerSelector: resolved.winner.selectorText, value: source.value, important: source.important }
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}

const stripImportant = (value: string) => value.replace(/\s*!important\s*$/i, '').trim()

// ─────────────────── Provenance-aware label (mirrors SizeLabel) ───────────────────

function OverrideNote({ selector, onSelect }: { selector: string; onSelect: () => void }) {
  return (
    <div className="embed-editor_override-note">
      <span>Overridden by a more specific selector:</span>
      <button type="button" className="embed-editor_override-note-sel" title="Select this selector" onClick={onSelect}>{selector}</button>
    </div>
  )
}

function PropLabel({ label, prop, clearProps, read, busy, clearProp, onProvenance, onSelectSelector }: {
  label: ReactNode
  prop: string
  clearProps?: string[]
} & Pick<Props, 'read' | 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const resolved = read(prop)
  const d = displayOf(resolved)
  const contributors = resolved?.contributors ?? []
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
      onReset={() => clearProp(clearProps ?? prop)}
      resetLabel="Clear"
      title={d.overridden ? `Overridden by ${d.winnerSelector}` : undefined}
      menuNote={(close) => (
        <>
          {d.overridden ? <OverrideNote selector={d.winnerSelector} onSelect={() => { onSelectSelector(d.winnerSelector, prop); close() }} /> : null}
          <ProvenanceList contributors={contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />
        </>
      )}
    >
      {label}
    </FieldLabel>
  )
}

// ─────────────────── Live value field ───────────────────

export function LiveInput({ value, busy, readOnly = false, ariaLabel, placeholder, prefix, prop, onLive, onCommit, onVariablePick }: {
  value: string
  busy: boolean
  readOnly?: boolean
  ariaLabel: string
  placeholder?: string
  prefix?: ReactNode
  /** The CSS property being edited — filters the variable picker (border-color →
   *  Color only; radius / width → no color/font). */
  prop: string
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
  const scrub = useScrub({
    value: draft,
    disabled: busy || readOnly,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: (text) => { setDraft(text); onCommit(text) },
  })
  return (
    <div className={`embed-editor_border-field${prefix ? ' has-prefix' : ''}`}>
      {prefix}
      <VariableConnect ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop={prop} onPick={(binding) => (onVariablePick ?? onCommit)(binding)}>
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; cancelLive(); onCommit(draft) }}
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
        readOnly={readOnly}
        spellCheck={false}
        placeholder={placeholder ?? '0'}
        aria-label={ariaLabel}
      />
      </VariableConnect>
    </div>
  )
}

// ─────────────────────────── Icons ───────────────────────────

function CornerIcon({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const rot = { tl: 0, tr: 90, br: 180, bl: 270 }[corner]
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M3 13V7a4 4 0 0 1 4-4h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
function LinkedRadiusIcon() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3.5" stroke="currentColor" strokeWidth="1.4" /></svg>
}
function SplitRadiusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 6V5a2 2 0 0 1 2-2h1" /><path d="M10 3h1a2 2 0 0 1 2 2v1" />
      <path d="M13 10v1a2 2 0 0 1-2 2h-1" /><path d="M6 13H5a2 2 0 0 1-2-2v-1" />
    </svg>
  )
}

// ─────────────────────────── Radius ───────────────────────────

const RADIUS = 'border-radius'
const CORNERS = [
  { prop: 'border-top-left-radius', corner: 'tl' as const },
  { prop: 'border-top-right-radius', corner: 'tr' as const },
  { prop: 'border-bottom-left-radius', corner: 'bl' as const },
  { prop: 'border-bottom-right-radius', corner: 'br' as const },
]
const CORNER_PROPS = CORNERS.map((c) => c.prop)

type Corners = { tl: string; tr: string; bl: string; br: string }

// Parse a `border-radius` shorthand into our four corners. Only the horizontal
// radii drive per-corner editing (the elliptical `/ y…` part, if present, is
// dropped). 1–4 values expand per spec: 1 → all; 2 → tl/br=a, tr/bl=b;
// 3 → tl=a, tr/bl=b, br=c; 4 → tl tr br bl.
function parseRadius(shorthand: string): Corners {
  const p = splitTopLevelSpaces(stripImportant(shorthand).split('/')[0]).filter(Boolean)
  return {
    tl: p[0] ?? '',
    tr: p[1] ?? p[0] ?? '',
    br: p[2] ?? p[0] ?? '',
    bl: p[3] ?? p[1] ?? p[0] ?? '',
  }
}

// Build the tightest `border-radius` shorthand (TL TR BR BL), collapsing equal
// runs; empty corners default to 0.
function serializeRadius(c: Corners): string {
  const v = (x: string) => x.trim() || '0'
  const tl = v(c.tl), tr = v(c.tr), br = v(c.br), bl = v(c.bl)
  if (tl === tr && tr === br && br === bl) return tl
  if (tl === br && tr === bl) return `${tl} ${tr}`
  if (tr === bl) return `${tl} ${tr} ${br}`
  return `${tl} ${tr} ${br} ${bl}`
}

function RadiusControl(props: Props) {
  const { read, busy } = props
  // Webflow models the four corners as one `border-radius` shorthand — writing the
  // corner longhands individually makes it drop the others (they flash and reset).
  // So we always read/write the single shorthand, and split mode edits rebuild it.
  // Explicit corner longhands (an author's embed) still take precedence for display.
  const cornerReads = CORNERS.map((c) => displayOf(read(c.prop)))
  const anyCorner = cornerReads.some((d) => d.present)
  const radiusD = displayOf(read(RADIUS))
  const parsed = parseRadius(radiusD.value)
  const cornerVals = CORNERS.map((c, i) => (cornerReads[i].present ? cornerReads[i].value : parsed[c.corner]))
  const allEqual = cornerVals.every((v) => v === cornerVals[0])
  const present = anyCorner || radiusD.present
  const single = allEqual ? cornerVals[0] : ''

  const [override, setOverride] = useState<boolean | null>(null)
  const linked = override ?? (present ? allEqual : true)

  // Every radius edit writes the ONE `border-radius` property (no corner coupling),
  // clearing any stray corner longhands so the shorthand is the single source.
  const writeShorthand = (value: string, important: boolean, live: boolean) => {
    ;(live ? props.liveSetProp : props.setProp)(RADIUS, value, important)
    if (!live && anyCorner) props.clearProp(CORNER_PROPS)
  }
  const writeAll = (next: string, live: boolean) => {
    const trimmed = next.trim()
    if (!trimmed) { if (!live) props.clearProp([RADIUS, ...CORNER_PROPS]); return }
    const { value, important } = parseImportant(trimmed)
    writeShorthand(value, important, live)
  }
  const writeCorner = (index: number, next: string, live: boolean) => {
    const corners: Corners = { tl: cornerVals[0], tr: cornerVals[1], bl: cornerVals[2], br: cornerVals[3] }
    corners[CORNERS[index].corner] = stripImportant(next.trim())
    writeShorthand(serializeRadius(corners), false, live)
  }
  const clearAll = () => { setOverride(null); props.clearProp([RADIUS, ...CORNER_PROPS]) }
  const setMode = (mode: string) => {
    if (mode === 'linked') {
      setOverride(true)
      const seed = stripImportant(single) || cornerVals.map(stripImportant).find(Boolean) || ''
      if (seed) writeAll(seed, false); else clearAll()
    } else setOverride(false)
  }

  return (
    <>
      <div className="embed-editor_size-row">
        <GroupLabel label="Radius" props={[RADIUS, ...CORNER_PROPS]} read={read} busy={busy} onClear={clearAll} onProvenance={props.onProvenance} onSelectSelector={props.onSelectSelector} />
        <div className="embed-editor_radius-head">
          <SegmentedControl
            className="embed-editor_radius-toggle"
            widthMode="hug"
            value={linked ? 'linked' : 'split'}
            options={[
              { value: 'linked', label: <LinkedRadiusIcon />, ariaLabel: 'One radius for all corners' },
              { value: 'split', label: <SplitRadiusIcon />, ariaLabel: 'Radius per corner' },
            ]}
            onChange={setMode}
          />
          {linked ? (
            <LiveInput value={single} busy={busy} ariaLabel="Border radius" prop="border-radius" onLive={(v) => writeAll(v, true)} onCommit={(v) => writeAll(v, false)} />
          ) : null}
        </div>
      </div>
      {!linked ? (
        <div className="embed-editor_radius-grid">
          {CORNERS.map((c, i) => (
            <LiveInput
              key={c.prop}
              value={cornerVals[i]}
              busy={busy}
              ariaLabel={`${c.corner} radius`}
              prop={c.prop}
              prefix={<span className="embed-editor_border-icon"><CornerIcon corner={c.corner} /></span>}
              onLive={(v) => writeCorner(i, v, true)}
              onCommit={(v) => writeCorner(i, v, false)}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

// ─────────────────────────── Border side + style/width/color ───────────────────────────

const SIDES = ['all', 'top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]
type Facet = 'style' | 'width' | 'color'
const EDGES = ['top', 'right', 'bottom', 'left'] as const

// Props the label clears — for 'all', all four edges plus any leftover shorthand.
const facetClear = (facet: Facet, side: Side): string[] =>
  side === 'all' ? [`border-${facet}`, ...EDGES.map((s) => `border-${s}-${facet}`)] : [`border-${side}-${facet}`]
// Representative property to read / label. A single side owns its edge longhand;
// "all" owns only the border facet shorthand. It must not borrow a side value — doing
// so makes the center selector show (and edit) Bottom when only Bottom is configured.
function facetRead(facet: Facet, side: Side, read: Read): { d: Display; prop: string } {
  const prop = side === 'all' ? `border-${facet}` : `border-${side}-${facet}`
  return { d: displayOf(read(prop)), prop }
}
const facetExternal = (d: Display) => (d.present ? (d.important ? `${d.value} !important` : d.value) : '')
function facetWrite(facet: Facet, side: Side, props: Props) {
  return (next: string, live: boolean) => {
    const trimmed = next.trim()
    if (!trimmed) { if (!live) props.clearProp(facetClear(facet, side)); return }
    const { value, important } = parseImportant(trimmed)
    const set = live ? props.liveSetProp : props.setProp
    if (side === 'all') {
      // Write the SINGLE `border-<facet>` shorthand — not the four edge longhands.
      // Webflow groups the sides, so setting them one at a time makes it drop/flash
      // the others (the read/write thrash the radius control avoids by writing one
      // `border-radius`). One property → one native write → no flicker.
      set(`border-${facet}`, value, important)
      // On commit, drop any stray per-side longhands so the shorthand stays the source
      // — but only when some exist, so a plain "all" edit stays a single write.
      if (!live) {
        const strays = EDGES.map((s) => `border-${s}-${facet}`).filter((p) => displayOf(props.read(p)).present)
        if (strays.length) props.clearProp(strays)
      }
    } else {
      set(`border-${side}-${facet}`, value, important)
    }
  }
}

// A blue edge means the picked selector actually sets that side. Keep this separate
// from `side` (the neutral raised button), which only says which side's fields are
// currently open. This lets Bottom remain visibly applied while All is being viewed.
function appliedBorderSides(read: Read): Set<Side> {
  const applied = new Set<Side>()
  const owns = (prop: string) => displayOf(read(prop)).isSelected
  if (['border', 'border-style', 'border-width', 'border-color'].some(owns)) applied.add('all')
  for (const side of EDGES) {
    if ([`border-${side}`, `border-${side}-style`, `border-${side}-width`, `border-${side}-color`].some(owns)) {
      applied.add(side)
    }
  }
  return applied
}

function SideSelector({ side, applied, onPick }: { side: Side; applied: ReadonlySet<Side>; onPick: (s: Side) => void }) {
  const btn = (s: Side, label: string) => (
    <button
      type="button"
      className={`embed-editor_border-side is-${s} ${side === s ? 'is-active' : ''} ${applied.has(s) ? 'is-applied' : ''}`}
      aria-pressed={side === s}
      aria-label={s === 'all' ? 'All borders' : `${label} border`}
      onClick={() => onPick(s)}
    >
      <span className="embed-editor_border-side-mark" />
    </button>
  )
  return (
    <div className="embed-editor_border-sides" role="group" aria-label="Border side">
      {btn('top', 'Top')}
      <div className="embed-editor_border-sides-mid">
        {btn('left', 'Left')}
        {btn('all', 'All')}
        {btn('right', 'Right')}
      </div>
      {btn('bottom', 'Bottom')}
    </div>
  )
}

const STYLE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'none', label: '✕', ariaLabel: 'None' },
  { value: 'solid', label: <span className="embed-editor_border-style-line is-solid" />, ariaLabel: 'Solid' },
  { value: 'dashed', label: <span className="embed-editor_border-style-line is-dashed" />, ariaLabel: 'Dashed' },
  { value: 'dotted', label: <span className="embed-editor_border-style-line is-dotted" />, ariaLabel: 'Dotted' },
]
const STYLE_VALUES = new Set(STYLE_OPTIONS.map((o) => o.value))

function ChevronIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function MenuItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`} onClick={onClick}>
      {label}
    </button>
  )
}

// The border-style segmented bar (None / Solid / Dashed / Dotted) + a chevron menu
// whose Custom item enters a free-value mode (double / groove / var()…) and offers
// the presets to switch back — mirroring the Display / Float / Clear controls. Writes
// go through the side-aware `write` (which handles the `border-style` shorthand for
// "all" vs a per-side longhand).
function StyleControl({ value, busy, write, clear }: {
  value: string
  busy: boolean
  write: (value: string, live: boolean) => void
  clear: () => void
}) {
  const lower = value.trim().toLowerCase()
  const customMode = !!lower && !STYLE_VALUES.has(lower)
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
  useEffect(() => { if (customMode && !focused.current) setDraft(value) }, [customMode, value])
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) { wantFocus.current = false; inputRef.current?.focus(); inputRef.current?.select() }
  }, [customMode, busy])

  const pick = (next: string) => { setOpen(false); if (next !== lower) write(next, false) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; write('unset', false) }
  const commitCustom = () => {
    const trimmed = draft.trim()
    if (!trimmed) { clear(); return }
    const { value: v, important } = parseImportant(trimmed)
    write(important ? `${v} !important` : v, false)
  }

  return (
    <div ref={rootRef} className={`embed-editor_display embed-editor_border-style ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Border style">
      {customMode ? (
        <VariableConnect ariaLabel="Connect border style to a variable" disabled={busy} prop="border-style" onPick={(binding) => write(binding, false)}>
        <input
          ref={inputRef}
          className="embed-editor_value-input embed-editor_display-input"
          value={draft}
          placeholder="custom value"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => { setDraft(event.target.value); const t = event.target.value.trim(); if (t) write(t, true) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; commitCustom() }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          aria-label="Border style value"
        />
        </VariableConnect>
      ) : (
        STYLE_OPTIONS.map((seg) => (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={lower === seg.value}
            className={`embed-editor_display-seg ${lower === seg.value ? 'is-selected' : ''}`}
            disabled={busy}
            title={seg.ariaLabel}
            aria-label={seg.ariaLabel}
            onClick={() => pick(seg.value)}
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
        aria-label="More border style options"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode
            ? STYLE_OPTIONS.map((seg) => <MenuItem key={seg.value} label={seg.ariaLabel ?? seg.value} selected={lower === seg.value} onClick={() => pick(seg.value)} />)
            : <MenuItem label="Custom" selected={false} onClick={enterCustom} />}
        </div>
      ) : null}
    </div>
  )
}

export function ColorVariableInput({
  value,
  swatchValue = value,
  busy,
  ariaLabel,
  prop = 'color',
  onLive,
  onCommit,
  onVariablePick,
}: {
  value: string
  swatchValue?: string
  busy: boolean
  ariaLabel: string
  prop?: string
  onLive: (value: string) => void
  onCommit: (value: string) => void
  onVariablePick?: (binding: string) => void
}) {
  return (
    <div className="embed-editor_border-color">
      <ColorSwatch value={stripImportant(swatchValue)} busy={busy} ariaLabel={ariaLabel} onChange={(color, live) => live ? onLive(color) : onCommit(color)} />
      <LiveInput
        value={value}
        busy={busy}
        ariaLabel={ariaLabel}
        placeholder="black"
        prop={prop}
        onLive={onLive}
        onCommit={onCommit}
        onVariablePick={onVariablePick}
      />
    </div>
  )
}

function ColorField({ side, props }: { side: Side; props: Props }) {
  const value = facetExternal(facetRead('color', side, props.read).d)
  const write = facetWrite('color', side, props)
  return (
    <ColorVariableInput
      value={value}
      busy={props.busy}
      ariaLabel={`${side} border color`}
      prop="border-color"
      onLive={(next) => write(next, true)}
      onCommit={(next) => write(next, false)}
    />
  )
}

function BorderControl(props: Props) {
  const { busy } = props
  const [side, setSide] = useState<Side>('all')
  const applied = appliedBorderSides(props.read)
  const styleF = facetRead('style', side, props.read)
  const widthF = facetRead('width', side, props.read)
  const colorF = facetRead('color', side, props.read)
  const writeStyle = facetWrite('style', side, props)
  const writeWidth = facetWrite('width', side, props)

  return (
    <div className="embed-editor_border-body">
      <SideSelector side={side} applied={applied} onPick={setSide} />
      <div className="embed-editor_border-fields">
        <div className="embed-editor_size-row">
          <PropLabel label="Style" prop={styleF.prop} clearProps={facetClear('style', side)} {...props} />
          <StyleControl
            value={styleF.d.present ? styleF.d.value.trim() : ''}
            busy={busy}
            write={writeStyle}
            clear={() => props.clearProp(facetClear('style', side))}
          />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel label="Width" prop={widthF.prop} clearProps={facetClear('width', side)} {...props} />
          <LiveInput value={facetExternal(widthF.d)} busy={busy} ariaLabel={`${side} border width`} prop="border-width" onLive={(v) => writeWidth(v, true)} onCommit={(v) => writeWidth(v, false)} />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel label="Color" prop={colorF.prop} clearProps={facetClear('color', side)} {...props} />
          <ColorField side={side} props={props} />
        </div>
      </div>
    </div>
  )
}

export default function BordersSection(props: Props) {
  return (
    <div className="embed-editor_borders">
      <RadiusControl {...props} />
      <div className="embed-editor_border-heading">Borders</div>
      <BorderControl {...props} />
    </div>
  )
}
