import { assert } from '../../../../shared/core/assert';

// A variable reference being typed, so the chooser can follow the typing.
//
// Typing `var(`, `var(--`, `--` or `var(--bra` in a value field opens the
// variable chooser filtered by what has been typed so far, the way an editor
// suggests a name as it is spelt. Picking one replaces the typed fragment with
// the whole reference, `var(--brand)`, and keeps everything around it.
//
// Only the text before the caret decides. A fragment starts at a word boundary,
// so `my-var(` and `a--b` are names being typed, not references.

/** The fragment of `value` between `start` and `end` that a pick replaces, and the name typed so far. */
export interface TypedVariable {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

// The longest fragment looked at. A custom property name past this is not one
// anybody is typing by hand, and it keeps the scan bounded on a long value.
export const TYPED_VARIABLE_CHARS_MAX = 256;

const NAME_CHARS = /^[A-Za-z0-9_-]*/;
// `var(` with an optional `--name`, or a bare `--name`, ending at the caret and
// starting at a boundary (the start, or a character that cannot be in a name).
const TYPED_BEFORE_CARET = /(?:^|[^A-Za-z0-9_-])(?:(var\(\s*)(?:--([A-Za-z0-9_-]*))?|--([A-Za-z0-9_-]*))$/;

/** The variable being typed at `caret` in `value`, or undefined when none is. */
export function typedVariableAt(value: string, caret: number): TypedVariable | undefined {
  assert(Number.isSafeInteger(caret), 'typedVariableAt: the caret is a whole offset');
  assert(caret >= 0, 'typedVariableAt: the caret is not before the value');
  if (caret > value.length) {
    return undefined;
  }
  const windowStart = Math.max(0, caret - TYPED_VARIABLE_CHARS_MAX);
  const before = value.slice(windowStart, caret);
  const match = TYPED_BEFORE_CARET.exec(before);
  if (match === null) {
    return undefined;
  }
  const opener = match[1];
  const name = opener === undefined ? (match[3] ?? '') : (match[2] ?? '');
  // The fragment is the match without the boundary character in front of it.
  const fragmentLength = (opener ?? '').length + (opener === undefined || match[2] !== undefined ? 2 : 0) + name.length;
  const start = caret - fragmentLength;
  assert(start >= windowStart, 'typedVariableAt: the fragment lies inside the scanned window');
  // A name the caret sits in the middle of is replaced whole, and so is the
  // `)` that bracket pairing put after `var(`.
  const after = value.slice(caret);
  const rest = NAME_CHARS.exec(after)?.[0] ?? '';
  const closer = opener === undefined ? undefined : /^\s*\)/.exec(after.slice(rest.length))?.[0];
  const end = caret + rest.length + (closer ?? '').length;
  assert(end <= value.length, 'typedVariableAt: the fragment ends inside the value');
  return { start, end, query: (name + rest).toLowerCase() };
}

/** `value` with the typed fragment replaced by `binding`, and the caret just after it. */
export function completeTypedVariable(value: string, typed: TypedVariable, binding: string): { readonly value: string; readonly caret: number } {
  assert(typed.start <= typed.end, 'completeTypedVariable: the fragment does not end before it starts');
  assert(typed.end <= value.length, 'completeTypedVariable: the fragment lies inside the value');
  const next = value.slice(0, typed.start) + binding + value.slice(typed.end);
  return { value: next, caret: typed.start + binding.length };
}

// Every `var(--…)` in a value, in order: the same references the field draws as chips.
const VARIABLE_REFERENCES = /var\(\s*--[A-Za-z0-9_-]+[^)]*\)/gi;

/**
 * `value` with its `index`-th variable swapped for `binding`: a chip pressed in
 * `calc(var(--a) + var(--b))` changes that chip and leaves the other alone. A
 * value with no `var()` at all is one bare variable (a native binding read back
 * by name), and the whole of it is swapped.
 */
export function replaceVariableAt(value: string, index: number, binding: string): string {
  assert(Number.isSafeInteger(index), 'replaceVariableAt: the chip index is whole');
  assert(index >= 0, 'replaceVariableAt: the chip index is not negative');
  const references = [...value.matchAll(VARIABLE_REFERENCES)];
  if (references.length === 0) {
    return binding;
  }
  const reference = references[index];
  if (reference === undefined) {
    return value;
  }
  const start = reference.index;
  return value.slice(0, start) + binding + value.slice(start + reference[0].length);
}

/**
 * The offset in the token field for offset `at` in its serialized value. The
 * field draws each `var(--…)` as one chip, one character wide; the value spells
 * it out. An offset inside a reference is moved to just after its chip.
 */
export function fieldOffsetOf(value: string, at: number): number {
  assert(at >= 0, 'fieldOffsetOf: the offset is not negative');
  assert(at <= value.length, 'fieldOffsetOf: the offset lies inside the value');
  let removed = 0;
  for (const reference of value.matchAll(VARIABLE_REFERENCES)) {
    const start = reference.index;
    if (start >= at) {
      break;
    }
    const end = start + reference[0].length;
    if (end <= at) {
      removed += reference[0].length - 1;
    } else {
      return start + 1 - removed;
    }
  }
  return at - removed;
}
