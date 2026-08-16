// The `transition` property is a comma-separated list of transitions, each
// `<property> <duration> <timing-function> <delay>` (property first, the two times
// in order). We parse it into an ordered list (index 0 = first) and serialize back,
// splitting on TOP-LEVEL commas/spaces so cubic-bezier()/steps() survive.

import { splitTopLevelCommas, splitTopLevelSpaces } from './background'

export type Transition = { property: string; duration: string; timing: string; delay: string }

export type TransitionProp = { value: string; label: string }

// Webflow's grouped Type dropdown — label shown, CSS property written.
export const TRANSITION_GROUPS: ReadonlyArray<{ heading: string; items: ReadonlyArray<TransitionProp> }> = [
  { heading: 'Common', items: [
    { value: 'opacity', label: 'Opacity' }, { value: 'margin', label: 'Margin' }, { value: 'padding', label: 'Padding' },
    { value: 'border', label: 'Border' }, { value: 'transform', label: 'Transform' }, { value: 'filter', label: 'Filter' }, { value: 'flex', label: 'Flex' },
  ] },
  { heading: 'Background', items: [
    { value: 'background-color', label: 'Background Color' }, { value: 'background-position', label: 'Background Position' },
    { value: 'text-shadow', label: 'Text Shadow' }, { value: 'box-shadow', label: 'Box Shadow' },
  ] },
  { heading: 'Size', items: [
    { value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'max-height', label: 'Max Height' },
    { value: 'max-width', label: 'Max Width' }, { value: 'min-height', label: 'Min Height' }, { value: 'min-width', label: 'Min Width' },
  ] },
  { heading: 'Borders', items: [
    { value: 'border-radius', label: 'Border Radius' }, { value: 'border-color', label: 'Border Color' }, { value: 'border-width', label: 'Border Width' },
  ] },
  { heading: 'Typography', items: [
    { value: 'color', label: 'Font Color' }, { value: 'font-size', label: 'Font Size' }, { value: 'line-height', label: 'Line Height' },
    { value: 'letter-spacing', label: 'Letter Spacing' }, { value: 'text-indent', label: 'Text Indent' }, { value: 'word-spacing', label: 'Word Spacing' },
    { value: 'font-variation-settings', label: 'Font Variations' }, { value: '-webkit-text-stroke-color', label: 'Text Stroke Color' },
    { value: 'text-underline-offset', label: 'Text Underline Offset' }, { value: 'text-decoration-color', label: 'Text Decoration Color' },
  ] },
  { heading: 'Position', items: [
    { value: 'top', label: 'Top' }, { value: 'left', label: 'Left' }, { value: 'bottom', label: 'Bottom' }, { value: 'right', label: 'Right' }, { value: 'z-index', label: 'z-Index' },
  ] },
  { heading: 'Margin', items: [
    { value: 'margin-bottom', label: 'Margin Bottom' }, { value: 'margin-left', label: 'Margin Left' }, { value: 'margin-right', label: 'Margin Right' }, { value: 'margin-top', label: 'Margin Top' },
  ] },
  { heading: 'Padding', items: [
    { value: 'padding-bottom', label: 'Padding Bottom' }, { value: 'padding-left', label: 'Padding Left' }, { value: 'padding-right', label: 'Padding Right' }, { value: 'padding-top', label: 'Padding Top' },
  ] },
  { heading: 'Flex', items: [
    { value: 'flex-grow', label: 'Flex Grow' }, { value: 'flex-shrink', label: 'Flex Shrink' }, { value: 'flex-basis', label: 'Flex Basis' },
  ] },
  { heading: 'Advanced', items: [{ value: 'all', label: 'All Properties' }] },
]

const PROP_LABEL = new Map(TRANSITION_GROUPS.flatMap((g) => g.items).map((i) => [i.value, i.label]))
export function transitionPropLabel(prop: string): string {
  return PROP_LABEL.get(prop.trim().toLowerCase()) ?? prop.trim()
}

const TIMING_KEYWORDS = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'])
function isTiming(token: string): boolean {
  const v = token.trim().toLowerCase()
  return TIMING_KEYWORDS.has(v) || v.startsWith('cubic-bezier(') || v.startsWith('steps(')
}
function isTime(token: string): boolean {
  return /^-?[\d.]+m?s$/i.test(token.trim())
}

/** Parse a `transition` value into an ordered list ('' / 'none' → empty).
 *  Positional (matching our serialize order property → duration → timing → delay) so
 *  that typed keywords/var() survive in the duration and easing slots: a bare `unset`
 *  or `var(--x)` isn't a recognized <time> or <easing>, so the old token-role scan
 *  dropped it — here we key off position instead. */
export function parseTransitions(value: string): Transition[] {
  const v = value.trim()
  if (!v || v.toLowerCase() === 'none') return []
  return splitTopLevelCommas(v).filter(Boolean).map((part) => {
    const tokens = splitTopLevelSpaces(part).map((t) => t.trim()).filter(Boolean)
    // A leading token that's neither a time nor an easing is the property. Our own
    // output always leads with it; external CSS may omit it (defaults to `all`).
    let property = 'all'
    let rest = tokens
    if (tokens.length && !isTime(tokens[0]) && !isTiming(tokens[0])) { property = tokens[0]; rest = tokens.slice(1) }
    // Next comes the duration — a <time>, or a typed keyword/var() we keep verbatim.
    // (An easing keyword here means the duration was omitted.) After the duration, a
    // <time> is the delay and anything else is the easing.
    let duration = '0s'
    if (rest.length && !isTiming(rest[0])) { duration = rest[0]; rest = rest.slice(1) }
    let timing = ''
    let delay = ''
    for (const t of rest) { if (isTime(t)) delay = t; else timing = t }
    return { property, duration, delay, timing }
  })
}

/** Serialize a transition list back to a `transition` value ('' when empty). */
export function serializeTransitions(list: Transition[]): string {
  if (!list.length) return ''
  return list
    .map((t) => [t.property || 'all', t.duration || '0s', t.timing, t.delay].filter((p) => p && p.trim()).join(' '))
    .join(', ')
}

export function blankTransition(): Transition {
  return { property: 'opacity', duration: '200ms', timing: 'ease', delay: '' }
}

/** A collapsed-row label ("Opacity: 200ms"). */
export function transitionLabel(t: Transition): string {
  return `${transitionPropLabel(t.property)}: ${t.duration || '0s'}`
}

// ─────────────────────────── Easing ───────────────────────────

/** The four cubic-bezier control values for a timing-function keyword or cubic-bezier(). */
/**
 * Is this a timing function the curve editor can open?
 *
 * Deliberately narrow: the five keywords and a well-formed `cubic-bezier()`,
 * which are exactly what a bezier curve can express and round-trip. `steps(4,
 * end)` and `linear(0, 0.5 50%, 1)` are timing functions too, and opening a
 * curve editor on one would quietly rewrite it as a bezier — so they are left
 * alone rather than mangled.
 */
export function isEasing(value: string): boolean {
  const v = String(value ?? '').trim().toLowerCase()
  if (/^(?:ease|linear|ease-in|ease-out|ease-in-out)$/.test(v)) return true
  return /^cubic-bezier\(\s*[\d.-]+\s*,\s*[\d.-]+\s*,\s*[\d.-]+\s*,\s*[\d.-]+\s*\)$/.test(v)
}

export function easingToBezier(timing: string): [number, number, number, number] {
  const v = timing.trim().toLowerCase()
  const named: Record<string, [number, number, number, number]> = {
    ease: [0.25, 0.1, 0.25, 1], linear: [0, 0, 1, 1],
    'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
  }
  if (named[v]) return named[v]
  const m = v.match(/^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/)
  if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]
  return [0.25, 0.1, 0.25, 1] // fall back to ease
}

const round = (n: number) => Math.round(n * 1000) / 1000
/** Serialize four bezier values to a timing-function, collapsing to a keyword when exact. */
export function bezierToEasing([x1, y1, x2, y2]: [number, number, number, number]): string {
  const key = `${round(x1)},${round(y1)},${round(x2)},${round(y2)}`
  const keywords: Record<string, string> = {
    '0.25,0.1,0.25,1': 'ease', '0,0,1,1': 'linear',
    '0.42,0,1,1': 'ease-in', '0,0,0.58,1': 'ease-out', '0.42,0,0.58,1': 'ease-in-out',
  }
  return keywords[key] ?? `cubic-bezier(${round(x1)}, ${round(y1)}, ${round(x2)}, ${round(y2)})`
}
