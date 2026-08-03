// Multi-layer `background` model. CSS backgrounds are parallel comma-separated
// lists — background-image holds the layers (index 0 = the TOP layer), and
// background-size / -position / -repeat / -attachment hold one entry per layer.
// background-color is a single value painted behind every layer. This module
// parses those longhands into an ordered layer list and serializes it back,
// splitting on TOP-LEVEL commas only (gradients / rgba() have inner commas).

export type LayerKind = 'image' | 'linear' | 'radial' | 'conic' | 'color' | 'other'

export type BgLayer = {
  /** The background-image value for this layer: `url(…)` or a `*-gradient(…)`. */
  image: string
  /** Per-layer longhands ('' = unset → the CSS initial value). */
  size: string
  position: string
  repeat: string
  attachment: string
}

export type BackgroundLonghands = {
  image: string
  size: string
  position: string
  repeat: string
  attachment: string
}

/** Split on commas that are NOT inside parentheses, brackets or quotes — so
 *  gradients, rgba(), clamp(), grid line names and quoted font families all
 *  survive intact. */
export function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

/** A "color overlay" is a solid-fill layer, expressed in CSS as a linear-gradient
 *  whose stops are all the SAME colour (Webflow's Color-overlay layer type). Returns
 *  that colour, or null when the value isn't a solid-colour gradient. */
export function colorOverlayOf(image: string): string | null {
  const match = image.trim().match(/^linear-gradient\((.*)\)$/is)
  if (!match) return null
  const parts = splitTopLevelCommas(match[1])
  if (!parts.length) return null
  const isDirection = (s: string) => /^to\s/i.test(s.trim()) || /^-?[\d.]+(deg|grad|rad|turn)$/i.test(s.trim())
  const stops = isDirection(parts[0]) ? parts.slice(1) : parts
  if (stops.length < 2) return null
  // Strip a trailing stop position (e.g. `#000 0%`, `red 10px`) to compare colours.
  const colours = stops.map((s) => s.trim().replace(/\s+-?[\d.]+(%|px|em|rem|vw|vh|vmin|vmax)?$/i, '').trim())
  const first = colours[0]
  return first && colours.every((c) => c === first) ? first : null
}

/** Build a color-overlay layer image from a single colour. Matches Webflow's
 *  canonical solid-overlay serialization (explicit 180deg + duplicated stop) so
 *  Webflow's own panel has the best chance of categorizing it as a Color layer. */
export function colorOverlayImage(color: string): string {
  const c = color.trim() || '#000000'
  return `linear-gradient(180deg, ${c}, ${c})`
}

/** Split on whitespace runs that are NOT inside parentheses, brackets or
 *  quotes. `clamp(4rem, 8vw, 6rem) 2rem` is two tokens, not five. */
export function splitTopLevelSpaces(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  const chars = [...value.trim()]
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && i + 1 < chars.length) { cur += chars[i + 1]; i += 1 }
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch }
    else if (ch === '(' || ch === '[') { depth += 1; cur += ch }
    else if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch }
    else if (/\s/.test(ch) && depth === 0) { if (cur) { parts.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

const REPEAT_KW = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'])
const ATTACH_KW = new Set(['scroll', 'fixed', 'local'])
const BOX_KW = new Set(['border-box', 'padding-box', 'content-box'])
const isImageToken = (t: string) => /^(url|(repeating-)?(linear|radial|conic)-gradient)\(/i.test(t) || t.toLowerCase() === 'none'
const isPositionToken = (t: string) => /^(left|right|top|bottom|center)$/i.test(t) || /^-?[\d.]+(px|%|em|rem|vw|vh|vmin|vmax|ch|fr)?$/i.test(t)

/** Parse a `background` shorthand into the five longhands + the (single) color.
 *  Order-tolerant per CSS; a `pos / size` group is split on the top-level slash.
 *  Longhands only some layer sets come back ''; color only from the last layer. */
export function splitBackgroundShorthand(bg: string): BackgroundLonghands & { color: string } {
  const layerStrs = splitTopLevelCommas(bg)
  const images: string[] = []
  const sizes: string[] = []
  const positions: string[] = []
  const repeats: string[] = []
  const attachments: string[] = []
  let color = ''
  layerStrs.forEach((layerStr, li) => {
    // Normalize `a / b` (with or without spaces around the slash) into tokens.
    const tokens = splitTopLevelSpaces(layerStr.replace(/\s*\/\s*/g, ' / '))
    let image = ''
    let repeat = ''
    let attachment = ''
    const posTokens: string[] = []
    const sizeTokens: string[] = []
    let afterSlash = false
    for (const t of tokens) {
      const lt = t.toLowerCase()
      if (t === '/') { afterSlash = true; continue }
      if (isImageToken(t)) { image = t; continue }
      if (REPEAT_KW.has(lt)) { repeat = repeat ? `${repeat} ${lt}` : lt; continue }
      if (ATTACH_KW.has(lt)) { attachment = lt; continue }
      if (BOX_KW.has(lt)) continue // origin / clip — not modeled here
      if (afterSlash) { sizeTokens.push(t); continue }
      if (isPositionToken(t)) { posTokens.push(t); continue }
      // A leftover (non-position) token in the LAST layer is the background-color
      // (covers named colours like `white` too, without a colour lookup table).
      if (li === layerStrs.length - 1) { color = t; continue }
      posTokens.push(t) // best effort for a stray token in a non-final layer
    }
    // A layer with no image is just the trailing colour — don't emit it as a layer.
    if (!image) {
      if (li === layerStrs.length - 1 && !color) color = posTokens.join(' ').trim()
      return
    }
    images.push(image || 'none')
    sizes.push(sizeTokens.join(' '))
    positions.push(posTokens.join(' '))
    repeats.push(repeat)
    attachments.push(attachment)
  })
  const join = (list: string[], initial: string) => (list.some((v) => v.trim()) ? list.map((v) => v.trim() || initial).join(', ') : '')
  return {
    image: images.join(', '),
    size: join(sizes, 'auto'),
    position: join(positions, '0% 0%'),
    repeat: join(repeats, 'repeat'),
    attachment: join(attachments, 'scroll'),
    color,
  }
}

/** Which kind of layer an image value is, from its function/keyword. */
export function layerKind(image: string): LayerKind {
  const v = image.trim().toLowerCase()
  if (v.startsWith('url(')) return 'image'
  if (colorOverlayOf(image) != null) return 'color'
  if (v.startsWith('linear-gradient') || v.startsWith('repeating-linear-gradient')) return 'linear'
  if (v.startsWith('radial-gradient') || v.startsWith('repeating-radial-gradient')) return 'radial'
  if (v.startsWith('conic-gradient') || v.startsWith('repeating-conic-gradient')) return 'conic'
  return 'other'
}

/** The file name inside a `url(…)`, or null when the value isn't a url(). */
export function urlFileName(image: string): string | null {
  const match = image.match(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/i)
  if (!match) return null
  const path = match[1].split('?')[0]
  const file = path.split(/[\\/]/).pop() ?? path
  return file || path
}

/** A short human label for a layer (Webflow-style). */
export function layerLabel(image: string): string {
  switch (layerKind(image)) {
    case 'image': return urlFileName(image) ?? 'Image'
    case 'color': return colorOverlayOf(image) ?? 'Color overlay'
    case 'linear': return 'Linear gradient'
    case 'radial': return 'Radial gradient'
    case 'conic': return 'Conic gradient'
    default: return image.trim() || 'Layer'
  }
}

/** Parse the five longhands into an ordered layer list (top layer first). */
export function parseLayers(props: BackgroundLonghands): BgLayer[] {
  const images = props.image.trim() ? splitTopLevelCommas(props.image) : []
  // `none` (the initial value, or an explicit reset) means there are no layers.
  const cleaned = images.filter((img) => img && img.toLowerCase() !== 'none')
  if (!cleaned.length) return []
  const sizes = props.size.trim() ? splitTopLevelCommas(props.size) : []
  const positions = props.position.trim() ? splitTopLevelCommas(props.position) : []
  const repeats = props.repeat.trim() ? splitTopLevelCommas(props.repeat) : []
  const attachments = props.attachment.trim() ? splitTopLevelCommas(props.attachment) : []
  return cleaned.map((image, i) => ({
    image,
    size: sizes[i] ?? '',
    position: positions[i] ?? '',
    repeat: repeats[i] ?? '',
    attachment: attachments[i] ?? '',
  }))
}

// CSS initial values used to pad a longhand list when only SOME layers set it
// (the list must stay index-aligned with background-image).
const INITIAL = { size: 'auto', position: '0% 0%', repeat: 'repeat', attachment: 'scroll' } as const

/** Serialize a layer list back to the five longhands. A longhand only every layer
 *  leaves unset comes back '' (→ clear the property); otherwise it's the full
 *  comma list, padding unset layers with the CSS initial so indexes line up. */
export function serializeLayers(layers: BgLayer[]): BackgroundLonghands {
  if (!layers.length) return { image: '', size: '', position: '', repeat: '', attachment: '' }
  const list = (key: 'size' | 'position' | 'repeat' | 'attachment'): string =>
    layers.some((l) => l[key].trim())
      ? layers.map((l) => l[key].trim() || INITIAL[key]).join(', ')
      : ''
  return {
    image: layers.map((l) => l.image.trim()).join(', '),
    size: list('size'),
    position: list('position'),
    repeat: list('repeat'),
    attachment: list('attachment'),
  }
}

/** A blank layer of the given kind, seeded with a sensible template. */
export function blankLayer(kind: LayerKind): BgLayer {
  const image =
    kind === 'linear' ? 'linear-gradient(180deg, #000000, #ffffff)'
    : kind === 'radial' ? 'radial-gradient(circle, #000000, #ffffff)'
    : kind === 'conic' ? 'conic-gradient(from 0deg, #000000, #ffffff)'
    : kind === 'color' ? colorOverlayImage('rgba(0, 0, 0, 0.5)')
    : 'url()'
  return { image, size: '', position: '', repeat: '', attachment: '' }
}
