import { useEffect, useRef, useState } from 'react'
import { SegBar, StackedField, LiveInput, PropLabel, GroupLabel, displayOf, type Props, type Seg } from './TypographySection'
import { parseFlexShorthand } from './lib/webflow'
import { splitTopLevelSpaces } from './lib/background'
import SegmentPill from './components/SegmentPill'

// The Flex Child section — the controls that apply to the selected element when it
// is a child of a flex (or grid) container: its sizing (the `flex` shorthand), its
// cross-axis alignment (`align-self`), and its `order`. Sits above Layout. Like the
// other sections it is always rendered and driven by the resolved model; writes
// target the picked selector. Icons mirror Webflow's own Flex Child panel.

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

// ─────────────────────────── Icons (from Webflow) ───────────────────────────

function FlexShrinkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M15 8L2 8L2 7L15 7V8Z" fill="currentColor" />
      <path d="M8.00004 10.7071L5.85359 12.8536L5.14648 12.1464L8.50004 8.79289L11.8536 12.1464L11.1465 12.8536L9.00004 10.7071V15H8.00004V10.7071Z" fill="currentColor" />
      <path d="M8.00004 4.29289L5.85359 2.14645L5.14648 2.85355L8.50004 6.20711L11.8536 2.85355L11.1465 2.14645L9.00004 4.29289V0L8.00004 4.37103e-08V4.29289Z" fill="currentColor" />
    </svg>
  )
}
function FlexGrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M2 0.999999L14 1L14 2L2 2L2 0.999999ZM2 14L14 14L14 15L2 15L2 14Z" fill="currentColor" />
      <path d="M8.52731 3.70718L10.6738 5.85363L11.3809 5.14652L8.02731 1.79297L4.67375 5.14652L5.38086 5.85363L7.52731 3.70718L7.52731 12.293L5.38086 10.1465L4.67375 10.8536L8.02731 14.2072L11.3809 10.8536L10.6738 10.1465L8.52731 12.293L8.52731 3.70718Z" fill="currentColor" />
    </svg>
  )
}
function FlexNoneIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 14H4L4 13H12V14ZM12 3L4 3L4 2L12 2V3Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M7.29293 7.99996L5.14648 5.85352L5.85359 5.14641L8.00004 7.29286L10.1465 5.14641L10.8536 5.85352L8.70714 7.99996L10.8536 10.1464L10.1465 10.8535L8.00004 8.70707L5.85359 10.8535L5.14648 10.1464L7.29293 7.99996Z" fill="currentColor" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M8.70708 8.00004L12.3535 4.35359L11.6464 3.64648L7.99998 7.29293L4.35353 3.64648L3.64642 4.35359L7.29287 8.00004L3.64642 11.6465L4.35353 12.3536L7.99998 8.70714L11.6464 12.3536L12.3535 11.6465L8.70708 8.00004Z" fill="currentColor" />
    </svg>
  )
}
function MoreDotsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8C3 7.44772 3.44772 7 4 7C4.55228 7 5 7.44772 5 8C5 8.55228 4.55228 9 4 9C3.44772 9 3 8.55228 3 8Z" fill="currentColor" />
      <path d="M7 8C7 7.44772 7.44772 7 8 7C8.55228 7 9 7.44772 9 8C9 8.55228 8.55228 9 8 9C7.44772 9 7 8.55228 7 8Z" fill="currentColor" />
      <path d="M11 8C11 7.44772 11.4477 7 12 7C12.5523 7 13 7.44772 13 8C13 8.55228 12.5523 9 12 9C11.4477 9 11 8.55228 11 8Z" fill="currentColor" />
    </svg>
  )
}
function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={onClick}>
      {label}
    </button>
  )
}
function AlignSelfStartIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 1V15H3V9H11.5C11.7761 9 12 8.77614 12 8.5V7.5C12 7.22386 11.7761 7 11.5 7H3V1H2Z" fill="currentColor" />
    </svg>
  )
}
function AlignSelfCenterIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7 15V9H2.5C2.22386 9 2 8.77614 2 8.5V7.5C2 7.22386 2.22386 7 2.5 7H7V1H8V15H7Z" fill="currentColor" />
      <path d="M14 7.5C14 7.22386 13.7761 7 13.5 7H9V9H13.5C13.7761 9 14 8.77614 14 8.5V7.5Z" fill="currentColor" />
    </svg>
  )
}
function AlignSelfEndIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 9V15H14V1H13V7H4.5C4.22386 7 4 7.22386 4 7.5V8.5C4 8.77614 4.22386 9 4.5 9H13Z" fill="currentColor" />
    </svg>
  )
}
function AlignSelfStretchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 15V1H3V7H13V1H14V15H13V9H3V15H2Z" fill="currentColor" />
    </svg>
  )
}
function AlignSelfBaselineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 2V8.29289L14.6464 6.64645L15.3536 7.35355L12.5 10.2071L9.64645 7.35355L10.3536 6.64645L12 8.29289V2H13Z" fill="currentColor" />
      <path d="M16 12L1 12V13L16 13V12Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M4.62582 2H6.37412L8.72712 10H7.68476L7.09649 7.99994H3.90349L3.31524 10H2.27288L4.62582 2ZM6.80237 6.99994L5.62585 2.9999H5.37409L4.19761 6.99994H6.80237Z" fill="currentColor" />
    </svg>
  )
}

// ─────────────────────────── Segment definitions ───────────────────────────

// Sizing writes the `flex` shorthand — the three presets mirror Webflow's own
// Flex Child sizing (Shrink if needed / Grow if possible / Don't shrink or grow).
const FLEX_SEGS: readonly Seg[] = [
  { value: '0 1 auto', icon: <FlexShrinkIcon />, label: 'Shrink if needed' },
  { value: '1 1 0%', icon: <FlexGrowIcon />, label: 'Grow if possible' },
  { value: '0 0 auto', icon: <FlexNoneIcon />, label: "Don't shrink or grow" },
]

const ALIGN_SELF_SEGS: readonly Seg[] = [
  { value: 'auto', icon: <CloseIcon />, label: 'Auto' },
  { value: 'flex-start', icon: <AlignSelfStartIcon />, label: 'Start' },
  { value: 'center', icon: <AlignSelfCenterIcon />, label: 'Center' },
  { value: 'flex-end', icon: <AlignSelfEndIcon />, label: 'End' },
  { value: 'stretch', icon: <AlignSelfStretchIcon />, label: 'Stretch' },
  { value: 'baseline', icon: <AlignSelfBaselineIcon />, label: 'Baseline' },
]

// justify-self = the item's INLINE-axis self alignment (grid items). Same glyphs as
// align-self, but box-alignment keywords (start/end, not flex-start/flex-end).
const JUSTIFY_SELF_SEGS: readonly Seg[] = [
  { value: 'auto', icon: <CloseIcon />, label: 'Auto' },
  { value: 'start', icon: <AlignSelfStartIcon />, label: 'Start' },
  { value: 'center', icon: <AlignSelfCenterIcon />, label: 'Center' },
  { value: 'end', icon: <AlignSelfEndIcon />, label: 'End' },
  { value: 'stretch', icon: <AlignSelfStretchIcon />, label: 'Stretch' },
  { value: 'baseline', icon: <AlignSelfBaselineIcon />, label: 'Baseline' },
]

// Order presets: a lower order floats an item ahead of its siblings, a higher order
// sinks it behind. The X writes the explicit default (`order: 0`); the label's Clear
// removes the property.
const ORDER_SEGS: readonly Seg[] = [
  { value: '0', icon: <CloseIcon />, label: 'Default order' },
  { value: '-1', icon: <span className="embed-editor_seg-text">First</span>, label: 'First' },
  { value: '1', icon: <span className="embed-editor_seg-text">Last</span>, label: 'Last' },
]

// Canonicalize a flex-basis token so a zero in ANY unit (0 / 0px / 0%) compares equal
// — Webflow may normalize the basis we write (`0%`) to a different zero on read-back.
function canonBasis(basis: string): string {
  return /^0(?:px|%|r?em|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?$/.test(basis) ? '0%' : basis
}

// Derive the segment that reflects the current `flex` value, in the same `G S B` shape
// as the preset seg values (using the SAME shorthand parser the write path expands
// with, so a preset always round-trips to its own segment). Prefers the shorthand, then
// synthesizes from the grow/shrink/basis longhands a native write / embed stores, and
// falls back to the CSS default (0 1 auto → Shrink) when nothing is set.
function flexCurrent(read: Props['read']): string {
  const shorthand = displayOf(read('flex'))
  let grow: string, shrink: string, basis: string
  if (shorthand.present) {
    const parsed = parseFlexShorthand(shorthand.value)
    if (!parsed) return norm(shorthand.value) // a CSS-wide keyword etc. → custom
    grow = parsed['flex-grow']; shrink = parsed['flex-shrink']; basis = parsed['flex-basis']
  } else {
    const g = displayOf(read('flex-grow'))
    const s = displayOf(read('flex-shrink'))
    const b = displayOf(read('flex-basis'))
    if (!g.present && !s.present && !b.present) return '0 1 auto'
    grow = g.present ? norm(g.value) : '0'
    shrink = s.present ? norm(s.value) : '1'
    basis = b.present ? norm(b.value) : 'auto'
  }
  return `${grow} ${shrink} ${canonBasis(basis)}`
}

// The property the Sizing label represents (for its blue/orange state, provenance and
// clear). Native writes store the longhands, not `flex`, so prefer whichever is set —
// a selected one first (blue), then any present, falling back to `flex`.
const FLEX_PROPS = ['flex', 'flex-grow', 'flex-shrink', 'flex-basis'] as const
function flexLabelProp(read: Props['read']): string {
  return FLEX_PROPS.find((p) => read(p)?.source === 'selected')
    ?? FLEX_PROPS.find((p) => read(p) != null)
    ?? 'flex'
}

function alignSelfCurrent(read: Props['read']): string {
  const d = displayOf(read('align-self'))
  if (!d.present) return 'auto'
  const v = norm(d.value)
  if (v === 'start' || v === 'self-start') return 'flex-start'
  if (v === 'end' || v === 'self-end') return 'flex-end'
  return v || 'auto'
}

function justifySelfCurrent(read: Props['read']): string {
  const d = displayOf(read('justify-self'))
  if (!d.present) return 'auto'
  const v = norm(d.value)
  if (v === 'flex-start' || v === 'self-start' || v === 'left') return 'start'
  if (v === 'flex-end' || v === 'self-end' || v === 'right') return 'end'
  return v || 'auto'
}

function orderCurrent(read: Props['read']): string {
  const d = displayOf(read('order'))
  return d.present ? norm(d.value) : '0'
}

// ─────────────────────────── Sizing (flex) ───────────────────────────

// The Sizing control: the three flex presets, a "…" that seeds `1 0 auto` and reveals
// the Grow / Shrink / Basis longhand inputs below (Webflow's "Customize grow and shrink
// behavior"), and a dropdown arrow to switch the whole `flex` to a single custom value
// (`unset`, `var(…)`) that can't be split into longhands.
const FLEX_SEG_VALUES = new Set(FLEX_SEGS.map((s) => s.value))

function SizingControl(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props
  const current = flexCurrent(read)
  const isPreset = FLEX_SEG_VALUES.has(current)
  // Decomposable values resolve to a `G S B` triple; a single leftover token is a whole
  // custom value (unset / var() / a keyword) that belongs in the single input.
  const isTriple = splitTopLevelSpaces(current).length === 3
  const [panelOpen, setPanelOpen] = useState(false)
  const [singleCustom, setSingleCustom] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  const showSingle = singleCustom || (!isPreset && !isTriple)
  const showPanel = !showSingle && panelOpen
  const customTriple = !isPreset && isTriple
  const clearFlex = () => clearProp(['flex', 'flex-grow', 'flex-shrink', 'flex-basis'])
  const flexProp = flexLabelProp(read)

  const pickPreset = (value: string) => { setMenuOpen(false); setSingleCustom(false); setPanelOpen(false); setProp('flex', value, false) }
  const togglePanel = () => {
    // Opening from a preset seeds a sensible custom starting point (grow 1 / shrink 0 / auto).
    if (!panelOpen && isPreset) setProp('flex', '1 0 auto', false)
    setPanelOpen((value) => !value)
  }

  return (
    <>
      <div className="embed-editor_size-row">
        <PropLabel label="Sizing" prop={flexProp} d={displayOf(read(flexProp))} contributors={read(flexProp)?.contributors ?? []} busy={busy} onClear={clearFlex} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <div ref={rootRef} className={`embed-editor_display ${showSingle ? 'is-custom' : ''}`} role="group" aria-label="Flex sizing">
          <SegmentPill />
          {showSingle ? (
            <LiveInput
              value={current}
              busy={busy}
              placeholder="unset, var(…)"
              ariaLabel="Flex sizing"
              className="embed-editor_value-input embed-editor_display-input"
              prop="flex"
              onCommit={(value, important) => setProp('flex', value, important)}
              onLiveCommit={(value, important) => liveSetProp('flex', value, important)}
              onClear={() => { setSingleCustom(false); clearFlex() }}
            />
          ) : (
            <>
              {FLEX_SEGS.map((seg) => (
                <button
                  key={seg.value}
                  type="button"
                  role="radio"
                  aria-checked={current === seg.value}
                  className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
                  disabled={busy}
                  aria-label={seg.label}
                  title={seg.label}
                  onClick={() => pickPreset(seg.value)}
                >
                  {seg.icon}
                </button>
              ))}
              <button
                type="button"
                className={`embed-editor_display-seg ${showPanel || customTriple ? 'is-selected' : ''}`}
                disabled={busy}
                aria-pressed={showPanel || customTriple}
                aria-label="Customize grow and shrink behavior"
                title="Customize grow and shrink behavior"
                onClick={togglePanel}
              >
                <MoreDotsIcon />
              </button>
            </>
          )}
          <button
            type="button"
            className="embed-editor_display-arrow"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More flex sizing options"
            disabled={busy}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <ChevronIcon />
          </button>
          {menuOpen ? (
            <div className="embed-editor_display-menu" role="menu">
              {showSingle
                ? FLEX_SEGS.map((seg) => <MenuItem key={seg.value} label={seg.label} onClick={() => pickPreset(seg.value)} />)
                : <MenuItem label="Custom" onClick={() => { setMenuOpen(false); setPanelOpen(false); setSingleCustom(true) }} />}
            </div>
          ) : null}
        </div>
      </div>
      {showPanel ? (
        <div className="embed-editor_type-triple embed-editor_flex-custom">
          <StackedField prop="flex-grow" label="Grow" placeholder="0" {...props} />
          <StackedField prop="flex-shrink" label="Shrink" placeholder="1" {...props} />
          <StackedField prop="flex-basis" label="Basis" placeholder="auto" {...props} />
        </div>
      ) : null}
    </>
  )
}

// ─────────────────────────── Grid-item position ───────────────────────────

const rawOf = (d: ReturnType<typeof displayOf>) => (d.present ? (d.important ? `${d.value} !important` : d.value) : '')

// Split a `grid-column` / `grid-row` shorthand into its start / end line values
// (`auto / span 2` → ['auto', 'span 2']); a lone value is the start (end blank).
function splitSlash(value: string): [string, string] {
  const i = value.indexOf('/')
  return i < 0 ? [value.trim(), ''] : [value.slice(0, i).trim(), value.slice(i + 1).trim()]
}

// Build the grid-column / grid-row shorthand from a start & end line ('' when both auto).
// `auto / span 2`, or just `2` when the end is auto. Webflow's grid-child placement reads
// this shorthand — the *-start / *-end longhands land in Custom properties instead.
function buildLine(start: string, end: string): string {
  const s = start.trim() || 'auto'
  const e = end.trim() || 'auto'
  if (s === 'auto' && e === 'auto') return ''
  return e === 'auto' ? s : `${s} / ${e}`
}

// One axis (Column or Row): its Start / End line fields. Reads the explicit longhands,
// falling back to the axis shorthand split across the two fields. Editing while the
// value comes from the shorthand expands it to longhands (dropping the shorthand) so
// they never conflict. The Start / End labels carry the blue/orange/clear state; the
// axis name (Column / Row) is a plain caption on the left.
function AxisRow({ axis, label, props: sp }: { axis: 'column' | 'row'; label: string; props: Props }) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = sp
  const startProp = `grid-${axis}-start`
  const endProp = `grid-${axis}-end`
  const shortProp = `grid-${axis}`
  const siblingProp = axis === 'column' ? 'grid-row' : 'grid-column'
  const startD = displayOf(read(startProp))
  const endD = displayOf(read(endProp))
  const shortD = displayOf(read(shortProp))
  const [shStart, shEnd] = shortD.present ? splitSlash(shortD.value) : ['', '']
  // Prefer the shorthand (what we write); fall back to any legacy *-start / *-end longhands.
  const startVal = shortD.present ? shStart : (startD.present ? rawOf(startD) : '')
  const endVal = shortD.present ? shEnd : (endD.present ? rawOf(endD) : '')

  // Clear THIS axis's placement. Webflow keeps grid-column & grid-row together as one grid
  // placement, so clearing one also drops the other in the native panel — re-assert the
  // sibling axis afterwards so only this axis is cleared.
  const clearAxis = () => {
    clearProp([shortProp, startProp, endProp])
    const sib = displayOf(read(siblingProp))
    if (sib.present && sib.value.trim()) setProp(siblingProp, sib.value.trim(), sib.important)
  }

  // Write the grid-column / grid-row SHORTHAND, combining this edit with the other axis end.
  // Webflow's grid-child placement reads the shorthand; the *-start / *-end longhands park in
  // Custom properties instead. Live updates as you type (the shorthand replaces itself cleanly).
  const commit = (which: 'start' | 'end', value: string, important: boolean, live: boolean) => {
    const start = (which === 'start' ? value : startVal).trim()
    const end = (which === 'end' ? value : endVal).trim()
    const line = buildLine(start, end)
    if (live) { if (line) liveSetProp(shortProp, line, important); return }
    if (!line) { clearAxis(); return }
    setProp(shortProp, line, important)
    // Drop any legacy longhands so they can't shadow the shorthand we just wrote.
    if (startD.present || endD.present) clearProp([startProp, endProp])
  }

  // The blue, clearable label is the AXIS (Column / Row) — we write the axis shorthand, so
  // Start / End are just plain captions under their inputs.
  const cell = (which: 'start' | 'end', caption: string, value: string) => (
    <div className="embed-editor_line-cell">
      <LiveInput
        value={value}
        busy={busy}
        placeholder={which === 'end' ? 'span 1' : 'auto'}
        ariaLabel={`${label} ${caption}`}
        className="u-input embed-editor_size-input"
        onCommit={(v, imp) => commit(which, v, imp, false)}
        onLiveCommit={(v, imp) => commit(which, v, imp, true)}
        onClear={() => commit(which, '', false, false)}
      />
      <span className="embed-editor_line-caption">{caption}</span>
    </div>
  )

  return (
    <div className="embed-editor_size-row embed-editor_line-row">
      <GroupLabel
        label={label}
        props={[shortProp, startProp, endProp]}
        read={read}
        busy={busy}
        onClear={clearAxis}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_line-cells">
        {cell('start', 'Start', startVal)}
        {cell('end', 'End', endVal)}
      </div>
    </div>
  )
}

// Grid-item Position: the Column / Row line placement (start / end each), which read
// the longhands or split the axis shorthand.
function PositionControl(props: Props) {
  return (
    <>
      <AxisRow axis="column" label="Column" props={props} />
      <AxisRow axis="row" label="Row" props={props} />
    </>
  )
}

// ─────────────────────────── Section ───────────────────────────

export default function FlexChildSection(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props
  return (
    <>
      <SizingControl {...props} />
      <PositionControl {...props} />

      <div className="embed-editor_size-row">
        <PropLabel label="Align" prop="align-self" d={displayOf(read('align-self'))} contributors={read('align-self')?.contributors ?? []} busy={busy} onClear={() => clearProp('align-self')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <SegBar
          segs={ALIGN_SELF_SEGS}
          current={alignSelfCurrent(read)}
          ariaLabel="Align self"
          prop="align-self"
          busy={busy}
          onCommit={(value, important) => setProp('align-self', value, important)}
          onLiveCommit={(value, important) => liveSetProp('align-self', value, important)}
          onClear={() => clearProp('align-self')}
        />
      </div>
      <div className="embed-editor_size-row">
        <PropLabel label="Justify" prop="justify-self" d={displayOf(read('justify-self'))} contributors={read('justify-self')?.contributors ?? []} busy={busy} onClear={() => clearProp('justify-self')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <SegBar
          segs={JUSTIFY_SELF_SEGS}
          current={justifySelfCurrent(read)}
          ariaLabel="Justify self"
          prop="justify-self"
          busy={busy}
          onCommit={(value, important) => setProp('justify-self', value, important)}
          onLiveCommit={(value, important) => liveSetProp('justify-self', value, important)}
          onClear={() => clearProp('justify-self')}
        />
      </div>
      <div className="embed-editor_size-row">
        <PropLabel label="Order" prop="order" d={displayOf(read('order'))} contributors={read('order')?.contributors ?? []} busy={busy} onClear={() => clearProp('order')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <SegBar
          segs={ORDER_SEGS}
          current={orderCurrent(read)}
          ariaLabel="Order"
          prop="order"
          busy={busy}
          moreSegment
          moreValue="2"
          onCommit={(value, important) => setProp('order', value, important)}
          onLiveCommit={(value, important) => liveSetProp('order', value, important)}
          onClear={() => clearProp('order')}
        />
      </div>
    </>
  )
}
