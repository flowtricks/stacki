// A CSS value field that behaves like a code editor: the value is coloured as
// you type, and the number under the caret answers to the arrow keys.
//
// Deliberately not CodeMirror. The variables sheet renders every value in the
// file at once — hundreds of fields — and an editor instance per cell is orders
// of magnitude more than the job needs. A value is one line of CSS with no
// nesting to track, so a regex tokeniser and the browser's own caret are
// enough, and the field stays a contentEditable that chips can live inside.

/** One coloured run of the value. `text` is raw (unescaped) source. */
export type CssToken = { kind: string; text: string }

const COMMENT = /^\/\*[\s\S]*?(?:\*\/|$)/
const STRING = /^"[^"]*"?|^'[^']*'?/
const CUSTOM_PROP = /^--[\w-]+/
const FUNCTION = /^[A-Za-z_][\w-]*(?=\()/
const HEX = /^#[0-9a-fA-F]{3,8}/
// A number, and the unit stuck to it: `16`, `1.5rem`, `.5e2%`, `-3px`.
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const UNIT = /^(?:[A-Za-z]+|%)/
const IDENT = /^[A-Za-z_][\w-]*/

/**
 * Split a CSS value into coloured runs. Unknown characters (punctuation,
 * whitespace, operators) come back as `plain` so joining the texts back
 * together always reproduces the input exactly.
 */
export function cssTokens(value: string): CssToken[] {
  const out: CssToken[] = []
  const push = (kind: string, text: string) => {
    // Runs of the same kind merge, so `((` is one span rather than two.
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let rest = value
  while (rest) {
    let m: RegExpMatchArray | null
    if ((m = rest.match(COMMENT))) push('comment', m[0])
    else if ((m = rest.match(STRING))) push('string', m[0])
    else if ((m = rest.match(CUSTOM_PROP))) push('prop', m[0])
    else if ((m = rest.match(FUNCTION))) push('fn', m[0])
    else if ((m = rest.match(HEX))) push('hex', m[0])
    else if ((m = rest.match(NUMBER))) {
      push('num', m[0])
      const unit = rest.slice(m[0].length).match(UNIT)
      if (unit) {
        push('unit', unit[0])
        m = [m[0] + unit[0]] as RegExpMatchArray
      }
    } else if ((m = rest.match(IDENT))) push('ident', m[0])
    else {
      push('plain', rest[0])
      m = [rest[0]] as RegExpMatchArray
    }
    rest = rest.slice(m[0].length)
  }
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The value as coloured HTML. `plain` runs stay bare text so the markup — and
 *  the DOM the caret walks — is no deeper than it needs to be. */
export function highlightCss(value: string): string {
  return cssTokens(value)
    .map((t) => (t.kind === 'plain' ? escapeHtml(t.text) : `<span class="cx-${t.kind}">${escapeHtml(t.text)}</span>`))
    .join('')
}

// ───────────────────────────── Arrow-key stepping ─────────────────────────────

/** How much one press moves the number: a tenth with alt, ten with shift. */
export function stepSize(e: { altKey?: boolean; shiftKey?: boolean }): number {
  if (e.altKey) return 0.1
  if (e.shiftKey) return 10
  return 1
}

// Every number in the value, with where it sits. The sign is deliberately NOT
// part of the match: in `calc(100% - 4px)` the minus is an operator, and
// stepping `4px` down through zero should read `-1px`, not `- -1px`.
const NUMBER_AT = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

/** Decimal places to keep: whatever the value had, but enough for the step. */
function precisionOf(text: string, step: number): number {
  const had = text.includes('.') ? text.split('.')[1].length : 0
  const needed = Number.isInteger(step) ? 0 : String(step).split('.')[1].length
  return Math.max(had, needed)
}

/**
 * Step the number the caret is in (or touching) by `delta`.
 *
 * Returns the new text and where the number now ends, so the caller can put the
 * caret back where the user left it, or null when there's no number to step —
 * in which case the key should do its normal thing.
 */
export function stepNumberAt(
  text: string,
  caret: number,
  delta: number,
  /** Floor for the stepped number — padding stops at 0, a margin doesn't. */
  min?: number,
): { text: string; caret: number } | null {
  NUMBER_AT.lastIndex = 0
  let match: RegExpExecArray | null
  let hit: { start: number; end: number; text: string } | null = null
  while ((match = NUMBER_AT.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    // Touching counts: the caret sits at an edge as often as inside, and after
    // typing a number it is always at its right edge.
    if (caret >= start && caret <= end) {
      hit = { start, end, text: match[0] }
      break
    }
    if (start > caret) break // numbers only get further away from here
  }
  if (!hit) return null
  // A `-` immediately before, and not part of a larger expression, is this
  // number's sign — `-4px` steps up to `-3px`, not to `-5px`.
  const signed = hit.start > 0 && text[hit.start - 1] === '-' && !/[\d.\w%)]\s*$/.test(text.slice(0, hit.start - 1))
  const start = signed ? hit.start - 1 : hit.start
  const current = Number((signed ? '-' : '') + hit.text)
  if (!Number.isFinite(current)) return null
  const next = min == null ? current + delta : Math.max(min, current + delta)
  // Float arithmetic: 0.1 + 0.2 must read 0.3 in a field someone is watching.
  const shown = next.toFixed(precisionOf(hit.text, delta)).replace(/^(-?)0\./, '$1.').replace(/\.$/, '')
  return {
    text: text.slice(0, start) + shown + text.slice(hit.end),
    caret: start + shown.length,
  }
}

// ───────────────────────────── Caret in a rich field ─────────────────────────
//
// The field is a contentEditable holding coloured spans and, sometimes, a
// variable chip. Re-colouring rebuilds its markup, so the caret has to be
// recorded and restored as an offset into the text — the nodes it pointed at
// are gone by then. A chip counts as one character, matching the placeholder
// the value serialiser uses.

const isChip = (n: Node): boolean => n instanceof HTMLElement && n.dataset.chip != null

/** Where the caret is, as an offset into the field's text. */
export function caretOffset(root: HTMLElement): number | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.endContainer)) return null
  let offset = 0
  let found = false
  const walk = (node: Node) => {
    if (found) return
    if (node === range.endContainer && node.nodeType !== Node.TEXT_NODE) {
      // A container-level position counts the children before it.
      let i = 0
      for (const child of Array.from(node.childNodes)) {
        if (i++ >= range.endOffset) break
        walk(child)
      }
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === range.endContainer) {
        offset += range.endOffset
        found = true
      } else {
        offset += (node.textContent ?? '').length
      }
      return
    }
    if (isChip(node)) {
      offset += 1
      return
    }
    node.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return found ? offset : null
}

/** Put the caret back at `offset` characters into the field. */
export function setCaretOffset(root: HTMLElement, offset: number): void {
  const doc = root.ownerDocument
  const sel = doc.getSelection()
  if (!sel) return
  let left = offset
  let target: { node: Node; at: number } | null = null
  const walk = (node: Node) => {
    if (target) return
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length
      if (left <= len) target = { node, at: left }
      else left -= len
      return
    }
    if (isChip(node)) {
      if (left <= 0) target = { node: node.parentNode as Node, at: Array.from((node.parentNode as Node).childNodes).indexOf(node as ChildNode) }
      else left -= 1
      return
    }
    node.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  const range = doc.createRange()
  if (target) range.setStart(target.node, target.at)
  else range.selectNodeContents(root), range.collapse(false)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}
