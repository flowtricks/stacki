// Color parsing + conversion for the color picker. Parsing leans on a shared
// canvas 2d context (the browser normalizes ANY CSS color — named, hex, rgb(),
// hsl(), transparent — to rgb/rgba), so we never ship a 148-name table.

export type RGBA = { r: number; g: number; b: number; a: number } // r,g,b 0–255, a 0–1
export type HSVA = { h: number; s: number; v: number; a: number } // h 0–360, s,v 0–100, a 0–1

let ctx: CanvasRenderingContext2D | null | undefined

function canvasCtx(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  try {
    ctx = document.createElement('canvas').getContext('2d')
  } catch {
    ctx = null
  }
  return ctx
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const round = (n: number) => Math.round(n)

/** Parse any CSS color string to RGBA, or null when it isn't a valid color. */
export function parseColor(input: string): RGBA | null {
  const value = input.trim()
  if (!value) return null
  const c = canvasCtx()
  if (!c) return parseColorFallback(value)
  // Invalid values leave fillStyle unchanged, so probe with two different sentinels
  // — if the readback matches neither-changed, the input was rejected.
  c.fillStyle = '#000000'
  c.fillStyle = value
  const a = c.fillStyle
  c.fillStyle = '#ffffff'
  c.fillStyle = value
  const b = c.fillStyle
  if (a !== b) return null
  return parseNormalized(a)
}

/** Parse the browser-normalized output (`#rrggbb` or `rgb[a](…)`). */
function parseNormalized(s: string): RGBA | null {
  if (s[0] === '#') {
    const hex = s.slice(1)
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 }
  }
  const m = /rgba?\(([^)]+)\)/i.exec(s)
  if (!m) return null
  const parts = m[1].split(',').map((p) => p.trim())
  return { r: round(parseFloat(parts[0])), g: round(parseFloat(parts[1])), b: round(parseFloat(parts[2])), a: parts[3] != null ? clamp(parseFloat(parts[3]), 0, 1) : 1 }
}

// A minimal fallback for non-DOM contexts (tests) — hex + rgb/rgba only.
function parseColorFallback(value: string): RGBA | null {
  // The one keyword worth knowing without a canvas: it is what an unset colour
  // is written as all over this panel, and a browser normalizes it to exactly
  // this. Left out, the fallback answers "not a colour" for the value the panel
  // shows most often.
  if (value.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  return parseNormalized(value)
}

export function rgbaToHsva({ r, g, b, a }: RGBA): HSVA {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min
  let h = 0
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h: round(h), s: round(max === 0 ? 0 : (d / max) * 100), v: round(max * 100), a }
}

export function hsvaToRgba({ h, s, v, a }: HSVA): RGBA {
  const sn = s / 100, vn = v / 100
  const c = vn * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = vn - c
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: round((r1 + m) * 255), g: round((g1 + m) * 255), b: round((b1 + m) * 255), a }
}

const hex2 = (n: number) => clamp(round(n), 0, 255).toString(16).padStart(2, '0')

/** `#rrggbb`, or `#rrggbbaa` when alpha < 1. */
export function formatHex({ r, g, b, a }: RGBA): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return a < 1 ? `${base}${hex2(a * 255)}` : base
}

/** `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
export function formatRgba({ r, g, b, a }: RGBA): string {
  const rn = round(r), gn = round(g), bn = round(b)
  return a < 1 ? `rgba(${rn}, ${gn}, ${bn}, ${round(a * 100) / 100})` : `rgb(${rn}, ${gn}, ${bn})`
}

// The picker's four notations. `hsb` (= hue/sat/brightness, the HSVA the picker
// stores) has no CSS form, so it emits rgb — it's an input representation only.
export type ColorMode = 'hex' | 'rgb' | 'hsl' | 'hsb'

export function formatColor(c: RGBA, mode: ColorMode): string {
  if (mode === 'rgb' || mode === 'hsb') return formatRgba(c)
  if (mode === 'hsl') return formatHsla(c)
  return formatHex(c)
}

/** RGBA → HSL channels (h 0–360, s/l 0–100). */
export function rgbaToHsl({ r, g, b }: RGBA): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h: round(h), s: round(s * 100), l: round(l * 100) }
}

function formatHsla(c: RGBA): string {
  const { h, s, l } = rgbaToHsl(c)
  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${round(c.a * 100) / 100})` : `hsl(${h}, ${s}%, ${l}%)`
}

/** Detect the notation a color string is written in (to keep output style stable). */
export function colorMode(input: string): ColorMode {
  const s = input.trim().toLowerCase()
  if (s.startsWith('hsl')) return 'hsl'
  if (s.startsWith('rgb')) return 'rgb'
  return 'hex'
}
