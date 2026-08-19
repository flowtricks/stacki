// Parse / serialize a CSS gradient function into a structured model so the
// Backgrounds panel can offer Webflow's visual gradient editor (position grid,
// size presets, a draggable stops bar, a repeat toggle) instead of raw CSS text.
//
// Handles (repeating-)linear / radial / conic gradients. Anything it can't parse
// stays editable as raw text (the caller falls back), so this never has to be
// exhaustive — just faithful for the shapes Webflow emits.

import { splitTopLevelCommas, splitTopLevelSpaces } from './background'

export type GradientType = 'linear' | 'radial' | 'conic'

/** One color stop: a color plus an optional position (`''` = auto/unspecified). */
export type GradientStop = { color: string; pos: string }

export type Gradient = {
  type: GradientType
  repeating: boolean
  /** linear: `180deg` / `to bottom` (`''` = default top→bottom). */
  angle: string
  /** radial: `circle` | `ellipse` (`''` = ellipse, the CSS default). */
  shape: string
  /** radial: `closest-side` | `closest-corner` | `farthest-side` | `farthest-corner`
   *  or an explicit length/`%` (`''` = farthest-corner, the CSS default). */
  size: string
  /** conic: `from 45deg` angle value without the keyword (`''` = 0deg). */
  from: string
  /** radial/conic center — `''` treated as `50%` (center). */
  posX: string
  posY: string
  stops: GradientStop[]
}

const GRADIENT_RE = /^(repeating-)?(linear|radial|conic)-gradient\s*\(([\s\S]*)\)\s*$/i
const RADIAL_SIZE_KW = new Set(['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner'])
const isAngle = (t: string) => /^-?[\d.]+(deg|grad|rad|turn)$/i.test(t.trim())
const isLength = (t: string) => /^-?[\d.]+(px|%|em|rem|vw|vh|vmin|vmax|ch|fr)?$/i.test(t.trim())
const POS_KW: Record<string, string> = { left: '0%', right: '100%', top: '0%', bottom: '100%', center: '50%' }

/** Map a position keyword/length to a percentage string (best effort). */
function posValue(token: string): string {
  const t = token.trim().toLowerCase()
  return POS_KW[t] ?? token.trim()
}

/** Parse `x y` (or a single value → x, y=center) into { posX, posY }. */
function parseCenter(text: string): { posX: string; posY: string } {
  const toks = splitTopLevelSpaces(text)
  if (!toks.length) return { posX: '', posY: '' }
  if (toks.length === 1) {
    const v = posValue(toks[0])
    // A lone vertical keyword sets Y; anything else sets X (center the other axis).
    if (/^(top|bottom)$/i.test(toks[0])) return { posX: '50%', posY: v }
    return { posX: v, posY: '50%' }
  }
  return { posX: posValue(toks[0]), posY: posValue(toks[1]) }
}

/** Split one stop into color + optional trailing position (handles rgba()/color-mix). */
function parseStop(part: string): GradientStop {
  const toks = splitTopLevelSpaces(part)
  if (toks.length > 1 && isLength(toks[toks.length - 1])) {
    return { pos: toks.pop() as string, color: toks.join(' ') }
  }
  return { color: toks.join(' '), pos: '' }
}

/** Is the first comma-group a prelude (direction/shape/size/position) vs a color stop? */
function isPrelude(type: GradientType, part: string): boolean {
  const p = part.trim().toLowerCase()
  if (type === 'linear') return p.startsWith('to ') || isAngle(p)
  if (type === 'conic') return p.startsWith('from ') || p.startsWith('at ')
  // radial: shape / size keyword / explicit size / an `at <pos>`.
  //
  // EVERY token has to look like geometry, not just one of them. A colour stop
  // carries a position — `red 0%` — and `0%` on its own reads as a radial
  // size, so testing whether ANY token looked like geometry swallowed the
  // first stop as though it were a prelude. On a two-stop gradient that left
  // one stop, which is not a gradient, and the whole thing came back
  // unparseable: `radial-gradient(red 0%, blue 100%)` — ordinary, valid CSS —
  // could not be read by the editor at all.
  if (p.startsWith('circle') || p.startsWith('ellipse') || p.includes(' at ') || p.startsWith('at ')) {
    return true
  }
  if (RADIAL_SIZE_KW.has(p)) return true
  const tokens = splitTopLevelSpaces(p)
  return tokens.length > 0 && tokens.every((t) => RADIAL_SIZE_KW.has(t.toLowerCase()) || isLength(t))
}

export function parseGradient(image: string): Gradient | null {
  const m = GRADIENT_RE.exec(image.trim())
  if (!m) return null
  const type = m[2].toLowerCase() as GradientType
  const parts = splitTopLevelCommas(m[3]).filter((s) => s.length)
  if (!parts.length) return null

  const g: Gradient = { type, repeating: !!m[1], angle: '', shape: '', size: '', from: '', posX: '', posY: '', stops: [] }
  let rest = parts
  if (isPrelude(type, parts[0])) {
    parsePrelude(g, parts[0])
    rest = parts.slice(1)
  }
  g.stops = rest.map(parseStop).filter((s) => s.color)
  if (g.stops.length < 2) return null // not a usable gradient
  return g
}

function parsePrelude(g: Gradient, prelude: string) {
  const p = prelude.trim()
  if (g.type === 'linear') { g.angle = p; return }
  if (g.type === 'conic') {
    const at = p.split(/\bat\b/i)
    const fromPart = at[0].replace(/^from\s+/i, '').trim()
    if (fromPart) g.from = fromPart
    if (at[1]) { const c = parseCenter(at[1]); g.posX = c.posX; g.posY = c.posY }
    return
  }
  // radial: `<shape?> <size?> at <pos?>`
  const at = p.split(/\bat\b/i)
  for (const tok of splitTopLevelSpaces(at[0])) {
    const lt = tok.toLowerCase()
    if (lt === 'circle' || lt === 'ellipse') g.shape = lt
    else if (RADIAL_SIZE_KW.has(lt) || isLength(tok)) g.size = g.size ? `${g.size} ${tok}` : tok
  }
  if (at[1]) { const c = parseCenter(at[1]); g.posX = c.posX; g.posY = c.posY }
}

/** The effective center as percentages (defaults to 50%/50% = center). */
export function gradientCenter(g: Gradient): { x: string; y: string } {
  return { x: g.posX.trim() || '50%', y: g.posY.trim() || '50%' }
}

function radialPrelude(g: Gradient): string {
  const shapeSize = [g.shape.trim(), g.size.trim()].filter(Boolean).join(' ')
  const x = g.posX.trim()
  const y = g.posY.trim()
  // Emit `at x y` only when the center isn't the default center.
  const centered = (!x || x === '50%') && (!y || y === '50%')
  const at = centered ? '' : `at ${x || '50%'} ${y || '50%'}`
  return [shapeSize, at].filter(Boolean).join(' ')
}

function conicPrelude(g: Gradient): string {
  const from = g.from.trim() ? `from ${g.from.trim()}` : ''
  const x = g.posX.trim()
  const y = g.posY.trim()
  const centered = (!x || x === '50%') && (!y || y === '50%')
  const at = centered ? '' : `at ${x || '50%'} ${y || '50%'}`
  return [from, at].filter(Boolean).join(' ')
}

/**
 * A gradient of `type` with no colours and no geometry set.
 *
 * Used when switching a layer between gradient kinds: the stops carry over,
 * the geometry does not. An angle is a direction for a linear gradient and
 * means nothing to a radial one; a centre point is the other way round. So each
 * kind starts on its own CSS defaults — every field `''` — and the caller puts
 * the colours back.
 */
export function blankGradientOf(type: GradientType): Gradient {
  return {
    type,
    repeating: false,
    angle: '',
    shape: '',
    size: '',
    from: '',
    posX: '',
    posY: '',
    stops: [],
  }
}

export function serializeGradient(g: Gradient): string {
  const fn = `${g.repeating ? 'repeating-' : ''}${g.type}-gradient`
  const prelude =
    g.type === 'linear' ? g.angle.trim()
    : g.type === 'radial' ? radialPrelude(g)
    : conicPrelude(g)
  const stops = g.stops.map((s) => (s.pos.trim() ? `${s.color.trim()} ${s.pos.trim()}` : s.color.trim())).join(', ')
  return `${fn}(${prelude ? `${prelude}, ` : ''}${stops})`
}

/** A horizontal CSS gradient string previewing the stops (for the editor bar). */
export function stopsBarCss(stops: GradientStop[]): string {
  if (stops.length < 2) return 'transparent'
  const parts = stops.map((s, i) => {
    const pos = s.pos.trim() || `${Math.round((i / (stops.length - 1)) * 100)}%`
    return `${s.color.trim() || 'transparent'} ${pos}`
  })
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** A stop's numeric position (0–100), inferring evenly-spaced when unset. */
export function stopPercent(stops: GradientStop[], i: number): number {
  const raw = stops[i]?.pos.trim()
  const m = raw ? /^(-?[\d.]+)%$/.exec(raw) : null
  if (m) return Math.max(0, Math.min(100, parseFloat(m[1])))
  return stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0
}

// ── Angle in degrees (for the dial) ────────────────────────────────────────────

// A linear gradient's angle keyword → degrees (CSS: 0 = up, 90 = right, 180 = down),
// keyed by the side words sorted alphabetically so `to top right` == `to right top`.
const SIDE_DEG: Record<string, number> = {
  top: 0, right: 90, bottom: 180, left: 270,
  'right top': 45, 'bottom right': 135, 'bottom left': 225, 'left top': 315,
}

/** A linear gradient's direction in degrees (defaults to 180 = top→bottom, per CSS). */
export function angleToDegrees(angle: string): number {
  const t = angle.trim().toLowerCase()
  if (!t) return 180
  const m = t.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/)
  if (m) {
    const n = parseFloat(m[1])
    switch (m[2]) {
      case 'turn': return n * 360
      case 'grad': return n * 0.9
      case 'rad': return (n * 180) / Math.PI
      default: return n
    }
  }
  if (t.startsWith('to ')) {
    const sides = t.slice(3).trim().split(/\s+/).filter(Boolean).sort().join(' ')
    return SIDE_DEG[sides] ?? 180
  }
  return 180
}

/** Degrees → a normalized `<n>deg` string (0–359). */
export function degreesToAngle(deg: number): string {
  return `${((Math.round(deg) % 360) + 360) % 360}deg`
}

// ── Colour interpolation (inserting a stop between two others) ──────────────────

type RGBA = [number, number, number, number]

/** Parse a hex or rgb()/rgba() colour to RGBA; null for names/var()/hsl (no mix). */
function parseColor(input: string): RGBA | null {
  const c = input.trim().toLowerCase()
  const hex = c.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('')
    if (h.length === 6) h += 'ff'
    if (h.length !== 8) return null
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255]
  }
  const rgb = c.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const p = rgb[1].split(',').map((s) => parseFloat(s.trim()))
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null
    return [p[0], p[1], p[2], p[3] == null || Number.isNaN(p[3]) ? 1 : p[3]]
  }
  return null
}

function formatColor([r, g, b, a]: RGBA): string {
  const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  if (a >= 1) return `#${hx(r)}${hx(g)}${hx(b)}`
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 100) / 100})`
}

/** Mix two colours (t in 0–1). Falls back to `a` when either can't be parsed. */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return a
  return formatColor([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t, ca[3] + (cb[3] - ca[3]) * t])
}

/** The interpolated colour of the ramp at percentage `p` (0–100) — for a new stop. */
export function colorAt(stops: GradientStop[], p: number): string {
  if (!stops.length) return 'transparent'
  const last = stops.length - 1
  const pct = stops.map((_, i) => stopPercent(stops, i))
  if (p <= pct[0]) return stops[0].color
  if (p >= pct[last]) return stops[last].color
  for (let i = 0; i < last; i += 1) {
    if (p >= pct[i] && p <= pct[i + 1]) {
      const span = pct[i + 1] - pct[i]
      return mixColors(stops[i].color, stops[i + 1].color, span === 0 ? 0 : (p - pct[i]) / span)
    }
  }
  return stops[last].color
}
