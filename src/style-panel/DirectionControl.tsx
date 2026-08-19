import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import SegmentPill from './components/SegmentPill'
import { commitInPlace } from './lib/commit-in-place'

// The flex Direction / flow control — shown only when `display` is flex. Two fixed
// segments (→ single row, ↓ single column) plus a third slot that shows whichever
// non-standard flow is selected. The chevron opens a grouped menu of every
// direction × wrap combination and a Custom escape hatch (unset / var(), like the
// Display control). Standard picks write the `flex-direction` + `flex-wrap`
// longhands; Custom writes a free `flex-direction` value.

// ─────────────────────────── Icons (from Webflow) ───────────────────────────

function ArrowRightIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.2929 7.00001L9.14645 3.85356L9.85355 3.14645L14.2071 7.50001L9.85355 11.8536L9.14645 11.1465L12.2929 8.00001H3V7.00001H12.2929Z" fill="currentColor" /></svg>
}
function ArrowDownIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.00004 12.2929L4.85359 9.14645L4.14648 9.85355L8.50004 14.2071L12.8536 9.85355L12.1465 9.14645L9.00004 12.2929L9.00004 3H8.00004L8.00004 12.2929Z" fill="currentColor" /></svg>
}
function ArrowLeftIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.70718 7.00001L6.85363 3.85356L6.14652 3.14645L1.79297 7.50001L6.14652 11.8536L6.85363 11.1465L3.70718 8.00001H13.0001V7.00001H3.70718Z" fill="currentColor" /></svg>
}
function ArrowUpIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.00007 3.70714L12.1465 6.85355L12.8536 6.14645L8.50004 1.79289L4.14648 6.14645L4.85359 6.85355L8.00007 3.70707L8.00007 13H9.00007L9.00007 3.70714Z" fill="currentColor" /></svg>
}
function RowWrapIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M14.207 11.5L10.8535 14.8535L10.1465 14.1465L12.293 12H3V11H12.293L10.1465 8.85352L10.8535 8.14648L14.207 11.5ZM11 4H3V3H11V4Z" fill="currentColor" /><path opacity="0.4" d="M11 4.20703L4.20703 11H3V10.793L9.79297 4H11V4.20703Z" fill="currentColor" /></svg>
}
function RowWrapReverseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M14.207 4.5L10.8535 1.14648L10.1465 1.85352L12.293 4L3 4L3 5L12.293 5L10.1465 7.14648L10.8535 7.85351L14.207 4.5ZM11 12L3 12L3 13L11 13L11 12Z" fill="currentColor" /><path opacity="0.4" d="M11 11.793L4.20703 5L3 5L3 5.20703L9.79297 12L11 12L11 11.793Z" fill="currentColor" /></svg>
}
function RowReverseWrapIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.79297 11.5L5.14648 14.8535L5.85352 14.1465L3.70703 12H13V11H3.70703L5.85352 8.85352L5.14648 8.14648L1.79297 11.5ZM5 4H13V3H5V4Z" fill="currentColor" /><path opacity="0.4" d="M5 4.20703L11.793 11H13V10.793L6.20703 4H5V4.20703Z" fill="currentColor" /></svg>
}
function RowReverseWrapReverseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.79297 4.5L5.14648 1.14649L5.85351 1.85352L3.70703 4L13 4L13 5L3.70703 5L5.85352 7.14648L5.14648 7.85352L1.79297 4.5ZM5 12L13 12L13 13L5 13L5 12Z" fill="currentColor" /><path opacity="0.4" d="M5 11.793L11.793 5L13 5L13 5.20703L6.20703 12L5 12L5 11.793Z" fill="currentColor" /></svg>
}
function ColumnWrapIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 14.207L14.8535 10.8535L14.1465 10.1465L12 12.293L12 3L11 3L11 12.293L8.85352 10.1465L8.14648 10.8535L11.5 14.207ZM4 11L4 3L3 3L3 11L4 11Z" fill="currentColor" /><path opacity="0.4" d="M4.20703 11L11 4.20703L11 3L10.793 3L4 9.79297L4 11L4.20703 11Z" fill="currentColor" /></svg>
}
function ColumnWrapReverseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 14.207L1.14648 10.8535L1.85352 10.1465L4 12.293L4 3L5 3L5 12.293L7.14648 10.1465L7.85352 10.8535L4.5 14.207ZM12 11L12 3L13 3L13 11L12 11Z" fill="currentColor" /><path opacity="0.4" d="M11.793 11L5 4.20703L5 3L5.20703 3L12 9.79297L12 11L11.793 11Z" fill="currentColor" /></svg>
}
function ColumnReverseWrapIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 1.79297L14.8535 5.14648L14.1465 5.85352L12 3.70703L12 13L11 13L11 3.70703L8.85352 5.85352L8.14648 5.14648L11.5 1.79297ZM4 5L4 13L3 13L3 5L4 5Z" fill="currentColor" /><path opacity="0.4" d="M4.20703 5L11 11.793L11 13L10.793 13L4 6.20703L4 5L4.20703 5Z" fill="currentColor" /></svg>
}
function ColumnReverseWrapReverseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 1.79297L1.14648 5.14648L1.85352 5.85352L4 3.70703L4 13L5 13L5 3.70703L7.14648 5.85352L7.85352 5.14648L4.5 1.79297ZM12 5L12 13L13 13L13 5L12 5Z" fill="currentColor" /><path opacity="0.4" d="M11.793 5L5 11.793L5 13L5.20703 13L12 6.20703L12 5L11.793 5Z" fill="currentColor" /></svg>
}
function ChevronIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

// ─────────────────────────── Flow model ───────────────────────────

const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse']

type Flow = {
  /** Normalized `<direction> [wrap]` key — matches the parent's current-state string. */
  value: string
  direction: string
  wrap: string
  icon: ReactNode
  /** Menu-item label within its group. */
  label: string
  /** A single-row / single-column primary — shown as a fixed segment, and only
   *  listed in the menu while in custom mode (so you can return to it). */
  primary?: boolean
}

const dirPhrase: Record<string, string> = {
  row: 'left to right', 'row-reverse': 'right to left', column: 'top to bottom', 'column-reverse': 'bottom to top',
}
const flow = (direction: string, wrap: string, icon: ReactNode, label: string, primary = false): Flow => ({
  value: wrap === 'nowrap' ? direction : `${direction} ${wrap}`,
  direction,
  wrap,
  icon,
  label,
  primary,
})
const tipFor = (f: Flow) => `Stack children ${dirPhrase[f.direction]}, ${f.label.toLowerCase()}`

// The chevron menu, grouped by primary direction. The two `primary` rows double as
// the fixed → / ↓ segments.
const GROUPS: ReadonlyArray<{ header: string; options: Flow[] }> = [
  { header: 'Left to right', options: [
    flow('row', 'nowrap', <ArrowRightIcon />, 'Single row', true),
    flow('row', 'wrap', <RowWrapIcon />, 'Wrap down'),
    flow('row', 'wrap-reverse', <RowWrapReverseIcon />, 'Wrap up'),
  ] },
  { header: 'Right to left', options: [
    flow('row-reverse', 'nowrap', <ArrowLeftIcon />, 'Single row'),
    flow('row-reverse', 'wrap', <RowReverseWrapIcon />, 'Wrap down'),
    flow('row-reverse', 'wrap-reverse', <RowReverseWrapReverseIcon />, 'Wrap up'),
  ] },
  { header: 'Top to bottom', options: [
    flow('column', 'nowrap', <ArrowDownIcon />, 'Single column', true),
    flow('column', 'wrap', <ColumnWrapIcon />, 'Wrap right'),
    flow('column', 'wrap-reverse', <ColumnWrapReverseIcon />, 'Wrap left'),
  ] },
  { header: 'Bottom to top', options: [
    flow('column-reverse', 'nowrap', <ArrowUpIcon />, 'Single column'),
    flow('column-reverse', 'wrap', <ColumnReverseWrapIcon />, 'Wrap right'),
    flow('column-reverse', 'wrap-reverse', <ColumnReverseWrapReverseIcon />, 'Wrap left'),
  ] },
]
const ALL = GROUPS.flatMap((group) => group.options)
const ROW = ALL.find((f) => f.value === 'row')!
const COLUMN = ALL.find((f) => f.value === 'column')!
const NONSTANDARD = ALL.filter((f) => !f.primary)
const DEFAULT_THIRD = NONSTANDARD[0] // Left to right, wrap down

const TOOLTIP_DELAY_MS = 500

// ─────────────────────────── Custom value helpers ───────────────────────────

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}
const joinImportant = (value: string, important: boolean) => (important ? `${value} !important` : value)

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
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(event) => { if (event.key === 'Enter') commitInPlace(event.currentTarget) }}
      disabled={busy}
      spellCheck={false}
      aria-label="Direction value"
      placeholder="custom value"
    />
  )
}

// ─────────────────────────── Control ───────────────────────────

export default function DirectionControl({ value, rawDirection, important, busy, onCommit, onCommitCustom }: {
  /** Normalized `<direction> [wrap]` string (standard highlighting). */
  value: string
  /** Raw `flex-direction` value — a free value (var()/unset/…) triggers custom mode. */
  rawDirection: string
  important: boolean
  busy: boolean
  onCommit: (direction: string, wrap: string) => void
  onCommitCustom: (value: string, important: boolean) => void
}) {
  const current = value.trim().toLowerCase() || 'row'
  const dir = rawDirection.trim().toLowerCase()
  // Custom whenever flex-direction is a free value, or carries !important.
  const customMode = important || (dir !== '' && !FLEX_DIRECTIONS.includes(dir))

  const thirdMatch = NONSTANDARD.find((f) => f.value === current)
  const third = thirdMatch ?? DEFAULT_THIRD

  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState<Flow | null>(null)
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
  useEffect(() => { if (!open) setHovered(null) }, [open])

  // Focus the custom field once its `unset` write settles (input is disabled mid-save).
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const pick = (next: Flow) => { setOpen(false); if (customMode || next.value !== current) onCommit(next.direction, next.wrap) }
  const enterCustom = () => { setOpen(false); wantFocus.current = true; onCommitCustom('unset', false) }

  // Delayed segment tooltip (right-anchored, arrow pointing to the hovered button).
  const [tip, setTip] = useState<{ text: string; arrowRight: number } | null>(null)
  const tipTimer = useRef<number | null>(null)
  const clearTipTimer = () => { if (tipTimer.current != null) { window.clearTimeout(tipTimer.current); tipTimer.current = null } }
  useEffect(() => clearTipTimer, [])
  const startTip = (text: string, el: HTMLElement) => {
    clearTipTimer()
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null
      const root = rootRef.current
      if (!root) return
      const track = root.getBoundingClientRect()
      const button = el.getBoundingClientRect()
      setTip({ text, arrowRight: track.right - (button.left + button.width / 2) })
    }, TOOLTIP_DELAY_MS)
  }
  const endTip = () => { clearTipTimer(); setTip(null) }

  const seg = (f: Flow, active: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`embed-editor_display-seg ${active ? 'is-selected' : ''}`}
      disabled={busy}
      aria-label={tipFor(f)}
      onClick={() => { endTip(); pick(f) }}
      onMouseEnter={(event) => startTip(tipFor(f), event.currentTarget)}
      onMouseLeave={endTip}
    >
      {f.icon}
    </button>
  )

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Direction">
      {customMode ? (
        <CustomField value={rawDirection} important={important} busy={busy} inputRef={inputRef} onCommit={onCommitCustom} />
      ) : (
        <>
          <SegmentPill />
          {seg(ROW, current === ROW.value)}
          {seg(COLUMN, current === COLUMN.value)}
          {seg(third, !!thirdMatch)}
        </>
      )}
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More direction options"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon />
      </button>

      {open ? (
        <div className="embed-editor_direction-menu" role="menu">
          {GROUPS.map((group) => {
            // Primaries (single row / single column) live on the segments; only surface
            // them in the menu while in custom mode, so there's a way back to them.
            const options = customMode ? group.options : group.options.filter((option) => !option.primary)
            return (
              <div className="embed-editor_direction-group" key={group.header}>
                <div className="embed-editor_direction-header">{group.header}</div>
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={!customMode && current === option.value}
                    className={`embed-editor_direction-item ${!customMode && current === option.value ? 'is-selected' : ''}`}
                    onClick={() => pick(option)}
                    onMouseEnter={() => setHovered(option)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span className="embed-editor_direction-item-icon">{option.icon}</span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )
          })}
          <div className="embed-editor_direction-group">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={customMode}
              className={`embed-editor_direction-item ${customMode ? 'is-selected' : ''}`}
              onClick={enterCustom}
              onMouseEnter={() => setHovered(null)}
            >
              <span className="embed-editor_direction-item-icon" />
              <span>Custom</span>
            </button>
          </div>
          <div className="embed-editor_direction-footer">
            {hovered
              ? <><code>flex-direction: {hovered.direction}</code><code>flex-wrap: {hovered.wrap}</code></>
              : 'Hover an option to see direction and wrap values.'}
          </div>
        </div>
      ) : null}

      {tip ? (
        <div className="u-segmented-tooltip" role="tooltip" style={{ '--tip-arrow-right': `${tip.arrowRight}px` } as CSSProperties}>
          {tip.text}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}
