// One clause of a filter function as a condition the list settings show:
// `data.featured`, `!data.draft`, `data.category === 'news'`, `new Date(data.date)
// < new Date()`, `(data.tags ?? []).includes('x')` and the other shapes the
// writer (loopQuery.ts) and hand-written code use for the same tests. A clause
// it does not recognise is kept as written, as a custom condition.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { isDateValue, isDocumentId, isFieldPath, LOOP_QUERY_LIMITS } from './loopQuery';
import type { LoopCondition, LoopFieldKind, LoopLiteral, LoopSource } from './loopQuery';
import { namePath, textOf, type Js } from './loopSyntax';

/** What a field of a collection holds, when its schema is known. */
export type FieldKindOf = (source: LoopSource, path: string) => LoopFieldKind | undefined;

export interface ConditionContext {
  readonly source: string;
  readonly base: readonly string[];
  readonly collection: LoopSource;
  readonly fieldKind: FieldKindOf | undefined;
}

const COMPARISONS: Readonly<Record<string, 'greater' | 'less' | 'atLeast' | 'atMost'>> = { '>': 'greater', '<': 'less', '>=': 'atLeast', '<=': 'atMost' };
const MIRRORED: Readonly<Record<string, string>> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '===': '===', '==': '==', '!==': '!==', '!=': '!=' };

/** One clause as a condition, or kept as written when it is anything else. */
export function conditionOf(node: Js, context: ConditionContext): LoopCondition {
  const custom: LoopCondition = { kind: 'custom', code: textOf(context, node) };
  const recognised = recognisedCondition(node, context);
  return recognised ?? custom;
}

function recognisedCondition(node: Js, context: ConditionContext): LoopCondition | undefined {
  if (node.kind === 'unary' && node.operator === '!') {
    const field = fieldOf(node.value, context);
    return field !== undefined && truthyField(field, context) ? { kind: 'test', field, operator: 'isFalse' } : undefined;
  }
  const bare = fieldOf(node, context);
  if (bare !== undefined) {
    return truthyField(bare, context) ? { kind: 'test', field: bare, operator: 'isTrue' } : undefined;
  }
  if (node.kind === 'call') {
    return callCondition(node, context);
  }
  if (node.kind !== 'binary') {
    return undefined;
  }
  // The field on the left: `'news' === data.category` reads as the same test.
  const leftField = valueField(node.left, context);
  const field = leftField ?? valueField(node.right, context);
  const operator = leftField !== undefined ? node.operator : MIRRORED[node.operator];
  const other = leftField !== undefined ? node.right : node.left;
  if (field === undefined || operator === undefined) {
    return undefined;
  }
  return binaryCondition(field, operator, other, context);
}

// A value read from a field, through the wrappers a date or a null-check adds.
interface FieldValue {
  readonly path: string;
  readonly date: boolean;
  /** `category?.id`: the id of the referenced entry. */
  readonly referenceId: boolean;
}

function valueField(node: Js, context: ConditionContext): FieldValue | undefined {
  let current = node;
  let date = false;
  for (let depth = 0; depth < 4; depth++) {
    if (current.kind === 'new' && isName(current.callee, 'Date') && current.args.length === 1 && current.args[0]) {
      date = true;
      current = current.args[0];
    } else if (
      current.kind === 'call' &&
      current.callee.kind === 'member' &&
      ['valueOf', 'getTime'].includes(current.callee.property) &&
      current.args.length === 0
    ) {
      date = true;
      current = current.callee.object;
    } else {
      break;
    }
  }
  const either = referenceIdOf(current);
  if (either !== undefined) {
    const field = relativeField(either, context.base);
    return field === undefined || date ? undefined : { path: field, date, referenceId: true };
  }
  const path = namePath(current);
  if (path === undefined) {
    return undefined;
  }
  const field = relativeField(path, context.base);
  if (field === undefined) {
    return undefined;
  }
  if (field.endsWith('.id') && context.fieldKind?.(context.collection, field.slice(0, -3)) === 'reference') {
    return { path: field.slice(0, -3), date, referenceId: true };
  }
  return { path: field, date, referenceId: false };
}

// `(X?.id ?? X)`: the id of a reference, or the text of a choice (loopQuery.ts).
function referenceIdOf(node: Js): readonly string[] | undefined {
  if (node.kind !== 'binary' || node.operator !== '??') {
    return undefined;
  }
  const left = namePath(node.left);
  const right = namePath(node.right);
  if (left === undefined || right === undefined || left[left.length - 1] !== 'id' || left.length !== right.length + 1) {
    return undefined;
  }
  return right.every((segment, index) => left[index] === segment) ? right : undefined;
}

function fieldOf(node: Js, context: ConditionContext): string | undefined {
  const path = namePath(node);
  return path === undefined ? undefined : relativeField(path, context.base);
}

export function relativeField(path: readonly string[], base: readonly string[]): string | undefined {
  if (path.length <= base.length || base.some((segment, index) => path[index] !== segment)) {
    return undefined;
  }
  const field = path.slice(base.length).join('.');
  return isFieldPath(field) ? field : undefined;
}

// `data.featured` alone means "is true" only for a switch; on text it means
// "has a value", which this reader keeps as written rather than mislabel.
function truthyField(field: string, context: ConditionContext): boolean {
  const kind = context.fieldKind?.(context.collection, field);
  return kind === undefined || kind === 'boolean';
}

function binaryCondition(field: FieldValue, operator: string, other: Js, context: ConditionContext): LoopCondition | undefined {
  const equality = operator === '===' || operator === '==' ? 'is' : operator === '!==' || operator === '!=' ? 'isNot' : undefined;
  if (equality !== undefined) {
    return equalityCondition(field, equality, operator, other, context);
  }
  const comparison = COMPARISONS[operator];
  if (comparison === undefined) {
    return undefined;
  }
  // A builder's relative date, "0 days in the past": the moment the page is built.
  if (isNow(other) || (other.kind === 'string' && /^0 days? in the (?:past|future)$/i.test(other.value.trim()))) {
    return comparison === 'less' || comparison === 'atMost'
      ? { kind: 'test', field: field.path, operator: 'inPast' }
      : { kind: 'test', field: field.path, operator: 'inFuture' };
  }
  const date = dateLiteral(other);
  if (date !== undefined) {
    if (comparison === 'less') {
      return { kind: 'test', field: field.path, operator: 'before', value: date };
    }
    return comparison === 'greater' ? { kind: 'test', field: field.path, operator: 'after', value: date } : undefined;
  }
  return other.kind === 'number' && !field.date ? { kind: 'test', field: field.path, operator: comparison, value: other.value } : undefined;
}

function equalityCondition(field: FieldValue, equality: 'is' | 'isNot', operator: string, other: Js, context: ConditionContext): LoopCondition | undefined {
  if (field.date) {
    return undefined;
  }
  // `!= null` and `!= undefined` both mean "has a value"; `!== null` alone does not.
  const loose = operator === '==' || operator === '!=';
  if ((other.kind === 'name' && other.name === 'undefined' && loose) || (other.kind === 'null' && loose)) {
    return { kind: 'test', field: field.path, operator: equality === 'is' ? 'isEmpty' : 'isSet' };
  }
  if (other.kind === 'boolean') {
    if (!other.value) {
      return undefined; // `=== false` leaves out items with no value; "is false" keeps them.
    }
    return { kind: 'test', field: field.path, operator: equality === 'is' ? 'isTrue' : 'isFalse' };
  }
  const literal = literalOf(other, field, context);
  return literal === undefined ? undefined : { kind: 'test', field: field.path, operator: equality, value: literal };
}

function literalOf(node: Js, field: FieldValue, context: ConditionContext): LoopLiteral | undefined {
  if (node.kind === 'number') {
    return field.referenceId ? undefined : { kind: 'number', number: node.value };
  }
  if (node.kind !== 'string' || node.value.length > LOOP_QUERY_LIMITS.valueCharsMax) {
    return undefined;
  }
  if (field.referenceId) {
    return isDocumentId(node.value) ? { kind: 'reference', id: node.value } : undefined;
  }
  assert(context.base.length > 0, 'A literal is compared with a field under a base');
  return { kind: 'text', text: node.value };
}

// `X.includes('a')`, `String(X ?? '').toLowerCase().includes('a')`,
// `(X ?? []).includes('a')`, `(X ?? []).some((tag) => tag.id === 'a')`.
function callCondition(node: Extract<Js, { readonly kind: 'call' }>, context: ConditionContext): LoopCondition | undefined {
  if (node.callee.kind !== 'member' || node.args.length !== 1) {
    return undefined;
  }
  const method = node.callee.property;
  const argument = node.args[0];
  const target = unwrapFallback(node.callee.object);
  if (method === 'some' && argument?.kind === 'function') {
    return someReference(target, argument, context);
  }
  if (method !== 'includes' || argument === undefined) {
    return undefined;
  }
  const lowered = target.kind === 'call' && target.callee.kind === 'member' && target.callee.property === 'toLowerCase' && target.args.length === 0;
  const text = unwrapString(lowered && target.callee.kind === 'member' ? target.callee.object : target);
  const field = fieldOf(text, context);
  if (field === undefined) {
    return undefined;
  }
  const kind = context.fieldKind?.(context.collection, field);
  if (kind === 'list') {
    if (argument.kind === 'string') {
      return { kind: 'test', field, operator: 'has', value: { kind: 'text', text: argument.value } };
    }
    return argument.kind === 'number' ? { kind: 'test', field, operator: 'has', value: { kind: 'number', number: argument.value } } : undefined;
  }
  if (argument.kind !== 'string' || argument.value === '' || argument.value.length > LOOP_QUERY_LIMITS.valueCharsMax) {
    return undefined;
  }
  return { kind: 'test', field, operator: 'contains', value: argument.value };
}

function someReference(target: Js, callback: Extract<Js, { readonly kind: 'function' }>, context: ConditionContext): LoopCondition | undefined {
  const field = fieldOf(target, context);
  const parameter = callback.parameters[0];
  const body = callback.body;
  if (field === undefined || parameter?.kind !== 'name' || body?.kind !== 'binary' || (body.operator !== '===' && body.operator !== '==')) {
    return undefined;
  }
  const plain = namePath(body.left);
  const path = referenceIdOf(body.left) ?? (plain?.[plain.length - 1] === 'id' ? plain.slice(0, -1) : undefined);
  const id = body.right;
  const named = path?.length === 1 && path[0] === parameter.name;
  if (!named || id.kind !== 'string' || !isDocumentId(id.value)) {
    return undefined;
  }
  return { kind: 'test', field, operator: 'has', value: { kind: 'reference', id: id.value } };
}

// `X ?? []`, `X ?? ''`, `X || []`: the field, defaulted.
function unwrapFallback(node: Js): Js {
  if (node.kind === 'binary' && (node.operator === '??' || node.operator === '||')) {
    return node.left;
  }
  return node;
}

// `String(X ?? '')` → `X`.
function unwrapString(node: Js): Js {
  if (node.kind === 'call' && isName(node.callee, 'String') && node.args.length === 1 && node.args[0]) {
    return unwrapFallback(node.args[0]);
  }
  return unwrapFallback(node);
}

export function isName(node: Js, name: string): boolean {
  return node.kind === 'name' && node.name === name;
}

// `new Date()` and `Date.now()`: the moment the page is built or rendered.
function isNow(node: Js): boolean {
  if (node.kind === 'new') {
    return isName(node.callee, 'Date') && node.args.length === 0;
  }
  return node.kind === 'call' && node.args.length === 0 && namePath(node.callee)?.join('.') === 'Date.now';
}

// `new Date('2024-01-01')` or the string alone.
function dateLiteral(node: Js): string | undefined {
  const inner = node.kind === 'new' && isName(node.callee, 'Date') && node.args.length === 1 ? node.args[0] : node;
  if (inner?.kind !== 'string') {
    return undefined;
  }
  const day = inner.value.slice(0, 10);
  return isDateValue(day) ? day : undefined;
}

// `a && b && c` as its clauses, left to right.
export function chainOf(node: Js, operator: '&&' | '||'): readonly Js[] {
  const out: Js[] = [];
  const pending: Js[] = [node];
  for (let count = 0; pending.length > 0 && count < LIMITS.treeNodesMax; count++) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    if (current.kind === 'binary' && current.operator === operator) {
      pending.push(current.right, current.left);
    } else {
      out.push(current);
    }
  }
  return out;
}
