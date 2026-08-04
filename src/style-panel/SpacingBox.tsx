import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HoverTooltip } from './components/SegmentedControl'
import useScrub from './components/useScrub'
import { handleArrowStep } from './lib/number-step'
import ProvenanceList from './ProvenanceList'
import VariableConnect, { useSharedVars } from './VariableConnect'
import type { ProjectVariable } from './lib/webflow'
import { selectorsMatch, type ResolvedProp } from './lib/resolved'

// Shared "spacing box" primitives: Webflow's masked-SVG frame with draggable side
// handles, click-to-edit value labels, and a popover editor. Used by SpacingSection
// (nested margin + padding) and PositionSection (a single inset frame: top/right/
// bottom/left). Each side is driven by the resolved model — blue when the picked
// selector sets it, orange when another selector does, dim (assumed unset) otherwise.

export type SetProp = (prop: string, value: string, important: boolean) => void
export type ClearProp = (prop: string | string[]) => void
export type LiveSetProp = (prop: string, value: string | null, important: boolean) => void
export type Read = (prop: string) => ResolvedProp | undefined
export type SelectSelector = (selector: string, prop?: string) => void

export type Side = 'top' | 'right' | 'bottom' | 'left'

type Display = {
  present: boolean
  isSelected: boolean
  value: string
  important: boolean
  /** The picked selector sets this side but a more specific selector wins. */
  overridden: boolean
  /** The selector that wins the cascade (for the override tooltip). */
  winnerSelector: string
}
function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) return { present: false, isSelected: false, value: '', important: false, overridden: false, winnerSelector: '' }
  const isSelected = resolved.source === 'selected'
  // A wrapped value that Webflow cannot round-trip is moved to the selected embed
  // rule, while its native class can still read back as the inner Variable object.
  // Prefer that authored fallback so spacing shows/edits `calc(...)`, not the lossy
  // variable name. This remains scoped to the same selected selector.
  const editingSelector = resolved.contributors.find((contributor) => contributor.editing)?.selectorText
  const wrappedFallback = resolved.contributors.find((contributor) =>
    contributor.origin === 'embed'
    && isWrappedValue(contributor.value)
    && (contributor.isSelected || (!!editingSelector && selectorsMatch(contributor.selectorText, editingSelector))))
  const source = wrappedFallback ?? (isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner)
  return {
    present: true,
    isSelected,
    value: source.value,
    important: source.important,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
  }
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}

// ── Drag-to-adjust helpers (shared by the SVG side handles) ──────────────────

// Each side drags along one axis; `sign` maps "away from centre" to an increase
// (drag the top band up, the left band left, etc.).
const SIDE_AXIS: Record<Side, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  top: { axis: 'y', sign: -1 },
  bottom: { axis: 'y', sign: 1 },
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
}

const ALL_SIDES: Side[] = ['top', 'right', 'bottom', 'left']
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

// Sides a drag affects, by modifier: Shift → all four, Alt/Option → the dragged
// side + its opposite, otherwise just the dragged side. All affected sides are
// set to the same value (they equalise as you drag).
function affectedSides(side: Side, event: { shiftKey: boolean; altKey: boolean }): Side[] {
  if (event.shiftKey) return ALL_SIDES
  if (event.altKey) return [side, OPPOSITE[side]]
  return [side]
}

// CSS px of value change per screen px dragged. 0.5 ≈ half-speed for fine control.
const DRAG_SENSITIVITY = 0.5

/** Split a length into its number and unit (unit '' when absent / non-numeric). */
function parseNumUnit(value: string): { num: number; unit: string } {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i)
  if (!match) return { num: 0, unit: '' }
  return { num: parseFloat(match[1]), unit: match[2].toLowerCase() }
}

/** How many CSS px one unit spans, so a drag in screen px maps to a value delta. */
function pxPerUnit(unit: string): number {
  switch (unit) {
    case 'px': return 1
    case 'rem':
    case 'em': return 16
    case 'pt': return 96 / 72
    default: return 16 // %, vw, … — approximate so the drag still feels reasonable
  }
}

/** Round to a sensible precision for the unit and re-attach it. */
function formatLength(num: number, unit: string): string {
  const rounded = unit === 'px' || unit === '%' ? Math.round(num) : Math.round(num * 100) / 100
  return `${rounded}${unit}`
}

// The frame band, drawn exactly like Webflow's spacing control: four shaded
// trapezoids clipped by a mask that subtracts a rounded inner rect which is 1px
// larger than the centre hole on every side — so its rounded corners bite into
// the band and the trapezoids meet a rounded (not square) inner corner. Fixed
// geometry (viewBox == Webflow's) with preserveAspectRatio="none" scales the SVG
// to the frame while the frame keeps Webflow's aspect ratio, so nothing distorts.
export const FRAMES = {
  // w/h: viewBox size · band: side thickness · or/ir: outer/inner corner radius
  // mask: the subtracted inner rect (1px larger than the w-2·band × h-2·band hole)
  margin: {
    w: 224, h: 112, or: 4, ir: 4,
    mask: { x: 35, y: 23, w: 154, h: 66 },
    paths: {
      top: 'm0,0 h224 l-36,24 h-152 l-36,-24z',
      right: 'm224,0 v112 l-36,-24 v-64 l36,-24z',
      bottom: 'm0,112 h224 l-36,-24 h-152 l-36,24z',
      left: 'm0,0 v112 l36,-24 v-64 l-36,-24z',
    },
  },
  padding: {
    w: 150, h: 60, or: 2, ir: 2,
    mask: { x: 35, y: 23, w: 80, h: 14 },
    paths: {
      top: 'm0,0 h150 l-36,24 h-78 l-36,-24z',
      right: 'm150,0 v60 l-36,-24 v-12 l36,-24z',
      bottom: 'm0,60 h150 l-36,-24 h-78 l-36,24z',
      left: 'm0,0 v60 l36,-24 v-12 l-36,-24z',
    },
  },
  // Webflow's position/inset frame — a single 172×56 band with a 36×24 edge and a
  // 100×8 centre hole (the exact geometry from Webflow's position control SVG).
  position: {
    w: 172, h: 56, or: 4, ir: 4,
    mask: { x: 35, y: 23, w: 102, h: 10 },
    paths: {
      top: 'm0,0 h172 l-36,24 h-100 l-36,-24z',
      right: 'm172,0 v56 l-36,-24 v-8 l36,-24z',
      bottom: 'm0,56 h172 l-36,-24 h-100 l-36,24z',
      left: 'm0,0 v56 l36,-24 v-8 l-36,-24z',
    },
  },
} as const

export type FrameKey = keyof typeof FRAMES

type FillProps = {
  frame: FrameKey
  /** Maps a side to its CSS property (`margin-top`, `padding-top`, or plain `top`). */
  propFor: (side: Side) => string
  /** Grows inward (padding): flip the drag direction and clamp at 0. Insets & margins grow outward. */
  inward?: boolean
  read: Read
  busy: boolean
  setProp: SetProp
  liveSetProp: LiveSetProp
  // Report the in-flight drag value (affected props + display string) so the
  // matching labels mirror it live; onLiveEnd clears it on release.
  onLive: (props: string[], display: string) => void
  onLiveEnd: () => void
}

// Each trapezoid is also a drag handle: hovering brightens it (CSS), and dragging
// along its axis grows/shrinks that side's value. The value keeps the unit already
// in the field (rem when the field is empty or unitless). Live-set on every rAF
// while dragging, committed once on release.
export function SpacingFill({ frame, propFor, inward = false, read, busy, setProp, liveSetProp, onLive, onLiveEnd }: FillProps) {
  const f = FRAMES[frame]
  const maskId = 'sp-' + useId().replace(/:/g, '')
  const drag = useRef<
    | null
    | {
        // All props the drag writes (dragged side alone, ± opposite, or all four).
        props: string[]
        unit: string
        startNum: number
        axis: 'x' | 'y'
        sign: 1 | -1
        startX: number
        startY: number
        important: boolean
      }
  >(null)
  const raf = useRef<number | null>(null)
  const pending = useRef<string | null>(null)

  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current) }, [])

  const valueAt = (event: React.PointerEvent) => {
    const d = drag.current!
    const px = (d.axis === 'x' ? event.clientX - d.startX : event.clientY - d.startY) * d.sign
    let next = d.startNum + (px * DRAG_SENSITIVITY) / pxPerUnit(d.unit)
    if (inward && next < 0) next = 0 // padding can't go negative; insets/margins can
    return formatLength(next, d.unit)
  }

  const flush = () => {
    raf.current = null
    const d = drag.current
    if (d && pending.current != null) d.props.forEach((prop) => liveSetProp(prop, pending.current!, d.important))
  }

  const onDown = (side: Side) => (event: React.PointerEvent) => {
    if (busy) return
    event.preventDefault()
    const shown = displayOf(read(propFor(side)))
    const { num, unit } = parseNumUnit(shown.value)
    const a = SIDE_AXIS[side]
    // Outward grows away from centre; inward (padding) drags the opposite way
    // (Webflow flips the resize cursors to match).
    const sign = (inward ? -a.sign : a.sign) as 1 | -1
    // Modifier (read at press) fixes which sides this drag equalises.
    const sides = affectedSides(side, event)
    drag.current = {
      props: sides.map((s) => propFor(s)),
      unit: unit || 'rem',
      startNum: num,
      axis: a.axis,
      sign,
      startX: event.clientX,
      startY: event.clientY,
      important: shown.important,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onMove = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const value = valueAt(event)
    // Update the labels every move (cheap setState); throttle the canvas write to rAF.
    onLive(d.props, d.important ? `${value} !important` : value)
    pending.current = value
    if (raf.current == null) raf.current = requestAnimationFrame(flush)
  }

  const onUp = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null }
    const value = valueAt(event)
    drag.current = null
    pending.current = null
    onLiveEnd()
    d.props.forEach((prop) => setProp(prop, value, d.important))
  }

  return (
    <svg
      className="embed-editor_spacing-fill"
      viewBox={`0 0 ${f.w} ${f.h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <mask id={maskId} maskContentUnits="userSpaceOnUse">
        <rect x="0" y="0" width={f.w} height={f.h} rx={f.or} ry={f.or} fill="#fff" />
        <rect x={f.mask.x} y={f.mask.y} width={f.mask.w} height={f.mask.h} rx={f.ir} ry={f.ir} fill="#000" />
      </mask>
      <g mask={`url(#${maskId})`}>
        {(['top', 'right', 'bottom', 'left'] as Side[]).map((side) => (
          <path
            key={side}
            className={`embed-editor_spacing-tri is-${side}`}
            d={f.paths[side]}
            onPointerDown={onDown(side)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        ))}
      </g>
    </svg>
  )
}

/** Label text: the value with its unit (the empty placeholder when unset), sans
 *  !important. The CSS truncates it to the band, so the unit shows when there's room. */
function labelFor(value: string, empty: string): string {
  const v = value.trim().replace(/\s*!important$/i, '')
  return v || empty
}

function variableFor(value: string, variables: ProjectVariable[]): ProjectVariable | undefined {
  const raw = value.trim().replace(/\s*!important$/i, '')
  const binding = raw.match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i)?.[0]
  // Purple is reserved for a direct variable value. Expressions that merely contain
  // a variable, such as `calc(var(--space) * 2)`, remain normal blue property values.
  if (binding) return binding === raw ? variables.find((variable) => variable.binding === binding) : undefined
  return variables.find((variable) => {
    const fullName = variable.group ? `${variable.group}/${variable.name}` : variable.name
    return raw === fullName || raw === variable.name
  })
}

function isWrappedValue(value: string | undefined): boolean {
  if (!value) return false
  const raw = value.trim().replace(/\s*!important$/i, '')
  return /^(?!var\()[a-z-]+\(/i.test(raw)
}

/** `margin-top` -> `Margin top`, `top` -> `Top` for the click editor label. */
function humanLabel(prop: string): string {
  const spaced = prop.replace('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// The always-visible value: a clickable label (not an input). Click opens the
// editor popover; Alt/Option-click clears the side. Mirrors an in-flight drag.
export function SpacingLabel({
  prop,
  side,
  override,
  emptyLabel,
  read,
  busy,
  clearProp,
  onEdit,
  variables,
  variableLabels = false,
}: {
  prop: string
  side: Side
  override?: string | null
  emptyLabel: string
  read: Read
  busy: boolean
  clearProp: ClearProp
  onEdit: (prop: string, side: Side) => void
  variables: ProjectVariable[]
  variableLabels?: boolean
}) {
  const resolved = read(prop)
  const d = displayOf(resolved)
  const value = override ?? (d.present ? (d.important ? `${d.value} !important` : d.value) : '')
  // Native getProperties can collapse a calc(var(...)) selected value to a Variable
  // object even when the winning/embed fallback keeps the authored expression. Either
  // expression signal means this is a blue property value, not a direct purple variable.
  const hasWrappedValue = isWrappedValue(value) || isWrappedValue(resolved?.winner.value)
  // A live drag (override) always shows its own value plainly; otherwise reflect
  // the cascade — struck-through when a more specific selector overrides this side.
  // The native-variable/expression pair is one authored value represented through two
  // bridge layers, not a meaningful visual override, so keep its property label blue.
  const overridden = override == null && d.overridden && !hasWrappedValue
  const color = override != null || (d.present && d.isSelected) ? 'is-selected' : d.present ? 'is-other' : ''
  const variable = override == null && variableLabels && !hasWrappedValue ? variableFor(value, variables) : undefined
  const state = `${color}${variable ? ' is-variable' : ''}${overridden ? ' is-overridden' : ''}`
  const variableFullName = variable ? (variable.group ? `${variable.group}/${variable.name}` : variable.name) : ''
  const tooltipValue = variable ? variable.name : labelFor(value, emptyLabel)
  const tooltipContent = variableFullName || (overridden ? `Overridden by ${d.winnerSelector}` : tooltipValue)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [showTooltip, setShowTooltip] = useState(false)
  const tooltipTimer = useRef<number | null>(null)
  const clearTooltipTimer = () => {
    if (tooltipTimer.current != null) { window.clearTimeout(tooltipTimer.current); tooltipTimer.current = null }
  }
  useEffect(() => clearTooltipTimer, [])
  const openTooltip = () => {
    clearTooltipTimer()
    tooltipTimer.current = window.setTimeout(() => { tooltipTimer.current = null; setShowTooltip(true) }, 350)
  }
  const closeTooltip = () => { clearTooltipTimer(); setShowTooltip(false) }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`embed-editor_spacing-label embed-editor_spacing-${side} ${state}`}
        data-prop={prop}
        disabled={busy}
        onMouseEnter={openTooltip}
        onMouseLeave={closeTooltip}
        onFocus={() => setShowTooltip(true)}
        onBlur={closeTooltip}
        onClick={(event) => {
          closeTooltip()
          if (event.altKey) { clearProp(prop); return } // Alt/Option-click removes the value
          onEdit(prop, side)
        }}
      >
        {variable?.name ?? labelFor(value, emptyLabel)}
      </button>
      {showTooltip && buttonRef.current ? (
        <HoverTooltip anchor={buttonRef.current}>
          <span className="embed-editor_spacing-tooltip">
            <span className={variableFullName ? 'embed-editor_spacing-tooltip-meta' : 'embed-editor_spacing-tooltip-value'}>
              {tooltipContent}
            </span>
          </span>
        </HoverTooltip>
      ) : null}
    </>
  )
}

// The editor shown inside the popover: a live text input (number + unit, with the
// same arrow-step / !important handling as before). Commits + closes on blur.
export function SpacingEditor({
  prop,
  placeholder,
  read,
  setProp,
  clearProp,
  liveSetProp,
  onSelectSelector,
  onClose,
  onSameLabelPress,
}: {
  prop: string
  placeholder: string
  read: Read
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onSelectSelector: SelectSelector
  onClose: () => void
  /** Fired when the popover closes because its OWN side's label was pressed —
   *  lets the parent suppress that label's click from re-opening it (toggle). */
  onSameLabelPress: () => void
}) {
  const d = displayOf(read(prop))
  const external = d.present ? (d.important ? `${d.value} !important` : d.value) : ''
  const [draft, setDraft] = useState(external)
  const draftRef = useRef(draft)
  const liveTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const closed = useRef(false)
  // The value when the popover opened, and whether Enter explicitly confirmed it —
  // used so a plain open+close leaves the side untouched (see `close`).
  const originalRef = useRef(external)
  const commitRequested = useRef(false)

  const setDraftValue = (text: string) => { draftRef.current = text; setDraft(text) }

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  const cancelLive = () => {
    if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null }
  }
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

  // A scrub only moves the draft: this popover's authoritative write happens when it
  // closes (see `close`), which is also what typing in it does.
  const scrub = useScrub({
    value: draft,
    onPreview: setDraftValue,
    onInput: liveNow,
    onCommit: setDraftValue,
  })

  // Commit the latest draft (via ref, so the document listener's stale closure
  // still reads it) and close — guarded so blur + outside-click can't double-fire.
  const close = () => {
    if (closed.current) return
    closed.current = true
    cancelLive()
    // Only apply on an explicit Enter or an actual edit. Opening the popover and
    // clicking away (or blurring) must leave the side untouched — otherwise an
    // inherited / other-selector value gets silently written onto the picked style.
    const trimmed = draftRef.current.trim()
    const changed = trimmed !== originalRef.current.trim()
    if (commitRequested.current || changed) {
      if (!trimmed) clearProp(prop)
      else { const parsed = parseImportant(trimmed); setProp(prop, parsed.value, parsed.important) }
    }
    onClose()
  }

  const reset = () => {
    closed.current = true // skip the commit path; we're clearing, not committing
    cancelLive()
    clearProp(prop)
    onClose()
  }

  // Any pointerdown outside the popover closes it — pointerdown (not mousedown/
  // click) so it fires even when the target preventDefaults its press and thereby
  // suppresses the compat mousedown + blur (e.g. the drag bands).
  useEffect(() => {
    const onDocDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      // Pressing this side's own label should net to a close (not reopen): flag it
      // so the label's click doesn't re-open the popover we're about to close.
      const labelProp = (event.target as Element).closest?.('.embed-editor_spacing-label')?.getAttribute('data-prop')
      if (labelProp === prop) onSameLabelPress()
      close()
    }
    document.addEventListener('pointerdown', onDocDown)
    return () => document.removeEventListener('pointerdown', onDocDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="embed-editor_spacing-popover"
      ref={rootRef}
      // Keep the input focused when pressing anywhere in the popover other than the
      // input itself, so an inside click never blurs → commits → closes.
      onMouseDown={(event) => { if (event.target !== inputRef.current) event.preventDefault() }}
    >
      <div className="embed-editor_spacing-popover-row">
        <span className="embed-editor_spacing-popover-label" {...scrub.label}>{humanLabel(prop)}</span>
        <VariableConnect ariaLabel={`Connect ${humanLabel(prop)} to a variable`} disabled={false} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
          <input
            {...scrub.input}
            ref={inputRef}
            className={`u-input embed-editor_spacing-editor`}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => { setDraftValue(event.target.value); scheduleLive(event.target.value) }}
            onBlur={close}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { commitRequested.current = true; event.currentTarget.blur(); return }
              if (event.key === 'Escape') { cancelLive(); closed.current = true; onClose(); return }
              const stepped = handleArrowStep(event)
              if (!stepped) return
              event.preventDefault()
              const el = event.currentTarget
              el.value = stepped.text
              el.setSelectionRange(stepped.caret, stepped.caret)
              setDraftValue(stepped.text)
              scheduleLive(stepped.text)
            }}
            spellCheck={false}
            aria-label={prop}
          />
        </VariableConnect>
      </div>
      {/* Which selectors set this side and which one wins (the winner reads full
          strength, the rest dimmed). Each row jumps to that selector. */}
      <ProvenanceList
        contributors={read(prop)?.contributors ?? []}
        prop={prop}
        onSelect={(sel, p) => { onSelectSelector(sel, p); onClose() }}
      />
      {/* Reused Reset item — mousedown-preventDefault keeps input focus so the
          blur→commit path doesn't fire before the click clears the value. */}
      <button
        type="button"
        className="u-field-label-menu-item embed-editor_spacing-reset"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.preventDefault(); reset() }}
      >
        <svg className="u-field-label-menu-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.2 5.2H2.2V2.2" />
          <path d="M2.6 5.2A5.5 5.5 0 1 1 4 12.2" />
        </svg>
        <span>Reset</span>
        <span className="u-field-label-menu-shortcut">Option + click</span>
      </button>
    </div>
  )
}

// ── Orchestration hook: drag-mirroring + which side's popover is open ─────────

type SharedProps = {
  read: Read
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  liveSetProp: LiveSetProp
  onSelectSelector: SelectSelector
}

// Wires the pieces together for one box (or a set of nested frames sharing a
// popover): returns a `label(prop, side)` renderer, the SpacingFill live handlers,
// and the editor node (or null when closed). `emptyLabel` is the placeholder for an
// unset side ("0" for margin/padding, "Auto" for inset).
export function useSpacingBox(shared: SharedProps, options?: { emptyLabel?: string; variableLabels?: boolean }): {
  label: (prop: string, side: Side) => ReactNode
  fillHandlers: { onLive: (props: string[], display: string) => void; onLiveEnd: () => void }
  editor: ReactNode
} {
  const emptyLabel = options?.emptyLabel ?? '0'
  const { vars: variables } = useSharedVars(!!options?.variableLabels)
  // The props the in-flight drag is writing and their shared live value, so every
  // matching label mirrors the drag in real time (only one drag runs at a time).
  const [liveDrag, setLiveDrag] = useState<{ props: string[]; value: string } | null>(null)
  const onLive = (dragProps: string[], value: string) => setLiveDrag({ props: dragProps, value })
  const onLiveEnd = () => setLiveDrag(null)

  // The side whose editor popover is open (null = closed).
  const [editing, setEditing] = useState<{ prop: string; side: Side } | null>(null)
  // When the open popover is closed by pressing its own label, the label's click
  // must NOT re-open it — this holds that prop so onEdit skips the reopen once.
  const suppressReopen = useRef<string | null>(null)
  const onEdit = (prop: string, side: Side) => {
    if (suppressReopen.current === prop) { suppressReopen.current = null; return }
    suppressReopen.current = null
    setEditing({ prop, side })
  }

  const label = (prop: string, side: Side) => (
    <SpacingLabel
      key={prop}
      prop={prop}
      side={side}
      override={liveDrag?.props.includes(prop) ? liveDrag.value : null}
      emptyLabel={emptyLabel}
      read={shared.read}
      busy={shared.busy}
      clearProp={shared.clearProp}
      onEdit={onEdit}
      variables={variables}
      variableLabels={options?.variableLabels}
    />
  )

  const editor = editing ? (
    <SpacingEditor
      key={editing.prop}
      prop={editing.prop}
      placeholder={emptyLabel}
      read={shared.read}
      setProp={shared.setProp}
      clearProp={shared.clearProp}
      liveSetProp={shared.liveSetProp}
      onSelectSelector={shared.onSelectSelector}
      onClose={() => setEditing(null)}
      onSameLabelPress={() => { suppressReopen.current = editing.prop }}
    />
  ) : null

  return { label, fillHandlers: { onLive, onLiveEnd }, editor }
}
