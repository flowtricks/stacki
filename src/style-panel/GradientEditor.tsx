import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import ColorSwatch from './components/ColorSwatch'
import useScrub from './components/useScrub'
import VariableConnect from './VariableConnect'
import { handleArrowStep } from './lib/number-step'
import { angleToDegrees, degreesToAngle, gradientCenter, serializeGradient, stopPercent, stopsBarCss, type Gradient, type GradientStop } from './lib/gradient'

// Webflow-style visual gradient editor: a position grid + size presets (radial),
// an angle dial (linear/conic), a draggable stops bar, a repeat toggle, and the
// selected stop's color + position. Edits the gradient's INTERNAL structure and
// re-serializes it to the layer's background-image (see BackgroundSection).
//
// Local `draft` is the source of truth while dragging/typing (live writes don't
// rebuild the model, so the `gradient` prop stays stale mid-interaction); it syncs
// back from the prop whenever we aren't actively editing.

type Props = {
  gradient: Gradient
  busy: boolean
  onChange: (g: Gradient, live: boolean) => void
}

const RADIAL_SIZES = [
  { value: 'closest-side', label: 'Closest side', tip: 'Closest side extends the gradient from the defined position to the closest side.' },
  { value: 'closest-corner', label: 'Closest corner', tip: 'Closest corner extends the gradient from the defined position to the closest corner.' },
  { value: 'farthest-side', label: 'Farthest side', tip: 'Farthest side extends the gradient from the defined position to the farthest side.' },
  { value: 'farthest-corner', label: 'Farthest corner', tip: 'Farthest corner extends the gradient from the defined position to the farthest corner.' },
] as const

// Webflow's radial-extent icons (closest/farthest × side/corner).
const RADIAL_SIZE_ICONS: Record<string, ReactNode> = {
  'closest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M1 3v12h14V3h-1v11H2V3H1z" fill="currentColor" />
      <path opacity=".4" fillRule="evenodd" clipRule="evenodd" d="M8 4.5a2.5 2.5 0 11-3 0V2H3.337A5.53 5.53 0 002 3.337v6.326A5.5 5.5 0 109.663 2H8v2.5z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M1 1h14v1H7v2.05a2.51 2.51 0 00-1 0V2H1V1z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'closest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M14 2H5V1h10v14H1V5h1v9h12V2z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M2 1H1v3h1V2.707L4.414 5.12c.186-.28.427-.52.707-.706L2.71 2H4V1H2z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path opacity=".4" fillRule="evenodd" clipRule="evenodd" d="M2 5v6.19A6.5 6.5 0 0011.19 2H5v.88l1.146 1.145a2.5 2.5 0 11-2.12 2.12L2.878 5H2z" fill="currentColor" />
    </svg>
  ),
  'farthest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M13 2H2v12h11v1H1V1h12v1z" fill="currentColor" />
      <path opacity=".4" fillRule="evenodd" clipRule="evenodd" d="M13.85 5a7.465 7.465 0 00-1.35-3H2v10.5A7.503 7.503 0 0013.85 8H8.5a2.5 2.5 0 110-3h5.35z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M14 1h1v14h-1V7H8.95a2.513 2.513 0 000-1H14V1z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'farthest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity=".6" fillRule="evenodd" clipRule="evenodd" d="M14 2H2v12h9v1H1V1h14v10h-1V2z" fill="currentColor" />
      <path opacity=".4" fillRule="evenodd" clipRule="evenodd" d="M11 13.12V14H2V2h12v9h-.88L8.976 6.854a2.5 2.5 0 10-2.12 2.12L11 13.122z" fill="currentColor" />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M8.586 7.88c-.186.28-.427.52-.707.706L13.29 14H12v1h3v-3h-1v1.293L8.586 7.88z" fill="currentColor" />
    </svg>
  ),
}

// Radial extent presets with Webflow's icons + delayed description tooltips.
function RadialSizeControl({ value, busy, onChange }: { value: string; busy: boolean; onChange: (v: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [arrowRight, setArrowRight] = useState(0)
  const timer = useRef<number | null>(null)
  const clearT = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => clearT, [])
  const start = (v: string, el: HTMLElement) => {
    clearT()
    timer.current = window.setTimeout(() => {
      timer.current = null
      const root = rootRef.current
      if (root) {
        const track = root.getBoundingClientRect()
        const btn = el.getBoundingClientRect()
        setArrowRight(track.right - (btn.left + btn.width / 2))
      }
      setHovered(v)
    }, 500)
  }
  const end = () => { clearT(); setHovered(null) }
  const tip = RADIAL_SIZES.find((s) => s.value === hovered)?.tip
  return (
    <div ref={rootRef} className="embed-editor_grad-sizes" role="group" aria-label="Gradient size">
      {RADIAL_SIZES.map((s) => {
        const active = value === s.value
        return (
          <button
            key={s.value}
            type="button"
            className={`embed-editor_grad-size ${active ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={s.label}
            aria-pressed={active}
            onClick={() => { end(); onChange(s.value) }}
            onMouseEnter={(e) => start(s.value, e.currentTarget)}
            onMouseLeave={end}
          >
            {RADIAL_SIZE_ICONS[s.value]}
          </button>
        )
      })}
      {hovered && tip ? (
        <div className="u-segmented-tooltip" role="tooltip" style={{ '--tip-arrow-right': `${arrowRight}px` } as CSSProperties}>
          {tip}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  )
}

// 3×3 position picker: pick a corner/edge/center; the active cell is filled.
function PositionGrid({ x, y, busy, onPick }: { x: string; y: string; busy: boolean; onPick: (px: string, py: string) => void }) {
  const cells = ['0%', '50%', '100%']
  const activeX = cells.indexOf(x)
  const activeY = cells.indexOf(y)
  return (
    <div className="embed-editor_grad-grid" role="group" aria-label="Gradient position">
      {cells.map((py, yi) => cells.map((px, xi) => {
        const active = xi === activeX && yi === activeY
        return (
          <button
            key={`${xi}-${yi}`}
            type="button"
            className={`embed-editor_grad-grid-cell ${active ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={`Position ${px} ${py}`}
            aria-pressed={active}
            onClick={() => onPick(px, py)}
          >
            <span className="embed-editor_grad-grid-dot" />
          </button>
        )
      }))}
    </div>
  )
}

// A number field with a unit suffix (used for Left/Top and a stop's position).
function NumField({ value, unit, label, busy, onLive, onCommit }: {
  value: string
  unit: string
  label: string
  busy: boolean
  onLive: (v: string) => void
  onCommit: (v: string) => void
}) {
  const num = value.replace(/[a-z%]+$/i, '').trim()
  const [text, setText] = useState(num)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(num) }, [num])
  const withUnit = (t: string) => { const s = t.trim(); return s === '' ? '' : /[a-z%]$/i.test(s) ? s : `${s}${unit}` }
  const scrub = useScrub({
    value: text,
    disabled: busy,
    onPreview: setText,
    onInput: (t) => onLive(withUnit(t)),
    onCommit: (t) => { setText(t); onCommit(withUnit(t)) },
  })
  return (
    <div className="embed-editor_grad-num">
      <VariableConnect ariaLabel={`Connect ${label} to a variable`} disabled={busy} className="is-fill" prop="left" onPick={(binding) => onCommit(binding)}>
        <input
          {...scrub.input}
          className="u-input embed-editor_grad-num-input"
          value={text}
          inputMode="decimal"
          spellCheck={false}
          disabled={busy}
          aria-label={label}
          onChange={(e) => { setText(e.target.value); onLive(withUnit(e.target.value)) }}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; onCommit(withUnit(text)) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.currentTarget.blur(); return }
            const stepped = handleArrowStep(e)
            if (!stepped) return
            e.preventDefault()
            e.currentTarget.value = stepped.text
            e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
            setText(stepped.text)
            onLive(withUnit(stepped.text))
          }}
        />
      </VariableConnect>
      <span className="embed-editor_grad-num-unit">{unit}</span>
    </div>
  )
}

const RepeatIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M11.5 5.5A4 4 0 0 0 4 6.5M4.5 10.5A4 4 0 0 0 12 9.5M12 4v2h-2M4 12v-2h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const RotateCcwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 4v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M4.2 7A4.4 4.4 0 1 1 3.9 9.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)
const RotateCwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M12 4v3H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M11.8 7A4.4 4.4 0 1 0 12.1 9.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)

// The angle dial (linear): drag the dot around the circle to set the gradient's
// direction (0° = up, 90° = right — CSS convention), matching Webflow's control.
function AngleDial({ deg, busy, onChange }: { deg: number; busy: boolean; onChange: (deg: number, live: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const dragging = useRef(false)
  const angleFrom = (event: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    const dx = event.clientX - (rect.left + rect.width / 2)
    const dy = event.clientY - (rect.top + rect.height / 2)
    return Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360)
  }
  const onDown = (event: React.PointerEvent) => {
    if (busy) return
    event.preventDefault()
    dragging.current = true
    ref.current?.setPointerCapture(event.pointerId)
    onChange(angleFrom(event), true)
  }
  const onMove = (event: React.PointerEvent) => { if (dragging.current) onChange(angleFrom(event), true) }
  const onUp = (event: React.PointerEvent) => { if (!dragging.current) return; dragging.current = false; onChange(angleFrom(event), false) }
  const rad = (deg * Math.PI) / 180
  return (
    <button ref={ref} type="button" className="embed-editor_grad-dial" disabled={busy}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      aria-label="Gradient angle" title="Drag to set the angle">
      <span className="embed-editor_grad-dial-dot" style={{ left: `${50 + 38 * Math.sin(rad)}%`, top: `${50 - 38 * Math.cos(rad)}%` }} />
    </button>
  )
}

// Linear angle control: the dial + ±45° rotate buttons + a DEG number field.
export function AngleControl({ angle, busy, onChange }: { angle: string; busy: boolean; onChange: (angle: string, live: boolean) => void }) {
  const deg = angleToDegrees(angle)
  const set = (d: number, live: boolean) => onChange(degreesToAngle(d), live)
  return (
    <div className="embed-editor_grad-angle">
      <AngleDial deg={deg} busy={busy} onChange={(d, live) => set(d, live)} />
      <button type="button" className="embed-editor_grad-rotate" disabled={busy} title="Rotate −45°" aria-label="Rotate counterclockwise" onClick={() => set(deg - 45, false)}><RotateCcwIcon /></button>
      <button type="button" className="embed-editor_grad-rotate" disabled={busy} title="Rotate +45°" aria-label="Rotate clockwise" onClick={() => set(deg + 45, false)}><RotateCwIcon /></button>
      <NumField value={String(Math.round(deg))} unit="deg" label="Gradient angle" busy={busy} onLive={(v) => set(angleToDegrees(v), true)} onCommit={(v) => set(angleToDegrees(v), false)} />
    </div>
  )
}

export default function GradientEditor({ gradient, busy, onChange }: Props) {
  const external = useMemo(() => serializeGradient(gradient), [gradient])
  const [draft, setDraft] = useState<Gradient>(gradient)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(gradient) }, [external]) // eslint-disable-line react-hooks/exhaustive-deps

  const [selected, setSelected] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)
  const dragStop = useRef<number | null>(null)

  const g = draft
  const stops = g.stops
  const sel = Math.max(0, Math.min(selected, stops.length - 1))
  const center = gradientCenter(g)

  const push = (next: Gradient, live: boolean) => { setDraft(next); onChange(next, live) }
  const patch = (p: Partial<Gradient>, live = false) => push({ ...g, ...p }, live)
  const patchStops = (next: GradientStop[], live = false) => push({ ...g, stops: next }, live)
  const setStop = (i: number, p: Partial<GradientStop>, live = false) =>
    patchStops(stops.map((s, k) => (k === i ? { ...s, ...p } : s)), live)

  // Sort stops by position, keeping the given stop selected.
  const sortStops = (keep: number) => {
    const tagged = stops.map((s, i) => ({ s, i, p: stopPercent(stops, i) }))
    tagged.sort((a, b) => a.p - b.p || a.i - b.i)
    setSelected(tagged.findIndex((t) => t.i === keep))
    patchStops(tagged.map((t) => t.s), false)
  }

  // Drag a stop along the bar (live), commit + sort on release.
  const onHandleDown = (i: number) => (e: React.PointerEvent) => {
    if (busy) return
    e.preventDefault()
    setSelected(i)
    dragStop.current = i
    editing.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const i = dragStop.current
    const bar = barRef.current
    if (i == null || !bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.round(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)))
    setStop(i, { pos: `${pct}%` }, true)
  }
  const onHandleUp = (e: React.PointerEvent) => {
    const i = dragStop.current
    if (i == null) return
    dragStop.current = null
    editing.current = false
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    sortStops(i)
  }

  // Click the bar background → insert a stop there (color = nearest stop's).
  const onBarClick = (e: React.MouseEvent) => {
    if (busy || dragStop.current != null) return
    const bar = barRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.round(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)))
    // Nearest existing stop by position → copy its color.
    let nearest = 0
    let best = Infinity
    stops.forEach((_, k) => { const d = Math.abs(stopPercent(stops, k) - pct); if (d < best) { best = d; nearest = k } })
    const next = [...stops, { color: stops[nearest]?.color ?? '#000000', pos: `${pct}%` }]
    const tagged = next.map((s, i) => ({ s, p: i === next.length - 1 ? pct : stopPercent(next, i) }))
    tagged.sort((a, b) => a.p - b.p)
    const sorted = tagged.map((t) => t.s)
    setSelected(sorted.findIndex((s) => s.pos === `${pct}%`))
    patchStops(sorted, false)
  }
  const removeStop = (i: number) => {
    if (stops.length <= 2) return
    patchStops(stops.filter((_, k) => k !== i), false)
    setSelected((s) => Math.max(0, Math.min(s, stops.length - 2)))
  }

  // Delete / Backspace removes the selected stop (a gradient needs ≥ 2, so it's a
  // no-op below that). Window-scoped because the handle can't hold focus (its
  // pointerdown preventDefaults), but guarded so it never steals the keystroke
  // while a text field (color / position) is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || (e.key !== 'Delete' && e.key !== 'Backspace')) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (sel < 0 || sel >= stops.length || stops.length <= 2) return
      e.preventDefault()
      removeStop(sel)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, sel, stops])

  const current = stops[sel] ?? { color: '', pos: '' }

  return (
    <div className="embed-editor_grad">
      {/* Geometry: radial = position grid + size presets; conic = angle + grid;
          linear = angle only. */}
      {g.type === 'radial' ? (
        <>
          <div className="embed-editor_size-row embed-editor_grad-pos-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
            <div className="embed-editor_grad-pos">
              <PositionGrid x={center.x} y={center.y} busy={busy} onPick={(px, py) => patch({ posX: px, posY: py })} />
              <div className="embed-editor_grad-pos-fields">
                <label className="embed-editor_grad-pos-field"><span>Left</span>
                  <NumField value={center.x} unit="%" label="Position left" busy={busy}
                    onLive={(v) => patch({ posX: v }, true)} onCommit={(v) => patch({ posX: v })} />
                </label>
                <label className="embed-editor_grad-pos-field"><span>Top</span>
                  <NumField value={center.y} unit="%" label="Position top" busy={busy}
                    onLive={(v) => patch({ posY: v }, true)} onCommit={(v) => patch({ posY: v })} />
                </label>
              </div>
            </div>
          </div>
          <div className="embed-editor_size-row">
            <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
            <RadialSizeControl value={g.size.trim() || 'farthest-corner'} busy={busy} onChange={(size) => patch({ size })} />
          </div>
        </>
      ) : g.type === 'linear' ? (
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
          <AngleControl angle={g.angle} busy={busy} onChange={(angle, live) => patch({ angle }, live)} />
        </div>
      ) : (
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
          <NumField
            value={g.from.replace(/deg$/i, '') || '0'}
            unit="deg"
            label="Gradient angle"
            busy={busy}
            onLive={(v) => patch({ from: v }, true)}
            onCommit={(v) => patch({ from: v })}
          />
        </div>
      )}

      {/* Stops bar. */}
      <div
        ref={barRef}
        className="embed-editor_grad-bar"
        style={{ ['--grad-image' as string]: stopsBarCss(stops) }}
        onClick={onBarClick}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
      >
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`embed-editor_grad-handle ${i === sel ? 'is-active' : ''}`}
            style={{ left: `${stopPercent(stops, i)}%`, ['--stop-color' as string]: s.color.trim() || 'transparent' }}
            disabled={busy}
            aria-label={`Stop ${i + 1} at ${stopPercent(stops, i)}%`}
            onClick={(e) => { e.stopPropagation(); setSelected(i) }}
            onDoubleClick={(e) => { e.stopPropagation(); removeStop(i) }}
            onPointerDown={onHandleDown(i)}
          />
        ))}
      </div>

      {/* Repeat toggle. */}
      <div className="embed-editor_size-row embed-editor_grad-repeat">
        <label className="embed-editor_grad-check">
          <input type="checkbox" checked={g.repeating} disabled={busy} onChange={(e) => patch({ repeating: e.target.checked })} />
          <span>Repeat</span>
        </label>
        <button type="button" className="embed-editor_icon-btn" disabled={busy} title="Reverse stops"
          aria-label="Reverse gradient stops"
          onClick={() => patchStops([...stops].reverse().map((s, i, arr) => ({ ...s, pos: s.pos.trim() ? `${100 - stopPercent(stops, stops.length - 1 - i)}%` : '' })))}>
          <RepeatIcon />
        </button>
      </div>

      {/* Selected stop: color + position. */}
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
        <div className="embed-editor_grad-stop">
          <ColorSwatch value={current.color} busy={busy} ariaLabel="Stop color" onChange={(c, live) => { editing.current = live; setStop(sel, { color: c }, live) }} />
          <input
            className="u-input embed-editor_grad-color"
            value={current.color}
            spellCheck={false}
            disabled={busy}
            aria-label="Stop color"
            onFocus={() => { editing.current = true }}
            onChange={(e) => setStop(sel, { color: e.target.value }, true)}
            onBlur={() => { editing.current = false; setStop(sel, { color: current.color }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          <NumField value={current.pos || `${Math.round(stopPercent(stops, sel))}%`} unit="%" label="Stop position" busy={busy}
            onLive={(v) => setStop(sel, { pos: v }, true)} onCommit={(v) => { setStop(sel, { pos: v }); sortStops(sel) }} />
        </div>
      </div>
    </div>
  )
}
