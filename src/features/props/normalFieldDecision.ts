// What the {} toggle does with the expression a prop holds: the pure decision
// behind it (PropFieldLabel.tsx). The switch must never delete the user's
// value silently, so it keeps a literal as the plain value, or replaces code
// with the control's empty value. Pure, so every case is pinned by a table.

import type { Attr } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { FieldDefinition } from './propRules';
import { valueFromExpr } from './propFieldModel';
import { plainTextOf, textValue } from './propLiteral';
import { optionAttr } from './propKinds';

/**
 * The switch to the plain control, as a decision: `literal` is an expression
 * that equals a plain value, so nothing is lost; `replace` is code the control
 * cannot hold, swapped for the control's empty value (the one Reset gives, or
 * the type's valid empty value for a required prop) and offered back through an
 * Undo notice; `blocked` is a required prop with no valid empty value to write.
 */
export type NormalFieldDecision =
  { readonly kind: 'literal'; readonly value: Attr } | { readonly kind: 'replace'; readonly value: Attr | undefined } | { readonly kind: 'blocked' };

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
 * What the {} toggle writes for the expression a field holds. A literal the
 * field's type takes is kept as the plain value; anything else is replaced by
 * the control's empty value, never by a missing attribute on a required prop.
 */
export function decideNormalField(input: NormalFieldInput): NormalFieldDecision {
  const source = input.source.trim();
  assert(source.length <= LIMITS.attrCharsMax, 'decideNormalField: source limit exceeded');
  assert(input.field.name.length > 0, 'decideNormalField: a field has a name');
  const kept = literalValue(input.field, source);
  if (kept !== undefined) {
    return { kind: 'literal', value: kept };
  }
  if (!input.required) {
    return { kind: 'replace', value: undefined };
  }
  const empty = requiredEmptyValue(input.field);
  return empty === undefined ? { kind: 'blocked' } : { kind: 'replace', value: empty };
}

function literalValue(field: FieldDefinition, source: string): Attr | undefined {
  const text = plainTextOf(source);
  if (text !== undefined) {
    return textValue(field, text);
  }
  const wordy = field.type === 'string' || field.type === 'other';
  if (wordy && (NUMBER_LITERAL.test(source) || BOOLEAN_LITERAL.test(source))) {
    // A text field written `{42}` holds the text 42 on the plain control.
    return { type: 'string', value: source };
  }
  return valueFromExpr(field, source);
}

/**
 * A value a required prop's control accepts as empty, so the attribute is
 * never missing: '' for text, the first option, false, the lower bound or 0, an
 * empty list. Undefined where no such value exists (an object, a function).
 */
export function requiredEmptyValue(field: FieldDefinition): Attr | undefined {
  assert(field.name.length > 0, 'requiredEmptyValue: a field has a name');
  switch (field.type) {
    case 'string':
    case 'other':
      return { type: 'string', value: '' };
    case 'boolean':
      return { type: 'expr', value: 'false' };
    case 'number':
      return field.minExclusive === true || (field.max !== undefined && field.max < 0) ? undefined : { type: 'expr', value: String(field.min ?? 0) };
    case 'enum': {
      const first = field.options?.[0];
      return first === undefined ? undefined : optionAttr(field, first);
    }
    case 'code':
      return field.codeKind === undefined ? { type: 'expr', value: '[]' } : undefined;
    default:
      return undefined;
  }
}

/**
 * What "Reset to default property value" does: `remove` takes the attribute
 * out (an optional prop falls back to its default); `write` puts the control's
 * valid empty value in place of a required prop's value, since removing it
 * would leave the component invalid; `disabled` says why there is nothing to
 * do: nothing is written, or a required prop already holds its empty value, or a required prop
 * has no valid empty value to return to.
 */
export type ResetPlan =
  | { readonly kind: 'remove' }
  | { readonly kind: 'write'; readonly value: Attr }
  | { readonly kind: 'disabled'; readonly reason: 'already-default' | 'no-empty-value' };

export interface ResetInput {
  readonly field: FieldDefinition;
  readonly value: Attr | undefined;
  /** Whether removing the attribute would leave a prop the component needs missing. */
  readonly required: boolean;
}

export function planReset(input: ResetInput): ResetPlan {
  const { field, value, required } = input;
  assert(field.name.length > 0, 'planReset: a field has a name');
  if (value === undefined) {
    return { kind: 'disabled', reason: 'already-default' };
  }
  if (!required) {
    // An attribute that is written is an override even when it equals the default; removing it is the reset.
    return { kind: 'remove' };
  }
  const empty = requiredEmptyValue(field);
  if (empty === undefined) {
    return { kind: 'disabled', reason: 'no-empty-value' };
  }
  const same = empty.type !== 'bare' && value.type !== 'bare' && empty.type === value.type && empty.value === value.value;
  return same ? { kind: 'disabled', reason: 'already-default' } : { kind: 'write', value: empty };
}
