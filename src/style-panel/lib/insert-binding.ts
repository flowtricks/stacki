// Where a picked variable goes in the field.
//
// Picking one used to replace the whole value, which is right for most fields:
// `2rem` becomes `var(--space-6)` and that is the entire edit. But it is
// destructive the moment the value is an expression — picking a variable inside
// `calc(100% - 2rem)` threw away the calc, and the only way to get it back was
// undo and a retype.
//
// So the value decides. A plain value is replaced, because replacing it is what
// picking a variable means there. Anything with structure to lose has the
// variable put in at the caret instead, and keeps everything around it.

/** `!important` and whatever whitespace led up to it, kept aside and put back. */
function splitImportant(value: string): { body: string; suffix: string } {
  const m = value.match(/(\s*!\s*important\s*)$/i)
  return m ? { body: value.slice(0, m.index), suffix: m[1] } : { body: value, suffix: '' }
}

const LONE_VAR = /^var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)$/i

/**
 * Is this a value picking a variable should replace outright?
 *
 * True for a plain value (`2rem`, `red`, `#fff`), with or without `!important`,
 * and for a value that is already just a variable — swapping one variable for
 * another is a replacement too. False for anything with a function call or more
 * than one part in it, where replacing would throw away the rest.
 */
export function replacesWholeValue(value: string): boolean {
  const { body } = splitImportant(String(value ?? ''))
  const t = body.trim()
  if (!t) return true
  if (LONE_VAR.test(t)) return true
  // A function call — calc(), clamp(), color-mix(), min(), any of them.
  if (t.includes('(')) return false
  // `1px solid red`: three parts, and a variable is being picked for one of
  // them. Replacing would drop the other two.
  if (/\s/.test(t)) return false
  return true
}

/** The `var(…)` around `caret`, if the caret is inside one. */
function varAround(value: string, caret: number): { start: number; end: number } | null {
  const re = /var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/gi
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const start = m.index
    const end = start + m[0].length
    if (caret >= start && caret <= end) return { start, end }
  }
  return null
}

/**
 * The value to write when `binding` is picked for a field currently holding
 * `value`, with the caret at `caret` (null when it isn't known).
 *
 * `!important` survives either way: dropping it silently would change what the
 * declaration does, and nobody picking a variable asked for that.
 */
export function insertBinding(value: string, binding: string, caret: number | null): string {
  const text = String(value ?? '')
  const { body, suffix } = splitImportant(text)

  if (replacesWholeValue(text)) return binding + suffix

  // No caret to work from — the field was never focused, or the selection went
  // before the picker opened. Swapping the variable already there is the best
  // guess when there is one.
  //
  // With nothing to swap, the variable goes on the END. It used to replace the
  // whole value instead, on the reasoning that a replacement is at least valid
  // CSS — but that quietly deleted whatever had been built up, which is the
  // one outcome nobody could want and the one that is hardest to undo. A
  // variable stuck on the end is visibly wrong and takes a second to fix; a
  // calc() that has vanished has to be written again from memory.
  if (caret == null) {
    const existing = body.match(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/i)
    return existing ? text.replace(existing[0], binding) : body + binding + suffix
  }

  const at = Math.max(0, Math.min(caret, body.length))
  // Sitting inside a variable already: this is a swap, not an insertion — two
  // variables nested where one was meant is never what was wanted.
  const around = varAround(body, at)
  if (around) return body.slice(0, around.start) + binding + body.slice(around.end) + suffix
  return body.slice(0, at) + binding + body.slice(at) + suffix
}
