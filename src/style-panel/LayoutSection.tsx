import { useEffect, useRef, useState } from 'react'
import FieldLabel from './components/FieldLabel'
import Select, { type SelectOption } from './components/Select'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import useScrub from './components/useScrub'
import DisplayControl from './DisplayControl'
import VariableConnect from './VariableConnect'
import { handleArrowStep } from './lib/number-step'
import { cap, readProp } from './lib/prop-read'
import type { ParsedRule } from './lib/types'
import { splitTopLevelSpaces } from './lib/background'

// The Layout section of the style panel. The Display control is always shown;
// the rest (flex vs grid controls) conditionally appears based on the current
// `display` value. Every control is addressed by property name and reads the
// live declaration each render (declIds regenerate on every rebuild).

type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type LiveSetProp = (prop: string, value: string | null, important: boolean) => void

type Props = {
  rule: ParsedRule
  busy: boolean
  onSetProp: SetProp
  onClearProp: ClearProp
  onLiveSetProp: LiveSetProp
}

// Nicer labels for the enumerated values; anything else is capitalized.
const LABELS: Record<string, string> = {
  'flex-start': 'Start', 'flex-end': 'End',
  'space-between': 'Space between', 'space-around': 'Space around', 'space-evenly': 'Space evenly',
  start: 'Start', end: 'End', center: 'Center', stretch: 'Stretch', baseline: 'Baseline',
  nowrap: 'No wrap', wrap: 'Wrap', 'wrap-reverse': 'Wrap reverse',
}
const optLabel = (value: string) => LABELS[value] ?? cap(value)

const WRAP = ['nowrap', 'wrap', 'wrap-reverse']
const JUSTIFY_FLEX = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']
const ALIGN_FLEX = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline']
const JUSTIFY_GRID = ['stretch', 'start', 'center', 'end']

const FLEX_DIRECTION: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: '→', ariaLabel: 'Row' },
  { value: 'column', label: '↓', ariaLabel: 'Column' },
  { value: 'row-reverse', label: '←', ariaLabel: 'Row reverse' },
  { value: 'column-reverse', label: '↑', ariaLabel: 'Column reverse' },
]
const GRID_FLOW: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: '→', ariaLabel: 'Rows' },
  { value: 'column', label: '↓', ariaLabel: 'Columns' },
]

function buildOptions(known: string[], current: string): SelectOption<string>[] {
  const options: SelectOption<string>[] = [{ value: '', label: '—' }, ...known.map((value) => ({ value, label: optLabel(value) }))]
  if (current && !known.includes(current)) options.push({ value: current, label: current })
  return options
}

function SelectRow({ rule, busy, prop, label, values, onSetProp, onClearProp, onLiveSetProp }: {
  rule: ParsedRule; busy: boolean; prop: string; label: string; values: string[]
  onSetProp: SetProp; onClearProp: ClearProp; onLiveSetProp: LiveSetProp
}) {
  const found = readProp(rule, prop)
  const current = found ? found.value.trim().toLowerCase() : ''
  return (
    <div className="embed-editor_size-row">
      <FieldLabel className="embed-editor_size-label" active={Boolean(found)} disabled={busy} onReset={() => onClearProp(prop)} resetLabel="Clear">
        {label}
      </FieldLabel>
      <Select
        value={current}
        options={buildOptions(values, current)}
        ariaLabel={label}
        disabled={busy}
        onChange={(choice) => (choice ? onSetProp(prop, choice, false) : onClearProp(prop))}
        onPreview={(choice) => onLiveSetProp(prop, choice || null, false)}
      />
    </div>
  )
}

function SegRow({ rule, busy, prop, label, options, onSetProp, onClearProp }: {
  rule: ParsedRule; busy: boolean; prop: string; label: string
  options: ReadonlyArray<SegmentedOption<string>>; onSetProp: SetProp; onClearProp: ClearProp
}) {
  const found = readProp(rule, prop)
  const value = found ? found.value.trim().toLowerCase() : ''
  return (
    <div className="embed-editor_size-row">
      <FieldLabel className="embed-editor_size-label" active={Boolean(found)} disabled={busy} onReset={() => onClearProp(prop)} resetLabel="Clear">
        {label}
      </FieldLabel>
      <SegmentedControl value={value} options={options} ariaLabel={label} onChange={(choice) => onSetProp(prop, choice, false)} />
    </div>
  )
}

// ─────────────────────────── Gap ───────────────────────────

function LockedIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  )
}
function UnlockedIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.9-.6" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

// Split a `gap` value into its row / column parts. One token → both equal (a
// linked gap); two tokens → `gap: <row> <column>` per the CSS shorthand.
function parseGap(value: string): { row: string; col: string } {
  const parts = splitTopLevelSpaces(value).filter(Boolean)
  if (parts.length === 0) return { row: '', col: '' }
  if (parts.length === 1) return { row: parts[0], col: parts[0] }
  return { row: parts[0], col: parts[1] }
}

// A length field with live-as-you-type updates, a commit on blur, and ↑/↓ number
// stepping — the shared gap-cell input (mirrors PropField, minus the property binding).
function GapInput({ value, busy, ariaLabel, onLive, onCommit }: {
  value: string
  busy: boolean
  ariaLabel: string
  onLive: (value: string) => void
  onCommit: (value: string) => void
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
    disabled: busy,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: (text) => { setDraft(text); onCommit(text) },
  })
  return (
    <VariableConnect ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} className="is-fill" prop="gap" onPick={(binding) => onCommit(binding)}>
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
        spellCheck={false}
        placeholder="0"
        aria-label={ariaLabel}
      />
    </VariableConnect>
  )
}

// The Gap control: a lock toggle plus one field (linked → `gap: 2rem`) or two
// fields (unlinked → `gap: 2rem 3rem`, i.e. `gap: <row> <column>`). The link
// state derives from the value (equal parts = linked) but the user can override it.
function GapControl({ rule, busy, onSetProp, onClearProp, onLiveSetProp }: {
  rule: ParsedRule; busy: boolean; onSetProp: SetProp; onClearProp: ClearProp; onLiveSetProp: LiveSetProp
}) {
  const found = readProp(rule, 'gap')
  const value = found ? found.value.trim() : ''
  const { row, col } = parseGap(value)
  const [linkOverride, setLinkOverride] = useState<boolean | null>(null)
  const linked = linkOverride ?? (row === col)

  const writeLinked = (next: string, live: boolean) => {
    const v = next.trim()
    if (!v) { if (!live) onClearProp('gap'); return }
    ;(live ? onLiveSetProp : onSetProp)('gap', v, false)
  }
  const writeSplit = (r: string, c: string, live: boolean) => {
    if (!r.trim() && !c.trim()) { if (!live) onClearProp('gap'); return }
    ;(live ? onLiveSetProp : onSetProp)('gap', `${r.trim() || '0'} ${c.trim() || '0'}`, false)
  }

  const toggleLink = () => {
    if (linked) { setLinkOverride(false); return }
    setLinkOverride(true)
    const single = row || col
    if (single) onSetProp('gap', single, false)
    else onClearProp('gap')
  }

  return (
    <div className="embed-editor_size-row">
      <FieldLabel className="embed-editor_size-label" active={Boolean(found)} disabled={busy} onReset={() => { setLinkOverride(null); onClearProp('gap') }} resetLabel="Clear">
        Gap
      </FieldLabel>
      <div className="embed-editor_gap">
        {linked ? (
          <GapInput value={row} busy={busy} ariaLabel="Gap" onLive={(v) => writeLinked(v, true)} onCommit={(v) => writeLinked(v, false)} />
        ) : (
          <>
            <div className="embed-editor_gap-cell">
              <GapInput value={col} busy={busy} ariaLabel="Column gap" onLive={(v) => writeSplit(row, v, true)} onCommit={(v) => writeSplit(row, v, false)} />
              <span className="embed-editor_gap-caption">Columns</span>
            </div>
            <div className="embed-editor_gap-cell">
              <GapInput value={row} busy={busy} ariaLabel="Row gap" onLive={(v) => writeSplit(v, col, true)} onCommit={(v) => writeSplit(v, col, false)} />
              <span className="embed-editor_gap-caption">Rows</span>
            </div>
          </>
        )}
        <button
          type="button"
          className={`embed-editor_icon-btn embed-editor_gap-link ${linked ? 'is-active' : ''}`}
          disabled={busy}
          aria-pressed={linked}
          title={linked ? 'Linked — one gap for rows and columns' : 'Unlinked — separate row and column gaps'}
          onClick={toggleLink}
        >
          {linked ? <LockedIcon /> : <UnlockedIcon />}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────── Grid ───────────────────────────

// justify-content / align-content values (how the TRACKS distribute in the container).
const GRID_CONTENT = ['start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly']

// Split a grid-template track list on TOP-LEVEL whitespace so repeat(…)/minmax(…)
// and [line-name] tokens stay intact.
function splitTracks(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value.trim()) {
    if (ch === '(' || ch === '[') { depth += 1; cur += ch }
    else if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch }
    else if (/\s/.test(ch) && depth === 0) { if (cur) { parts.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}
// The number of tracks a grid-template value defines — expands `repeat(n, …)` and
// ignores [line-name] tokens. 0 when unset / none.
function countTracks(value: string): number {
  const v = value.trim().toLowerCase()
  if (!v || v === 'none') return 0
  let count = 0
  for (const t of splitTracks(v)) {
    if (t.startsWith('[')) continue
    const rep = t.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/i)
    if (rep) count += parseInt(rep[1], 10) * Math.max(1, splitTracks(rep[2]).filter((x) => !x.startsWith('[')).length)
    else count += 1
  }
  return count
}
// The count stepper writes N UNIFORM tracks of the axis default — every column is
// minmax(0px, 1fr) (fills its share but can shrink to nothing so content can't overflow),
// every row is auto (content-sized). The min needs a unit (`0px`, not bare `0`) or Webflow
// reads the whole grid-template as a custom value. Mirrors GridControls' count stepper.
const NEW_COLUMN = 'minmax(0px, 1fr)'
const NEW_ROW = 'auto'
const uniformTracks = (n: number, fill: string) => Array.from({ length: Math.max(0, n) }, () => fill).join(' ')

// grid-auto-flow is a direction (row | column) optionally packed `dense`.
function parseFlow(value: string): { dir: string; dense: boolean } {
  const v = value.toLowerCase()
  return { dir: v.includes('column') ? 'column' : 'row', dense: v.includes('dense') }
}
const buildFlow = (dir: string, dense: boolean) => (dense ? `${dir} dense` : dir)

const ChevUp = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12"><path d="M4.6 9.4 8 6l3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const ChevDown = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12"><path d="M4.6 6.6 8 10l3.4-3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const DenseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d="M14.8535 11.1465 14.1465 11.8535 12.5 10.207V14H11.5v-3.793L9.85352 11.8535 9.14648 11.1465 12 8.29297 14.8535 11.1465Z" fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d="M14.1025 1.005C14.6067 1.056 15 1.482 15 2v4l-.005.103c-.048.47-.422.844-.892.892L14 7h-4c-.518 0-.944-.393-.995-.897L9 6V2c0-.552.448-1 1-1h4l.103.005ZM10 6h4V2h-4v4Z" fill="currentColor" />
    <path opacity="0.4" d="M9 9H3v4h6v1H3l-.103-.005c-.47-.048-.844-.422-.892-.892L2 13V9c0-.552.448-1 1-1h6v1Z" fill="currentColor" />
    <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M7.103 1.005C7.607 1.056 8 1.482 8 2v4l-.005.103c-.048.47-.422.844-.892.892L7 7H3c-.518 0-.944-.393-.995-.897L2 6V2c0-.552.448-1 1-1h4l.103.005ZM3 6h4V2H3v4Z" fill="currentColor" />
  </svg>
)

// A whole-number track-count field with ▲▼ steppers (Webflow's Columns/Rows inputs).
function CountField({ value, busy, ariaLabel, onCommit }: { value: number; busy: boolean; ariaLabel: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(value > 0 ? String(value) : '')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value > 0 ? String(value) : '') }, [value])
  const clampN = (n: number) => Math.min(500, Math.max(1, n))
  const commit = (t: string) => {
    const n = parseInt(t, 10)
    if (Number.isNaN(n)) { setText(value > 0 ? String(value) : ''); return }
    onCommit(clampN(n))
  }
  const step = (delta: number) => onCommit(clampN((value || 0) + delta))
  return (
    <div className="embed-editor_grid-count">
      <input
        className="u-input embed-editor_size-input"
        value={text}
        inputMode="numeric"
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder="0"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit(text) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); step(1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1) }
        }}
      />
      <div className="embed-editor_grid-count-steppers">
        <button type="button" tabIndex={-1} disabled={busy} aria-label="Increase" onClick={() => step(1)}><ChevUp /></button>
        <button type="button" tabIndex={-1} disabled={busy} aria-label="Decrease" onClick={() => step(-1)}><ChevDown /></button>
      </div>
    </div>
  )
}

// Columns + Rows track counts. Each count writes N equal `1fr` tracks; the wrench
// track editor (custom sizing) isn't built yet — use the value field for that.
function GridTracksRow({ rule, busy, onSetProp, onClearProp }: {
  rule: ParsedRule; busy: boolean; onSetProp: SetProp; onClearProp: ClearProp
}) {
  const colsFound = readProp(rule, 'grid-template-columns')
  const rowsFound = readProp(rule, 'grid-template-rows')
  const cols = colsFound ? countTracks(colsFound.value) : 0
  const rows = rowsFound ? countTracks(rowsFound.value) : 0
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top">
      <FieldLabel className="embed-editor_size-label" active={Boolean(colsFound || rowsFound)} disabled={busy} onReset={() => onClearProp(['grid-template-columns', 'grid-template-rows'])} resetLabel="Clear">
        Grid
      </FieldLabel>
      <div className="embed-editor_grid-tracks">
        <div className="embed-editor_gap-cell">
          <CountField value={cols} busy={busy} ariaLabel="Grid columns" onCommit={(n) => onSetProp('grid-template-columns', uniformTracks(n, NEW_COLUMN), false)} />
          <span className="embed-editor_gap-caption">Columns</span>
        </div>
        <div className="embed-editor_gap-cell">
          <CountField value={rows} busy={busy} ariaLabel="Grid rows" onCommit={(n) => onSetProp('grid-template-rows', uniformTracks(n, NEW_ROW), false)} />
          <span className="embed-editor_gap-caption">Rows</span>
        </div>
      </div>
    </div>
  )
}

// grid-auto-flow: a row/column segmented control + a `dense` toggle.
function GridDirectionRow({ rule, busy, onSetProp, onClearProp }: {
  rule: ParsedRule; busy: boolean; onSetProp: SetProp; onClearProp: ClearProp
}) {
  const found = readProp(rule, 'grid-auto-flow')
  const { dir, dense } = found ? parseFlow(found.value) : { dir: 'row', dense: false }
  return (
    <div className="embed-editor_size-row">
      <FieldLabel className="embed-editor_size-label" active={Boolean(found)} disabled={busy} onReset={() => onClearProp('grid-auto-flow')} resetLabel="Clear">
        Direction
      </FieldLabel>
      <div className="embed-editor_grid-direction">
        <SegmentedControl value={dir} options={GRID_FLOW} ariaLabel="Grid direction" disabled={busy} onChange={(d) => onSetProp('grid-auto-flow', buildFlow(d, dense), false)} />
        <button type="button" className={`embed-editor_icon-btn ${dense ? 'is-active' : ''}`} disabled={busy} aria-pressed={dense} title="Dense — backfill earlier gaps in the grid" onClick={() => onSetProp('grid-auto-flow', buildFlow(dir, !dense), false)}>
          <DenseIcon />
        </button>
      </div>
    </div>
  )
}

// Item alignment inside cells: X = justify-items, Y = align-items.
function GridAlignRow({ rule, busy, onSetProp, onClearProp, onLiveSetProp }: {
  rule: ParsedRule; busy: boolean; onSetProp: SetProp; onClearProp: ClearProp; onLiveSetProp: LiveSetProp
}) {
  const ji = readProp(rule, 'justify-items')
  const ai = readProp(rule, 'align-items')
  const axis = (axisLabel: string, prop: string) => {
    const found = readProp(rule, prop)
    const cur = found ? found.value.trim().toLowerCase() : ''
    return (
      <div className="embed-editor_grid-axis">
        <span className="embed-editor_grid-axis-label">{axisLabel}</span>
        <Select value={cur} options={buildOptions(JUSTIFY_GRID, cur)} ariaLabel={`Align ${axisLabel}`} disabled={busy} onChange={(choice) => (choice ? onSetProp(prop, choice, false) : onClearProp(prop))} onPreview={(choice) => onLiveSetProp(prop, choice || null, false)} />
      </div>
    )
  }
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top">
      <FieldLabel className="embed-editor_size-label" active={Boolean(ji || ai)} disabled={busy} onReset={() => onClearProp(['justify-items', 'align-items'])} resetLabel="Clear">
        Align
      </FieldLabel>
      <div className="embed-editor_grid-align">
        {axis('X', 'justify-items')}
        {axis('Y', 'align-items')}
      </div>
    </div>
  )
}

export default function LayoutSection({ rule, busy, onSetProp, onClearProp, onLiveSetProp }: Props) {
  const displayFound = readProp(rule, 'display')
  const display = displayFound ? displayFound.value.trim().toLowerCase() : ''
  const isFlex = display === 'flex' || display === 'inline-flex'
  const isGrid = display === 'grid' || display === 'inline-grid'

  return (
    <div className="embed-editor_layout">
      {/* Display — always shown. */}
      <div className="embed-editor_size-row">
        <FieldLabel className="embed-editor_size-label" active={Boolean(displayFound)} disabled={busy} onReset={() => onClearProp('display')} resetLabel="Clear">
          Display
        </FieldLabel>
        <DisplayControl
          value={displayFound?.value ?? ''}
          important={displayFound?.important ?? false}
          busy={busy}
          onCommit={(value, important) => onSetProp('display', value, important)}
        />
      </div>

      {isFlex ? (
        <>
          <SegRow rule={rule} busy={busy} prop="flex-direction" label="Direction" options={FLEX_DIRECTION} onSetProp={onSetProp} onClearProp={onClearProp} />
          <SelectRow rule={rule} busy={busy} prop="flex-wrap" label="Wrap" values={WRAP} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <SelectRow rule={rule} busy={busy} prop="justify-content" label="Justify" values={JUSTIFY_FLEX} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <SelectRow rule={rule} busy={busy} prop="align-items" label="Align" values={ALIGN_FLEX} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <GapControl rule={rule} busy={busy} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
        </>
      ) : null}

      {isGrid ? (
        <>
          <GridTracksRow rule={rule} busy={busy} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <GridDirectionRow rule={rule} busy={busy} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <GridAlignRow rule={rule} busy={busy} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <GapControl rule={rule} busy={busy} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <SelectRow rule={rule} busy={busy} prop="justify-content" label="Justify content" values={GRID_CONTENT} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
          <SelectRow rule={rule} busy={busy} prop="align-content" label="Align content" values={GRID_CONTENT} onSetProp={onSetProp} onClearProp={onClearProp} onLiveSetProp={onLiveSetProp} />
        </>
      ) : null}
    </div>
  )
}
