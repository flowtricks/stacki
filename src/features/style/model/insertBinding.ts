import { assert } from '../../../../shared/core/assert';

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
  const match = value.match(/(\s*!\s*important\s*)$/i);
  return match ? { body: value.slice(0, match.index), suffix: match[1] ?? '' } : { body: value, suffix: '' };
}

const LONE_VAR = /^var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)$/i;

/**
 * Is this a value picking a variable should replace outright?
 *
 * True for a plain value (`2rem`, `red`, `#fff`), with or without `!important`,
 * and for a value that is already just a variable — swapping one variable for
 * another is a replacement too. False for anything with a function call or more
 * than one part in it, where replacing would throw away the rest.
 */
export function replacesWholeValue(value: string): boolean {
  const { body } = splitImportant(String(value ?? ''));
  const trimmed = body.trim();
  if (!trimmed) {
    return true;
  }
  if (LONE_VAR.test(trimmed)) {
    return true;
  }
  // A function call — calc(), clamp(), color-mix(), min(), any of them.
  if (trimmed.includes('(')) {
    return false;
  }
  // `1px solid red`: three parts, and a variable is being picked for one of
  // them. Replacing would drop the other two.
  if (/\s/.test(trimmed)) {
    return false;
  }
  return true;
}

/** The `var(…)` around `caret`, if the caret is inside one. */
function varAround(value: string, caret: number): { start: number; end: number } | undefined {
  const re = /var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/gi;
  // A global regex advances `lastIndex` on every match, so each `var()` is visited once.
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret >= start && caret <= end) {
      return { start, end };
    }
  }
  return undefined;
}

/**
 * The value to write when `binding` is picked for a field currently holding
 * `value`, with the caret at `caret` (undefined when it isn't known).
 *
 * `!important` survives either way: dropping it silently would change what the
 * declaration does, and nobody picking a variable asked for that.
 */
export function insertBinding(value: string, binding: string, caret: number | undefined): string {
  const text = String(value ?? '');
  const { body, suffix } = splitImportant(text);

  if (replacesWholeValue(text)) {
    return binding + suffix;
  }

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
  if (caret === undefined) {
    const existing = body.match(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/i);
    return existing ? text.replace(existing[0], binding) : body + binding + suffix;
  }

  const at = Math.max(0, Math.min(caret, body.length));
  // Sitting inside a variable already: this is a swap, not an insertion — two
  // variables nested where one was meant is never what was wanted.
  const around = varAround(body, at);
  if (around) {
    return body.slice(0, around.start) + binding + body.slice(around.end) + suffix;
  }
  return body.slice(0, at) + binding + body.slice(at) + suffix;
}

/** A selection in the field's value, as offsets: `start` is not after `end`. */
export interface ValueSelection {
  readonly start: number;
  readonly end: number;
}

/**
 * The value to write when `binding` is picked with `selection` recorded in the
 * field. Text that was selected is what the person meant to change, so the
 * variable takes its place: `2rem` selected in `calc(2rem + 1rem)` becomes
 * `calc(var(--h3) + 1rem)`. A selection that cuts into a variable takes the
 * whole of that variable, because half a `var()` is not a value. A collapsed
 * selection is a caret, and insertBinding decides.
 */
export function insertBindingAt(value: string, binding: string, selection: ValueSelection | undefined): string {
  const text = String(value ?? '');
  if (selection === undefined) {
    return insertBinding(text, binding, undefined);
  }
  assert(selection.start <= selection.end, 'insertBindingAt: the selection does not end before it starts');
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  if (start === end) {
    return insertBinding(text, binding, start);
  }
  const widened = widenOverVariables(text, { start, end });
  assert(widened.start <= start, 'insertBindingAt: widening never shrinks the selection');
  return text.slice(0, widened.start) + binding + text.slice(widened.end);
}

// The selection grown to cover every `var()` it cuts into.
function widenOverVariables(value: string, selection: ValueSelection): ValueSelection {
  let { start, end } = selection;
  const re = /var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/gi;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchStart < end && matchEnd > start) {
      start = Math.min(start, matchStart);
      end = Math.max(end, matchEnd);
    }
  }
  return { start, end };
}
