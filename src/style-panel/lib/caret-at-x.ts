// Which character of a single-line text field sits under a given screen x.
//
// Needed by the scrub (components/useScrub.ts) to know WHICH number you grabbed in a
// multi-part value like `0 2px 4px`. The obvious API, `document.caretPositionFromPoint`,
// is no use here: an input's text lives in its shadow root, so the node it returns fails
// every "is this my element" check, and `selectionStart` is whatever the last selection
// was — on an unfocused field, not the press at all. Measuring the string is exact and
// doesn't care whether the field is focused.

let measurer: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d')
  return measurer
}

/** The font shorthand for canvas. `computed.font` is empty in some engines, so rebuild it. */
function fontOf(computed: CSSStyleDeclaration): string {
  if (computed.font) return computed.font
  return `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} / ${computed.lineHeight} ${computed.fontFamily}`
}

/**
 * Index of the character boundary nearest `clientX` inside `el`. Falls back to the end of
 * the value when the canvas is unavailable — the scrub then just grabs the last number,
 * which is still a sane thing to have pressed on.
 *
 * An x alone can't locate a caret once the text wraps onto a second line, so a textarea
 * whose content doesn't fit falls back to its own selection. (An <input> never wraps — it
 * scrolls, which `scrollLeft` already accounts for — and the one textarea in the panel
 * only grows past a line while focused, which is when selectionStart is meaningful.)
 */
export function caretAtX(el: HTMLInputElement | HTMLTextAreaElement, clientX: number): number {
  const text = el.value
  if (!text) return 0
  const ctx = context()
  if (!ctx) return text.length

  const computed = window.getComputedStyle(el)
  ctx.font = fontOf(computed)
  // Chromium honours this; elsewhere it's ignored and the estimate drifts by a pixel or
  // two, which the nearest-run fallback in findScrubTarget absorbs.
  ctx.letterSpacing = computed.letterSpacing === 'normal' ? '0px' : computed.letterSpacing

  const rect = el.getBoundingClientRect()
  const padLeft = Number.parseFloat(computed.paddingLeft) || 0
  const padRight = Number.parseFloat(computed.paddingRight) || 0
  const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0
  const borderRight = Number.parseFloat(computed.borderRightWidth) || 0

  const width = ctx.measureText(text).width
  const inner = rect.width - borderLeft - borderRight - padLeft - padRight
  const wraps = el.tagName === 'TEXTAREA' && (text.includes('\n') || width > inner)
  if (wraps) return el.selectionStart ?? 0

  // Where the first glyph starts. Short text inside a centred/right-aligned field is
  // offset by the slack, and a long value is scrolled.
  let originX = rect.left + borderLeft + padLeft - el.scrollLeft
  if (width < inner) {
    const align = computed.textAlign
    if (align === 'center') originX += (inner - width) / 2
    else if (align === 'right' || align === 'end') originX += inner - width
  }

  const x = clientX - originX
  if (x <= 0) return 0
  if (x >= width) return text.length

  // Walk the prefixes and stop at the boundary whose midpoint we've passed — the same
  // rule a text caret uses, so the index matches where a click would put it.
  let previous = 0
  for (let i = 1; i <= text.length; i++) {
    const current = ctx.measureText(text.slice(0, i)).width
    if (x < (previous + current) / 2) return i - 1
    previous = current
  }
  return text.length
}
