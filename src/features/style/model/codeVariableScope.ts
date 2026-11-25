import { assert } from '../../../../shared/core/assert';
import { typedVariableAt, type TypedVariable } from './typedVariable';
import { SLOT_MARK, slotOfMarked, type ValueSlot } from '../../../../shared/properties/valueSlot';

// Where a code editor's text holds CSS values, so `--` can offer the
// project's variables there and only there.
//
// The Custom value box has offered variables as `var(--` or `--` is typed for
// a while (typedVariable.ts). The code editors (the clip-path code, the CSS
// Code rule editor) are CodeMirror, not that token field, and had none of it.
// They now share one rule for where a reference is being typed:
//
// - `value`: the whole text is one property's value (`inset(…)` for
//   clip-path), so a reference may be typed anywhere in it, and the chooser
//   offers what fits that property.
// - `declarations`: the text is a rule or a declaration list
//   (`.a { width: 1rem; }`). A reference is only typed in a declaration's
//   value — after its colon — and the chooser offers what fits that
//   declaration's property. `--` at the start of a declaration names a new
//   custom property, which is not a reference, so nothing is offered there.

/** What a code editor's text is, for the variables typed into it. */
export type CodeVariableScope = { readonly kind: 'value'; readonly prop: string } | { readonly kind: 'declarations' };

/** A reference being typed in a code editor, and the property its value belongs to. */
export interface CodeTypedVariable {
  readonly typed: TypedVariable;
  /** Undefined for a custom property's own value, which may hold a variable of any type. */
  readonly prop: string | undefined;
}

// How far back a declaration's start is looked for, and how far ahead its end.
// A declaration longer than this is not one being typed by hand, and it keeps
// the scan bounded on a long rule.
export const DECLARATION_CHARS_MAX = 4_096;

// A property name: a standard one, a vendor-prefixed one, or a custom property.
const PROPERTY_NAME = /^-{0,2}[a-z][a-z0-9-]*$/i;

/** The reference being typed at `caret` in `text` read as `scope`, or undefined when none is. */
export function codeTypedVariableAt(text: string, caret: number, scope: CodeVariableScope): CodeTypedVariable | undefined {
  assert(Number.isSafeInteger(caret), 'codeTypedVariableAt: the caret is a whole offset');
  assert(caret >= 0, 'codeTypedVariableAt: the caret is not before the text');
  const typed = typedVariableAt(text, caret);
  if (typed === undefined) {
    return undefined;
  }
  switch (scope.kind) {
    case 'value':
      return { typed, prop: scope.prop };
    case 'declarations': {
      const prop = declarationPropertyAt(text, typed);
      if (prop === undefined) {
        return undefined;
      }
      return { typed, prop: prop.startsWith('--') ? undefined : prop };
    }
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

// The property whose value `typed` sits in, or undefined when it does not sit
// in a declaration's value (a selector, a property name, an at-rule prelude).
function declarationPropertyAt(text: string, typed: TypedVariable): string | undefined {
  assert(typed.start <= typed.end, 'declarationPropertyAt: the fragment does not end before it starts');
  assert(typed.end <= text.length, 'declarationPropertyAt: the fragment lies inside the text');
  const windowStart = Math.max(0, typed.start - DECLARATION_CHARS_MAX);
  const before = text.slice(windowStart, typed.start);
  // The declaration starts after the last `;`, `{` or `}` before the fragment.
  const declaration = declarationTextBefore(before);
  const colon = declaration.indexOf(':');
  if (colon < 0) {
    return undefined;
  }
  // A selector with a pseudo-class (`a:hover --x`) has a colon too; what tells
  // it apart is that a `{` follows before the declaration could end.
  const after = text.slice(typed.end, typed.end + DECLARATION_CHARS_MAX);
  const closer = after.search(/[;{}]/);
  if (closer >= 0 && after[closer] === '{') {
    return undefined;
  }
  const property = declaration.slice(0, colon).trim().toLowerCase();
  if (PROPERTY_NAME.test(property)) {
    return property;
  }
  return undefined;
}

// A line that opens a declaration: a property name and its colon (`text-wrap:`), nothing else before it.
const DECLARATION_LINE = /^[ \t]*-{0,2}[a-z][a-z0-9-]*[ \t]*:/i;

/**
 * The text of the declaration that ends `before` (the text up to the caret): what follows the last
 * `;`, `{` or `}`. A line above that was left without its `;` is still being written, and must not
 * name the property of the line being typed: `width: 1rem` + newline + `text-wrap: --` is a
 * `text-wrap` value, so the declaration starts at the last line that opens with a property and a
 * colon. A continuation line (a grid's strings, a value broken after a comma) opens no declaration.
 */
export function declarationTextBefore(before: string): string {
  const opener = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'));
  const declaration = before.slice(opener + 1);
  let lineStart = declaration.length;
  // Each pass moves to an earlier line, so the declaration's length bounds the loop.
  for (let steps = 0; steps <= declaration.length && lineStart > 0; steps++) {
    const lineBreak = declaration.lastIndexOf('\n', lineStart - 1);
    const line = declaration.slice(lineBreak + 1);
    if (DECLARATION_LINE.test(line)) {
      assert(declaration.endsWith(line), "declarationTextBefore: the line is the declaration's tail");
      return line;
    }
    if (lineBreak < 0) {
      return declaration;
    }
    lineStart = lineBreak;
  }
  return declaration;
}

/**
 * Where a pick would land in the property's value, so the picker judges each variable at that place
 * (shared/properties/valueSlot.ts): `10%` is no colour on its own and a valid one inside `color-mix()`.
 * The value is the whole text of a `value` editor, or the text after the colon up to the declaration's
 * `;` or `}` in a `declarations` editor. A custom property's value has no grammar to judge by, and
 * answers undefined.
 */
export function codeSlotAt(text: string, variable: CodeTypedVariable, scope: CodeVariableScope): ValueSlot | undefined {
  const { start, end } = variable.typed;
  assert(start <= end, 'codeSlotAt: the fragment does not end before it starts');
  assert(end <= text.length, 'codeSlotAt: the fragment lies inside the text');
  if (variable.prop === undefined) {
    return undefined;
  }
  if (scope.kind === 'value') {
    return slotOfMarked(`${text.slice(0, start)}${SLOT_MARK}${text.slice(end)}`);
  }
  const value = declarationValueAround(text, variable, SLOT_MARK);
  return value === undefined ? undefined : slotOfMarked(value);
}

/**
 * The declaration's value as it would read with `replacement` over the typed fragment, in a `declarations`
 * editor: the text after the colon up to the declaration's `;` or `}`. Undefined when the fragment sits
 * in no declaration. The hover preview of the typed chooser shows this value on the canvas.
 */
export function declarationValueWith(text: string, variable: CodeTypedVariable, replacement: string): string | undefined {
  assert(replacement.length > 0, 'declarationValueWith: a replacement is never empty');
  return declarationValueAround(text, variable, replacement);
}

function declarationValueAround(text: string, variable: CodeTypedVariable, between: string): string | undefined {
  const { start, end } = variable.typed;
  assert(start <= end, 'declarationValueAround: the fragment does not end before it starts');
  assert(end <= text.length, 'declarationValueAround: the fragment lies inside the text');
  const before = text.slice(Math.max(0, start - DECLARATION_CHARS_MAX), start);
  const declaration = declarationTextBefore(before);
  const colon = declaration.indexOf(':');
  if (colon < 0) {
    return undefined;
  }
  const ahead = text.slice(end, end + DECLARATION_CHARS_MAX);
  const closer = ahead.search(/[;}]/);
  const valueAfter = closer < 0 ? ahead : ahead.slice(0, closer);
  return `${declaration.slice(colon + 1).trimStart()}${between}${valueAfter}`;
}
