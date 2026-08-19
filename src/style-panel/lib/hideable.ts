// Turning a layer off without throwing it away.
//
// A transform, a filter, a transition — you want to see the element without it
// for a moment, and then you want it back. Deleting the layer and retyping it
// from memory is the only way the panel used to offer, so "is this blur doing
// anything?" cost you the blur.
//
// So a hidden layer is COMMENTED OUT in place:
//
//     filter: blur(5px) /* brightness(0.5) */;
//
// The browser ignores it, the element renders without it, and every character
// of it is still sitting in the stylesheet where it was. Turning it back on
// removes the comment markers and nothing else. Nothing is stored anywhere but
// the CSS, so a hidden layer survives a reload, a branch switch, and being
// opened in an editor that has never heard of this panel.
//
// The separator differs by property and the list splitting has to respect it:
// `transition` is comma-separated, `filter` and `transform` are space-separated,
// and both can hold functions with commas or spaces INSIDE their parentheses
// (`rgba(0, 0, 0, .5)`, `translate(1px 2px)`) which must not be split on.

export type Hideable<T> = { item: T; hidden: boolean }

/**
 * A value split into comment runs and the text between them.
 *
 * NOT one entry per top-level token. A single layer does not always serialize
 * to a single function: a rotate is `rotateX(…) rotateY(…) rotateZ(…)`, three
 * functions that the transform parser groups back into one layer. Splitting on
 * separators and parsing each piece alone turned one rotate into three, and a
 * two-layer value came back with four layers in it.
 *
 * So the only boundary here is the comment. Everything between comments is
 * handed to the property's own parser in one piece, exactly as it would have
 * been without any of this, and the parser does its own grouping.
 */
function splitRuns(value: string): Array<{ text: string; hidden: boolean }> {
  const text = String(value ?? '')
  const runs: Array<{ text: string; hidden: boolean }> = []
  let i = 0
  let start = 0
  const pushVisible = (end: number) => {
    const piece = text.slice(start, end).trim()
    if (piece) runs.push({ text: piece, hidden: false })
  }
  while (i < text.length) {
    if (!text.startsWith('/*', i)) {
      i++
      continue
    }
    const close = text.indexOf('*/', i + 2)
    // An unterminated comment: everything after it was meant to be hidden and
    // there is no way to tell where it should have stopped. Treat the rest as
    // one hidden run rather than dropping it.
    if (close === -1) {
      pushVisible(i)
      const rest = text.slice(i + 2).trim()
      if (rest) runs.push({ text: rest, hidden: true })
      return runs
    }
    pushVisible(i)
    const inner = text.slice(i + 2, close).trim()
    if (inner) runs.push({ text: inner, hidden: true })
    i = close + 2
    start = i
  }
  pushVisible(text.length)
  return runs
}

/**
 * A property's value as layers, with the commented-out ones marked hidden.
 *
 * `parseAll` is the property's own parser, handed a whole run of uncommented
 * CSS, so no parser has to learn about any of this — or lose the grouping it
 * does across several functions.
 */
export function parseHideable<T>(
  value: string,
  _sep: ',' | ' ',
  parseAll: (text: string) => T[]
): Array<Hideable<T>> {
  const out: Array<Hideable<T>> = []
  for (const run of splitRuns(value)) {
    // The placeholder written when every layer is hidden — not a layer, and a
    // row for it would be a row nobody added.
    if (!run.hidden && run.text.toLowerCase() === 'none') continue
    // A hidden run carries the comma that was hidden along with it (see
    // serializeHideable) — punctuation from the list, not part of the layer,
    // and enough to make the property's own parser see an empty entry.
    const text = run.hidden ? run.text.replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '') : run.text
    if (!text) continue
    for (const item of parseAll(text) ?? []) {
      if (item === undefined || item === null) continue
      out.push({ item, hidden: run.hidden })
    }
  }
  return out
}

/**
 * Layers back to a property value, hidden ones wrapped in a comment.
 *
 * `serializeAll` is the property's own serializer, called with one layer so the
 * comment can be put around exactly that layer's text.
 *
 * The commas are the whole difficulty. A comment is removed before the value is
 * parsed, so commenting an entry out of a comma-separated list LEAVES ITS COMMA
 * BEHIND — `transition: opacity 200ms ease, /* transform 300ms linear *␘/`
 * reaches the parser as `opacity 200ms ease,`, a trailing comma, which is a
 * syntax error. The browser then drops the WHOLE declaration, so hiding one
 * transition silently turns off the one still showing. Verified in Chromium
 * rather than reasoned about: that value computes to `all`, as if the property
 * had never been written.
 *
 * So a comma next to a hidden entry goes INSIDE its comment, and only the
 * commas between two showing entries are left in the value itself.
 */
export function serializeHideable<T>(
  rows: ReadonlyArray<Hideable<T>>,
  sep: ',' | ' ',
  serializeAll: (items: T[]) => string
): string {
  const parts = rows
    .map((row) => ({ text: serializeAll([row.item]).trim(), hidden: row.hidden }))
    .filter((p) => p.text)
  if (!parts.length) return ''

  let out = ''
  let shown = false
  for (const part of parts) {
    if (part.hidden) {
      // The comma that would have preceded this entry, kept inside the comment
      // so it disappears along with the entry. Nothing precedes the first
      // showing entry, so it takes no comma at all.
      const comma = sep === ',' && shown ? ', ' : ''
      out += `${out ? ' ' : ''}/* ${comma}${part.text} */`
    } else {
      out += shown ? `${sep === ',' ? ',' : ''} ${part.text}` : `${out ? ' ' : ''}${part.text}`
      shown = true
    }
  }

  // Every layer hidden leaves `filter: /* blur(5px) */` — a declaration with no
  // value, which is a syntax error, so the whole thing (comment included) is
  // dropped by the browser and the hidden layer is gone for good.
  //
  // `none` is the get-out: valid for all of these properties, means the same as
  // not declaring them, and gives the comment something to sit beside. Hiding
  // your only filter therefore still leaves it recoverable.
  return shown ? out : `none ${out}`
}

/** Whether every layer is hidden — the caller may prefer to clear the property. */
export const allHidden = <T>(rows: ReadonlyArray<Hideable<T>>): boolean =>
  rows.length > 0 && rows.every((r) => r.hidden)
