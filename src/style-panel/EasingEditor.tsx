import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { easingToBezier, bezierToEasing, isEasing } from './lib/transition'
import VariableConnect from './VariableConnect'

// A cubic-bezier easing editor (Webflow-style): preset curves on the left, a large
// draggable curve on the right. Dragging either control point (or picking a preset)
// updates the timing-function; the curve maps the CSS bezier onto a 0→1 grid with
// progress increasing upward, so control points may overshoot above/below the box.

type Bezier = [number, number, number, number]

const PRESETS: ReadonlyArray<{ heading: string; items: ReadonlyArray<{ label: string; b: Bezier }> }> = [
  { heading: 'Default', items: [
    { label: 'Linear', b: [0, 0, 1, 1] }, { label: 'Ease', b: [0.25, 0.1, 0.25, 1] },
    { label: 'Ease In Out', b: [0.42, 0, 0.58, 1] },
  ] },
  { heading: 'Ease In', items: [
    { label: 'Sine', b: [0.12, 0, 0.39, 0] }, { label: 'Quad', b: [0.11, 0, 0.5, 0] }, { label: 'Cubic', b: [0.32, 0, 0.67, 0] },
    { label: 'Quart', b: [0.5, 0, 0.75, 0] }, { label: 'Quint', b: [0.64, 0, 0.78, 0] }, { label: 'Expo', b: [0.7, 0, 0.84, 0] },
    { label: 'Circ', b: [0.55, 0, 1, 0.45] }, { label: 'Back', b: [0.36, 0, 0.66, -0.56] },
  ] },
  { heading: 'Ease Out', items: [
    { label: 'Sine', b: [0.61, 1, 0.88, 1] }, { label: 'Quad', b: [0.5, 1, 0.89, 1] }, { label: 'Cubic', b: [0.33, 1, 0.68, 1] },
    { label: 'Quart', b: [0.25, 1, 0.5, 1] }, { label: 'Quint', b: [0.22, 1, 0.36, 1] }, { label: 'Expo', b: [0.16, 1, 0.3, 1] },
    { label: 'Circ', b: [0, 0.55, 0.45, 1] }, { label: 'Back', b: [0.34, 1.56, 0.64, 1] },
  ] },
  { heading: 'Ease In Out', items: [
    { label: 'Sine', b: [0.37, 0, 0.63, 1] }, { label: 'Quad', b: [0.45, 0, 0.55, 1] }, { label: 'Cubic', b: [0.65, 0, 0.35, 1] },
    { label: 'Quart', b: [0.76, 0, 0.24, 1] }, { label: 'Quint', b: [0.83, 0, 0.17, 1] }, { label: 'Expo', b: [0.87, 0, 0.13, 1] },
    { label: 'Circ', b: [0.85, 0, 0.15, 1] }, { label: 'Back', b: [0.68, -0.6, 0.32, 1.6] },
  ] },
]

// Where a framed modal actually goes. The caller passes the box of the panel it
// belongs over, and that box is trusted only as far as the window: a panel
// wider than the viewport (or one measured while the layout was mid-change)
// would otherwise put the modal partly or wholly off-screen, and take the app's
// layout with it — an absolutely positioned box hanging past the right edge
// gives the document something to scroll.
const EDGE = 8
// Wide enough for the curve (280px) and a row of preset thumbnails (8 x 46 plus
// gaps), and no wider: filling the panel made a dialog the size of the sheet it
// was opened over.
const IDEAL_WIDTH = 480
function framedStyle(frame: { left: number; width: number }): { left: number; width: number } {
  const room = (typeof window === 'undefined' ? 0 : window.innerWidth) || frame.width || IDEAL_WIDTH
  const panel = frame.width || room
  const width = Math.max(320, Math.min(IDEAL_WIDTH, panel - EDGE * 2, room - EDGE * 2))
  // Centred in the panel it belongs to, then kept inside the window.
  const centred = (frame.left || 0) + (panel - width) / 2
  const left = Math.max(EDGE, Math.min(centred, room - width - EDGE))
  return { left, width }
}

const bezEq = (a: Bezier, b: Bezier) => a.every((n, i) => Math.abs(n - b[i]) < 0.005)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
// One coordinate of the unit cubic-bezier (0,0)->(1,1) at parameter s.
const bezAt = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3
// The eased PROGRESS (output) at input time t: solve x(s)=t for the parameter s, then
// read y(s). This is what makes the playback follow the ease — the parameter s is NOT
// time, so tracing the curve by s alone moves at the wrong (uniform) rate.
function easeProgress(t: number, x1: number, y1: number, x2: number, y2: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  let lo = 0, hi = 1, s = t
  for (let i = 0; i < 24; i += 1) {
    const x = bezAt(s, x1, x2)
    if (Math.abs(x - t) < 1e-4) break
    if (x < t) lo = s; else hi = s
    s = (lo + hi) / 2
  }
  return bezAt(s, y1, y2)
}
// The matched preset's name ("Ease", "Ease In Sine"), else "Custom".
function presetName(b: Bezier): string {
  for (const g of PRESETS) for (const item of g.items) if (bezEq(item.b, b)) return g.heading === 'Default' ? item.label : `${g.heading} ${item.label}`
  return 'Custom'
}
const GearIcon = () => (<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" /><path d="M8 1.5v1.5M8 13v1.5M2.4 4.6l1.3.75M12.3 10.65l1.3.75M2.4 11.4l1.3-.75M12.3 5.35l1.3-.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>)
const PlayIcon = () => (<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" /><path d="M6.6 5.6l4 2.4-4 2.4z" fill="currentColor" /></svg>)
const PauseIcon = () => (<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" /><path d="M6.4 5.5v5M9.6 5.5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>)

// A small preview curve for a preset button (unit bezier drawn in a 24×24 box).
/** The curve itself, at glyph size: a preset's thumbnail here, and the icon on
 *  the button that opens this editor from the variables sheet. */
export function MiniCurve({ b }: { b: Bezier }) {
  const S = 24
  const p = (x: number, y: number) => `${(x * S).toFixed(1)} ${(S - y * S).toFixed(1)}`
  return (
    <svg viewBox={`-3 -8 ${S + 6} ${S + 16}`} className="embed-editor_ease-mini" aria-hidden="true">
      <path d={`M ${p(0, 0)} C ${p(b[0], b[1])} ${p(b[2], b[3])} ${p(1, 1)}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function BezierEditor({ value, onChange, playT }: { value: Bezier; onChange: (b: Bezier) => void; playT: number | null }) {
  const S = 280
  const svgRef = useRef<SVGSVGElement>(null)
  const areaRef = useRef<SVGRectElement>(null)
  const [drag, setDrag] = useState<0 | 1 | null>(null)
  const sx = (x: number) => x * S
  const sy = (y: number) => S - y * S
  // The play point: x is linear elapsed time; y is the EASED progress at that time
  // (so the dot rides the curve and the right-edge playhead slides up at the eased
  // rate, not uniformly).
  const pd = playT != null ? { x: sx(playT), y: sy(easeProgress(playT, value[0], value[1], value[2], value[3])) } : null

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag == null) return
    const rect = areaRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const y = clamp(1 - (event.clientY - rect.top) / rect.height, -1, 2)
    const next: Bezier = [...value]
    next[drag * 2] = Math.round(x * 100) / 100
    next[drag * 2 + 1] = Math.round(y * 100) / 100
    onChange(next)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`-58 -90 ${S + 100} ${S + 210}`}
      className="embed-editor_ease-curve"
      onPointerMove={move}
      onPointerUp={() => setDrag(null)}
    >
      <rect ref={areaRef} x="0" y="0" width={S} height={S} className="embed-editor_ease-grid" />
      <text transform={`translate(-34 ${S / 2}) rotate(-90)`} textAnchor="middle" className="embed-editor_ease-axis">PROGRESS</text>
      <text x={S / 2} y={S + 42} textAnchor="middle" className="embed-editor_ease-axis">TIME</text>
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <g key={i} className="embed-editor_ease-gridline">
          <line x1={(S / 8) * i} y1="0" x2={(S / 8) * i} y2={S} />
          <line x1="0" y1={(S / 8) * i} x2={S} y2={(S / 8) * i} />
        </g>
      ))}
      {/* Handle guide lines from the endpoints to the control points. */}
      <line x1={sx(0)} y1={sy(0)} x2={sx(value[0])} y2={sy(value[1])} className="embed-editor_ease-handle-line" />
      <line x1={sx(1)} y1={sy(1)} x2={sx(value[2])} y2={sy(value[3])} className="embed-editor_ease-handle-line" />
      {/* The easing curve. */}
      <path d={`M ${sx(0)} ${sy(0)} C ${sx(value[0])} ${sy(value[1])} ${sx(value[2])} ${sy(value[3])} ${sx(1)} ${sy(1)}`} className="embed-editor_ease-path" />
      {/* Playhead on the right edge — slides up with the current progress. */}
      {pd ? <polygon points={`${S},${pd.y} ${S + 9},${pd.y - 9} ${S + 27},${pd.y - 9} ${S + 27},${pd.y + 9} ${S + 9},${pd.y + 9}`} className="embed-editor_ease-playhead" /> : null}
      {/* Play-preview dot tracing the curve. */}
      {pd ? <circle cx={pd.x} cy={pd.y} r="6" className="embed-editor_ease-play-dot" /> : null}
      {/* Draggable control points. */}
      {([0, 1] as const).map((i) => (
        <circle
          key={i}
          cx={sx(value[i * 2])}
          cy={sy(value[i * 2 + 1])}
          r="7"
          className="embed-editor_ease-handle"
          onPointerDown={(e) => { e.preventDefault(); setDrag(i); svgRef.current?.setPointerCapture(e.pointerId) }}
        />
      ))}
    </svg>
  )
}

export default function EasingEditor({ value, onClose, onChange, frame }: {
  value: string
  onClose: () => void
  onChange: (timing: string) => void
  /** Where to put the modal, when it belongs over one panel rather than the
   *  window. The style panel opens it full width (its own panel IS the width);
   *  the variables sheet passes its own box so the editor covers the sheet it
   *  was opened from instead of the panel beside it. */
  frame?: { left: number; width: number } | null
}) {
  const [bezier, setBezier] = useState<Bezier>(() => easingToBezier(value))
  // What is being typed into the value field, until it is committed. Null while
  // the field simply shows the curve.
  const [draft, setDraft] = useState<string | null>(null)
  const [playT, setPlayT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const playRaf = useRef<number | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => () => { if (playRaf.current != null) cancelAnimationFrame(playRaf.current) }, [])
  const apply = (b: Bezier) => { setDraft(null); setBezier(b); onChange(bezierToEasing(b)) }
  /** Take what was typed, if it is a curve this editor can show. */
  const commitText = () => {
    const text = (draft ?? '').trim()
    setDraft(null)
    if (!text || !isEasing(text)) return
    apply(easingToBezier(text))
  }
  // Preview: the playhead + dot trace the easing. It LOOPS — play → brief hold → restart
  // — until paused (matching Webflow); the button toggles play/pause.
  const stopPlay = () => {
    if (playRaf.current != null) { cancelAnimationFrame(playRaf.current); playRaf.current = null }
    setPlaying(false); setPlayT(null)
  }
  const startPlay = () => {
    setPlaying(true)
    const DUR = 1200, HOLD = 350
    let start = performance.now()
    const step = (now: number) => {
      const e = now - start
      if (e < DUR) setPlayT(e / DUR)
      else if (e < DUR + HOLD) setPlayT(1)
      else { start = now; setPlayT(0) }
      playRaf.current = requestAnimationFrame(step)
    }
    playRaf.current = requestAnimationFrame(step)
  }
  const togglePlay = () => { if (playing) stopPlay(); else startPlay() }

  return createPortal(
    <div
      className={`embed-editor_bg-modal-backdrop embed-editor_ease-backdrop${frame ? ' is-framed' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className={`embed-editor_ease-modal u-surface-surface${frame ? ' is-framed' : ''}`}
        style={frame ? framedStyle(frame) : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Easing editor"
      >
        <header className="embed-editor_ease-head">
          <span className="embed-editor_ease-title"><GearIcon /> Easing Editor</span>
          <button type="button" className="embed-editor_icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="embed-editor_ease-body">
          <div className="embed-editor_ease-main">
            <div className="embed-editor_ease-main-head">
              <button type="button" className={`embed-editor_ease-play ${playing ? 'is-playing' : ''}`} onClick={togglePlay} aria-label={playing ? 'Pause preview' : 'Preview easing'}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
              <span className="embed-editor_ease-name">{presetName(bezier)}</span>
            </div>
            <BezierEditor value={bezier} onChange={apply} playT={playT} />
            {/* The value as text, editable: the same code field the variables
                sheet uses, so it is coloured as you read it and a curve can be
                typed or pasted rather than only dragged. A value that is not a
                curve the editor can show (a steps(), a half-typed one) reverts
                on commit — the curve above it is the source of truth. */}
            <div className="embed-editor_ease-value">
              <VariableConnect
                className="is-fill"
                code
                prop="transition-timing-function"
                ariaLabel="Timing function"
                onPick={(binding) => setDraft(binding)}
              >
                <input
                  className="u-input embed-editor_ease-input"
                  value={draft ?? bezierToEasing(bezier)}
                  spellCheck={false}
                  aria-label="Timing function"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitText()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitText() }
                    if (e.key === 'Escape') { e.preventDefault(); setDraft(null) }
                  }}
                />
              </VariableConnect>
            </div>
          </div>
          <div className="embed-editor_ease-presets">
            {PRESETS.map((group) => (
              <div key={group.heading} className="embed-editor_ease-group">
                <h4 className="embed-editor_ease-group-title">{group.heading}</h4>
                <div className="embed-editor_ease-grid-presets">
                  {group.items.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`embed-editor_ease-preset ${bezEq(preset.b, bezier) ? 'is-active' : ''}`}
                      title={`${group.heading} ${preset.label}`}
                      onClick={() => apply(preset.b)}
                    >
                      <MiniCurve b={preset.b} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
