// What the template condition editor works on: the kind of value a name holds
// (so each name offers the operators that make sense for it), the draft being
// edited (a row may still be half-chosen), and the model a draft writes as.
// Pure, so the rules are pinned by tests without a renderer; the expression
// itself is read and written in src/editor/conditionExpression.ts.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Condition, GroupMatch } from '../../editor/conditionalValue';
import { negatedCondition, type ConditionProp } from './conditionalModel';
import {
  CONDITION_EXPRESSION_LIMITS,
  EXPRESSION_OPERATORS,
  isConditionSubject,
  isOptionalChainSubject,
  isCodeCondition,
  isWritableLiteral,
  ordersValues,
  takesValue,
  takesValues,
  type ConditionExpression,
  type ExpressionCondition,
  type ExpressionGroup,
  type ExpressionLiteral,
  type ExpressionOperator,
} from '../../editor/conditionExpression';
import { dataTree } from '../../editor/dataSuggest';
import { readRichConditionExpression } from '../../editor/conditionExpressionRich';
import type { DataContext } from '../../editor/dataScope';
import type { TreeNode } from '../../editor/dataSample';

/** What a name holds, as far as the app can tell; `unknown` is typed by hand. */
export type ConditionValueKind = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'date' | 'unknown';

export interface ConditionValueType {
  readonly kind: ConditionValueKind;
  /** The values an enum takes; empty for every other kind. */
  readonly options: readonly string[];
}

const UNKNOWN: ConditionValueType = { kind: 'unknown', options: [] };

/** The type of `subject` in `context`, read from the same data tree the picker shows. */
export function valueTypeOf(context: DataContext | undefined, subject: string): ConditionValueType {
  assert(subject.length <= CONDITION_EXPRESSION_LIMITS.subjectCharsMax, 'valueTypeOf: the subject is bounded');
  if (context === undefined) {
    return UNKNOWN;
  }
  const node = findNode(dataTree(context), subject);
  if (node === undefined) {
    return UNKNOWN;
  }
  const kind = kindOfNode(node.kind);
  if (kind === 'enum') {
    const field = context.propsSchema?.find((entry) => entry.name === subject);
    return field?.options !== undefined && field.options.length > 0 ? { kind, options: field.options } : { kind: 'string', options: [] };
  }
  return { kind, options: [] };
}

function kindOfNode(kind: string): ConditionValueKind {
  switch (kind) {
    case 'text':
    case 'string':
      return 'string';
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    case 'list':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

// An iterative walk with a visit cap: the tree is data, and its size is not ours to trust.
function findNode(roots: readonly TreeNode[], path: string): TreeNode | undefined {
  const pending: TreeNode[] = [...roots];
  for (let visits = 0; pending.length > 0 && visits < LIMITS.treeNodesMax; visits += 1) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (node.path === path) {
      return node;
    }
    if (path.startsWith(node.path) && node.children !== undefined) {
      pending.push(...node.children);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Operators.
// ---------------------------------------------------------------------------

const OPERATOR_KEYS = {
  isTrue: 'props.condition.operator.isTrue',
  isFalse: 'props.condition.operator.isFalse',
  isSet: 'props.condition.operator.isSet',
  isNotSet: 'props.condition.operator.isNotSet',
  isEmpty: 'props.condition.operator.isEmpty',
  isNotEmpty: 'props.condition.operator.isNotEmpty',
  equals: 'props.condition.operator.equals',
  notEquals: 'props.condition.operator.notEquals',
  greaterThan: 'props.condition.operator.greaterThan',
  lessThan: 'props.condition.operator.lessThan',
  atLeast: 'props.condition.operator.atLeast',
  atMost: 'props.condition.operator.atMost',
  contains: 'props.condition.operator.contains',
  notContains: 'props.condition.operator.notContains',
  startsWith: 'props.condition.operator.startsWith',
  endsWith: 'props.condition.operator.endsWith',
  lengthEquals: 'props.condition.operator.lengthEquals',
  lengthGreaterThan: 'props.condition.operator.lengthGreaterThan',
  isAnyOf: 'props.conditional.operator.isAny',
  isNoneOf: 'props.conditional.operator.isNotAny',
} as const satisfies Record<ExpressionOperator, string>;

// What each kind of value can sensibly be asked, in menu order. A plain test of the name itself (`x`, `!x`) is
// "is true" on a switch and "is set" on everything else, which is how the owner of the code reads it; a name whose
// type is not known offers everything and says nothing.
const OPERATORS_BY_KIND: Readonly<Record<ConditionValueKind, readonly ExpressionOperator[]>> = {
  boolean: ['isTrue', 'isFalse'],
  string: ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty', 'equals', 'notEquals', 'isAnyOf', 'isNoneOf', 'contains', 'notContains', 'startsWith', 'endsWith'],
  enum: ['isTrue', 'isFalse', 'equals', 'notEquals', 'isAnyOf', 'isNoneOf'],
  number: ['equals', 'notEquals', 'isAnyOf', 'isNoneOf', 'greaterThan', 'atLeast', 'lessThan', 'atMost', 'isSet', 'isNotSet'],
  array: ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty', 'contains', 'notContains', 'lengthEquals', 'lengthGreaterThan'],
  object: ['isTrue', 'isFalse'],
  date: ['isTrue', 'isFalse'],
  unknown: [...EXPRESSION_OPERATORS],
};

/** Whether the kind reads a plain test of the name as "is set" rather than "is true". */
function truthyMeansSet(kind: ConditionValueKind): boolean {
  return kind !== 'boolean' && kind !== 'unknown';
}

/** The words an operator wears on a kind: the same code reads "is true" on a switch and "is set" on a text. */
export function operatorLabel(kind: ConditionValueKind, operator: ExpressionOperator, translate: Translator = ENGLISH_TRANSLATE): string {
  if (truthyMeansSet(kind)) {
    if (operator === 'isTrue') {
      return translate('props.condition.operator.isSet');
    }
    if (operator === 'isFalse') {
      return translate('props.condition.operator.isNotSet');
    }
    // `!= null` on a kind whose plain test already says "set": told apart by what it checks.
    if (operator === 'isSet' && OPERATORS_BY_KIND[kind].includes('isTrue')) {
      return translate('props.condition.operator.isNotNull');
    }
    if (operator === 'isNotSet' && OPERATORS_BY_KIND[kind].includes('isTrue')) {
      return translate('props.condition.operator.isNull');
    }
  }
  return translate(OPERATOR_KEYS[operator]);
}

/**
 * The operators a kind offers, in menu order, with their words; `keep` is the operator the code already uses,
 * offered even where the kind would not (a number tested for truthiness reads "is set", in place of `!= null`'s).
 */
export function operatorsFor(
  kind: ConditionValueKind,
  keep: ExpressionOperator | undefined,
  translate: Translator = ENGLISH_TRANSLATE,
): readonly { readonly value: ExpressionOperator; readonly label: string }[] {
  const listed = OPERATORS_BY_KIND[kind];
  let all: readonly ExpressionOperator[] = listed;
  if ((keep === 'isTrue' || keep === 'isFalse') && !listed.includes(keep)) {
    // The plain test replaces the null test where both would read "is set".
    const swapped = listed.map((operator): ExpressionOperator => (operator === 'isSet' ? 'isTrue' : operator === 'isNotSet' ? 'isFalse' : operator));
    all = swapped.includes(keep) ? swapped : [...swapped, keep];
  } else if (keep !== undefined && !listed.includes(keep)) {
    all = [...listed, keep];
  }
  return all.map((value) => ({ value, label: operatorLabel(kind, value, translate) }));
}

/** The operator a freshly chosen name starts with. */
export function defaultOperator(kind: ConditionValueKind): ExpressionOperator {
  assert(OPERATORS_BY_KIND[kind].length > 0, 'defaultOperator: every kind offers an operator');
  return kind === 'number' ? 'isSet' : 'isTrue';
}

// ---------------------------------------------------------------------------
// Values as typed.
// ---------------------------------------------------------------------------

const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/;
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * The literal the text typed in a row says for `kind` and `operator`, or
 * undefined while it is not a value yet (empty, or not a number where one is
 * needed). A name of unknown kind is typed by hand: `5` is a number, `true`
 * a switch, and `"5"` the words 5.
 */
export function literalOfText(kind: ConditionValueKind, operator: ExpressionOperator, text: string): ExpressionLiteral | undefined {
  assert(text.length <= LIMITS.attrCharsMax, 'literalOfText: the text is bounded');
  const typed = text.trim();
  if (typed === '') {
    return undefined;
  }
  const literal = literalOf(kind, operator, typed);
  return literal !== undefined && isWritableLiteral(literal) ? literal : undefined;
}

function literalOf(kind: ConditionValueKind, operator: ExpressionOperator, typed: string): ExpressionLiteral | undefined {
  if (operator === 'lengthEquals' || operator === 'lengthGreaterThan') {
    return WHOLE_NUMBER.test(typed) ? { kind: 'number', value: Number(typed) } : undefined;
  }
  if (operator === 'startsWith' || operator === 'endsWith') {
    return { kind: 'string', value: typed };
  }
  if (kind === 'number' || (kind === 'unknown' && ordersValues(operator) && PLAIN_NUMBER.test(typed))) {
    return PLAIN_NUMBER.test(typed) ? { kind: 'number', value: Number(typed) } : undefined;
  }
  if (kind === 'string' || kind === 'enum') {
    return { kind: 'string', value: typed };
  }
  const quote = typed.charAt(0);
  if (typed.length >= 2 && (quote === '"' || quote === "'") && typed.endsWith(quote)) {
    return { kind: 'string', value: typed.slice(1, -1) };
  }
  if (typed === 'true' || typed === 'false') {
    return { kind: 'boolean', value: typed === 'true' };
  }
  if (PLAIN_NUMBER.test(typed)) {
    return { kind: 'number', value: Number(typed) };
  }
  return { kind: 'string', value: typed };
}

/** A literal as the text a row shows: words that would read as a number or a switch are quoted where the kind is typed by hand. */
export function textOfLiteral(kind: ConditionValueKind, literal: ExpressionLiteral): string {
  if (literal.kind === 'number') {
    return String(literal.value);
  }
  if (literal.kind === 'boolean') {
    return literal.value ? 'true' : 'false';
  }
  const byHand = kind !== 'string' && kind !== 'enum' && kind !== 'number';
  const ambiguous = literal.value === 'true' || literal.value === 'false' || PLAIN_NUMBER.test(literal.value) || /^(["']).*\1$/.test(literal.value);
  return byHand && ambiguous ? `"${literal.value}"` : literal.value;
}

// ---------------------------------------------------------------------------
// The draft.
// ---------------------------------------------------------------------------

/** A condition as it is being chosen: no name yet, or a comparison with no value yet; or a locked part of the code. */
export interface ConditionRowDraft {
  readonly subject: string | undefined;
  readonly operator: ExpressionOperator;
  /** The value as typed. */
  readonly text: string;
  /** The values an Is any of / Is none of row holds, as chips. */
  readonly values?: readonly ExpressionLiteral[];
  /** Set on a part of the test the rows cannot draw: its code, kept as written and shown as a Computed chip. */
  readonly code?: string;
}

export interface ConditionGroupDraft {
  readonly match: GroupMatch;
  readonly conditions: readonly ConditionRowDraft[];
}

export interface ConditionExpressionDraft {
  readonly groups: readonly ConditionGroupDraft[];
  /** The comments the test opens with, written back first. */
  readonly leading?: string;
}

/** Finds the type of a name; the editor passes the data context's. */
export type TypeOfSubject = (subject: string) => ConditionValueType;

/** The draft a model opens as: always at least one row, so there is somewhere to start. */
export function draftOfExpression(model: ConditionExpression, typeOf: TypeOfSubject): ConditionExpressionDraft {
  if (model.groups.length === 0) {
    return { groups: [{ match: 'all', conditions: [blankRow()] }] };
  }
  const groups = model.groups.map((group) => ({
    match: group.match,
    conditions: group.conditions.map((condition) => rowOfCondition(condition, typeOf)),
  }));
  return model.leading === undefined ? { groups } : { groups, leading: model.leading };
}

/** The row a condition opens as: locked code keeps its text; a list keeps its values as chips. */
export function rowOfCondition(condition: ExpressionCondition, typeOf: TypeOfSubject): ConditionRowDraft {
  if (isCodeCondition(condition)) {
    assert(condition.code.length > 0, 'rowOfCondition: locked code is not blank');
    return { subject: undefined, operator: 'isTrue', text: '', code: condition.code };
  }
  if ('values' in condition) {
    assert(condition.values.length > 0, 'rowOfCondition: a list holds a value');
    return { subject: condition.subject, operator: condition.operator, text: '', values: condition.values };
  }
  const text = 'value' in condition ? textOfLiteral(typeOf(condition.subject).kind, condition.value) : '';
  return { subject: condition.subject, operator: condition.operator, text };
}

export function blankRow(): ConditionRowDraft {
  return { subject: undefined, operator: 'isTrue', text: '' };
}

/** The condition a row says, or undefined while the row is not finished. */
export function conditionOfRow(row: ConditionRowDraft, typeOf: TypeOfSubject): ExpressionCondition | undefined {
  if (row.code !== undefined) {
    return { kind: 'code', code: row.code }; // Locked: written back exactly as it was read.
  }
  if (row.subject === undefined) {
    return undefined;
  }
  if (!isConditionSubject(row.subject) && !isOptionalChainSubject(row.subject)) {
    return undefined;
  }
  if (takesValues(row.operator)) {
    const values = (row.values ?? []).filter(isWritableLiteral);
    return values.length === 0 ? undefined : { subject: row.subject, operator: row.operator, values };
  }
  if (!takesValue(row.operator)) {
    return { subject: row.subject, operator: row.operator };
  }
  const value = literalOfText(typeOf(row.subject).kind, row.operator, row.text);
  return value === undefined ? undefined : { subject: row.subject, operator: row.operator, value };
}

/** The model a draft writes as: finished rows only, and no group left with none. */
export function expressionOfDraft(draft: ConditionExpressionDraft, typeOf: TypeOfSubject): ConditionExpression {
  assert(draft.groups.length <= CONDITION_EXPRESSION_LIMITS.groupsMax, 'expressionOfDraft: the groups are bounded');
  const groups: ExpressionGroup[] = [];
  for (const group of draft.groups) {
    const conditions = group.conditions.flatMap((row) => {
      const condition = conditionOfRow(row, typeOf);
      return condition === undefined ? [] : [condition];
    });
    if (conditions.length > 0) {
      groups.push({ match: group.match, conditions });
    }
  }
  return draft.leading === undefined ? { groups } : { groups, leading: draft.leading };
}

export function withGroupAdded(draft: ConditionExpressionDraft): ConditionExpressionDraft {
  if (draft.groups.length >= CONDITION_EXPRESSION_LIMITS.groupsMax) {
    return draft;
  }
  return { ...draft, groups: [...draft.groups, { match: 'all', conditions: [blankRow()] }] };
}

export function withGroupRemoved(draft: ConditionExpressionDraft, index: number): ConditionExpressionDraft {
  assert(index >= 0, 'withGroupRemoved: the index is not negative');
  assert(index < draft.groups.length, 'withGroupRemoved: the group exists');
  const groups = draft.groups.filter((_, at) => at !== index);
  // The editor always keeps a row to start from.
  return { ...draft, groups: groups.length === 0 ? [{ match: 'all', conditions: [blankRow()] }] : groups };
}

export function withGroup(
  draft: ConditionExpressionDraft,
  index: number,
  change: (group: ConditionGroupDraft) => ConditionGroupDraft,
): ConditionExpressionDraft {
  assert(index >= 0, 'withGroup: the index is not negative');
  assert(index < draft.groups.length, 'withGroup: the group exists');
  return { ...draft, groups: draft.groups.map((group, at) => (at === index ? change(group) : group)) };
}

export function withRowAdded(group: ConditionGroupDraft): ConditionGroupDraft {
  if (group.conditions.length >= CONDITION_EXPRESSION_LIMITS.conditionsPerGroupMax) {
    return group;
  }
  return { ...group, conditions: [...group.conditions, blankRow()] };
}

export function withRow(group: ConditionGroupDraft, index: number, row: ConditionRowDraft): ConditionGroupDraft {
  assert(index >= 0, 'withRow: the index is not negative');
  assert(index < group.conditions.length, 'withRow: the row exists');
  return { ...group, conditions: group.conditions.map((existing, at) => (at === index ? row : existing)) };
}

/**
 * A locked part after its code was edited: the rows the new code reads as, in its place, when it is one run of
 * `&&` the rows can draw (`variant === "main"` becomes Variant equals main); otherwise one locked part holding it.
 */
export function rowsOfEditedCode(code: string, typeOf: TypeOfSubject): readonly ConditionRowDraft[] {
  assert(code.trim().length > 0, 'rowsOfEditedCode: the code is not blank');
  const model = readRichConditionExpression(code);
  const [only] = model?.groups ?? [];
  if (model === undefined || model.groups.length !== 1 || only === undefined || model.leading !== undefined) {
    return [{ subject: undefined, operator: 'isTrue', text: '', code }];
  }
  if (only.match === 'any' && only.conditions.length > 1) {
    return [{ subject: undefined, operator: 'isTrue', text: '', code }]; // An `||` inside an `&&` group stays one part.
  }
  const rows = only.conditions.map((condition) => rowOfCondition(condition, typeOf));
  assert(rows.length > 0, 'rowsOfEditedCode: a read group holds a condition');
  return rows;
}

/** The group with the row at `index` replaced by `rows`, bounded by the group's limit. */
export function withRowReplaced(group: ConditionGroupDraft, index: number, rows: readonly ConditionRowDraft[]): ConditionGroupDraft {
  assert(index >= 0, 'withRowReplaced: the index is not negative');
  assert(index < group.conditions.length, 'withRowReplaced: the row exists');
  const conditions = [...group.conditions.slice(0, index), ...rows, ...group.conditions.slice(index + 1)];
  return conditions.length > CONDITION_EXPRESSION_LIMITS.conditionsPerGroupMax ? group : { ...group, conditions };
}

export function withRowRemoved(group: ConditionGroupDraft, index: number): ConditionGroupDraft {
  assert(index >= 0, 'withRowRemoved: the index is not negative');
  assert(index < group.conditions.length, 'withRowRemoved: the row exists');
  return { ...group, conditions: group.conditions.filter((_, at) => at !== index) };
}

/** A row after another name is chosen: the operator is kept when the new name offers it, else starts over. */
export function rowWithSubject(row: ConditionRowDraft, subject: string, type: ConditionValueType): ConditionRowDraft {
  const offered = operatorsFor(type.kind, undefined).some((option) => option.value === row.operator);
  return offered ? { ...row, subject } : { subject, operator: defaultOperator(type.kind), text: '' };
}

// ---------------------------------------------------------------------------
// The catalog: props, and the values the frontmatter computes from them.
// ---------------------------------------------------------------------------

/** The type a catalog entry tests as: an option prop is an enum of its options, a computed value a switch. */
export function typeOfCatalogEntry(entry: ConditionProp): ConditionValueType {
  if (entry.computed !== undefined) {
    return { kind: 'boolean', options: [] };
  }
  switch (entry.kind) {
    case 'option':
      return entry.options.length > 0 ? { kind: 'enum', options: entry.options } : { kind: 'string', options: [] };
    case 'switch':
      return { kind: 'boolean', options: [] };
    case 'text':
      return { kind: 'string', options: [] };
    case 'number':
      return { kind: 'number', options: [] };
    default: {
      const exhaustive: never = entry.kind;
      return exhaustive;
    }
  }
}

/**
 * The type of `subject`: the catalog's when it lists the name (so a computed
 * value is a switch and an option prop offers its options), else the data
 * tree's (a loop item's field, a collection entry).
 */
export function typeOfSubjectIn(catalog: readonly ConditionProp[], fallback: TypeOfSubject): TypeOfSubject {
  return (subject) => {
    const entry = catalog.find((candidate) => candidate.name === subject);
    return entry === undefined ? fallback(subject) : typeOfCatalogEntry(entry);
  };
}

/**
 * The row a computed value's row can be replaced by, when its definition is
 * one condition on a prop (`isWritten` is true is Variant is any of Main,
 * Link; is false, none of them), or undefined.
 */
export function plainerRow(row: ConditionRowDraft, catalog: readonly ConditionProp[]): ConditionRowDraft | undefined {
  if (row.code !== undefined || row.subject === undefined) {
    return undefined;
  }
  const entry = catalog.find((candidate) => candidate.name === row.subject);
  const equivalent = entry?.computed?.equivalent;
  if (equivalent === undefined) {
    return undefined;
  }
  let meant: Condition | undefined;
  if (row.operator === 'isTrue') {
    meant = equivalent;
  } else if (row.operator === 'isFalse') {
    meant = negatedCondition(equivalent);
  } else {
    return undefined;
  }
  return meant === undefined ? undefined : rowOfValueCondition(meant);
}

/** A Value conditions condition as a row: `in` one value is equals, more is Is any of; `notIn` the same, negated. */
export function rowOfValueCondition(condition: Condition): ConditionRowDraft | undefined {
  switch (condition.kind) {
    case 'code':
      return undefined;
    case 'test':
      return { subject: condition.subject, operator: condition.operator === 'truthy' ? 'isTrue' : 'isFalse', text: '' };
    case 'compare': {
      assert(condition.values.length > 0, 'rowOfValueCondition: a comparison has a value');
      const [only] = condition.values;
      if (condition.values.length === 1 && only !== undefined) {
        const text = only.kind === 'number' ? String(only.value) : only.value;
        return { subject: condition.subject, operator: condition.operator === 'in' ? 'equals' : 'notEquals', text };
      }
      return { subject: condition.subject, operator: condition.operator === 'in' ? 'isAnyOf' : 'isNoneOf', text: '', values: condition.values };
    }
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}
