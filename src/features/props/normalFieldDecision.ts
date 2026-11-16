// What "Use the normal field" does with the expression a prop holds: the pure
// decision behind the {} toggle and its menu item (PropFieldLabel.tsx). The
// switch must never delete the user's value, so it either rewrites the
// expression as the equal plain value, or says why it cannot and leaves the
// source untouched. Pure, so every case is pinned by a table of inputs.

import type { Attr } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { FieldDefinition } from './propRules';
import { valueFromExpr } from './propFieldModel';
import { plainTextOf, textValue } from './propLiteral';

/** Why the normal field cannot take over: it is code, it is a literal the type refuses, or it is the only value a required prop has. */
export type NormalFieldRefusal = 'code' | 'invalid-literal' | 'required-empty';

export type NormalFieldDecision =
  { readonly kind: 'convert'; readonly value: Attr | undefined } | { readonly kind: 'blocked'; readonly reason: NormalFieldRefusal };

export interface NormalFieldInput {
  readonly field: FieldDefinition;
  /** The source between the braces, as written. */
  readonly source: string;
  /** Whether leaving the prop out would leave the component without a value it needs. */
  readonly required: boolean;
}

const NUMBER_LITERAL = /^[-+]?(\d+\.?\d*|\.\d+)$/;
const BOOLEAN_LITERAL = /^(true|false)$/;

/**
 * The plain value an expression equals, or why there is none. A literal the
 * field's type refuses (`{"x"}` on an enum without "x") is refused too, rather
 * than written as a value the control would flag.
 */
export function decideNormalField(input: NormalFieldInput): NormalFieldDecision {
  const source = input.source.trim();
  assert(source.length <= LIMITS.attrCharsMax, 'decideNormalField: source limit exceeded');
  assert(input.field.name.length > 0, 'decideNormalField: a field has a name');
  if (source === '') {
    // Nothing is lost by clearing an empty expression, unless the component needs a value.
    return input.required ? { kind: 'blocked', reason: 'required-empty' } : { kind: 'convert', value: undefined };
  }
  const text = plainTextOf(source);
  if (text !== undefined) {
    const value = textValue(input.field, text);
    return value === undefined ? { kind: 'blocked', reason: 'invalid-literal' } : { kind: 'convert', value };
  }
  const wordy = input.field.type === 'string' || input.field.type === 'other';
  const scalar = NUMBER_LITERAL.test(source) || BOOLEAN_LITERAL.test(source);
  if (wordy && scalar) {
    // A text field written `{42}` holds the text 42 on the plain control.
    return { kind: 'convert', value: { type: 'string', value: source } };
  }
  const value = valueFromExpr(input.field, source);
  if (value !== undefined) {
    return { kind: 'convert', value };
  }
  return { kind: 'blocked', reason: scalar ? 'invalid-literal' : 'code' };
}
