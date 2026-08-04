import { useEffect, useRef, useState } from 'react'
import { displayOf, GroupLabel, PropLabel } from './TypographySection'
import useScrub from './components/useScrub'
import { handleArrowStep } from './lib/number-step'
import VariableConnect from './VariableConnect'
import type { ResolvedProp } from './lib/resolved'

// The Gap control for the Layout section: a lock toggle plus one field (linked →
// both gaps equal) or two fields (unlinked → separate row/column).
// Native-first / embed-fallback is handled by the parent's set/clear/liveSet.
//
// A gap can be written three ways: the modern `row-gap`/`column-gap` longhands, the
// legacy `grid-*-gap` aliases (what Webflow emits, and all this control used to read or
// write), or the `gap` shorthand. Reading only the aliases meant a rule using the modern
// longhands showed an empty field, and writing only the aliases appended a SECOND
// declaration for a gap the rule already had — so the field read 0, the edit duplicated
// the property, and if the value matched what was already there nothing moved on the
// canvas. So: read whichever form the CSS uses, and write the form(s) already present.

type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type LiveSetProp = (prop: string, value: string | null, important: boolean) => void

const ROW = 'row-gap'
const COL = 'column-gap'
const ROW_LEGACY = 'grid-row-gap'
const COL_LEGACY = 'grid-column-gap'
const SHORTHAND = 'gap'
/** Every declaration this row represents — for the label's active state and Clear. */
const GAP_PROPS = [ROW, COL, ROW_LEGACY, COL_LEGACY, SHORTHAND]

// `gap: <row> [<column>]` — one value sets both axes.
function shorthandPart(value: string, axis: 'row' | 'col'): string {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  return axis === 'row' ? parts[0] : (parts[1] ?? parts[0])
}

type Axis = {
  /** The value to show in the field. */
  value: string
  important: boolean
  /** Declarations a write should update — empty means nothing is set yet. */
  targets: string[]
  /** The declaration the shown value came from (for the label + provenance). */
  resolved: ResolvedProp | undefined
}

// One axis's state: where its value comes from, and what a write should touch.
function axisState(
  read: (prop: string) => ResolvedProp | undefined,
  modern: string,
  legacy: string,
  axis: 'row' | 'col',
): Axis {
  const m = read(modern)
  const l = read(legacy)
  const mSet = m?.source === 'selected'
  const lSet = l?.source === 'selected'
  // Update every form the picked rule already carries: with both present the later one
  // wins and we can't see declaration order from here, so keeping them in step is the
  // only way the edit is guaranteed to show. Nothing set → write the modern longhand.
  const targets = [mSet ? modern : null, lSet ? legacy : null].filter((p): p is string => p != null)
  // Show the picked rule's own value (preferring the alias — when both exist it's the one
  // the old write path appended last, so it's what the canvas is using), else an
  // inherited longhand, else the `gap` shorthand's part for this axis.
  const own = lSet ? l : mSet ? m : undefined
  const src = own ?? l ?? m
  if (src) {
    const raw = rawEffective(src)
    return { value: raw.value, important: raw.important, targets, resolved: src }
  }
  const short = read(SHORTHAND)
  if (short) {
    const raw = rawEffective(short)
    return { value: shorthandPart(raw.value, axis), important: raw.important, targets, resolved: short }
  }
  return { value: '', important: false, targets, resolved: undefined }
}

// The effective raw value + !important (not lowercased) — mirrors EmbedEditor's helper.
function rawEffective(resolved: ResolvedProp | undefined): { value: string; important: boolean } {
  if (!resolved) return { value: '', important: false }
  const src = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return { value: src.value, important: src.important }
}

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

// A length field: live-as-you-type updates, commit on blur, ↑/↓ number stepping.
function GapInput({ prop, value, busy, ariaLabel, onLive, onCommit }: {
  prop: string
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
    <VariableConnect className="is-fill" ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop={prop} onPick={(binding) => onCommit(binding)}>
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

export default function GapControl({ show, read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  // Whether the row is applicable (flex/grid, or a gap already set). Passed in
  // (rather than gating the mount in the parent) so this component stays mounted
  // across background refreshes — otherwise the link-toggle state would reset.
  show: boolean
  read: (prop: string) => ResolvedProp | undefined
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const rowAxis = axisState(read, ROW, ROW_LEGACY, 'row')
  const colAxis = axisState(read, COL, COL_LEGACY, 'col')
  const rowRes = rowAxis.resolved
  const colRes = colAxis.resolved
  const row = rowAxis.value
  const col = colAxis.value
  const important = rowAxis.important || colAxis.important
  const [linkOverride, setLinkOverride] = useState<boolean | null>(null)
  const linked = linkOverride ?? (row === col)

  // All hooks run above this guard so the component keeps its state while hidden.
  if (!show) return null

  const put = (live: boolean) => (live ? liveSetProp : setProp)
  // Write an axis: update whatever form(s) it already uses, or add the modern longhand.
  const writeAxis = (axis: Axis, fallback: string, next: string, live: boolean) => {
    const v = next.trim()
    const targets = axis.targets.length ? axis.targets : [fallback]
    if (!v) { if (!live) clearProp(targets); return }
    targets.forEach((prop) => put(live)(prop, v, axis.important))
  }
  // Linked → both axes take the same value; unlinked → each field owns one.
  const writeBoth = (next: string, live: boolean) => {
    writeAxis(rowAxis, ROW, next, live)
    writeAxis(colAxis, COL, next, live)
  }
  const toggleLink = () => {
    if (linked) { setLinkOverride(false); return }
    setLinkOverride(true)
    const single = row || col
    if (single) writeBoth(single, false)
    else clearProp(GAP_PROPS)
  }

  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label="Gap"
        props={GAP_PROPS}
        read={read}
        busy={busy}
        onClear={() => { setLinkOverride(null); clearProp(GAP_PROPS) }}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_gap">
        {linked ? (
          <GapInput prop={ROW} value={row} busy={busy} ariaLabel="Gap" onLive={(v) => writeBoth(v, true)} onCommit={(v) => writeBoth(v, false)} />
        ) : (
          <>
            <div className="embed-editor_gap-cell">
              <GapInput prop={COL} value={col} busy={busy} ariaLabel="Column gap" onLive={(v) => writeAxis(colAxis, COL, v, true)} onCommit={(v) => writeAxis(colAxis, COL, v, false)} />
              <PropLabel
                label="Columns"
                prop={COL}
                d={displayOf(colRes)}
                contributors={colRes?.contributors ?? []}
                busy={busy}
                onClear={() => clearProp(colAxis.targets.length ? colAxis.targets : [COL, COL_LEGACY])}
                onProvenance={onProvenance}
                onSelectSelector={onSelectSelector}
              />
            </div>
            <div className="embed-editor_gap-cell">
              <GapInput prop={ROW} value={row} busy={busy} ariaLabel="Row gap" onLive={(v) => writeAxis(rowAxis, ROW, v, true)} onCommit={(v) => writeAxis(rowAxis, ROW, v, false)} />
              <PropLabel
                label="Rows"
                prop={ROW}
                d={displayOf(rowRes)}
                contributors={rowRes?.contributors ?? []}
                busy={busy}
                onClear={() => clearProp(rowAxis.targets.length ? rowAxis.targets : [ROW, ROW_LEGACY])}
                onProvenance={onProvenance}
                onSelectSelector={onSelectSelector}
              />
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
