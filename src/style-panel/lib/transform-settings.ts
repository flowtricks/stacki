// The settings behind the transform list: where a transform pivots, whether the
// back of a turned element shows, and the two perspectives.
//
// The two perspectives are different CSS entirely, which is the thing worth
// knowing before reading any of this:
//
//   Children perspective — the `perspective` PROPERTY. Depth for the element's
//     CHILDREN, so a row of cards can turn as if seen from one viewpoint.
//   Self perspective — a `perspective()` FUNCTION inside the element's OWN
//     `transform`. Depth for this element alone.
//
// The function is the one with a trap in it. It is legal anywhere in the list,
// so nothing complains, but the result depends on WHERE — `perspective(500px)
// rotateY(45deg)` and `rotateY(45deg) perspective(500px)` compute to different
// matrices (checked in Chromium, see test/transform-settings.js). It has to lead
// the list, and it has to survive every edit made to the layers after it —
// parseTransforms drops any function it does not recognise, so a self
// perspective left in the value would disappear the next time a layer moved.
// Hence it is lifted out before the layers are parsed and put back in front on
// the way out.

/** An origin as the pad and its two fields hold it: x, y, and a z we only carry. */
export type Origin = { x: string; y: string; z: string }

const X_WORD: Record<string, string> = { left: '0%', center: '50%', right: '100%' }
const Y_WORD: Record<string, string> = { top: '0%', center: '50%', bottom: '100%' }

/** The default both origin properties resolve to when nothing is declared. */
export const CENTER: Origin = { x: '50%', y: '50%', z: '' }

// Top-level splitting: an origin can hold a calc() or a var() with spaces inside.
function splitSpaces(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && /\s/.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * A `transform-origin` / `perspective-origin` value as x, y (and any z).
 *
 * Keywords become percentages so the two fields always have a number to show —
 * `left top` and `0% 0%` are the same corner, and the pad has to light up for
 * both. An empty or unreadable value is the centre, which is what both
 * properties do by default.
 */
export function parseOrigin(value: string): Origin {
  const parts = splitSpaces(String(value ?? '').trim())
  if (!parts.length) return { ...CENTER }
  const lower = parts.map((p) => p.toLowerCase())

  if (parts.length === 1) {
    const w = lower[0]
    if (w in Y_WORD && !(w in X_WORD)) return { x: '50%', y: Y_WORD[w], z: '' }
    if (w in X_WORD) return { x: X_WORD[w], y: '50%', z: '' }
    return { x: parts[0], y: '50%', z: '' }
  }

  // Two keywords may be written either way round (`top left` is a corner, not a
  // nonsense x of `top`), so the y-only words decide the order.
  const swapped = (lower[0] in Y_WORD && !(lower[0] in X_WORD)) || (lower[1] in X_WORD && !(lower[1] in Y_WORD))
  const rawX = swapped ? parts[1] : parts[0]
  const rawY = swapped ? parts[0] : parts[1]
  return {
    x: X_WORD[rawX.toLowerCase()] ?? rawX,
    y: Y_WORD[rawY.toLowerCase()] ?? rawY,
    z: parts[2] ?? '',
  }
}

/** An origin back to a value ('' when it is the plain default). */
export function serializeOrigin(o: Origin): string {
  const x = (o.x || '').trim() || '50%'
  const y = (o.y || '').trim() || '50%'
  const z = (o.z || '').trim()
  if (!z && x === '50%' && y === '50%') return ''
  return z ? `${x} ${y} ${z}` : `${x} ${y}`
}

/** The nine positions of the pad, in reading order (top-left first). */
export const ORIGIN_PRESETS: ReadonlyArray<{ x: string; y: string; label: string }> = [
  { x: '0%', y: '0%', label: 'Top left' },
  { x: '50%', y: '0%', label: 'Top' },
  { x: '100%', y: '0%', label: 'Top right' },
  { x: '0%', y: '50%', label: 'Left' },
  { x: '50%', y: '50%', label: 'Center' },
  { x: '100%', y: '50%', label: 'Right' },
  { x: '0%', y: '100%', label: 'Bottom left' },
  { x: '50%', y: '100%', label: 'Bottom' },
  { x: '100%', y: '100%', label: 'Bottom right' },
]

// `0` and `0%` are the same place, and a field showing `0` should still light up
// the corner. Only the three pad positions need comparing, so this is enough.
const samePos = (a: string, b: string): boolean => {
  const n = (v: string) => v.trim().toLowerCase().replace(/^0(?:px|%|em|rem)$/, '0')
  return n(a) === n(b)
}

/** Which pad dot an origin sits on, or -1 when it is somewhere in between. */
export const originPreset = (o: Origin): number =>
  ORIGIN_PRESETS.findIndex((p) => samePos(p.x, o.x) && samePos(p.y, o.y))

/**
 * Lift a `perspective()` out of a transform value.
 *
 * Returns the distance and the value without it, so the rest can go through the
 * layer parser — which would otherwise drop the function on the floor.
 */
export function takeSelfPerspective(value: string): { distance: string; rest: string } {
  const text = String(value ?? '')
  let i = 0
  let depth = 0
  while (i < text.length) {
    // Skip comments whole: a hidden layer's text is not part of the list.
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 2
      continue
    }
    const ch = text[i]
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth--; i++; continue }
    if (depth === 0 && /[a-z]/i.test(ch)) {
      const at = /^perspective\s*\(/i.exec(text.slice(i))
      // A name boundary, so `my-perspective(…)` is left alone.
      if (at && (i === 0 || !/[\w-]/.test(text[i - 1]))) {
        let j = i + at[0].length
        let d = 1
        while (j < text.length && d > 0) {
          if (text[j] === '(') d++
          else if (text[j] === ')') d--
          j++
        }
        const distance = text.slice(i + at[0].length, j - 1).trim()
        const rest = `${text.slice(0, i)} ${text.slice(j)}`.replace(/\s+/g, ' ').trim()
        return { distance, rest }
      }
      while (i < text.length && /[\w-]/.test(text[i])) i++
      continue
    }
    i++
  }
  return { distance: '', rest: text.trim() }
}

/** Put a `perspective()` back at the front of a transform value. */
export function withSelfPerspective(rest: string, distance: string): string {
  const d = (distance || '').trim()
  const body = (rest || '').trim()
  // No distance, or a zero one: there is nothing to write. `perspective(0)` is
  // not a smaller perspective, it is an invalid one.
  if (!d || /^0(?:[a-z]*|%)$/i.test(d)) return body
  // `none` is the placeholder written when every layer is hidden (see
  // lib/hideable.ts) to keep the declaration from being empty. A perspective()
  // is itself a value, so the placeholder is no longer needed — and
  // `perspective(500px) none` is not a valid transform, which would drop the
  // declaration and every hidden layer's comment with it.
  const layers = body.replace(/^none\b\s*/i, '')
  return layers ? `perspective(${d}) ${layers}` : `perspective(${d})`
}
