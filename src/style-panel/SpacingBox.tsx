import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HoverTooltip } from './components/SegmentedControl'
import { handleArrowStep } from './lib/number-step'
import { isNonNegative } from './lib/css-properties'
import ProvenanceList from './ProvenanceList'
import VariableConnect, { useSharedVars } from './VariableConnect'
import type { ProjectVariable } from './lib/webflow'
import { selectorsMatch, type ResolvedProp } from './lib/resolved'
import { getHost, getModifiers, onModifiers, setModifiers } from './lib/host'

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

// The props of `sides` alongside `prop`, which names `side` (`padding-right` →
// `padding-`, the bare inset `right` → ``). Only sides share a prefix this way,
// so anything else stays a one-property edit.
function siblingProps(prop: string, side: Side, sides: Side[]): string[] {
  if (!prop.endsWith(side)) return [prop]
  const prefix = prop.slice(0, prop.length - side.length)
  return sides.map((s) => `${prefix}${s}`)
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

// Dragging a side, wherever the press lands: the band around it or the number
// written on it. Both are the same gesture — press, move along the side's axis,
// let go — so both run this. The value keeps the unit already in the field (rem
// when the field is empty or unitless), the canvas is written on every rAF, and
// the file once on release.
//
// `threshold` is what tells a drag from a press. The bands are nothing but drag
// handles, so they start at once; a number is also a button that opens the
// editor, so it waits a few pixels before it becomes a drag, and reports
// afterwards whether it did (`wasDrag`) so the click that follows can be
// ignored.
type SideDragOptions = {
  propFor: (side: Side) => string
  inward: boolean
  read: Read
  busy: boolean
  setProp: SetProp
  liveSetProp: LiveSetProp
  onLive: (props: string[], display: string) => void
  onLiveEnd: () => void
  threshold?: number
}

function useSideDrag({
  propFor,
  inward,
  read,
  busy,
  setProp,
  liveSetProp,
  onLive,
  onLiveEnd,
  threshold = 0,
}: SideDragOptions) {
  const drag = useRef<
    | null
    | {
        side: Side
        /** The props being written right now — the modifiers decide, and they
         *  are free to change halfway through. */
        props: string[]
        /** Every prop this drag has written live, so one that stops being
         *  affected can be put back. */
        written: Set<string>
        unit: string
        startNum: number
        axis: 'x' | 'y'
        sign: 1 | -1
        startX: number
        startY: number
        /** Where the pointer is now, so a modifier pressed without moving still
         *  has somewhere to apply. */
        x: number
        y: number
        shiftKey: boolean
        altKey: boolean
        important: boolean
        /** Past the threshold — this is a drag now, not a press. */
        active: boolean
      }
  >(null)
  const raf = useRef<number | null>(null)
  const pending = useRef<string | null>(null)
  const dragged = useRef(false)

  const cancelFrame = () => {
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null }
  }
  useEffect(() => cancelFrame, [])

  const valueAt = () => {
    const d = drag.current!
    const px = (d.axis === 'x' ? d.x - d.startX : d.y - d.startY) * d.sign
    let next = d.startNum + (px * DRAG_SENSITIVITY) / pxPerUnit(d.unit)
    if (inward && next < 0) next = 0 // padding can't go negative; insets/margins can
    return formatLength(next, d.unit)
  }

  const flush = () => {
    raf.current = null
    const d = drag.current
    if (d && pending.current != null) d.props.forEach((prop) => liveSetProp(prop, pending.current!, d.important))
  }

  // Everything the drag does on any change — the pointer moving, or a modifier
  // going down or up under a pointer that is standing still.
  const apply = () => {
    const d = drag.current
    if (!d || !d.active) return
    dragged.current = true
    const next = affectedSides(d.side, d).map((s) => propFor(s))
    // A side the modifier just dropped goes back to what it was. It was only
    // ever previewed — nothing has been written to the file yet — so putting it
    // back is undoing the live write, not another edit.
    for (const prop of d.written) {
      if (!next.includes(prop)) {
        liveSetProp(prop, null, d.important)
        d.written.delete(prop)
      }
    }
    d.props = next
    for (const prop of next) d.written.add(prop)
    const value = valueAt()
    // Update the labels every time (cheap setState); throttle the canvas write to rAF.
    onLive(d.props, d.important ? `${value} !important` : value)
    pending.current = value
    if (raf.current == null) raf.current = requestAnimationFrame(flush)
  }

  // While a drag is live, Shift and Option are read as they are pressed rather
  // than as they were at the start: reach for one mid-drag and the other sides
  // join in from that moment.
  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const d = drag.current
      if (!d || (d.shiftKey === shiftKey && d.altKey === altKey)) return
      d.shiftKey = shiftKey
      d.altKey = altKey
      apply()
    }
    // Read off any key event, not just the modifiers themselves, and through
    // the shared store — see the hover hook below for both reasons.
    const onKey = (event: KeyboardEvent) => setModifiers(event.shiftKey, event.altKey)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    const offModifiers = onModifiers(follow)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      offModifiers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPointerDown = (side: Side) => (event: React.PointerEvent) => {
    if (busy) return
    // A band has nothing else to be, so it takes the press outright. A number is
    // a button: leave it its focus and its click until the pointer moves.
    if (threshold === 0) event.preventDefault()
    const shown = displayOf(read(propFor(side)))
    const { num, unit } = parseNumUnit(shown.value)
    const a = SIDE_AXIS[side]
    // Outward grows away from centre; inward (padding) drags the opposite way
    // (Webflow flips the resize cursors to match).
    const sign = (inward ? -a.sign : a.sign) as 1 | -1
    drag.current = {
      side,
      props: [],
      written: new Set(),
      unit: unit || 'rem',
      startNum: num,
      axis: a.axis,
      sign,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      important: shown.important,
      active: threshold === 0,
    }
    dragged.current = false
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.x = event.clientX
    d.y = event.clientY
    d.shiftKey = event.shiftKey
    d.altKey = event.altKey
    if (!d.active) {
      const far =
        Math.abs(event.clientX - d.startX) >= threshold || Math.abs(event.clientY - d.startY) >= threshold
      if (!far) return
      d.active = true
    }
    apply()
  }

  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    cancelFrame()
    if (d.active) {
      d.x = event.clientX
      d.y = event.clientY
      d.shiftKey = event.shiftKey
      d.altKey = event.altKey
      // One last apply: the sides the modifiers name at the moment of release
      // are the sides that get written.
      apply()
      cancelFrame()
    }
    const value = d.active ? valueAt() : null
    const props = d.props
    const important = d.important
    drag.current = null
    pending.current = null
    // Pressed and let go without moving: that was a click, and the click handler
    // is the one that should hear about it.
    if (value == null) return
    onLiveEnd()
    props.forEach((prop) => setProp(prop, value, important))
  }

  return { onPointerDown, onPointerMove, onPointerUp, wasDrag: () => dragged.current }
}

// Pointing at a side, as opposed to changing it. The canvas draws what the
// pointer is over — the strip of the page that side is holding open — so the
// panel has to say which sides those are, and keep saying it while Shift or
// Option change the answer under a pointer that hasn't moved.
function useSideHover({ propFor, kind, read }: { propFor: (side: Side) => string; kind: 'padding' | 'margin'; read: Read }) {
  const over = useRef<null | { side: Side; shiftKey: boolean; altKey: boolean }>(null)

  const report = () => {
    const o = over.current
    if (!o) { getHost().onSpacingHover?.(null); return }
    const sides = affectedSides(o.side, o)
    const labels: Record<string, string> = {}
    for (const s of sides) {
      try {
        const shown = displayOf(read(propFor(s)))
        labels[s] = shown.present ? shown.value : '0'
      } catch {
        // A value that can't be read is a missing label, not a missing band.
      }
    }
    getHost().onSpacingHover?.({ kind, sides, labels })
  }
  // The listener below is registered once; this keeps it calling the current
  // one, which reads the values as they are now rather than as they were when
  // the panel first rendered.
  const reportRef = useRef(report)
  reportRef.current = report

  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const o = over.current
      if (!o || (o.shiftKey === shiftKey && o.altKey === altKey)) return
      o.shiftKey = shiftKey
      o.altKey = altKey
      reportRef.current()
    }
    // Every key event, not only the modifier keys themselves: what is wanted is
    // the state of Shift and Option right now, and reading it off whatever
    // event just happened means a missed keyup (focus moved for a moment, a
    // shortcut ate the event) is corrected by the next one rather than leaving
    // the canvas lit up for a modifier nobody is holding.
    //
    // Captured rather than bubbled: a field in the panel that stops a key event
    // from travelling must not stop the canvas from following the modifier. And
    // the answer goes through the shared store, because the other place these
    // are pressed is the canvas — see setModifiers.
    const onKey = (event: KeyboardEvent) => setModifiers(event.shiftKey, event.altKey)
    const onBlur = () => setModifiers(false, false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    const offModifiers = onModifiers(follow)
    // Leaving the panel entirely (or unmounting mid-hover) must not leave the
    // canvas lit up with nothing pointing at it.
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
      offModifiers()
      if (over.current) { over.current = null; getHost().onSpacingHover?.(null) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    onEnter: (side: Side) => (event: React.MouseEvent | React.PointerEvent) => {
      // A modifier held before the pointer arrived counts: the pointer event
      // knows what this window saw, the store knows what the canvas saw too.
      const held = getModifiers()
      over.current = {
        side,
        shiftKey: event.shiftKey || held.shiftKey,
        altKey: event.altKey || held.altKey,
      }
      report()
    },
    onLeave: () => {
      if (!over.current) return
      over.current = null
      report()
    },
    /** Follow a modifier held while the pointer moves within the same side. */
    onOver: (event: React.MouseEvent | React.PointerEvent) => {
      const o = over.current
      if (!o || (o.shiftKey === event.shiftKey && o.altKey === event.altKey)) return
      o.shiftKey = event.shiftKey
      o.altKey = event.altKey
      report()
    },
  }
}

// Each trapezoid is also a drag handle: hovering brightens it (CSS), and dragging
// along its axis grows/shrinks that side's value.
export function SpacingFill({ frame, propFor, inward = false, read, busy, setProp, liveSetProp, onLive, onLiveEnd }: FillProps) {
  const f = FRAMES[frame]
  const maskId = 'sp-' + useId().replace(/:/g, '')
  const { onPointerDown, onPointerMove, onPointerUp } = useSideDrag({
    propFor,
    inward,
    read,
    busy,
    setProp,
    liveSetProp,
    onLive,
    onLiveEnd,
  })
  const hover = useSideHover({ propFor, kind: inward ? 'padding' : 'margin', read })

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
            onPointerDown={onPointerDown(side)}
            onPointerMove={(event) => { hover.onOver(event); onPointerMove(event) }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={hover.onEnter(side)}
            onPointerLeave={hover.onLeave}
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

// The always-visible value: a label you can click or drag. Click opens the
// editor popover; Alt/Option-click clears the side; dragging it adjusts the
// value, the same gesture as dragging the band behind it — which is where most
// presses land, since the number sits on top of the band.
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
  setProp,
  liveSetProp,
  onLive,
  onLiveEnd,
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
  setProp: SetProp
  liveSetProp: LiveSetProp
  onLive: (props: string[], display: string) => void
  onLiveEnd: () => void
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

  // The number drags like the band it sits on: `padding-top` → `padding-left`
  // and friends, so Shift and Alt reach the other sides from here too. A few
  // pixels of travel separate a drag from the click that opens the editor.
  const propForSide = (s: Side) => siblingProps(prop, side, [s])[0]
  const { onPointerDown, onPointerMove, onPointerUp, wasDrag } = useSideDrag({
    propFor: propForSide,
    inward: prop.startsWith('padding'),
    read,
    busy,
    setProp,
    liveSetProp,
    onLive,
    onLiveEnd,
    threshold: 3,
  })
  // `padding-top` → padding, `margin-top` → margin, a bare inset (`top`) → the
  // box it is drawn in, which is the margin frame.
  const hover = useSideHover({
    propFor: propForSide,
    kind: prop.startsWith('padding') ? 'padding' : 'margin',
    read,
  })

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
        onPointerEnter={hover.onEnter(side)}
        onPointerLeave={hover.onLeave}
        onFocus={() => setShowTooltip(true)}
        onBlur={closeTooltip}
        onPointerDown={(event) => { closeTooltip(); onPointerDown(side)(event) }}
        onPointerMove={(event) => { hover.onOver(event); onPointerMove(event) }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(event) => {
          closeTooltip()
          if (wasDrag()) return // that press was a drag; it has already been applied
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
  side,
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
  side: Side
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
  // Which sides the pending commit writes. Enter alone writes this one; the drag
  // modifiers mean the same here — Option/Alt adds the opposite side, Shift takes
  // all four. Reset on every keystroke so a modifier only counts on the Enter that
  // held it, and left at this side alone for a commit that comes from a blur.
  const commitProps = useRef<string[]>([prop])

  const setDraftValue = (text: string) => { draftRef.current = text; setDraft(text) }

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  const cancelLive = () => {
    if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null }
  }
  useEffect(() => cancelLive, [])

  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      const trimmed = text.trim()
      if (!trimmed) return
      const parsed = parseImportant(trimmed)
      liveSetProp(prop, parsed.value, parsed.important)
    }, 100)
  }

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
      const props = commitProps.current
      if (!trimmed) clearProp(props)
      else {
        const parsed = parseImportant(trimmed)
        props.forEach((target) => setProp(target, parsed.value, parsed.important))
      }
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
        <span className="embed-editor_spacing-popover-label">{humanLabel(prop)}</span>
        <VariableConnect ariaLabel={`Connect ${humanLabel(prop)} to a variable`} disabled={false} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
          <input
            ref={inputRef}
            className={`u-input embed-editor_spacing-editor`}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => { setDraftValue(event.target.value); scheduleLive(event.target.value) }}
            onBlur={close}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRequested.current = true
                commitProps.current = siblingProps(prop, side, affectedSides(side, event))
                event.currentTarget.blur()
                return
              }
              // A modifier only applies to the Enter that carries it.
              commitProps.current = [prop]
              if (event.key === 'Escape') { cancelLive(); closed.current = true; onClose(); return }
              // Padding stops at 0; a margin or an inset is free to go negative,
              // which is the whole point of pulling something out of its box.
              const stepped = handleArrowStep(event, isNonNegative(prop) ? 0 : undefined)
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
      setProp={shared.setProp}
      liveSetProp={shared.liveSetProp}
      onLive={onLive}
      onLiveEnd={onLiveEnd}
    />
  )

  const editor = editing ? (
    <SpacingEditor
      key={editing.prop}
      prop={editing.prop}
      side={editing.side}
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
