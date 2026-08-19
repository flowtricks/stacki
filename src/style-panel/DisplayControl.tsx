import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import SegmentPill from './components/SegmentPill'
import { commitInPlace } from './lib/commit-in-place'

// The value editor for `display`. For values we can represent it shows a
// segmented bar (Block / Flex / Grid + a 4th slot for the inline set, None and
// Contents). For anything else (var(--x), unset, table-cell, …) it shows an
// editable text field. Both
// modes carry a dropdown arrow: from the bar you can jump to inline values or
// "Custom"; from a custom value you can jump back to any built-in.

const PRIMARY = ['block', 'flex', 'grid'] as const
const INLINE = ['inline-block', 'inline-flex', 'inline-grid', 'inline'] as const
// The two that leave no box of their own: `none` takes the element and its
// children off the page, `contents` takes only the box, so the children lay out
// as if the element weren't there. Grouped together in the menu because that is
// the question they answer — what happens to this element's own box.
const BOXLESS = ['none', 'contents'] as const
// 4th-slot values (the inline set + the boxless pair), used to detect the bar's
// 4th segment.
const OTHER = [...INLINE, ...BOXLESS] as const

const SUPPORTED: ReadonlySet<string> = new Set<string>([...PRIMARY, ...OTHER])
export const DISPLAY_VALUES: readonly string[] = [...PRIMARY, ...OTHER]

// Compact labels for the bar's narrow 4th segment.
const SHORT: Record<string, string> = {
  none: 'None',
  contents: 'Contents',
  inline: 'Inline',
  'inline-block': 'In-block',
  'inline-flex': 'In-flex',
  'inline-grid': 'In-grid',
}
// Full labels for the dropdown menu.
const FULL: Record<string, string> = {
  none: 'None',
  contents: 'Contents',
  inline: 'Inline',
  'inline-block': 'Inline-block',
  'inline-flex': 'Inline-flex',
  'inline-grid': 'Inline-grid',
}

// Delayed hover tooltips per display value (reuses the segmented-control tooltip CSS).
const TOOLTIP_DELAY_MS = 500
const TOOLTIPS: Record<string, ReactNode> = {
  block: <><strong>Block</strong> elements start on a new line and take up the full available width.</>,
  flex: <><strong>Flex</strong> lays out its child elements on a horizontal or vertical axis.</>,
  grid: <><strong>Grid</strong> lets you place items within rows and columns.</>,
  none: <><strong>None</strong> hides elements.</>,
  contents: <><strong>Contents</strong> removes the element's own box. Its children stay, and lay out as though they were children of its parent.</>,
  'inline-block': <><strong>Inline-block</strong> behaves like inline, but accepts width and height properties.</>,
  'inline-flex': <><strong>Inline-flex</strong> behaves as an inline element. It stacks its content horizontally or vertically.</>,
  'inline-grid': <><strong>Inline-grid</strong> behaves as an inline element. It stacks its content in rows and columns.</>,
  inline: <><strong>Inline</strong> is the default for text content. The text's font size and line height determine its size.</>,
}

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/** True when the display value maps onto the segmented bar (not a free value). */
export function isDisplayValueSupported(value: string): boolean {
  return SUPPORTED.has(value.trim().toLowerCase())
}

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
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

// Editable text field for a custom display value, shown next to the arrow.
function CustomValueField({
  value,
  important,
  busy,
  inputRef,
  onCommit,
}: {
  value: string
  important: boolean
  busy: boolean
  inputRef: React.RefObject<HTMLInputElement>
  onCommit: (value: string, important: boolean) => void
}) {
  const [draft, setDraft] = useState(joinImportant(value, important))
  const focused = useRef(false)

  // Mirror external edits, but never clobber what the user is typing.
  useEffect(() => { if (!focused.current) setDraft(joinImportant(value, important)) }, [value, important])

  const commit = () => {
    const parsed = parseImportant(draft)
    if (parsed.value && (parsed.value !== value.trim() || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important)
    }
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
      aria-label="Value"
      placeholder="custom value"
    />
  )
}

export default function DisplayControl({
  value,
  important,
  busy,
  onCommit,
}: {
  value: string
  important: boolean
  busy: boolean
  onCommit: (value: string, important: boolean) => void
}) {
  const current = value.trim().toLowerCase()
  // The bar only represents a supported token *without* !important. Anything else
  // — contents, unset, var(--x), or a supported token made !important — is custom.
  const segmented = isDisplayValueSupported(current) && !important
  const customMode = !segmented
  const isPrimary = (PRIMARY as readonly string[]).includes(current)
  // The 4th segment shows the chosen inline/none value, or None as the default.
  const fourth = isPrimary ? 'none' : current

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // After choosing Custom, focus (and select) the field once its `unset` write
  // settles — the input is disabled mid-save, so we wait for busy to clear.
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  // Pick a built-in value → the segmented bar. Button mode has no !important, so
  // committing without it also drops any prior !important (back to the buttons).
  const pick = (next: string) => {
    setOpen(false)
    if (next !== current || important) onCommit(next, false)
  }
  // Switch to a free value: default it to `unset`, then focus for typing.
  const enterCustom = () => {
    setOpen(false)
    wantFocus.current = true
    onCommit('unset', false)
  }

  // Delayed hover tooltip for the segments (reuses the segmented-control tooltip,
  // right-anchored with a down-arrow to the hovered segment).
  const [hoveredValue, setHoveredValue] = useState<string | null>(null)
  const [arrowRight, setArrowRight] = useState(0)
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = () => { if (hoverTimer.current != null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null } }
  useEffect(() => clearHoverTimer, [])
  const startHover = (segValue: string, el: HTMLElement) => {
    if (!TOOLTIPS[segValue]) return
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
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Display">
      {customMode ? (
        <CustomValueField value={value} important={important} busy={busy} inputRef={inputRef} onCommit={onCommit} />
      ) : (
        <>
          <SegmentPill />
          {PRIMARY.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={current === option}
              className={`embed-editor_display-seg ${current === option ? 'is-selected' : ''}`}
              disabled={busy}
              onClick={() => { endHover(); pick(option) }}
              onMouseEnter={(event) => startHover(option, event.currentTarget)}
              onMouseLeave={endHover}
            >
              {cap(option)}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={!isPrimary}
            className={`embed-editor_display-seg ${!isPrimary ? 'is-selected' : ''}`}
            disabled={busy}
            onClick={() => { endHover(); pick(fourth) }}
            onMouseEnter={(event) => startHover(fourth, event.currentTarget)}
            onMouseLeave={endHover}
          >
            {SHORT[fourth]}
          </button>
        </>
      )}

      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More display options"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon />
      </button>

      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode ? (
            // From a custom value: offer every built-in to switch back to the bar.
            <>
              {PRIMARY.map((option) => (
                <MenuItem key={option} label={cap(option)} selected={current === option} onClick={() => pick(option)} />
              ))}
              <div className="embed-editor_display-menu-divider" />
              {INLINE.map((option) => (
                <MenuItem key={option} label={FULL[option]} selected={current === option} onClick={() => pick(option)} />
              ))}
              <div className="embed-editor_display-menu-divider" />
              {BOXLESS.map((option) => (
                <MenuItem key={option} label={FULL[option]} selected={current === option} onClick={() => pick(option)} />
              ))}
            </>
          ) : (
            // From the bar: inline values, None, and an escape hatch to Custom.
            <>
              {INLINE.map((option) => (
                <MenuItem key={option} label={FULL[option]} selected={current === option} onClick={() => pick(option)} />
              ))}
              <div className="embed-editor_display-menu-divider" />
              {BOXLESS.map((option) => (
                <MenuItem key={option} label={FULL[option]} selected={current === option} onClick={() => pick(option)} />
              ))}
              <div className="embed-editor_display-menu-divider" />
              <MenuItem label="Custom" selected={false} onClick={enterCustom} />
            </>
          )}
        </div>
      ) : null}

      {hoveredValue && TOOLTIPS[hoveredValue] ? (
        <div className="u-segmented-tooltip" role="tooltip" style={{ '--tip-arrow-right': `${arrowRight}px` } as CSSProperties}>
          {TOOLTIPS[hoveredValue]}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}
