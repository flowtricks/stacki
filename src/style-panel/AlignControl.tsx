import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import Select, { type SelectOption } from './components/Select'
import { GroupLabel } from './TypographySection'
import type { ResolvedProp } from './lib/resolved'
import { useComputedChoice } from './lib/computed-style'
import { commitInPlace } from './lib/commit-in-place'

// Webflow's flex-alignment control: a live preview grid on the left (3×3 click
// targets under a real-flex bar preview) plus the X / Y axis dropdowns. The X axis
// is the horizontal screen direction, Y the vertical — each maps to justify-content
// or align-items depending on the flex-direction (main axis). All writes target the
// picked selector via `onSet`; each axis's own X / Y label owns clear / provenance for
// the one property it drives, so the two can be reset independently.

type Props = {
  /** Effective justify-content value (raw, '' when unset). */
  justify: string
  /** Effective align-items value (raw, '' when unset). */
  align: string
  /** flex-direction is column / column-reverse (main axis is vertical). */
  column: boolean
  busy: boolean
  /** Resolved model, for the X / Y labels' blue / orange / clear states. */
  read: (prop: string) => ResolvedProp | undefined
  onSet: (prop: string, value: string) => void
  /** Live preview; `null` = drop the preview and restore the committed value. */
  onLive: (prop: string, value: string | null) => void
  onClear: (prop: string) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}

const CUSTOM = '__custom__'

// ─────────────────────────── Icons ───────────────────────────
// Glyphs lifted from Webflow's own alignment dropdown. The "column" set (main-axis
// packing) is shown for justify-content; the "row" set (cross-axis) for align-items.

function Icon({ children, rotate = 0 }: { children: ReactNode; rotate?: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {rotate ? <g transform={`rotate(${rotate} 8 8)`}>{children}</g> : children}
    </svg>
  )
}

// justify-content — authored HORIZONTAL (bars packed left→right).
const JUSTIFY_PATHS: Record<string, ReactNode> = {
  'flex-start': <path d="M2 14V1H3V5H11.5C11.7761 5 12 5.22386 12 5.5V6.5C12 6.77614 11.7761 7 11.5 7H3V8H7.5C7.77614 8 8 8.22386 8 8.5V9.5C8 9.77614 7.77614 10 7.5 10H3V14H2Z" fill="currentColor" />,
  center: <><path d="M7 14V10H4.5C4.22386 10 4 9.77614 4 9.5V8.5C4 8.22386 4.22386 8 4.5 8H7V7H2.5C2.22386 7 2 6.77614 2 6.5V5.5C2 5.22386 2.22386 5 2.5 5H7V1H8V14H7Z" fill="currentColor" /><path d="M14 5.5C14 5.22386 13.7761 5 13.5 5H9V7H13.5C13.7761 7 14 6.77614 14 6.5V5.5Z" fill="currentColor" /><path d="M12 8.5C12 8.22386 11.7761 8 11.5 8H9V10H11.5C11.7761 10 12 9.77614 12 9.5V8.5Z" fill="currentColor" /></>,
  'flex-end': <path d="M13 14V10H8.5C8.22386 10 8 9.77614 8 9.5V8.5C8 8.22386 8.22386 8 8.5 8H13V7H4.5C4.22386 7 4 6.77614 4 6.5V5.5C4 5.22386 4.22386 5 4.5 5H13V1H14V14H13Z" fill="currentColor" />,
  'space-between': <><path d="M14 4L14 1L15 1L15 14L14 14L14 11L12.5 11C12.2239 11 12 10.7761 12 10.5L12 4.5C12 4.22386 12.2239 4 12.5 4L14 4Z" fill="currentColor" /><path d="M2 14L2 0.999999L3 0.999999L3 4L4.5 4C4.77614 4 5 4.22386 5 4.5L5 10.5C5 10.7761 4.77614 11 4.5 11L3 11L3 14L2 14Z" fill="currentColor" /></>,
  'space-around': <><path d="M2 14V1H3V14H2Z" fill="currentColor" /><path d="M4.5 4C4.22386 4 4 4.22386 4 4.5L4 10.5C4 10.7761 4.22386 11 4.5 11H5.5C5.77614 11 6 10.7761 6 10.5L6 4.5C6 4.22386 5.77614 4 5.5 4L4.5 4Z" fill="currentColor" /><path d="M11.5 11C11.2239 11 11 10.7761 11 10.5V4.5C11 4.22386 11.2239 4 11.5 4L12.5 4C12.7761 4 13 4.22386 13 4.5V10.5C13 10.7761 12.7761 11 12.5 11H11.5Z" fill="currentColor" /><path d="M14 14V1H15V14H14Z" fill="currentColor" /></>,
}

// align-items — authored VERTICAL (items on a horizontal line, aligned top→bottom).
const ALIGN_PATHS: Record<string, ReactNode> = {
  'flex-start': <path d="M2 2H15V3H11V7.5C11 7.77614 10.7761 8 10.5 8L9.5 8C9.22386 8 9 7.77614 9 7.5V3L8 3L8 11.5C8 11.7761 7.77614 12 7.5 12H6.5C6.22386 12 6 11.7761 6 11.5L6 3L2 3V2Z" fill="currentColor" />,
  center: <><path d="M8 7V2.5C8 2.22386 7.77614 2 7.5 2H6.5C6.22386 2 6 2.22386 6 2.5V7L2 7V8L15 8V7H11V4.5C11 4.22386 10.7761 4 10.5 4L9.5 4C9.22386 4 9 4.22386 9 4.5V7H8Z" fill="currentColor" /><path d="M8 9V13.5C8 13.7761 7.77614 14 7.5 14H6.5C6.22386 14 6 13.7761 6 13.5V9H8Z" fill="currentColor" /><path d="M10.5 12C10.7761 12 11 11.7761 11 11.5V9H9V11.5C9 11.7761 9.22386 12 9.5 12H10.5Z" fill="currentColor" /></>,
  'flex-end': <path d="M8 13L8 4.5C8 4.22386 7.77614 4 7.5 4H6.5C6.22386 4 6 4.22386 6 4.5L6 13L2 13V14L15 14V13H11V8.5C11 8.22386 10.7761 8 10.5 8L9.5 8C9.22386 8 9 8.22386 9 8.5V13H8Z" fill="currentColor" />,
  stretch: <path fillRule="evenodd" clipRule="evenodd" d="M6 3L2 3V2H15V3L11 3V13L15 13V14L2 14V13H6L6 3ZM8 3L9 3L9 13H8L8 3Z" fill="currentColor" />,
  baseline: <path fillRule="evenodd" clipRule="evenodd" d="M8 7V3.5C8 3.22386 7.77614 3 7.5 3H5.5C5.22386 3 5 3.22386 5 3.5L5 7H2V8H5V13.5C5 13.7761 5.22386 14 5.5 14H7.5C7.77614 14 8 13.7761 8 13.5V8H9V10.5C9 10.7761 9.22386 11 9.5 11H11.5C11.7761 11 12 10.7761 12 10.5V8L15 8V7L12 7V3.5C12 3.22386 11.7761 3 11.5 3H9.5C9.22386 3 9 3.22386 9 3.5V7H8ZM6 4V7H7V4L6 4ZM10 7H11V4L10 4V7Z" fill="currentColor" />,
}

// The icon for a value on a given SCREEN axis. Glyphs are authored for their natural
// orientation (justify = horizontal, align = vertical). A column layout swaps which
// property drives each screen axis, so when a value set lands on the opposite axis we
// rotate the glyph 90° — it always reads along the axis it controls, like Webflow.
function iconFor(value: string, prop: string, axis: 'x' | 'y'): ReactNode {
  const isJustify = prop === 'justify-content'
  const paths = (isJustify ? JUSTIFY_PATHS : ALIGN_PATHS)[value]
  if (!paths) return undefined
  const naturalAxis = isJustify ? 'x' : 'y'
  const rotate = axis === naturalAxis ? 0 : isJustify ? 90 : -90
  return <Icon rotate={rotate}>{paths}</Icon>
}

// Baseline has no spatial cross-axis layout, so the box shows two markers sitting on
// a baseline — a letter "A" and a down arrow, each with an underline tick — instead of
// item bars, matching Webflow. They're distributed by the OTHER axis (justify-content),
// so Space-between pushes them to the edges, Center sits them together, etc.
const BASELINE_A = (
  <svg viewBox="0 0 14 16" width="14" height="16" fill="none" aria-hidden="true">
    <path d="M2.6 10 L7 3 L11.4 10 M4.1 7.6 H9.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="1.4" y1="13" x2="12.6" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)
const BASELINE_ARROW = (
  <svg viewBox="0 0 14 16" width="14" height="16" fill="none" aria-hidden="true">
    <path d="M7 3 V9.2 M4.4 6.9 L7 9.6 L9.6 6.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="1.4" y1="13" x2="12.6" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

const JUSTIFY_VALUES = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']
const ALIGN_VALUES = ['flex-start', 'center', 'flex-end', 'stretch', 'baseline']

// Map assorted spellings onto the canonical values used above.
function norm(value: string): string {
  const v = value.trim().toLowerCase()
  if (v === 'start' || v === 'self-start' || v === 'left') return 'flex-start'
  if (v === 'end' || v === 'self-end' || v === 'right') return 'flex-end'
  return v
}

// Labels track the screen axis, not the property: start/end read as Left/Right on
// the X axis and Top/Bottom on the Y axis.
function axisLabel(value: string, axis: 'x' | 'y'): string {
  switch (value) {
    case 'flex-start': return axis === 'x' ? 'Left' : 'Top'
    case 'flex-end': return axis === 'x' ? 'Right' : 'Bottom'
    case 'center': return 'Center'
    case 'space-between': return 'Space between'
    case 'space-around': return 'Space around'
    case 'space-evenly': return 'Space evenly'
    case 'stretch': return 'Stretch'
    case 'baseline': return 'Baseline'
    default: return value
  }
}

// The free-text field shown in Custom mode: live-updates while typing, commits on
// blur, and clears the property when emptied (mirrors the panel's other inputs).
function CustomInput({ value, busy, ariaLabel, autoFocus, onCommit, onLive, onClear }: {
  value: string
  busy: boolean
  ariaLabel: string
  autoFocus: boolean
  onCommit: (value: string) => void
  onLive: (value: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const liveTimer = useRef<number | null>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const cancelLive = () => { if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null } }
  useEffect(() => cancelLive, [])
  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => { liveTimer.current = null; const t = text.trim(); if (t) onLive(t) }, 100)
  }
  const commit = () => { const t = draft.trim(); if (t) onCommit(t); else onClear() }
  return (
    <input
      className="u-select-custom-input"
      value={draft}
      onChange={(event) => { setDraft(event.target.value); scheduleLive(event.target.value) }}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; cancelLive(); commit() }}
      onKeyDown={(event) => { if (event.key === 'Enter') commitInPlace(event.currentTarget) }}
      disabled={busy}
      spellCheck={false}
      placeholder="unset"
      aria-label={ariaLabel}
      autoFocus={autoFocus}
    />
  )
}

// One axis dropdown. `prop` is the CSS property this axis edits (justify-content or
// align-items, per direction); `fallback` is the CSS default shown when unset. The
// last option is always "Custom", which seeds `unset` and reveals a free-text field
// for any other value.
function AxisSelect({ axis, label, prop, value, values, fallback, busy, read, onSet, onLive, onClear, onProvenance, onSelectSelector }: {
  axis: 'x' | 'y'
  label: string
  prop: string
  value: string
  values: string[]
  fallback: string
  busy: boolean
  read: (prop: string) => ResolvedProp | undefined
  onSet: (prop: string, value: string) => void
  /** Live preview; `null` = drop the preview and restore the committed value. */
  onLive: (prop: string, value: string | null) => void
  onClear: (prop: string) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const [forceCustom, setForceCustom] = useState(false)
  const ariaLabel = axis === 'x' ? 'Horizontal alignment' : 'Vertical alignment'
  const present = Boolean(value.trim())
  const n = norm(value)
  const known = values.includes(n)
  // Unset → what the page computes for this element, which catches a rule the
  // panel's matcher can't see; `normal` and friends aren't options, so those fall
  // through to the CSS default below.
  const computed = useComputedChoice(present ? '' : prop, values)
  const customMode = forceCustom || (present && !known)
  const options: SelectOption<string>[] = values.map((v) => ({ value: v, label: axisLabel(v, axis), icon: iconFor(v, prop, axis) }))
  options.push({ value: CUSTOM, label: 'Custom' })

  const pick = (v: string) => {
    if (v === CUSTOM) { setForceCustom(true); onSet(prop, 'unset'); return }
    setForceCustom(false)
    onSet(prop, v)
  }
  // Hover scrub: preview the option under the pointer on the canvas, and put the
  // original back when the list closes without a pick. "Custom" has no value of its own
  // to show, so landing on it reverts rather than previewing `unset`.
  const preview = (v: string | null) => onLive(prop, v === CUSTOM ? null : v)

  return (
    <div className="embed-editor_align-axis">
      {/* The axis label — not the row's "Align" caption — carries this property's
          blue / orange state and its clear menu, so X and Y reset independently. */}
      <GroupLabel
        label={label}
        props={[prop]}
        read={read}
        busy={busy}
        onClear={() => onClear(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={customMode ? CUSTOM : (present ? n : (computed || fallback))}
        options={options}
        ariaLabel={ariaLabel}
        disabled={busy}
        hideTriggerIcon
        onChange={pick}
        onPreview={preview}
        customInput={customMode ? (
          <CustomInput
            value={value}
            busy={busy}
            ariaLabel={ariaLabel}
            autoFocus={forceCustom}
            onCommit={(val) => onSet(prop, val)}
            onLive={(val) => onLive(prop, val)}
            onClear={() => { setForceCustom(false); onClear(prop) }}
          />
        ) : undefined}
      />
    </div>
  )
}

// The preview square: a 3×3 grid of click targets (start / center / end on each
// axis) under a real-flex bar preview that lays out with the current values.
function AlignBox({ justify, align, column, busy, onSet }: Pick<Props, 'justify' | 'align' | 'column' | 'busy' | 'onSet'>) {
  const j = norm(justify) || 'flex-start'
  const a = norm(align) || 'stretch'
  const isBaseline = a === 'baseline'
  // Stretch → let the real align-items fill the cross axis (omit the size); every
  // other value → a short fixed-length bar that align-items then positions (Webflow
  // shows the children as small ticks unless they're stretched).
  const cross = a === 'stretch' ? undefined : '28%'
  const barStyle: CSSProperties = column ? { height: 2, width: cross } : { width: 2, height: cross }
  // Baseline aligns items to the first text baseline — i.e. the cross-axis start (the
  // top of a row) — so pin the A↓ glyph there (like Webflow), while the other axis
  // (justify-content) still positions it left/center/right.
  const previewStyle: CSSProperties = { flexDirection: column ? 'column' : 'row', justifyContent: j, alignItems: isBaseline ? 'flex-start' : a }
  const positions = ['flex-start', 'center', 'flex-end']
  // Screen X → horizontal property, screen Y → vertical property (flip on column).
  const xProp = column ? 'align-items' : 'justify-content'
  const yProp = column ? 'justify-content' : 'align-items'
  return (
    <div className="embed-editor_align-box">
      <div className="embed-editor_align-dots">
        {positions.map((ry) => positions.map((cx) => (
          <button
            key={`${ry}-${cx}`}
            type="button"
            className="embed-editor_align-dot"
            disabled={busy}
            aria-label={`Align ${axisLabel(cx, 'x')} ${axisLabel(ry, 'y')}`}
            onClick={() => { onSet(xProp, cx); onSet(yProp, ry) }}
          >
            <span />
          </button>
        )))}
      </div>
      <div className="embed-editor_align-preview" style={previewStyle} aria-hidden="true">
        {isBaseline ? (
          <>
            <span className="embed-editor_align-baseline">{BASELINE_A}</span>
            <span className="embed-editor_align-baseline">{BASELINE_ARROW}</span>
          </>
        ) : (
          // Double-click the clustered bars → space-between; double-click a spread bar
          // → collapse the main axis to that bar's position (start / center / end).
          positions.map((pos, i) => (
            <span
              key={i}
              className="embed-editor_align-bar"
              style={barStyle}
              title={j === 'space-between' ? 'Double-click to align here' : 'Double-click for Space between'}
              onDoubleClick={() => onSet('justify-content', j === 'space-between' ? pos : 'space-between')}
            />
          ))
        )}
      </div>
    </div>
  )
}

export default function AlignControl({ justify, align, column, busy, read, onSet, onLive, onClear, onProvenance, onSelectSelector }: Props) {
  // X = horizontal screen axis, Y = vertical. In a column layout the main axis is
  // vertical, so justify/align swap which screen axis they drive.
  const xProp = column ? 'align-items' : 'justify-content'
  const yProp = column ? 'justify-content' : 'align-items'
  const xValues = column ? ALIGN_VALUES : JUSTIFY_VALUES
  const yValues = column ? JUSTIFY_VALUES : ALIGN_VALUES
  const xValue = column ? align : justify
  const yValue = column ? justify : align
  // CSS defaults: justify-content → flex-start, align-items → stretch.
  const xFallback = column ? 'stretch' : 'flex-start'
  const yFallback = column ? 'flex-start' : 'stretch'
  return (
    <div className="embed-editor_align">
      <AlignBox justify={justify} align={align} column={column} busy={busy} onSet={onSet} />
      <div className="embed-editor_align-axes">
        <AxisSelect axis="x" label="X" prop={xProp} value={xValue} values={xValues} fallback={xFallback} busy={busy} read={read} onSet={onSet} onLive={onLive} onClear={onClear} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <AxisSelect axis="y" label="Y" prop={yProp} value={yValue} values={yValues} fallback={yFallback} busy={busy} read={read} onSet={onSet} onLive={onLive} onClear={onClear} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      </div>
    </div>
  )
}
