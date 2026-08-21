import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import VariableConnect from './VariableConnect'
import { GroupLabel } from './TypographySection'
import { handleArrowStep } from './lib/number-step'
import { panelSpan } from './lib/panel-box'
import { parseTrackList, serializeTrackList, parseTrackSize, serializeTrackSize, trackKind, trackLabel, isFixedSizeTrack, parseAreas, serializeAreas, areaLabel, nextAreaName, trackForm, asTrackList, asRepeat, canEditAsTracks, type TrackSize, type GridArea } from './lib/grid-template'
import type { ResolvedProp } from './lib/resolved'

// The "Grid settings" modal (Webflow's Configure-grid popup): the Columns and Rows
// track lists — drag to reorder, click a track to size it (a single Default size or a
// minmax(min, max) pair) — plus the auto-generated track sizes and (read-only for now)
// the areas. Resolved-model API; writes an explicit space-separated grid-template.

type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type Read = (prop: string) => ResolvedProp | undefined
type OnProvenance = (prop: string, anchor: DOMRect) => void
type OnSelectSelector = (selector: string, prop?: string) => void
// The resolved-model label bits every section header threads through to GroupLabel.
type LabelProps = { read: Read; busy: boolean; clearProp: ClearProp; onProvenance: OnProvenance; onSelectSelector: OnSelectSelector }

const val = (read: Read, prop: string): string => {
  const r = read(prop)
  if (!r) return ''
  return (r.source === 'selected' && r.selectedValue ? r.selectedValue.value : r.winner.value).trim()
}

// ── icons ──
const CloseIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>)
const PlusIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>)
// The repeat()/written-out toggle. Two tracks collapsing into one boxed count,
// or opening back out — the arrows say which way the press goes.
const CollapseTracksIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <rect x="1.5" y="4.5" width="4" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="10.5" y="4.5" width="4" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6.6 8h2.8M8.6 6.9 9.7 8 8.6 9.1M7.4 6.9 6.3 8l1.1 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ExpandTracksIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <rect x="5.5" y="4.5" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4.2 8H1.6M2.7 6.9 1.6 8l1.1 1.1M11.8 8h2.6M13.3 6.9 14.4 8l-1.1 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const TrashIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M3 4h10M6.5 4V3h3v1M5 4l.5 8.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const DuplicateIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const GripIcon = () => (<svg viewBox="0 0 16 16" aria-hidden="true" className="embed-editor_bg-glyph"><circle cx="6" cy="4" r="1" /><circle cx="10" cy="4" r="1" /><circle cx="6" cy="8" r="1" /><circle cx="10" cy="8" r="1" /><circle cx="6" cy="12" r="1" /><circle cx="10" cy="12" r="1" /></svg>)
const WarnIcon = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16"><path d="M8 2 1.5 13.5h13L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 6.5v3.2M8 11.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>)
// Webflow's grid track glyphs: a GEAR for minmax/custom, an "A" for auto/content, and
// a double-arrow for everything else (fr / lengths). The arrow points along the axis
// (↔ columns, ↕ rows) and the faint grid lines flank that same axis.
const FAINT_ROW = 'M1 1H15V2H1V1ZM1 14H15V15H1V14Z'
const FAINT_COL = 'M1 1V15H2V1H1ZM14 1V15H15V1H14Z'
const GEAR_D = 'M7.00002 3.25C7.00002 3.11193 7.11195 3 7.25002 3L8.75002 3C8.88809 3 9.00002 3.11193 9.00002 3.25V4.43301C9.00002 4.52233 9.04767 4.60486 9.12502 4.64952L10.3391 5.35046C10.4164 5.39512 10.5117 5.39512 10.5891 5.35046L11.6136 4.75897C11.7331 4.68994 11.886 4.73091 11.9551 4.85048L12.7051 6.14952C12.7741 6.26909 12.7331 6.42199 12.6136 6.49103L11.5891 7.08249C11.5118 7.12715 11.4641 7.20968 11.4641 7.29899L11.4641 8.70076C11.4641 8.79008 11.5118 8.87261 11.5891 8.91727L12.6137 9.50879C12.7332 9.57782 12.7742 9.73072 12.7052 9.8503L11.9552 11.1493C11.8861 11.2689 11.7332 11.3099 11.6137 11.2408L10.5893 10.6494C10.5119 10.6048 10.4166 10.6048 10.3393 10.6494L9.12502 11.3505C9.04767 11.3951 9.00002 11.4777 9.00002 11.567V12.75C9.00002 12.8881 8.88809 13 8.75002 13H7.25002C7.11195 13 7.00002 12.8881 7.00002 12.75V11.567C7.00002 11.4777 6.95237 11.3951 6.87502 11.3505L5.66088 10.6495C5.58353 10.6048 5.48823 10.6048 5.41088 10.6495L4.38633 11.241C4.26675 11.3101 4.11385 11.2691 4.04482 11.1495L3.29482 9.85048C3.22578 9.73091 3.26675 9.57801 3.38633 9.50897L4.41092 8.91742C4.48827 8.87277 4.53592 8.79023 4.53592 8.70092V7.29884C4.53592 7.20952 4.48827 7.12699 4.41092 7.08233L3.38643 6.49084C3.26686 6.4218 3.22589 6.26891 3.29492 6.14933L4.04492 4.85029C4.11396 4.73072 4.26686 4.68975 4.38643 4.75879L5.4111 5.35038C5.48845 5.39504 5.58375 5.39504 5.6611 5.35038L6.87502 4.64952C6.95237 4.60486 7.00002 4.52233 7.00002 4.43301V3.25ZM7.99997 9.5C8.82839 9.5 9.49997 8.82843 9.49997 8C9.49997 7.17157 8.82839 6.5 7.99997 6.5C7.17154 6.5 6.49997 7.17157 6.49997 8C6.49997 8.82843 7.17154 9.5 7.99997 9.5Z'
const AUTO_D = 'M8.87418 4H7.12589L4.77295 12H5.8153L6.39552 10.0273H9.6046L10.1848 12H11.2272L8.87418 4ZM8.12592 4.9999L9.31048 9.02728H6.68963L7.87416 4.9999H8.12592Z'
const ARROW_D = 'M8.52731 3.70718L10.6738 5.85363L11.3809 5.14652L8.02731 1.79297L4.67375 5.14652L5.38086 5.85363L7.52731 3.70718L7.52731 12.293L5.38086 10.1465L4.67375 10.8536L8.02731 14.2072L11.3809 10.8536L10.6738 10.1465L8.52731 12.293L8.52731 3.70718Z'
function TrackIcon({ track, axis }: { track: string; axis: 'column' | 'row' }) {
  const kind = trackKind(track)
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={axis === 'column' ? FAINT_COL : FAINT_ROW} fill="currentColor" />
      {kind === 'minmax' ? (
        <path fillRule="evenodd" clipRule="evenodd" d={GEAR_D} fill="currentColor" />
      ) : kind === 'auto' || kind === 'content' ? (
        <path fillRule="evenodd" clipRule="evenodd" d={AUTO_D} fill="currentColor" />
      ) : (
        <path d={ARROW_D} fill="currentColor" transform={axis === 'column' ? 'rotate(90 8 8)' : undefined} />
      )}
    </svg>
  )
}

// ── a single track's value input (default size, or a minmax bound) ──
function TrackInput({ value, placeholder, ariaLabel, busy, onCommit }: {
  value: string; placeholder: string; ariaLabel: string; busy: boolean; onCommit: (v: string) => void
}) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  return (
    <VariableConnect code ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} className="is-fill" prop="grid-template-columns" onPick={(binding) => onCommit(binding)}>
    <input
      className="u-input embed-editor_size-input"
      value={text}
      spellCheck={false}
      disabled={busy}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; onCommit(text.trim()) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); return }
        // ↑/↓ step the number under the caret (unit preserved) and apply immediately.
        const stepped = handleArrowStep(e)
        if (!stepped) return
        e.preventDefault()
        e.currentTarget.value = stepped.text
        e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
        setText(stepped.text)
        onCommit(stepped.text.trim())
      }}
    />
    </VariableConnect>
  )
}

const SIZING_OPTIONS: ReadonlyArray<SegmentedOption<'default' | 'minmax'>> = [
  { value: 'default', label: 'Default' },
  { value: 'minmax', label: 'Min/Max' },
]

type AutoFit = { on: boolean; can: boolean; onToggle: (on: boolean) => void }

// The per-track editor: Default (a single size) or Min/Max (a minmax pair). Track lists
// (not the auto sections) also get the Auto-fit toggle + its constraint warning.
function TrackSizeEditor({ track, busy, autoFit, onChange }: { track: string; busy: boolean; autoFit?: AutoFit; onChange: (size: TrackSize) => void }) {
  const size = parseTrackSize(track)
  // When Auto-fit is on the track is `repeat(auto-fit, <inner>)`. Switching the sizing
  // mode operates on that INNER track and drops the wrapper — writing the unwrapped
  // value also unchecks Auto-fit (rawTemplate no longer contains repeat(auto-fit, …)),
  // instead of nesting the whole repeat() inside the new minmax's max.
  const autoFitInner = (() => {
    const m = track.match(/^repeat\(\s*auto-fit\s*,\s*(.+)\)\s*$/is)
    return m ? parseTrackSize(m[1].trim()) : null
  })()
  const switchMode = (mode: 'default' | 'minmax') => {
    if (mode === size.mode) return
    const base = autoFitInner ?? size
    if (mode === 'minmax') {
      if (base.mode === 'minmax') onChange(base)
      // Min 0px (Webflow's minmax default) so a track can shrink to nothing rather than
      // being held open by its content — matches the count stepper's new-column default.
      // The unit matters: a bare `0` makes Webflow read the grid-template as a custom value.
      else onChange({ mode: 'minmax', min: '0px', max: base.value || '1fr' })
    } else {
      if (base.mode === 'default') onChange(base)
      else onChange({ mode: 'default', value: base.max || base.min || 'auto' })
    }
  }
  return (
    <div className="embed-editor_grid-track-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Sizing</span>
        <SegmentedControl value={size.mode} options={SIZING_OPTIONS} onChange={switchMode} ariaLabel="Track sizing" disabled={busy} />
      </div>
      {size.mode === 'default' ? (
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
          <TrackInput value={size.value} placeholder="1fr" ariaLabel="Track size" busy={busy} onCommit={(v) => onChange({ mode: 'default', value: v || 'auto' })} />
        </div>
      ) : (
        <>
          <div className="embed-editor_size-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Min</span>
            <TrackInput value={size.min} placeholder="auto" ariaLabel="Track min" busy={busy} onCommit={(v) => onChange({ mode: 'minmax', min: v || 'auto', max: size.max })} />
          </div>
          <div className="embed-editor_size-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Max</span>
            <TrackInput value={size.max} placeholder="1fr" ariaLabel="Track max" busy={busy} onCommit={(v) => onChange({ mode: 'minmax', min: size.min, max: v || '1fr' })} />
          </div>
        </>
      )}
      {autoFit ? (
        <>
          <label className="embed-editor_grad-check embed-editor_grid-autofit">
            <input type="checkbox" checked={autoFit.on} disabled={busy || (!autoFit.can && !autoFit.on)} onChange={(e) => autoFit.onToggle(e.target.checked)} />
            <span>Auto-fit</span>
          </label>
          {!autoFit.can && !autoFit.on ? (
            <div className="embed-editor_grid-warning">
              <span className="embed-editor_grid-warning-icon"><WarnIcon /></span>
              <span>Auto-fit can’t be enabled when there are auto, flexible (FR), minmax(auto, fr), minmax(auto, auto), or other auto-fit columns or rows.</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

// The size editor as an anchored POPUP (Webflow's track popover), not an inline
// accordion — portaled over the modal, positioned below the clicked row (flips above
// when there isn't room), with a caret pointing at it. Closes on outside click /
// Escape / scroll.
function TrackPopover({ anchorEl, onClose, children }: { anchorEl: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; caretLeft: number; below: boolean } | null>(null)
  // The panel's span, read at mount so the first layout (which measures this
  // popover's height) already has the right width. The anchor lives inside the
  // grid modal — itself portaled — so this falls back to the published box.
  const [span] = useState(() => panelSpan(anchorEl))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const anchor = anchorEl.getBoundingClientRect()
    const gap = 8
    const h = el.offsetHeight
    const below = anchor.bottom + gap + h <= window.innerHeight
    const top = below ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - h)
    // The caret is absolutely positioned inside the popover, so its x is local
    // to the popover's left edge — not the window's.
    const caretLeft = Math.min(Math.max(anchor.left + anchor.width / 2 - span.left, 16), span.width - 16)
    setPos({ top, caretLeft, below })
  }, [anchorEl])
  useEffect(() => {
    // Ignore clicks on the trigger row — its own onClick toggles the popover closed;
    // if this handler closed it first, that same click would immediately re-open it.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchorEl.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onScroll = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true) }
  }, [onClose, anchorEl])
  return createPortal(
    <div
      ref={ref}
      className={`embed-editor_grid-popover ${pos && !pos.below ? 'is-above' : ''}`}
      role="dialog"
      style={{ position: 'fixed', left: span.left, width: span.width, top: pos?.top ?? 0, visibility: pos == null ? 'hidden' : 'visible' }}
    >
      <span className="embed-editor_grid-popover-caret" style={{ left: pos?.caretLeft ?? 16 }} aria-hidden="true" />
      {children}
    </div>,
    document.body,
  )
}

// The expression toggle's glyph: the braces you write one in.
const BracesIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path
      d="M6.4 2.5c-1.2 0-1.7.6-1.7 1.7v1.9c0 1-.3 1.4-1.2 1.4v1c.9 0 1.2.4 1.2 1.4v1.9c0 1.1.5 1.7 1.7 1.7M9.6 2.5c1.2 0 1.7.6 1.7 1.7v1.9c0 1 .3 1.4 1.2 1.4v1c-.9 0-1.2.4-1.2 1.4v1.9c0 1.1-.5 1.7-1.7 1.7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

// The whole track list as one field, for a value the list cannot hold: a
// variable standing in for every track (`var(--columns)`), an !important, a
// subgrid. The tracks are how you build a grid; this is how you say one the
// builder has no controls for.
//
// It is the same editor the panel opens over a cramped field — multi-line, with
// variables as chips and the value coloured as code — but sitting in the panel
// rather than in a box over it. A field that already has the room does not need
// one opened in front of it, which is what `expanded` says.
function ExpressionField({ prop, value, title, busy, onCommit }: {
  prop: string; value: string; title: string; busy: boolean; onCommit: (v: string, important: boolean) => void
}) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  // Whatever is in the field is the value, `!important` included — this is the
  // way in for everything the track controls have no way to say.
  const commit = (typed: string) => {
    const v = typed.trim()
    const m = v.match(/!\s*important\s*$/i)
    onCommit(m ? v.slice(0, m.index).trim() : v, !!m)
  }
  return (
    <VariableConnect
      className="is-multiline"
      code
      expanded
      ariaLabel={`${title} expression`}
      disabled={busy}
      prop={prop}
      onPick={(next) => { setText(next); commit(next) }}
    >
      <textarea
        className="embed-editor_grid-expression"
        value={text}
        spellCheck={false}
        rows={3}
        disabled={busy}
        aria-label={`${title} expression`}
        placeholder="repeat(auto-fit, minmax(12rem, 1fr))"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={(e) => { focused.current = false; commit(e.currentTarget.value) }}
        onKeyDown={(e) => {
          // A CSS value has no need for a line break, so Enter is "done".
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
        }}
      />
    </VariableConnect>
  )
}

// The repeat() switch: which of the two ways this track list is written (see
// trackForm). On, `repeat(3, 1fr)`; off, `1fr 1fr 1fr` — the same grid either
// way, so this is about the CSS you end up reading, not the layout.
//
// It stays on through an edit: adding a fourth track to `repeat(3, 1fr)` writes
// `repeat(4, 1fr)` rather than quietly writing them all out, which is what used
// to happen. Tracks that differ cannot be a repeat() at all, so there the
// switch is off and says why.
function RepeatSwitch({ on, can, why, busy, title, onChange }: {
  on: boolean; can: boolean; why: string; busy: boolean; title: string; onChange: (on: boolean) => void
}) {
  return (
    <label
      className={`embed-editor_switch ${on ? 'is-on' : ''} ${can ? '' : 'is-disabled'}`}
      title={can ? why : `Tracks that differ can’t be written as repeat()`}
    >
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={busy || !can}
        aria-label={`Use repeat() for ${title.toLowerCase()}`}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="embed-editor_switch-label">repeat()</span>
    </label>
  )
}

// A reorderable track list (Columns / Rows). Drag the grip to reorder, click a row to
// open its size editor (popup), trash to remove, + to append a 1fr track.
function TrackSection({ title, prop, axis, setProp, labels }: {
  title: string; prop: string; axis: 'column' | 'row'; setProp: SetProp; labels: LabelProps
}) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels
  const rawTemplate = val(read, prop)
  // `!important` is carried beside the value, not in it — the field shows it,
  // since the field is where it can be typed.
  const important = !!(read(prop)?.selectedValue ?? read(prop)?.winner)?.important
  const shown = important && rawTemplate ? `${rawTemplate} !important` : rawTemplate
  const tracks = parseTrackList(rawTemplate)
  // Which way this list is written. The value answers whenever it can — it is
  // either a repeat() or it isn't — and the preference only decides the cases
  // where the question doesn't arise yet: no tracks, or one. A new grid is a
  // repeat(), which is what the count stepper writes, so that is the default.
  const form = trackForm(rawTemplate)
  const same = (list: string[]) => list.length > 1 && list.every((x) => x === list[0])
  const [preferRepeat, setPreferRepeat] = useState(true)
  // A value that says which form it is IS the setting; remember it for the next
  // time the value can't say (emptied, down to one track).
  useEffect(() => {
    if (form === 'repeat') setPreferRepeat(true)
    else if (form === 'list') setPreferRepeat(false)
  }, [form])
  // Under two tracks there is nothing a repeat() would say differently, so the
  // switch stays available and simply waits.
  const canRepeat = tracks.length < 2 || same(tracks)
  const repeatOn = form === 'repeat' ? true : form === 'list' ? false : canRepeat && preferRepeat
  // Every edit writes the list back in the form the switch is showing, so
  // adding a track to a repeat() keeps it one.
  const asWritten = (next: string[]) =>
    repeatOn && same(next) ? `repeat(${next.length}, ${next[0]})` : serializeTrackList(next)
  const write = (next: string[]) => { const s = asWritten(next); if (s) setProp(prop, s, false); else clearProp(prop) }
  // Auto-fit wraps the whole track list in repeat(auto-fit, …) — valid only when every
  // track is a `<fixed-size>` (a fixed length or a minmax() with a fixed min, e.g.
  // minmax(20rem, 1fr)); otherwise the warning explains why.
  const autoFitOn = /\bauto-fit\b/i.test(rawTemplate)
  const autoFit: AutoFit = {
    on: autoFitOn,
    can: tracks.length > 0 && tracks.every(isFixedSizeTrack),
    onToggle: (on: boolean) => {
      if (on) {
        // Reuse an existing fixed-size track as-is (e.g. minmax(20rem, 1fr)); turn a
        // bare fixed length into a responsive minmax(<len>, 1fr) so columns flex to fill.
        const base = tracks.find(isFixedSizeTrack) ?? tracks[0] ?? '200px'
        const pattern = trackKind(base) === 'length' ? `minmax(${base}, 1fr)` : base
        setProp(prop, `repeat(auto-fit, ${pattern})`, false)
      } else {
        const m = rawTemplate.match(/repeat\(\s*auto-fit\s*,\s*(.+)\)\s*$/is)
        setProp(prop, m ? m[1].trim() : (tracks[0] ?? '1fr'), false)
      }
    },
  }
  // Editing the value as text rather than as tracks. Asked for with the braces
  // — or forced, when the value is one the track list cannot hold: showing
  // `var(--columns)` or an !important as tracks would read it as a track with a
  // strange name, and the first edit would write that reading back over it. In
  // that case the braces are pressed and stuck, which is the honest state.
  const [expression, setExpression] = useState(false)
  const tracksCanHold = canEditAsTracks(important ? `${rawTemplate} !important` : rawTemplate)
  const asExpression = expression || !tracksCanHold
  const [open, setOpen] = useState<number | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const openAt = (i: number, el: HTMLElement) => {
    if (open === i) { setOpen(null); return }
    setOpen(i)
    setAnchorEl(el.closest('li') ?? el)
  }

  // New tracks use Webflow's defaults: a column is minmax(0px, 1fr) (fills its share but can
  // shrink so content can't overflow the grid), a row is auto (content-sized). The min needs
  // a unit — a bare `0` makes Webflow read the whole grid-template as a custom value.
  // Adding to a list whose tracks are all the same adds another of THOSE — a
  // fourth column of `repeat(3, 1fr)` is a 1fr, not the generic default, which
  // would differ by a character (`minmax(0px, 1fr)` vs `minmax(0, 1fr)`) and
  // quietly break the list into one that can no longer be a repeat().
  const add = () => {
    const fresh = same(tracks) ? tracks[0] : axis === 'column' ? 'minmax(0px, 1fr)' : 'auto'
    write([...tracks, fresh])
    setOpen(tracks.length)
  }
  const remove = (i: number) => {
    write(tracks.filter((_, k) => k !== i))
    setOpen((o) => (o === i ? null : o != null && o > i ? o - 1 : o))
  }
  const setTrack = (i: number, size: TrackSize) => write(tracks.map((t, k) => (k === i ? serializeTrackSize(size) : t)))
  const duplicate = (i: number) => write([...tracks.slice(0, i + 1), tracks[i], ...tracks.slice(i + 1)])
  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...tracks]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    write(next)
    setOpen((o) => (o === from ? to : o))
  }

  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        {/* Label, then how the value is written, then the field for writing it
            by hand — all packed left, so the eye reads along the row instead of
            crossing a gap between them. The + stays where every other section
            keeps its add. */}
        <span className="embed-editor_grid-section-title">
          <GroupLabel label={title} props={[prop]} read={read} busy={busy} onClear={() => clearProp(prop)} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
          <span className="embed-editor_grid-section-count">({tracks.length})</span>
        </span>
        <RepeatSwitch
          on={repeatOn}
          can={canRepeat && !asExpression}
          why={repeatOn ? `Written as repeat(${tracks.length}, …)` : 'Write these tracks as repeat()'}
          busy={busy}
          title={title}
          onChange={(next) => {
            setPreferRepeat(next)
            if (!tracks.length) return
            const value = next ? asRepeat(rawTemplate) : asTrackList(rawTemplate)
            if (value) setProp(prop, value, false)
          }}
        />
        <button
          type="button"
          className={`embed-editor_icon-btn ${asExpression ? 'is-active' : ''}`}
          disabled={busy || !tracksCanHold}
          aria-pressed={asExpression}
          aria-label={`Edit ${title.toLowerCase()} as an expression`}
          title={
            !tracksCanHold
              ? 'This value can’t be shown as tracks'
              : asExpression
                ? 'Back to tracks'
                : 'Edit the whole value as an expression'
          }
          onClick={() => setExpression((v) => !v)}
        >
          <BracesIcon />
        </button>
        {asExpression ? null : (
          <button type="button" className="embed-editor_icon-btn" onClick={add} disabled={busy} title={`Add a ${title.toLowerCase().replace(/s$/, '')}`} aria-label={`Add a ${title}`}><PlusIcon /></button>
        )}
      </div>
      {asExpression ? (
        <ExpressionField
          prop={prop}
          value={shown}
          title={title}
          busy={busy}
          onCommit={(v, imp) => { if (v) setProp(prop, v, imp); else clearProp(prop) }}
        />
      ) : tracks.length ? (
        <ul className="embed-editor_grid-track-list">
          {tracks.map((track, i) => {
            const isOpen = open === i
            return (
              <li
                key={i}
                className={`embed-editor_grid-track ${isOpen ? 'is-open' : ''} ${dragOver === i ? 'is-drop-target' : ''} ${dragFrom === i ? 'is-dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(i) }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom != null) reorder(dragFrom, i); setDragFrom(null); setDragOver(null) }}
              >
                <div className="embed-editor_grid-track-row">
                  <span
                    className="embed-editor_bg-grip"
                    draggable={!busy}
                    onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)) }}
                    onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  ><GripIcon /></span>
                  <button type="button" className="embed-editor_grid-track-main" onClick={(e) => openAt(i, e.currentTarget)} disabled={busy}>
                    <span className="embed-editor_grid-track-glyph" aria-hidden="true"><TrackIcon track={track} axis={axis} /></span>
                    <span className="embed-editor_grid-track-label">{trackLabel(track)}</span>
                  </button>
                  <div className="embed-editor_grid-track-actions">
                    <button type="button" className="embed-editor_grid-track-action" onClick={() => duplicate(i)} disabled={busy} title="Duplicate track" aria-label="Duplicate track"><DuplicateIcon /></button>
                    <button type="button" className="embed-editor_grid-track-action embed-editor_grid-track-action-danger" onClick={() => remove(i)} disabled={busy} title="Remove track" aria-label="Remove track"><TrashIcon /></button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="embed-editor_grid-empty">No {title.toLowerCase()}</div>
      )}
      {open != null && anchorEl && tracks[open] ? (
        <TrackPopover anchorEl={anchorEl} onClose={() => setOpen(null)}>
          <TrackSizeEditor track={tracks[open]} busy={busy} autoFit={autoFit} onChange={(s) => setTrack(open, s)} />
        </TrackPopover>
      ) : null}
    </section>
  )
}

// The auto-generated track size (grid-auto-columns / grid-auto-rows) — like any other
// track: a single clickable row whose popup edits the value (grid-auto-columns/-rows).
function AutoSection({ title, prop, axis, setProp, labels }: {
  title: string; prop: string; axis: 'column' | 'row'; setProp: SetProp; labels: LabelProps
}) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels
  const current = val(read, prop) || 'auto'
  const [open, setOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const note = axis === 'column'
    ? 'Define the sizing for all automatically created columns.'
    : 'Define the sizing for all automatically created rows.'
  const setSize = (size: TrackSize) => {
    const v = serializeTrackSize(size)
    if (v && v.toLowerCase() !== 'auto') setProp(prop, v, false); else clearProp(prop)
  }
  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        <span className="embed-editor_grid-section-title">
          <GroupLabel label={title} props={[prop]} read={read} busy={busy} onClear={() => clearProp(prop)} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
          <span className="embed-editor_grid-section-count">(0)</span>
        </span>
      </div>
      <div className="embed-editor_grid-track-list">
        <div className="embed-editor_grid-track">
          <div className="embed-editor_grid-track-row">
            <button type="button" className="embed-editor_grid-track-main" onClick={(e) => { setOpen((o) => !o); setAnchorEl(e.currentTarget.closest<HTMLElement>('.embed-editor_grid-track-list') ?? e.currentTarget) }} disabled={busy}>
              <span className="embed-editor_grid-track-glyph" aria-hidden="true"><TrackIcon track={current} axis={axis} /></span>
              <span className="embed-editor_grid-track-label">{trackLabel(current)}</span>
            </button>
          </div>
        </div>
      </div>
      {open && anchorEl ? (
        <TrackPopover anchorEl={anchorEl} onClose={() => setOpen(false)}>
          <TrackSizeEditor track={current} busy={busy} onChange={setSize} />
          <div className="embed-editor_grid-popover-note">{note}</div>
          <button type="button" className="embed-editor_grid-popover-ok" onClick={() => setOpen(false)}>Ok, got it</button>
        </TrackPopover>
      ) : null}
    </section>
  )
}

// A crosshair marker for area rows (Webflow's area glyph).
const AreaIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <rect x="5.5" y="5.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)

// The area's name field — commits on blur / Enter, keeps the old name if emptied.
// Grid area names are single idents, so whitespace is stripped as you type (a typed
// space would split the name into two cells in grid-template-areas).
function AreaNameInput({ value, busy, onCommit }: { value: string; busy: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  const commit = () => { const t = text.trim(); if (t) onCommit(t); else setText(value) }
  return (
    <input
      className="u-input embed-editor_size-input"
      value={text}
      spellCheck={false}
      disabled={busy}
      aria-label="Area name"
      onChange={(e) => setText(e.target.value.replace(/\s+/g, ''))}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

// A 1-based grid-cell number field (Column/Row start/end) with ↑/↓ stepping.
function AreaNumInput({ value, ariaLabel, busy, onCommit }: { value: number; ariaLabel: string; busy: boolean; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(String(value)) }, [value])
  const clampN = (n: number) => Math.max(1, Math.min(999, n))
  const commit = (t: string) => { const n = parseInt(t, 10); if (Number.isNaN(n)) { setText(String(value)); return } onCommit(clampN(n)) }
  return (
    <input
      className="u-input embed-editor_size-input embed-editor_grid-area-num"
      value={text}
      inputMode="numeric"
      spellCheck={false}
      disabled={busy}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit(text) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); onCommit(clampN(value + 1)) }
        else if (e.key === 'ArrowDown') { e.preventDefault(); onCommit(clampN(value - 1)) }
      }}
    />
  )
}

// The area editor popover body: Name + Position (Column start/end, Row start/end).
function AreaEditor({ area, busy, onChange }: { area: GridArea; busy: boolean; onChange: (patch: Partial<GridArea>) => void }) {
  return (
    <div className="embed-editor_grid-track-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Name</span>
        <AreaNameInput value={area.name} busy={busy} onCommit={(name) => onChange({ name })} />
      </div>
      <div className="embed-editor_size-row embed-editor_grid-area-pos">
        <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
        <div className="embed-editor_grid-area-fields">
          <div className="embed-editor_grid-area-pair">
            <div className="embed-editor_grid-area-inputs">
              <AreaNumInput value={area.colStart} ariaLabel="Column start" busy={busy} onCommit={(n) => onChange({ colStart: n })} />
              <AreaNumInput value={area.colEnd} ariaLabel="Column end" busy={busy} onCommit={(n) => onChange({ colEnd: n })} />
            </div>
            <span className="embed-editor_grid-area-cap">Column: start/end</span>
          </div>
          <div className="embed-editor_grid-area-pair">
            <div className="embed-editor_grid-area-inputs">
              <AreaNumInput value={area.rowStart} ariaLabel="Row start" busy={busy} onCommit={(n) => onChange({ rowStart: n })} />
              <AreaNumInput value={area.rowEnd} ariaLabel="Row end" busy={busy} onCommit={(n) => onChange({ rowEnd: n })} />
            </div>
            <span className="embed-editor_grid-area-cap">Row: start/end</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// The Areas list + editor: add / rename / reposition / remove named grid areas,
// serialized to grid-template-areas. Keyed by name so a reposition doesn't jump the
// open editor.
function AreasSection({ setProp, labels }: { setProp: SetProp; labels: LabelProps }) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels
  const areas = parseAreas(val(read, 'grid-template-areas'))
  const write = (next: GridArea[]) => { const s = serializeAreas(next); if (s) setProp('grid-template-areas', s, false); else clearProp('grid-template-areas') }
  const [openName, setOpenName] = useState<string | null>(null)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const openArea = openName != null ? areas.find((a) => a.name === openName) ?? null : null

  const add = () => {
    const maxRow = areas.reduce((m, a) => Math.max(m, a.rowEnd), 0)
    write([...areas, { name: nextAreaName(areas), colStart: 1, colEnd: 1, rowStart: maxRow + 1, rowEnd: maxRow + 1 }])
  }
  const update = (name: string, patch: Partial<GridArea>) => {
    write(areas.map((a) => (a.name === name ? { ...a, ...patch } : a)))
    if (patch.name) setOpenName(patch.name) // follow a rename so the editor stays open
  }
  const remove = (name: string) => { write(areas.filter((a) => a.name !== name)); setOpenName((o) => (o === name ? null : o)) }
  const openAt = (name: string, el: HTMLElement) => {
    if (openName === name) { setOpenName(null); return }
    setOpenName(name)
    setAnchorEl(el.closest('li') ?? el)
  }

  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        <span className="embed-editor_grid-section-title">
          <GroupLabel label="Areas" props={['grid-template-areas']} read={read} busy={busy} onClear={() => clearProp('grid-template-areas')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
          <span className="embed-editor_grid-section-count">({areas.length})</span>
        </span>
        <button type="button" className="embed-editor_icon-btn" onClick={add} disabled={busy} title="Add an area" aria-label="Add an area"><PlusIcon /></button>
      </div>
      {areas.length ? (
        <ul className="embed-editor_grid-track-list">
          {areas.map((area) => {
            const isOpen = openName === area.name
            return (
              <li key={area.name} className={`embed-editor_grid-track ${isOpen ? 'is-open' : ''}`}>
                <div className="embed-editor_grid-track-row">
                  <button type="button" className="embed-editor_grid-track-main" onClick={(e) => openAt(area.name, e.currentTarget)} disabled={busy}>
                    <span className="embed-editor_grid-track-glyph" aria-hidden="true"><AreaIcon /></span>
                    <span className="embed-editor_grid-track-label">{areaLabel(area)}</span>
                  </button>
                  <div className="embed-editor_grid-track-actions">
                    <button type="button" className="embed-editor_grid-track-action embed-editor_grid-track-action-danger" onClick={() => remove(area.name)} disabled={busy} title="Remove area" aria-label="Remove area"><TrashIcon /></button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="embed-editor_grid-empty">No Areas</div>
      )}
      {openArea && anchorEl ? (
        <TrackPopover anchorEl={anchorEl} onClose={() => setOpenName(null)}>
          <AreaEditor area={openArea} busy={busy} onChange={(patch) => update(openArea.name, patch)} />
        </TrackPopover>
      ) : null}
    </section>
  )
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="embed-editor_bg-modal-backdrop style-panel-surface" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="embed-editor_grid-modal u-surface-surface" role="dialog" aria-modal="true" aria-label="Grid settings">
        <div className="embed-editor_grid-modal-head">
          <span className="embed-editor_grid-modal-title">Grid settings</span>
          <button type="button" className="embed-editor_bg-modal-close" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="embed-editor_grid-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export default function GridSettings({ read, busy, setProp, clearProp, onProvenance, onSelectSelector, onClose }: {
  read: Read; busy: boolean; setProp: SetProp; clearProp: ClearProp
  onProvenance: OnProvenance; onSelectSelector: OnSelectSelector; onClose: () => void
}) {
  const labels: LabelProps = { read, busy, clearProp, onProvenance, onSelectSelector }
  return (
    <Modal onClose={onClose}>
      <TrackSection title="Columns" prop="grid-template-columns" axis="column" setProp={setProp} labels={labels} />
      <AutoSection title="Auto-generated columns" prop="grid-auto-columns" axis="column" setProp={setProp} labels={labels} />
      <TrackSection title="Rows" prop="grid-template-rows" axis="row" setProp={setProp} labels={labels} />
      <AutoSection title="Auto-generated rows" prop="grid-auto-rows" axis="row" setProp={setProp} labels={labels} />
      <AreasSection setProp={setProp} labels={labels} />
    </Modal>
  )
}
