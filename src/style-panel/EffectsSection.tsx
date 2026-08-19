import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { parseHideable, serializeHideable, type Hideable } from './lib/hideable'
import TransformSettings from './TransformSettings'
import { takeSelfPerspective, withSelfPerspective } from './lib/transform-settings'
import { createPortal } from 'react-dom'
import FieldLabel from './components/FieldLabel'
import { PropTip, ProvenanceLabel } from './components/PropTip'
import Select, { type SelectOption } from './components/Select'
import DragSlider from './components/DragSlider'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import SegmentedField, { type SegOption } from './SegmentedField'
import ColorSwatch from './components/ColorSwatch'
import { useLiveColor } from './lib/live-color'
import LayerList from './LayerList'
import LayerPopover from './LayerPopover'
import { CURSOR_ICONS } from './cursor-icons'
import { useComputedChoice } from './lib/computed-style'
import { ShadowNum, ShadowColorRow } from './ShadowFields'
import { parseBoxShadows, serializeBoxShadows, blankBoxShadow, boxShadowLabel, type BoxShadow } from './lib/box-shadow'
import { handleArrowStep } from './lib/number-step'
import { parseTransforms, serializeTransforms, blankTransform, retypeTransform, transformLabel, hasZ, IDENTITY, type Transform, type TransformType } from './lib/transform'
import { transformAxisIcon, transformTypeIcon, LockIcon, UnlockIcon } from './transform-icons'
import ProvenanceList from './ProvenanceList'
import VariableConnect from './VariableConnect'
import type { Contributor, ResolvedProp } from './lib/resolved'
import EasingEditor from './EasingEditor'
import { parseTransitions, serializeTransitions, blankTransition, transitionLabel, easingToBezier, TRANSITION_GROUPS, type Transition } from './lib/transition'
import { parseFilters, serializeFilters, blankFilter, filterLabel, type Filter } from './lib/filter'
import FilterEditor from './FilterFields'
import { commitInPlace } from './lib/commit-in-place'

// The Effects section (Webflow parity): blending, opacity, outline, box shadows,
// transforms, transitions, filters, backdrop filters, cursor, and pointer-events.
// Each control is driven by the resolved model (blue when the picked selector sets
// it, orange via another selector, a clear menu on the label). The list-style
// effects (shadows/transforms/…) edit their raw CSS value for now.

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

// The property label: blue/active when the picked selector sets it (with a clear
// menu + provenance), orange when it's set through another selector.
function EffLabel({ label, prop, props }: { label: string; prop: string; props: Props }) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props
  const d = displayOf(read(prop))
  const contributors: Contributor[] = read(prop)?.contributors ?? []
  if (d.present && !d.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${d.overridden ? 'is-overridden' : ''}`}
      active={d.isSelected}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      title={d.overridden ? `Overridden by ${d.winnerSelector}` : undefined}
      menuNote={(close) => <ProvenanceList contributors={contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
    >
      {label}
    </FieldLabel>
  )
}

// The outline's colour: the swatch and the field beside it, both showing a drag
// as it happens. The drag writes to the canvas, not to the model the field
// reads, so without this the page moves under the pointer while the number
// sits still (see live-color.ts).
function OutlineColor({ props, value }: { props: Props; value: string }) {
  const { busy, setProp, liveSetProp } = props
  const [shown, noteLive] = useLiveColor(value)
  return (
    <>
      <ColorSwatch
        value={shown}
        busy={busy}
        ariaLabel="Outline color"
        onChange={(c, live) => {
          noteLive(live ? c : null)
          if (live) liveSetProp('outline-color', c, false)
          else setProp('outline-color', c, false)
        }}
      />
      <LiveText prop="outline-color" placeholder="currentColor" props={props} dragging={shown === value ? undefined : shown} />
    </>
  )
}

// A live text field bound to one property (raw CSS value editors).
function LiveText({ prop, placeholder, props, dragging }: { prop: string; placeholder: string; props: Props; dragging?: string }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read(prop))
  // `dragging` is what a swatch beside this field is showing mid-drag.
  const external = dragging ?? (d.present ? (d.important ? `${d.value} !important` : d.value) : '')
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const live = (text: string) => {
    cancel()
    timer.current = window.setTimeout(() => { const t = text.trim(); if (t) { const p = parseImportant(t); liveSetProp(prop, p.value, p.important) } }, 100)
  }
  const commit = () => {
    const t = draft.trim()
    if (!t) { clearProp(prop); return }
    const p = parseImportant(t)
    setProp(prop, p.value, p.important)
  }
  return (
    <VariableConnect code className="is-fill" ariaLabel={`Connect ${prop} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
    <input
      className="u-input embed-editor_size-input embed-editor_eff-value"
      data-prop={prop}
      value={draft}
      onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancel(); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
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
      aria-label={prop}
    />
    </VariableConnect>
  )
}

// ─────────────────────────── Option lists ───────────────────────────

const BLEND_MODES: SelectOption<string>[] = [
  'normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge', 'overlay',
  'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
].map((v) => ({ value: v, label: v === 'color-burn' ? 'Color burn' : v === 'color-dodge' ? 'Color dodge' : v === 'soft-light' ? 'Soft light' : v === 'hard-light' ? 'Hard light' : v[0].toUpperCase() + v.slice(1) }))

// Grouped like Webflow's cursor menu: a non-selectable heading per group, each
// cursor indented and shown with its Webflow glyph.
const CURSOR_GROUPS: ReadonlyArray<{ heading: string; values: string[] }> = [
  { heading: 'General', values: ['auto', 'default', 'none'] },
  { heading: 'Links & Status', values: ['pointer', 'not-allowed', 'wait', 'progress', 'help', 'context-menu'] },
  { heading: 'Selection', values: ['cell', 'crosshair', 'text', 'vertical-text'] },
  { heading: 'Drag & Drop', values: ['grab', 'grabbing', 'alias', 'copy', 'move'] },
  { heading: 'Zoom', values: ['zoom-in', 'zoom-out'] },
  { heading: 'Resize', values: ['col-resize', 'row-resize', 'nesw-resize', 'nwse-resize', 'ew-resize', 'ns-resize', 'n-resize', 'w-resize', 's-resize', 'e-resize', 'nw-resize', 'ne-resize', 'sw-resize', 'se-resize'] },
]
const CURSORS: SelectOption<string>[] = CURSOR_GROUPS.flatMap((g) => [
  { value: `__${g.heading}`, label: g.heading, heading: true },
  ...g.values.map((v) => ({ value: v, label: v, icon: CURSOR_ICONS[v], indent: true })),
])

const OUTLINE_OPTS: readonly SegOption[] = [
  { value: 'none', label: '✕', menuLabel: 'None', ariaLabel: 'None' },
  { value: 'solid', label: <span className="embed-editor_border-style-line is-solid" />, menuLabel: 'Solid', ariaLabel: 'Solid' },
  { value: 'dashed', label: <span className="embed-editor_border-style-line is-dashed" />, menuLabel: 'Dashed', ariaLabel: 'Dashed' },
  { value: 'dotted', label: <span className="embed-editor_border-style-line is-dotted" />, menuLabel: 'Dotted', ariaLabel: 'Dotted' },
]
const EVENTS_OPTS: readonly SegOption[] = [
  { value: 'auto', label: 'Auto', menuLabel: 'Auto' },
  { value: 'none', label: 'None', menuLabel: 'None' },
]

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
)

// The "Custom…" sentinel + preset value sets (values that ARE listed in the dropdown,
// so anything else counts as a custom value that opens the input).
const CUSTOM = '__custom__'
const BLEND_SET = new Set(BLEND_MODES.map((o) => o.value))
const CURSOR_SET = new Set(CURSOR_GROUPS.flatMap((g) => g.values))

// The free-text input the Select swaps in when "Custom…" is picked (or the current
// value isn't a listed preset). Empty when just switched from a preset, so you type
// a fresh value; committing empty clears the property and returns to the dropdown.
function CustomInput({ prop, value, placeholder, busy, autoFocus, setProp, liveSetProp, clearProp, onExit }: {
  prop: string
  value: string
  placeholder: string
  busy: boolean
  autoFocus: boolean
  setProp: SetProp
  liveSetProp: LiveSetProp
  clearProp: ClearProp
  onExit: () => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const live = (text: string) => {
    cancel()
    timer.current = window.setTimeout(() => { const t = text.trim(); if (t) { const p = parseImportant(t); liveSetProp(prop, p.value, p.important) } }, 100)
  }
  const commit = () => {
    const t = draft.trim()
    if (!t) { clearProp(prop); onExit(); return }
    const p = parseImportant(t)
    setProp(prop, p.value, p.important)
  }
  return (
    <VariableConnect ariaLabel={`Connect ${prop} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
    <input
      className="u-input u-select-custom-input"
      value={draft}
      autoFocus={autoFocus}
      onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancel(); commit() }}
      onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={prop}
    />
    </VariableConnect>
  )
}

// A preset dropdown whose last option is "Custom…" — picking it (or an existing
// value not in the list) swaps the trigger for a free-text input.
function PresetSelectRow({ prop, label, options, presets, fallback, placeholder, props, allowCustom = true }: {
  prop: string
  label: string
  options: SelectOption<string>[]
  presets: Set<string>
  fallback: string
  placeholder: string
  props: Props
  /** Offer a "Custom…" free-value option. Off for enumerated props (e.g. cursor)
   *  where Webflow won't store arbitrary/CSS-wide values anyway. */
  allowCustom?: boolean
}) {
  const { read, busy, setProp, liveSetProp, clearProp } = props
  const d = displayOf(read(prop))
  const current = d.present ? d.value.trim() : ''
  // Nothing authored → highlight what the page actually computes for this element,
  // falling back to the CSS initial value when there's no canvas to ask.
  const computed = useComputedChoice(current ? '' : prop, options.map((o) => o.value))
  const isPreset = !current || presets.has(current)
  const [forceCustom, setForceCustom] = useState(false)
  const customMode = allowCustom && (forceCustom || (d.present && !isPreset))
  const pick = (v: string) => {
    if (v === CUSTOM) { setForceCustom(true); return }
    setForceCustom(false)
    setProp(prop, v, false)
  }
  const inputValue = forceCustom && isPreset ? '' : (d.present ? (d.important ? `${d.value} !important` : d.value) : '')
  // With Custom off, still surface a pre-existing non-preset value so the trigger
  // shows it (rather than silently falling back to the first option).
  const selectOptions = allowCustom
    ? [...options, { value: CUSTOM, label: 'Custom…' }]
    : (d.present && !isPreset ? [...options, { value: current, label: current }] : options)
  return (
    <div className="embed-editor_size-row">
      <EffLabel label={label} prop={prop} props={props} />
      <Select
        value={customMode ? CUSTOM : (current || computed || fallback)}
        options={selectOptions}
        onChange={pick}
        onPreview={(v) => liveSetProp(prop, v === CUSTOM ? null : v, false)}
        ariaLabel={label}
        disabled={busy}
        customInput={customMode ? (
          <CustomInput prop={prop} value={inputValue} placeholder={placeholder} busy={busy} autoFocus={forceCustom}
            setProp={setProp} liveSetProp={liveSetProp} clearProp={clearProp} onExit={() => setForceCustom(false)} />
        ) : undefined}
      />
    </div>
  )
}

// ─────────────────────────── Rows ───────────────────────────

function OpacityRow({ props }: { props: Props }) {
  const { read, busy, setProp, liveSetProp } = props
  const d = displayOf(read('opacity'))
  const raw = d.present ? d.value.trim() : ''
  const pctOf = (v: string) => {
    if (!v) return 100
    const n = parseFloat(v)
    if (Number.isNaN(n)) return 100
    return Math.round(v.includes('%') ? n : n * 100)
  }
  const pct = pctOf(raw)
  const toCss = (p: number) => (p >= 100 ? '1' : p <= 0 ? '0' : String(Math.round(p) / 100))
  const clamp = (p: number) => Math.min(100, Math.max(0, Math.round(p)))
  // Drag previews live (DragSlider already throttles the writes); release commits.
  const live = (p: number) => liveSetProp('opacity', toCss(clamp(p)), false)
  const commit = (p: number) => setProp('opacity', toCss(clamp(p)), false)

  // The number field's local draft: typing previews live; blur / Enter commits.
  const [text, setText] = useState(String(pct))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(String(pct)) }, [pct])
  const parse = (t: string) => { const n = parseFloat(t); return Number.isNaN(n) ? null : clamp(n) }

  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Opacity" prop="opacity" props={props} />
      <div className="embed-editor_shadow-field">
        <DragSlider value={pct} min={0} max={100} disabled={busy} ariaLabel="Opacity"
          onPreview={(p) => { if (!focused.current) setText(String(p)) }}
          onInput={live}
          onCommit={(p) => { if (!focused.current) setText(String(p)); commit(p) }} />
        <div className="embed-editor_grad-num embed-editor_opacity-num">
          <VariableConnect className="is-fill" ariaLabel="Connect Opacity to a variable" disabled={busy} prop="opacity" onPick={(binding) => setProp('opacity', binding, false)}>
          <input
            className="u-input embed-editor_grad-num-input"
            value={text}
            inputMode="decimal"
            spellCheck={false}
            disabled={busy}
            aria-label="Opacity percent"
            onFocus={() => { focused.current = true }}
            onChange={(e) => { setText(e.target.value); const n = parse(e.target.value); if (n != null) live(n) }}
            onBlur={() => { focused.current = false; const n = parse(text); if (n != null) commit(n); else setText(String(pct)) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
              const stepped = handleArrowStep(e)
              if (!stepped) return
              e.preventDefault()
              e.currentTarget.value = stepped.text
              e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
              setText(stepped.text)
              const n = parse(stepped.text); if (n != null) live(n)
            }}
          />
          </VariableConnect>
          <span className="embed-editor_grad-num-unit">%</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────── 2D & 3D transforms (layered, mirrors text-shadow) ───────────────

const TRANSFORM_TYPES: ReadonlyArray<SegmentedOption<TransformType>> = [
  { value: 'move', label: 'Move' },
  { value: 'scale', label: 'Scale' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'skew', label: 'Skew' },
]

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="8" r="1.15" fill="currentColor" /><circle cx="8" cy="8" r="1.15" fill="currentColor" /><circle cx="12" cy="8" r="1.15" fill="currentColor" /></svg>
)
const TransformPlusIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>)

const FilterGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path d="M2.5 4h11l-4.2 5v3.5L6.7 14V9L2.5 4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
)

// The Filters / Backdrop filters row: a stack of filter functions (blur/brightness/…/
// drop-shadow) edited as one CSS `filter` value. Mirrors TransformsRow.
function FiltersRow({ prop, label, props }: { prop: string; label: string; props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read(prop))
  // Shared by Filters and Backdrop filters, so both get the eye from here.
  const rows = parseHideable(d.present ? d.value : '', ' ', parseFilters)
  const layers = rows.map((r) => r.item)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const write = (next: Array<Hideable<Filter>>, live: boolean) => {
    const value = serializeHideable(next, ' ', serializeFilters)
    if (live) { if (value) liveSetProp(prop, value, false); return }
    if (value) setProp(prop, value, false); else clearProp(prop)
  }
  const add = () => { const next = [...rows, { item: blankFilter(), hidden: false }]; write(next, false); setOpenIdx(next.length - 1) }
  const remove = (i: number) => { write(rows.filter((_, j) => j !== i), false); setOpenIdx((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur)) }
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); write(next, false)
    setOpenIdx((cur) => (cur === from ? to : cur))
  }
  const patch = (i: number, next: Filter, live: boolean) => write(rows.map((r, j) => (j === i ? { ...r, item: next } : r)), live)
  const toggle = (i: number) => write(rows.map((r, j) => (j === i ? { ...r, hidden: !r.hidden } : r)), false)
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label={label} prop={prop} props={props} />
        <button type="button" className="embed-editor_icon-btn" onClick={add} disabled={busy} title={`Add a ${label.toLowerCase()} filter`} aria-label="Add a filter"><TransformPlusIcon /></button>
      </div>
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel={label}
        onOpen={(i, el) => { setOpenIdx((cur) => (cur === i ? null : i)); setAnchorEl(el) }}
        onReorder={reorder}
        onRemove={remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={toggle}
        renderRow={(i) => ({ preview: <FilterGlyph />, label: filterLabel(layers[i]) })}
      />
      {openIdx != null && anchorEl && layers[openIdx] ? (
        <LayerPopover anchorEl={anchorEl} ariaLabel={label} onClose={() => setOpenIdx(null)}>
          <FilterEditor filter={layers[openIdx]} busy={busy} onChange={(next, live) => patch(openIdx!, next, live)} />
        </LayerPopover>
      ) : null}
    </div>
  )
}

// Per-type slider config: the unit the slider re-attaches, its coarse range (in value
// units), and how many slider steps map to one unit. The slider is integer-only, so
// `scale` (0–2) runs in hundredths for sub-integer precision; the number field always
// allows a precise value outside the range.
const AXIS_CFG: Record<TransformType, { unit: string; min: number; max: number; steps: number }> = {
  // Move is in rem unless the value itself says otherwise — `steps` is how many
  // slider notches make one unit, so 100 gives hundredths of a rem across a
  // range wide enough to push something off its own width.
  move: { unit: 'rem', min: -20, max: 20, steps: 100 },
  scale: { unit: '', min: 0, max: 2, steps: 100 },
  rotate: { unit: 'deg', min: -180, max: 180, steps: 1 },
  skew: { unit: 'deg', min: -90, max: 90, steps: 1 },
}

// Split "10px" / "1.5" / "45deg" into number + unit (bare number → the type's default
// unit); null for var()/calc()/… so the slider disables but the field stays editable.
function parseAxis(value: string, fallbackUnit: string): { num: number; unit: string } | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i)
  if (!m) return null
  // `none` isn't a real axis unit — never re-attach it (that's what produces `1none`).
  const raw = m[2].toLowerCase() === 'none' ? '' : m[2]
  return { num: parseFloat(m[1]), unit: raw || fallbackUnit }
}

// One transform axis (X / Y / Z): a coarse drag slider beside a precise number field,
// mirroring text-shadow's ShadowNum. The slider drives the numeric part and re-attaches
// the value's unit; the field holds the full value (e.g. `10px`) so var()/calc() and any
// unit survive.
function AxisInput({ type, label, value, placeholder, busy, onPreview, onLive, onCommit }: {
  type: TransformType; label: string; value: string; placeholder: string; busy: boolean
  /** Per-frame during a slider drag (before the throttled onLive) — lets a linked pair
   *  mirror this axis smoothly, not just on the throttled write. */
  onPreview?: (v: string) => void; onLive: (v: string) => void; onCommit: (v: string) => void
}) {
  const cfg = AXIS_CFG[type]
  const parsed = parseAxis(value, cfg.unit)
  const unit = parsed?.unit ?? cfg.unit
  const fmt = (slider: number): string => `${Number((slider / cfg.steps).toFixed(4))}${unit}`

  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const timer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancel = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const live = (text: string) => { cancel(); timer.current = window.setTimeout(() => { const t = text.trim(); if (t) onLive(t) }, 100) }
  const commit = () => { const t = draft.trim(); onCommit(t || placeholder) }
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption embed-editor_transform-axis" aria-hidden="true">{transformAxisIcon(type, label.toLowerCase() as 'x' | 'y' | 'z')}</span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={Math.round((parsed?.num ?? 0) * cfg.steps)}
          min={cfg.min * cfg.steps}
          max={cfg.max * cfg.steps}
          disabled={busy || !parsed}
          ariaLabel={label}
          onPreview={(s) => { const v = fmt(s); if (!focused.current) setDraft(v); onPreview?.(v) }}
          onInput={(s) => onLive(fmt(s))}
          onCommit={(s) => onCommit(fmt(s))}
        />
        <input
          className="u-input embed-editor_size-input embed-editor_shadow-num"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); live(e.target.value) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; cancel(); commit() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
            const stepped = handleArrowStep(e)
            if (!stepped) return
            e.preventDefault()
            e.currentTarget.value = stepped.text
            e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
            setDraft(stepped.text); live(stepped.text)
          }}
          disabled={busy}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
        />
      </div>
    </div>
  )
}

// The per-layer editor: a Type toggle (Move/Scale/Rotate/Skew) + X/Y/Z fields (Z is
// hidden for Skew, which is 2D). Switching Type resets the axes to that type's identity.
function TransformEditor({ layer, busy, onChange }: { layer: Transform; busy: boolean; onChange: (patch: Partial<Transform>, live: boolean) => void }) {
  const id = IDENTITY[layer.type]
  // Scale defaults to linked X & Y (uniform scale, like Webflow); the lock toggles it.
  const [locked, setLocked] = useState(true)
  const linkXY = layer.type === 'scale' && locked
  // Optimistic axis values so a LINKED drag moves BOTH sliders together, every frame. A
  // live/preview write previews to the canvas but doesn't refresh the read model `layer`
  // derives from, so the partner slider (driven by its value prop) would otherwise sit
  // still until release. Mirror every edit here and feed these to the fields.
  const [live, setLive] = useState<{ x: string; y: string; z: string }>({ x: layer.x, y: layer.y, z: layer.z })
  useEffect(() => { setLive({ x: layer.x, y: layer.y, z: layer.z }) }, [layer.x, layer.y, layer.z])
  const bump = (patch: Partial<Transform>) => setLive((cur) => ({ x: patch.x ?? cur.x, y: patch.y ?? cur.y, z: patch.z ?? cur.z }))
  // One axis edit → the axes it actually drives (X and Y move together when linked).
  const px = (v: string): Partial<Transform> => (linkXY ? { x: v, y: v } : { x: v })
  const py = (v: string): Partial<Transform> => (linkXY ? { x: v, y: v } : { y: v })
  const pz = (v: string): Partial<Transform> => ({ z: v })
  const preview = (p: Partial<Transform>) => bump(p)
  const emitLive = (p: Partial<Transform>) => { bump(p); onChange(p, true) }
  const emitCommit = (p: Partial<Transform>) => { bump(p); onChange(p, false) }
  const retype = (type: TransformType) => { const p = retypeTransform(type); bump(p); onChange(p, false) }
  return (
    <div className="embed-editor_type-shadow-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <SegmentedControl value={layer.type} options={TRANSFORM_TYPES} onChange={retype} ariaLabel="Transform type" />
      </div>
      {layer.type === 'scale' ? (
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="X" value={live.x} placeholder={id} busy={busy} onPreview={(v) => preview(px(v))} onLive={(v) => emitLive(px(v))} onCommit={(v) => emitCommit(px(v))} />
            <AxisInput type="scale" label="Y" value={live.y} placeholder={id} busy={busy} onPreview={(v) => preview(py(v))} onLive={(v) => emitLive(py(v))} onCommit={(v) => emitCommit(py(v))} />
          </div>
          <button
            type="button"
            className={`embed-editor_transform-lock ${locked ? 'is-locked' : ''}`}
            onClick={() => setLocked((v) => !v)}
            disabled={busy}
            aria-pressed={locked}
            title={locked ? 'Unlink X & Y' : 'Link X & Y'}
            aria-label={locked ? 'Unlink X and Y' : 'Link X and Y'}
          >
            {locked ? LockIcon : UnlockIcon}
          </button>
        </div>
      ) : (
        <>
          <AxisInput type={layer.type} label="X" value={live.x} placeholder={id} busy={busy} onPreview={(v) => preview(px(v))} onLive={(v) => emitLive(px(v))} onCommit={(v) => emitCommit(px(v))} />
          <AxisInput type={layer.type} label="Y" value={live.y} placeholder={id} busy={busy} onPreview={(v) => preview(py(v))} onLive={(v) => emitLive(py(v))} onCommit={(v) => emitCommit(py(v))} />
        </>
      )}
      {!hasZ(layer.type) ? null : layer.type === 'scale' ? (
        // Z reserves the same right gutter the lock button occupies, so its slider +
        // number field line up with X and Y.
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="Z" value={live.z} placeholder={id} busy={busy} onPreview={(v) => preview(pz(v))} onLive={(v) => emitLive(pz(v))} onCommit={(v) => emitCommit(pz(v))} />
          </div>
          <span className="embed-editor_transform-lock-spacer" aria-hidden="true" />
        </div>
      ) : (
        <AxisInput type={layer.type} label="Z" value={live.z} placeholder={id} busy={busy} onPreview={(v) => preview(pz(v))} onLive={(v) => emitLive(pz(v))} onCommit={(v) => emitCommit(pz(v))} />
      )}
    </div>
  )
}

// The transform stack: header + add, a reorderable/removable layer list, and the
// per-layer editor in a popup — the same layer + component functionality as text-shadow.
function TransformsRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('transform'))
  // A self perspective lives in this same value, as a perspective() function,
  // and parseTransforms drops every function it doesn't recognise — so lift it
  // out before the layers are read and put it back in front on the way out, or
  // it vanishes the next time any layer is touched. See lib/transform-settings.
  const { distance: selfPerspective, rest } = takeSelfPerspective(d.present ? d.value : '')
  // Rows rather than bare layers: a hidden one is still in the list and still
  // in the CSS, commented out (see lib/hideable.ts).
  const rows = parseHideable(rest, ' ', parseTransforms)
  const layers = rows.map((r) => r.item)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLButtonElement>(null)
  const put = (next: Array<Hideable<Transform>>, distance: string, live: boolean) => {
    const value = withSelfPerspective(serializeHideable(next, ' ', serializeTransforms), distance)
    if (live) { if (value) liveSetProp('transform', value, false); return }
    if (value) setProp('transform', value, false); else clearProp('transform')
  }
  const write = (next: Array<Hideable<Transform>>, live: boolean) => put(next, selfPerspective, live)
  const setSelfPerspective = (distance: string, live: boolean) => put(rows, distance, live)
  const add = () => { const next = [...rows, { item: blankTransform(), hidden: false }]; write(next, false); setOpenIdx(next.length - 1) }
  const remove = (i: number) => { write(rows.filter((_, j) => j !== i), false); setOpenIdx((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur)) }
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); write(next, false)
    setOpenIdx((cur) => (cur === from ? to : cur))
  }
  const patch = (i: number, p: Partial<Transform>, live: boolean) => write(rows.map((r, j) => (j === i ? { ...r, item: { ...r.item, ...p } } : r)), live)
  const toggle = (i: number) => write(rows.map((r, j) => (j === i ? { ...r, hidden: !r.hidden } : r)), false)
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="2D & 3D transforms" prop="transform" props={props} />
        <div className="embed-editor_bg-layers-actions">
        <button
          type="button"
          ref={settingsRef}
          className={`embed-editor_icon-btn ${settingsOpen ? 'is-active' : ''}`}
          onClick={() => setSettingsOpen((o) => !o)}
          disabled={busy}
          title="Transform settings"
          aria-label="Transform settings"
          aria-expanded={settingsOpen}
        ><MoreIcon /></button>
        <button type="button" className="embed-editor_icon-btn" onClick={add} disabled={busy} title="Add a transform" aria-label="Add a transform"><TransformPlusIcon /></button>
        </div>
      </div>
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Transforms"
        onOpen={(i, el) => { setOpenIdx((cur) => (cur === i ? null : i)); setAnchorEl(el) }}
        onReorder={reorder}
        onRemove={remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={toggle}
        renderRow={(i) => ({ preview: transformTypeIcon(layers[i].type), label: transformLabel(layers[i]) })}
      />
      {openIdx != null && anchorEl && layers[openIdx] ? (
        <LayerPopover anchorEl={anchorEl} ariaLabel="Transform" onClose={() => setOpenIdx(null)}>
          <TransformEditor layer={layers[openIdx]} busy={busy} onChange={(p, live) => patch(openIdx!, p, live)} />
        </LayerPopover>
      ) : null}
      {settingsOpen && settingsRef.current ? (
        <LayerPopover anchorEl={settingsRef.current} ariaLabel="Transform settings" onClose={() => setSettingsOpen(false)}>
          <TransformSettings
            read={read}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            selfPerspective={selfPerspective}
            onSelfPerspective={setSelfPerspective}
          />
        </LayerPopover>
      ) : null}
    </div>
  )
}

// ─────────────────────────── Transitions ───────────────────────────

const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" /><path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
function EaseCurveIcon({ timing }: { timing: string }) {
  const b = easingToBezier(timing || 'ease')
  const S = 16
  const pt = (x: number, y: number) => `${(x * S).toFixed(1)} ${(S - y * S).toFixed(1)}`
  return <svg viewBox={`-2 -5 ${S + 4} ${S + 10}`} width="16" height="16" aria-hidden="true"><path d={`M ${pt(0, 0)} C ${pt(b[0], b[1])} ${pt(b[2], b[3])} ${pt(1, 1)}`} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
}

function durationToMs(v: string): number {
  const m = v.trim().toLowerCase().match(/^(-?[\d.]+)(ms|s)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  return m[2] === 's' ? Math.round(n * 1000) : Math.round(n)
}
// The value's current time unit (so the slider keeps writing seconds when the value
// is in seconds instead of silently rewriting 1.2s → 1200ms). Non-time values → ms.
function durationUnit(v: string): 'ms' | 's' {
  return /^-?[\d.]+s$/i.test(v.trim()) ? 's' : 'ms'
}
// Format a slider's ms value back into the given unit (seconds rounded to 2 dp).
function fmtDuration(ms: number, unit: 'ms' | 's'): string {
  return unit === 's' ? `${parseFloat((ms / 1000).toFixed(2))}s` : `${Math.round(ms)}ms`
}

// Duration: a slider (numeric ms) alongside a free-text input holding the raw value,
// so the unit lives inside the field and you can type 0.2s, var(), inherit, unset, etc.
function DurationField({ value, busy, onCommit, onLive }: { value: string; busy: boolean; onCommit: (v: string) => void; onLive: (v: string) => void }) {
  const ms = durationToMs(value)
  const unit = durationUnit(value)
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  return (
    <div className="embed-editor_trans-duration">
      <DragSlider value={ms} min={0} max={2000} disabled={busy} ariaLabel="Duration" onPreview={(n) => { if (!focused.current) setDraft(fmtDuration(n, unit)) }} onInput={(n) => onLive(fmtDuration(n, unit))} onCommit={(n) => onCommit(fmtDuration(n, unit))} />
      <input
        className="u-input embed-editor_trans-dur-input"
        value={draft}
        spellCheck={false}
        disabled={busy}
        aria-label="Duration"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; onCommit(draft.trim() || '0ms') }}
        onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
      />
    </div>
  )
}

// The easing control: a curve-icon button opens the visual editor, and the text
// input takes any CSS timing value — keywords, cubic-bezier(), or inherit/unset/var().
function EasingField({ value, busy, onCommit, onEditEasing }: { value: string; busy: boolean; onCommit: (v: string) => void; onEditEasing: () => void }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  return (
    <div className="embed-editor_trans-easing">
      <button type="button" className="embed-editor_trans-easing-btn" onClick={onEditEasing} disabled={busy} title="Edit easing" aria-label="Edit easing">
        <EaseCurveIcon timing={value} />
      </button>
      <input
        className="u-input embed-editor_trans-easing-input"
        value={draft}
        placeholder="ease"
        spellCheck={false}
        disabled={busy}
        aria-label="Easing"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; onCommit(draft.trim() || 'ease') }}
        onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
      />
    </div>
  )
}

function TransitionEditor({ transition, busy, onChange, onEditEasing }: { transition: Transition; busy: boolean; onChange: (p: Partial<Transition>, live: boolean) => void; onEditEasing: () => void }) {
  const options: SelectOption<string>[] = TRANSITION_GROUPS.flatMap((g) => [
    { value: `__h_${g.heading}`, label: g.heading, heading: true } as SelectOption<string>,
    ...g.items.map((it) => ({ value: it.value, label: it.label, indent: true } as SelectOption<string>)),
  ])
  return (
    <div className="embed-editor_trans-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <Select value={transition.property} options={options} onChange={(v) => onChange({ property: v }, false)} ariaLabel="Transition type" disabled={busy} searchable />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Duration</span>
        <DurationField value={transition.duration} busy={busy} onCommit={(v) => onChange({ duration: v }, false)} onLive={(v) => onChange({ duration: v }, true)} />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Easing</span>
        <EasingField value={transition.timing} busy={busy} onCommit={(v) => onChange({ timing: v }, false)} onEditEasing={onEditEasing} />
      </div>
    </div>
  )
}

function TransitionsRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('transition'))
  // `transition` is comma-separated, unlike transform and filter.
  const rows = parseHideable(d.present ? d.value : '', ',', parseTransitions)
  const list = rows.map((r) => r.item)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [easingOpen, setEasingOpen] = useState(false)
  const write = (next: Array<Hideable<Transition>>, live: boolean) => {
    const value = serializeHideable(next, ',', serializeTransitions)
    if (live) { if (value) liveSetProp('transition', value, false); return }
    if (value) setProp('transition', value, false); else clearProp('transition')
  }
  const add = () => { const next = [...rows, { item: blankTransition(), hidden: false }]; write(next, false); setOpenIdx(next.length - 1) }
  const remove = (i: number) => { write(rows.filter((_, j) => j !== i), false); setOpenIdx((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur)) }
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...rows]; const [m] = next.splice(from, 1); next.splice(to, 0, m); write(next, false)
    setOpenIdx((cur) => (cur === from ? to : cur))
  }
  const patch = (i: number, p: Partial<Transition>, live: boolean) => write(rows.map((r, j) => (j === i ? { ...r, item: { ...r.item, ...p } } : r)), live)
  const toggle = (i: number) => write(rows.map((r, j) => (j === i ? { ...r, hidden: !r.hidden } : r)), false)
  const cur = openIdx != null ? list[openIdx] : null

  return (
    <div className="embed-editor_type-shadows embed-editor_transitions">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="Transitions" prop="transition" props={props} />
        <button type="button" className="embed-editor_icon-btn" disabled={busy} title="Add transition" aria-label="Add transition" onClick={add}><PlusIcon /></button>
      </div>
      <LayerList
        count={list.length}
        busy={busy}
        ariaLabel="Transitions"
        onOpen={(i, el) => { setOpenIdx((cur) => (cur === i ? null : i)); setAnchorEl(el) }}
        onReorder={reorder}
        onRemove={remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={toggle}
        renderRow={(i) => ({
          preview: <span className="embed-editor_trans-clock" aria-hidden="true"><ClockIcon /></span>,
          label: transitionLabel(list[i]),
        })}
      />
      {openIdx != null && anchorEl && cur ? (
        <LayerPopover anchorEl={anchorEl} ariaLabel="Transition" onClose={() => setOpenIdx(null)}>
          <TransitionEditor transition={cur} busy={busy} onChange={(p, live) => patch(openIdx!, p, live)} onEditEasing={() => setEasingOpen(true)} />
        </LayerPopover>
      ) : null}
      {easingOpen && cur ? (
        <EasingEditor value={cur.timing || 'ease'} onClose={() => setEasingOpen(false)} onChange={(timing) => patch(openIdx!, { timing }, false)} />
      ) : null}
    </div>
  )
}

// ─────────────── Box shadows (layered box-shadow, mirrors text-shadow) ───────────────

const BOX_SHADOW_TYPES: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'outset', label: 'Outside' },
  { value: 'inset', label: 'Inside' },
]

// The per-shadow editor: Type (Outside/Inside) + X/Y/Blur/Size length rows + Color —
// the same components the text-shadow editor uses.
function BoxShadowEditor({ shadow, busy, onChange }: { shadow: BoxShadow; busy: boolean; onChange: (patch: Partial<BoxShadow>, live: boolean) => void }) {
  return (
    <div className="embed-editor_type-shadow-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <SegmentedControl value={shadow.inset ? 'inset' : 'outset'} options={BOX_SHADOW_TYPES} onChange={(v) => onChange({ inset: v === 'inset' }, false)} ariaLabel="Shadow type" disabled={busy} />
      </div>
      <ShadowNum label="X" value={shadow.x} busy={busy} onCommit={(v) => onChange({ x: v }, false)} onLive={(v) => onChange({ x: v }, true)} />
      <ShadowNum label="Y" value={shadow.y} busy={busy} onCommit={(v) => onChange({ y: v }, false)} onLive={(v) => onChange({ y: v }, true)} />
      <ShadowNum label="Blur" value={shadow.blur} busy={busy} onCommit={(v) => onChange({ blur: v }, false)} onLive={(v) => onChange({ blur: v }, true)} />
      <ShadowNum label="Size" value={shadow.spread} busy={busy} onCommit={(v) => onChange({ spread: v }, false)} onLive={(v) => onChange({ spread: v }, true)} />
      <ShadowColorRow color={shadow.color} busy={busy} onChange={(c, live) => onChange({ color: c }, live)} />
    </div>
  )
}

// The box-shadow stack: header + add, a reorderable/removable layer list, and the
// per-shadow editor in a popup — the same layer + component functionality as text-shadow.
function BoxShadowsRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props
  const d = displayOf(read('box-shadow'))
  const rows = parseHideable(d.present ? d.value : '', ',', parseBoxShadows)
  const shadows = rows.map((r) => r.item)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const write = (next: Array<Hideable<BoxShadow>>, live: boolean) => {
    const value = serializeHideable(next, ',', serializeBoxShadows)
    if (live) { if (value) liveSetProp('box-shadow', value, false); return }
    if (value) setProp('box-shadow', value, false); else clearProp('box-shadow')
  }
  const add = () => { const next = [...rows, { item: blankBoxShadow(), hidden: false }]; write(next, false); setOpenIdx(next.length - 1) }
  const remove = (i: number) => { write(rows.filter((_, j) => j !== i), false); setOpenIdx((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur)) }
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); write(next, false)
    setOpenIdx((cur) => (cur === from ? to : cur))
  }
  const patch = (i: number, p: Partial<BoxShadow>, live: boolean) => write(rows.map((r, j) => (j === i ? { ...r, item: { ...r.item, ...p } } : r)), live)
  const toggle = (i: number) => write(rows.map((r, j) => (j === i ? { ...r, hidden: !r.hidden } : r)), false)
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="Box shadows" prop="box-shadow" props={props} />
        <button type="button" className="embed-editor_icon-btn" onClick={add} disabled={busy} title="Add a shadow" aria-label="Add a box shadow"><PlusIcon /></button>
      </div>
      <LayerList
        count={shadows.length}
        busy={busy}
        ariaLabel="Box shadows"
        onOpen={(i, el) => { setOpenIdx((cur) => (cur === i ? null : i)); setAnchorEl(el) }}
        onReorder={reorder}
        onRemove={remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={toggle}
        renderRow={(i) => ({
          preview: <span className="embed-editor_bg-layer-preview" style={{ background: `linear-gradient(${shadows[i].color}, ${shadows[i].color}), conic-gradient(#8883 25%, transparent 0 50%, #8883 0 75%, transparent 0) 0 0 / 10px 10px` }} aria-hidden="true" />,
          label: boxShadowLabel(shadows[i]),
        })}
      />
      {openIdx != null && anchorEl && shadows[openIdx] ? (
        <LayerPopover anchorEl={anchorEl} ariaLabel="Box shadow" onClose={() => setOpenIdx(null)}>
          <BoxShadowEditor shadow={shadows[openIdx]} busy={busy} onChange={(p, live) => patch(openIdx!, p, live)} />
        </LayerPopover>
      ) : null}
    </div>
  )
}

// ─────────────────────────── Section ───────────────────────────

// ─────────────────────────── Clip path ───────────────────────────

// The full clip-path editor is large (~340 KB); lazy-load it so it only enters the
// bundle when the popup opens. It's fully self-contained (reads the selected element
// and writes `clip-path` to its native class style itself — no props).
const ClipPathEditor = lazy(() => import('./clip-path/ClipPath'))

const ClipCloseIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>)
const ClipEditIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 2.5 13.5 5.5 6 13l-3.5.5L3 10l7.5-7.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>)

// Canonical shape glyphs mirroring the editor's preset picker, so the trigger reads at
// a glance. Local (not imported from the editor) to keep that module out of the bundle.
function ClipGlyph({ type }: { type: string }) {
  const cls = 'embed-editor_clip-trigger-glyph'
  switch (type) {
    case 'None': return <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
    case 'Polygon': return <svg className={cls} viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" /></svg>
    case 'Inset': return <svg className={cls} viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2.5" fill="currentColor" /></svg>
    case 'Circle': return <svg className={cls} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.75" fill="currentColor" /></svg>
    case 'Ellipse': return <svg className={cls} viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="6" ry="4.25" fill="currentColor" /></svg>
    case 'Shape': return <svg className={cls} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .5c.4 4.3 2.8 6.8 7.5 7.5-4.7.7-7.1 3.2-7.5 7.5-.4-4.3-2.8-6.8-7.5-7.5C5.2 7.3 7.6 4.8 8 .5Z" fill="currentColor" /></svg>
    default: return <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8Q5 4 8 8T13.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
  }
}

// A cheap classifier for the trigger label — names the shape without pulling the huge
// editor module (and its full parser) into the main bundle.
function clipPathType(value: string): string {
  const v = value.trim().toLowerCase()
  if (!v || v === 'none') return 'None'
  if (v.startsWith('polygon')) return 'Polygon'
  if (v.startsWith('circle')) return 'Circle'
  if (v.startsWith('ellipse')) return 'Ellipse'
  if (v.startsWith('inset') || v.startsWith('rect') || v.startsWith('xywh')) return 'Inset'
  if (v.startsWith('path')) return 'Path'
  if (v.startsWith('shape')) return 'Shape'
  if (v.startsWith('url')) return 'SVG'
  if (v.startsWith('var')) return 'Variable'
  return 'Custom'
}

// The editor in a full-panel modal, portaled to <body> and rendered at the panel's
// own scale (it used to re-apply moden's compact zoom — see embed-editor.css). The
// editor's clip-path writes are routed to the panel's selected selector via
// setProp/clearProp (so its own class picker is hidden).
function ClipPathModal({ props, onClose }: { props: Props; onClose: () => void }) {
  const { setProp, liveSetProp, clearProp } = props
  const pending = useRef<string | null>(null)
  const timer = useRef<number | null>(null)
  const commit = () => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null }
    if (pending.current != null) { setProp('clip-path', pending.current, false); pending.current = null }
  }
  // Flush any un-committed edit if the popup closes before it settles.
  useEffect(() => commit, [])
  // Stream fast previews as the shape is dragged; commit authoritatively (with the
  // panel's native→embed fallback) once edits settle, so a drag doesn't fire a
  // read-back per frame.
  const onApply = (value: string) => {
    liveSetProp('clip-path', value, false)
    pending.current = value
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(commit, 350)
  }
  const onClear = () => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null }
    pending.current = null
    clearProp('clip-path')
  }
  return createPortal(
    <div className="embed-editor_bg-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="embed-editor_clip-modal u-surface-page" role="dialog" aria-modal="true" aria-label="Clip path">
        <div className="embed-editor_clip-modal-head">
          <span className="embed-editor_clip-modal-title">Clip path</span>
          <div className="embed-editor_clip-modal-actions">
            {/* Portal target for the editor's shortcut-help control (it renders nothing
                when this is absent). Provided here since it's no longer a hosted tool. */}
            <div id="clip-path_header-shortcuts" />
            <button type="button" className="embed-editor_bg-modal-close" onClick={onClose} aria-label="Close"><ClipCloseIcon /></button>
          </div>
        </div>
        <div className="embed-editor_clip-modal-body">
          <Suspense fallback={<div className="embed-editor_clip-loading">Loading editor…</div>}>
            <ClipPathEditor onApply={onApply} onClear={onClear} hideClassPicker />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// The Clip row: the label (blue/clear/provenance like every other prop) + a button
// showing the current clip-path type. Clicking opens the visual editor popup.
function ClipPathRow({ props }: { props: Props }) {
  const { read, busy } = props
  const d = displayOf(read('clip-path'))
  const raw = d.present ? d.value : displayOf(read('-webkit-clip-path')).value
  const [open, setOpen] = useState(false)
  const type = clipPathType(raw)
  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Clip" prop="clip-path" props={props} />
      <button type="button" className="embed-editor_clip-trigger" disabled={busy} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="embed-editor_clip-trigger-type">
          <ClipGlyph type={type} />
          <span className="embed-editor_clip-trigger-label">{type}</span>
        </span>
        <ClipEditIcon />
      </button>
      {open ? <ClipPathModal props={props} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

export default function EffectsSection(props: Props) {
  const { read, busy, setProp, liveSetProp } = props
  const outline = displayOf(read('outline-style'))
  const outlineColor = displayOf(read('outline-color'))
  const events = displayOf(read('pointer-events'))

  return (
    <div className="embed-editor_size embed-editor_effects">
      <PresetSelectRow prop="mix-blend-mode" label="Blending" options={BLEND_MODES} presets={BLEND_SET} fallback="normal" placeholder="mix-blend-mode" props={props} />

      <OpacityRow props={props} />

      <div className="embed-editor_size-row">
        <EffLabel label="Outline" prop="outline-style" props={props} />
        <SegmentedField
          value={outline.present ? outline.value : ''}
          important={outline.important}
          options={OUTLINE_OPTS}
          prop="outline-style"
          fallback="none"
          busy={busy}
          onCommit={(v, imp) => setProp('outline-style', v, imp)}
          ariaLabel="Outline style"
        />
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Width" prop="outline-width" props={props} />
        <div className="embed-editor_eff-outline-pair">
          <LiveText prop="outline-width" placeholder="0" props={props} />
          <EffLabel label="Offset" prop="outline-offset" props={props} />
          <LiveText prop="outline-offset" placeholder="0" props={props} />
        </div>
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Color" prop="outline-color" props={props} />
        <div className="embed-editor_bg-inline">
          <OutlineColor props={props} value={outlineColor.present ? outlineColor.value : ''} />
        </div>
      </div>

      <BoxShadowsRow props={props} />
      <TransformsRow props={props} />
      <TransitionsRow props={props} />
      <FiltersRow prop="filter" label="Filters" props={props} />
      <FiltersRow prop="backdrop-filter" label="Backdrop filters" props={props} />

      <ClipPathRow props={props} />

      <PresetSelectRow prop="cursor" label="Cursor" options={CURSORS} presets={CURSOR_SET} fallback="auto" placeholder="cursor" props={props} allowCustom={false} />

      <div className="embed-editor_size-row">
        <EffLabel label="Events" prop="pointer-events" props={props} />
        <SegmentedField
          value={events.present ? events.value : ''}
          important={events.important}
          options={EVENTS_OPTS}
          prop="pointer-events"
          fallback="auto"
          busy={busy}
          onCommit={(v, imp) => setProp('pointer-events', v, imp)}
          ariaLabel="Pointer events"
        />
      </div>
    </div>
  )
}
