import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import FieldLabel from './components/FieldLabel'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import Select from './components/Select'
import useScrub, { type ScrubHandlers } from './components/useScrub'
import { handleArrowStep } from './lib/number-step'
import ProvenanceList from './ProvenanceList'
import { blankLayer, colorOverlayImage, colorOverlayOf, layerKind, layerLabel, parseLayers, serializeLayers, splitBackgroundShorthand, splitTopLevelSpaces, type BgLayer, type LayerKind } from './lib/background'
import LayerList from './LayerList'
import VariableConnect from './VariableConnect'
import { parseGradient, serializeGradient } from './lib/gradient'
import GradientEditor from './GradientEditor'
import ColorSwatch from './components/ColorSwatch'
import ImageAssetPicker from './components/ImageAssetPicker'
import type { Contributor, ResolvedProp } from './lib/resolved'

// The Backgrounds section — Webflow parity. `background` is a stack of layers
// (images + gradients) painted over a single background-color. The layer list
// reorders / adds / removes / edits layers; each layer edit re-serializes the
// five comma-separated longhands (see lib/background). Color and Clipping are
// single-value controls. Everything is driven by the resolved model (blue when
// the picked selector sets it, orange via another selector, clear menu, etc.).
//
// Deferred (still editable as raw text where relevant): the asset picker for
// images and a visual gradient editor — a layer's value is edited as its CSS.

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

// ─────────────────────────── Shared label ───────────────────────────

function BgLabel({ label, prop, d, contributors, busy, scrubProps, onClear, onProvenance, onSelectSelector }: {
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
      <button type="button" className="embed-editor_size-label embed-editor_prop-orange" disabled={busy} title="Set through another selector — click to see all" onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}>
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

// A live text field bound to one property (Color, and inside the layer editor).
function BgField({ prop, label, placeholder, prefix, read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  prop: string
  label: string
  placeholder: string
  prefix?: ReactNode
} & Props) {
  const d = displayOf(read(prop))
  const external = d.present ? (d.important ? `${d.value} !important` : d.value) : ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)

  useEffect(() => { if (!focused.current) setDraft(external) }, [external])
  const cancelLive = () => { if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null } }
  useEffect(() => cancelLive, [])
  // Undelayed live write for the scrub, which throttles its own — see useScrub.
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

  const input = (
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
  )

  return (
    <>
      <BgLabel label={label} prop={prop} d={d} contributors={read(prop)?.contributors ?? []} busy={busy} scrubProps={scrub.label} onClear={() => clearProp(prop)} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      {prefix ? <div className="embed-editor_bg-inline">{prefix}{input}</div> : input}
    </>
  )
}


// ─────────────────────────── Icons ───────────────────────────

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
)

// The layer editor lives in a full-width popup over the panel (dark backdrop),
// rather than expanding inline. Portaled to <body> so it escapes the panel's
// clipping / stacking; closes on backdrop click or Escape. No header — the rows
// (label left / control right, divider-separated) run edge to edge like Webflow.
function LayerEditorModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="embed-editor_bg-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="embed-editor_bg-modal u-surface-surface" role="dialog" aria-modal="true" aria-label="Background layer">
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ─────────────────────────── Layer editor ───────────────────────────

// A field bound to one longhand of one layer. Recomputes that longhand's whole
// comma list from `layers` (with the edit applied) and writes it live / on blur.
function LayerLonghandField({ layers, index, field, prop, label, placeholder, busy, setProp, clearProp, liveSetProp }: {
  layers: BgLayer[]
  index: number
  field: keyof BgLayer
  prop: string
  label: string
  placeholder: string
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
}) {
  const external = layers[index]?.[field] ?? ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)

  useEffect(() => { if (!focused.current) setDraft(external) }, [external])

  const listFor = (text: string): string => {
    const next = layers.map((l, i) => (i === index ? { ...l, [field]: text } : l))
    return serializeLayers(next)[field === 'image' ? 'image' : field] as string
  }
  const commit = (live: boolean, text = draft) => {
    const value = listFor(text.trim())
    if (live) { if (value) liveSetProp(prop, value, false); return }
    if (value) setProp(prop, value, false)
    else clearProp(prop)
  }
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => commit(true, text),
    onCommit: (text) => { setDraft(text); commit(false, text) },
  })

  return (
    <VariableConnect ariaLabel={`Connect ${label} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
    <input
      {...scrub.input}
      className="u-input embed-editor_size-input"
      value={draft}
      onChange={(event) => { setDraft(event.target.value); commit(true, event.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit(false) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); return }
        const stepped = handleArrowStep(event)
        if (!stepped) return
        event.preventDefault()
        const el = event.currentTarget
        el.value = stepped.text
        el.setSelectionRange(stepped.caret, stepped.caret)
        setDraft(stepped.text)
      }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={label}
    />
    </VariableConnect>
  )
}

// Layer-type icons (Webflow's), currentColor-driven. Gradient icons use a useId
// gradient id so multiple instances never collide.
function BgImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 7C6.55228 7 7 6.55228 7 6C7 5.44772 6.55228 5 6 5C5.44772 5 5 5.44772 5 6C5 6.55228 5.44772 7 6 7Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3ZM13 3L3 3V12.2929L8 7.29289L13 12.2929V3ZM8 8.70711L12.2929 13H3.70711L8 8.70711Z" fill="currentColor" />
    </svg>
  )
}
function BgLinearIcon() {
  const id = useId()
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3Z" fill={`url(#${id})`} />
      <defs>
        <linearGradient id={id} x1="14" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
function BgRadialIcon() {
  const id = useId()
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3Z" fill={`url(#${id})`} />
      <defs>
        <radialGradient id={id} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(8 8) rotate(90) scale(6)">
          <stop stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.166246" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" />
        </radialGradient>
      </defs>
    </svg>
  )
}
function BgColorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3Z" fill="currentColor" />
    </svg>
  )
}

const TYPE_OPTIONS: ReadonlyArray<SegmentedOption<LayerKind>> = [
  { value: 'image', label: <BgImageIcon />, ariaLabel: 'Image', tooltip: 'Image' },
  { value: 'linear', label: <BgLinearIcon />, ariaLabel: 'Linear gradient', tooltip: 'Linear gradient' },
  { value: 'radial', label: <BgRadialIcon />, ariaLabel: 'Radial gradient', tooltip: 'Radial gradient' },
  { value: 'color', label: <BgColorIcon />, ariaLabel: 'Color overlay', tooltip: 'Color overlay' },
]

type LayerFieldProps = { layers: BgLayer[]; index: number; busy: boolean; setProp: SetProp; clearProp: ClearProp; liveSetProp: LiveSetProp }

// A small draft input (live-as-you-type + commit-on-blur) for one part of a compound
// longhand (Size's width/height, Position's left/top). The parent maps the part back
// into the full comma list; this just owns the field's local text + arrow-stepping.
function BgPartInput({ value, placeholder, label, busy, disabled, onLive, onCommit }: {
  value: string; placeholder: string; label: string; busy: boolean; disabled?: boolean
  onLive: (v: string) => void; onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const scrub = useScrub({
    value: draft,
    disabled: busy || disabled,
    onPreview: setDraft,
    onInput: (text) => onLive(text.trim()),
    onCommit: (text) => { setDraft(text); onCommit(text.trim()) },
  })
  return (
    <input
      {...scrub.input}
      className={`u-input embed-editor_size-input ${disabled ? 'is-inactive' : ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      disabled={busy || disabled}
      spellCheck={false}
      onChange={(e) => { setDraft(e.target.value); onLive(e.target.value.trim()) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; onCommit(draft.trim()) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); return }
        const stepped = handleArrowStep(e)
        if (!stepped) return
        e.preventDefault()
        const el = e.currentTarget
        el.value = stepped.text
        el.setSelectionRange(stepped.caret, stepped.caret)
        setDraft(stepped.text)
        onLive(stepped.text.trim())
      }}
    />
  )
}

// ── Size: Custom | Cover | Contain, with Width/Height when Custom ──
type SizeMode = 'custom' | 'cover' | 'contain'
function parseSize(size: string): { mode: SizeMode; width: string; height: string } {
  const v = size.trim().toLowerCase()
  if (v === 'cover') return { mode: 'cover', width: '', height: '' }
  if (v === 'contain') return { mode: 'contain', width: '', height: '' }
  const parts = splitTopLevelSpaces(size.trim())
  return { mode: 'custom', width: parts[0] ?? '', height: parts[1] ?? '' }
}
function serializeSize(mode: SizeMode, width: string, height: string): string {
  if (mode === 'cover') return 'cover'
  if (mode === 'contain') return 'contain'
  const w = width.trim(); const h = height.trim()
  if (!w && !h) return ''
  return `${w || 'auto'} ${h || 'auto'}`
}
const SIZE_MODE_OPTIONS: ReadonlyArray<SegmentedOption<SizeMode>> = [
  { value: 'custom', label: 'Custom' },
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
]
function LayerSizeField({ layers, index, busy, setProp, clearProp, liveSetProp }: LayerFieldProps) {
  const parsed = parseSize(layers[index]?.size ?? '')
  const writeSize = (value: string, live: boolean) => {
    const list = serializeLayers(layers.map((l, i) => (i === index ? { ...l, size: value } : l))).size
    if (live) { if (list) liveSetProp('background-size', list, false); return }
    if (list) setProp('background-size', list, false); else clearProp('background-size')
  }
  // Cover / Contain size the image for you, so the Width/Height fields stay visible
  // but disabled (Webflow parity) — showing "Auto" since neither axis is authored.
  const isCustom = parsed.mode === 'custom'
  return (
    <div className="embed-editor_bg-stack">
      <SegmentedControl options={SIZE_MODE_OPTIONS} value={parsed.mode} onChange={(m) => writeSize(serializeSize(m, parsed.width, parsed.height), false)} ariaLabel="Background size" disabled={busy} />
      <div className="embed-editor_bg-pair">
        <label className="embed-editor_bg-pair-field">
          <BgPartInput value={parsed.width} placeholder="Auto" label="Width" busy={busy} disabled={!isCustom}
            onLive={(v) => writeSize(serializeSize('custom', v, parsed.height), true)}
            onCommit={(v) => writeSize(serializeSize('custom', v, parsed.height), false)} />
          <span className="embed-editor_bg-pair-cap">Width</span>
        </label>
        <label className="embed-editor_bg-pair-field">
          <BgPartInput value={parsed.height} placeholder="Auto" label="Height" busy={busy} disabled={!isCustom}
            onLive={(v) => writeSize(serializeSize('custom', parsed.width, v), true)}
            onCommit={(v) => writeSize(serializeSize('custom', parsed.width, v), false)} />
          <span className="embed-editor_bg-pair-cap">Height</span>
        </label>
      </div>
    </div>
  )
}

// ── Position: a 3×3 preset grid + Left/Top offsets ──
function axisIndex(token: string): number {
  const t = token.trim().toLowerCase()
  if (t === '' || t === 'left' || t === 'top' || t === '0' || t === '0%' || t === '0px') return 0
  if (t === 'center' || t === '50%') return 1
  if (t === 'right' || t === 'bottom' || t === '100%') return 2
  return -1
}
const AXIS_PCT = ['0%', '50%', '100%']
function LayerPositionField({ layers, index, busy, setProp, clearProp, liveSetProp }: LayerFieldProps) {
  const parts = splitTopLevelSpaces((layers[index]?.position ?? '').trim())
  const x = parts[0] ?? ''; const y = parts[1] ?? ''
  const writePos = (value: string, live: boolean) => {
    const list = serializeLayers(layers.map((l, i) => (i === index ? { ...l, position: value } : l))).position
    if (live) { if (list) liveSetProp('background-position', list, false); return }
    if (list) setProp('background-position', list, false); else clearProp('background-position')
  }
  const activeCol = axisIndex(x); const activeRow = axisIndex(y)
  return (
    <div className="embed-editor_bg-position">
      <div className="embed-editor_bg-posgrid" role="group" aria-label="Position preset">
        {[0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => (
          <button
            key={`${row}-${col}`}
            type="button"
            className={`embed-editor_bg-poscell ${activeCol === col && activeRow === row ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={`${['Left', 'Center', 'Right'][col]} ${['top', 'center', 'bottom'][row]}`}
            onClick={() => writePos(`${AXIS_PCT[col]} ${AXIS_PCT[row]}`, false)}
          />
        )))}
      </div>
      <div className="embed-editor_bg-posfields">
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Left</span>
          <BgPartInput value={x} placeholder="0px" label="Left" busy={busy}
            onLive={(v) => writePos(`${v || '0%'} ${y || '0%'}`, true)}
            onCommit={(v) => writePos(v || y ? `${v || '0%'} ${y || '0%'}` : '', false)} />
        </label>
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Top</span>
          <BgPartInput value={y} placeholder="0px" label="Top" busy={busy}
            onLive={(v) => writePos(`${x || '0%'} ${v || '0%'}`, true)}
            onCommit={(v) => writePos(x || v ? `${x || '0%'} ${v || '0%'}` : '', false)} />
        </label>
      </div>
    </div>
  )
}

// ── Tile (background-repeat) + Fixed (background-attachment) ──
const TileAllIcon = () => (<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>)
const TileXIcon = () => (<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1" y="5.5" width="4" height="5" rx="1" /><rect x="6" y="5.5" width="4" height="5" rx="1" /><rect x="11" y="5.5" width="4" height="5" rx="1" /></svg>)
const TileYIcon = () => (<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="5.5" y="1" width="5" height="4" rx="1" /><rect x="5.5" y="6" width="5" height="4" rx="1" /><rect x="5.5" y="11" width="5" height="4" rx="1" /></svg>)
const TileNoneIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>)
const TILE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'repeat', label: <TileAllIcon />, ariaLabel: 'Tile', tooltip: 'Tile' },
  { value: 'repeat-x', label: <TileXIcon />, ariaLabel: 'Tile horizontally', tooltip: 'Tile X' },
  { value: 'repeat-y', label: <TileYIcon />, ariaLabel: 'Tile vertically', tooltip: 'Tile Y' },
  { value: 'no-repeat', label: <TileNoneIcon />, ariaLabel: 'No tile', tooltip: 'None' },
]
const FIXED_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'scroll', label: 'Not fixed' },
]

// ── Image: thumbnail + name + dimensions + Choose image (asset picker) ──
function imageUrlOf(image: string): string | null {
  const m = image.match(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/i)
  return m ? m[1] : null
}
function LayerImageField({ layers, index, busy, applyLayers }: { layers: BgLayer[]; index: number; busy: boolean; applyLayers: (l: BgLayer[]) => void }) {
  const image = layers[index]?.image ?? ''
  const url = imageUrlOf(image)
  const name = url ? (url.split('?')[0].split(/[\\/]/).pop() || url) : ''
  const [open, setOpen] = useState(false)
  const [dims, setDims] = useState('')
  useEffect(() => { setDims('') }, [url])
  const pick = (assetUrl: string) => {
    applyLayers(layers.map((l, i) => (i === index ? { ...l, image: `url("${assetUrl}")` } : l)))
    setOpen(false)
  }
  return (
    <div className="embed-editor_bg-image">
      <div className="embed-editor_bg-image-row">
        <span className="embed-editor_bg-thumb">
          {url ? <img src={url} alt="" onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /> : null}
        </span>
        <div className="embed-editor_bg-image-meta">
          <span className="embed-editor_bg-image-name" title={url ?? ''}>{name || 'No image'}</span>
          {dims ? <span className="embed-editor_bg-image-dim">{dims}</span> : null}
        </div>
      </div>
      <button type="button" className="u-button is-small embed-editor_bg-choose" disabled={busy} onClick={() => setOpen((o) => !o)}>
        Choose image
      </button>
      {open ? <ImageAssetPicker selectedUrl={url ?? ''} onPick={pick} /> : null}
    </div>
  )
}

// A colour field that reads/writes a color-overlay layer (a solid-fill gradient).
function LayerColorField({ layers, index, busy, setProp, liveSetProp }: {
  layers: BgLayer[]
  index: number
  busy: boolean
  setProp: SetProp
  liveSetProp: LiveSetProp
}) {
  const external = colorOverlayOf(layers[index]?.image ?? '') ?? ''
  const [draft, setDraft] = useState(external)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(external) }, [external])

  const listFor = (color: string): string => {
    const image = colorOverlayImage(color)
    const next = layers.map((l, i) => (i === index ? { ...l, image } : l))
    return serializeLayers(next).image
  }
  const commit = (live: boolean) => {
    const value = listFor(draft.trim() || 'rgba(0, 0, 0, 0.5)')
    if (live) liveSetProp('background-image', value, false)
    else setProp('background-image', value, false)
  }

  return (
    <div className="embed-editor_bg-inline">
      <ColorSwatch value={draft} busy={busy} ariaLabel="Overlay color" onChange={(c, live) => {
        setDraft(c)
        const value = listFor(c.trim() || 'rgba(0, 0, 0, 0.5)')
        if (live) liveSetProp('background-image', value, false); else setProp('background-image', value, false)
      }} />
      <VariableConnect ariaLabel="Connect overlay color to a variable" disabled={busy} className="is-fill" prop="background-color" onPick={(binding) => { setDraft(binding); setProp('background-image', listFor(binding), false) }}>
      <input
        className="u-input embed-editor_size-input"
        value={draft}
        onChange={(event) => { setDraft(event.target.value); commit(true) }}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit(false) }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        disabled={busy}
        spellCheck={false}
        placeholder="rgba(0, 0, 0, 0.5)"
        aria-label="Overlay color"
      />
      </VariableConnect>
    </div>
  )
}

function LayerEditor({ layers, index, busy, setProp, clearProp, liveSetProp, applyLayers }: {
  layers: BgLayer[]
  index: number
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  applyLayers: (layers: BgLayer[]) => void
}) {
  const layer = layers[index]
  if (!layer) return null
  const kind = layerKind(layer.image)
  // The Type buttons show four kinds; a conic/unknown value maps to the nearest.
  const displayKind: LayerKind =
    kind === 'color' || kind === 'linear' || kind === 'radial' ? kind
    : kind === 'conic' ? 'linear'
    : 'image'

  const setKind = (next: LayerKind) => {
    if (next === displayKind) return
    const seeded = blankLayer(next)
    applyLayers(layers.map((l, i) => (i === index ? { ...l, image: seeded.image } : l)))
  }

  const fieldProps = { layers, index, busy, setProp, clearProp, liveSetProp }
  const typeRow = (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
      <SegmentedControl options={TYPE_OPTIONS} value={displayKind} onChange={setKind} ariaLabel="Layer type" disabled={busy} />
    </div>
  )

  // A colour overlay is a solid fill — just Type + Colour (no size/position/tile).
  if (displayKind === 'color') {
    return (
      <div className="embed-editor_bg-editor">
        {typeRow}
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
          <LayerColorField layers={layers} index={index} busy={busy} setProp={setProp} liveSetProp={liveSetProp} />
        </div>
      </div>
    )
  }

  // A gradient layer gets Webflow's visual editor (position grid, size presets,
  // stops bar, repeat) — its Size/Position edit the gradient's INTERNAL geometry,
  // not the background-size/position longhands. A gradient we can't parse falls
  // back to the raw text fields below.
  const isGradient = kind === 'linear' || kind === 'radial' || kind === 'conic'
  const gradient = isGradient ? parseGradient(layer.image) : null
  const writeImage = (image: string, live: boolean) => {
    const list = serializeLayers(layers.map((l, i) => (i === index ? { ...l, image } : l))).image
    if (live) liveSetProp('background-image', list, false)
    else setProp('background-image', list, false)
  }

  return (
    <div className="embed-editor_bg-editor">
      {typeRow}
      {gradient ? (
        <GradientEditor gradient={gradient} busy={busy} onChange={(g, live) => writeImage(serializeGradient(g), live)} />
      ) : (
        <>
          <div className="embed-editor_size-row embed-editor_bg-row-top">
            <span className="embed-editor_size-label embed-editor_bg-caption">{displayKind === 'image' ? 'Image' : 'Gradient'}</span>
            {displayKind === 'image'
              ? <LayerImageField layers={layers} index={index} busy={busy} applyLayers={applyLayers} />
              : <LayerLonghandField {...fieldProps} field="image" prop="background-image" label="Layer value" placeholder="gradient(…)" />}
          </div>
          <div className="embed-editor_size-row embed-editor_bg-row-top">
            <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
            <LayerSizeField {...fieldProps} />
          </div>
          <div className="embed-editor_size-row embed-editor_bg-row-top">
            <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
            <LayerPositionField {...fieldProps} />
          </div>
        </>
      )}
      {/* Tile (background-repeat) + Fixed (background-attachment) apply to image
          layers only — Webflow omits them for gradients (which have their own
          repeat toggle inside the gradient editor). */}
      {!isGradient ? (
        <>
          <div className="embed-editor_size-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Tile</span>
            <SegmentedControl
              options={TILE_OPTIONS}
              value={['repeat-x', 'repeat-y', 'no-repeat'].includes(layer.repeat.trim()) ? layer.repeat.trim() : 'repeat'}
              onChange={(v) => applyLayers(layers.map((l, i) => (i === index ? { ...l, repeat: v === 'repeat' ? '' : v } : l)))}
              ariaLabel="Layer tile"
              disabled={busy}
            />
          </div>
          <div className="embed-editor_size-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Fixed</span>
            <SegmentedControl
              options={FIXED_OPTIONS}
              value={layer.attachment.trim() === 'fixed' ? 'fixed' : 'scroll'}
              onChange={(v) => applyLayers(layers.map((l, i) => (i === index ? { ...l, attachment: v === 'scroll' ? '' : v } : l)))}
              ariaLabel="Layer fixed"
              disabled={busy}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

// ─────────────────────────── Section ───────────────────────────

export default function BackgroundSection(props: Props) {
  const { read, busy, setProp, clearProp, onProvenance, onSelectSelector } = props
  const val = (prop: string) => displayOf(read(prop)).value

  // Prefer the individual longhands; if the background is set via the `background`
  // SHORTHAND (Webflow emits it that way after adding a colour-overlay layer), fall
  // back to parsing that so the layers still load. Editing then migrates to
  // longhands (the shorthand is cleared) so writes are unambiguous.
  const rawImage = val('background-image').trim()
  const shorthand = val('background').trim()
  const fromShorthand = (!rawImage || rawImage.toLowerCase() === 'none') && !!shorthand
  const longhands = fromShorthand
    ? splitBackgroundShorthand(shorthand)
    : {
        image: val('background-image'),
        size: val('background-size'),
        position: val('background-position'),
        repeat: val('background-repeat'),
        attachment: val('background-attachment'),
        color: '',
      }
  const layers = parseLayers(longhands)

  // The value the PICKED selector itself sets for `prop` (null when it doesn't set
  // it — a value inherited from another selector doesn't count). Used to skip writes
  // that wouldn't change anything: each setProp/clearProp is a separate native op
  // that toggles busy + re-reads from Webflow, so rewriting all five longhands on
  // every change flashes the panel and echoes unchanged values back to Webflow.
  const ownValue = (prop: string): string | null => {
    const d = displayOf(read(prop))
    return d.present && d.isSelected ? d.value.trim() : null
  }
  // Write the stack back to the five longhands, but only those whose value actually
  // changed on the picked selector. When sourced from the shorthand, replace it:
  // clear `background` and preserve its colour into background-color.
  const applyLayers = (next: BgLayer[]) => {
    const s = serializeLayers(next)
    const write = (prop: string, value: string) => {
      const own = ownValue(prop)
      const v = value.trim()
      if (v) { if (own !== v) setProp(prop, v, false) }
      else if (own != null) clearProp(prop)
    }
    write('background-image', s.image)
    write('background-size', s.size)
    write('background-position', s.position)
    write('background-repeat', s.repeat)
    write('background-attachment', s.attachment)
    if (fromShorthand) {
      clearProp('background')
      if (longhands.color && !val('background-color').trim()) setProp('background-color', longhands.color, false)
    }
  }

  const [openLayer, setOpenLayer] = useState<number | null>(null)

  const addLayer = () => {
    // Default a new layer to an image (Webflow parity) — switch to a gradient via Type.
    applyLayers([blankLayer('image'), ...layers])
    setOpenLayer(0)
  }
  const removeLayer = (index: number) => {
    applyLayers(layers.filter((_, i) => i !== index))
    setOpenLayer((cur) => (cur === index ? null : cur != null && cur > index ? cur - 1 : cur))
  }
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...layers]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    applyLayers(next)
    setOpenLayer((cur) => (cur === from ? to : cur))
  }

  const clipD = displayOf(read('background-clip'))
  const clip = clipD.present ? clipD.value.trim() : 'border-box'

  return (
    <div className="embed-editor_size embed-editor_background">
      {/* Image & gradient — the layer stack (top layer first). */}
      <div className="embed-editor_bg-layers-head">
        <BgLabel label="Image & gradient" prop="background-image" d={displayOf(read('background-image'))} contributors={read('background-image')?.contributors ?? []} busy={busy} onClear={() => applyLayers([])} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <button type="button" className="embed-editor_icon-btn" onClick={addLayer} disabled={busy} title="Add a layer" aria-label="Add a background layer"><PlusIcon /></button>
      </div>

      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Background layers"
        onOpen={(i) => setOpenLayer(i)}
        onReorder={reorder}
        onRemove={removeLayer}
        renderRow={(i) => ({
          preview: <span className="embed-editor_bg-layer-preview" style={{ background: layers[i].image, backgroundSize: 'cover', backgroundPosition: 'center' }} aria-hidden="true" />,
          label: layerLabel(layers[i].image),
        })}
      />

      {openLayer != null && layers[openLayer] ? (
        <LayerEditorModal onClose={() => setOpenLayer(null)}>
          <LayerEditor layers={layers} index={openLayer} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={props.liveSetProp} applyLayers={applyLayers} />
        </LayerEditorModal>
      ) : null}

      {/* Colour — painted behind every layer. */}
      <div className="embed-editor_size-row">
        <BgField {...props} prop="background-color" label="Color" placeholder="transparent" prefix={<ColorSwatch value={val('background-color')} busy={busy} ariaLabel="Background color" onChange={(c, live) => { if (live) props.liveSetProp('background-color', c, false); else props.setProp('background-color', c, false) }} />} />
      </div>

      {/* Clipping — background-clip. "None" writes border-box explicitly. */}
      <div className="embed-editor_size-row">
        <BgLabel label="Clipping" prop="background-clip" d={clipD} contributors={read('background-clip')?.contributors ?? []} busy={busy} onClear={() => clearProp('background-clip')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <Select
          value={clip}
          options={[
            { value: 'border-box', label: 'None' },
            { value: 'padding-box', label: 'Clip background to padding' },
            { value: 'content-box', label: 'Clip background to content' },
            { value: 'text', label: 'Clip background to text' },
          ]}
          onChange={(next) => setProp('background-clip', next, false)}
          onPreview={(next) => props.liveSetProp('background-clip', next, false)}
          ariaLabel="Background clipping"
          disabled={busy}
        />
      </div>
    </div>
  )
}
