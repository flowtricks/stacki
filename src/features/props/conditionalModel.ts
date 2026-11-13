// What the Value conditions editor works on: the component's props a
// condition can test (with each one's kind and options), the draft being
// edited (conditions may still be half-chosen), the operators each kind of
// prop offers, and the read-only summary a field shows once it is
// conditional. Pure, so the rules are pinned by tests without a renderer;
// the model and its code live in src/editor/conditionalValue.ts.

import { assert } from '../../../shared/core/assert';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr } from '../../../shared/page/pageNode';
import type { SchemaField } from '../../editor/dataScope';
import { readPropsDestructure } from '../../editor/loopProps';
import {
  CONDITIONAL_LIMITS,
  conditionalAttr,
  isReferencePath,
  parseConditionalValue,
  readConditionalExpression,
  sameLiteral,
  type Condition,
  type ConditionLiteral,
  type ConditionalResult,
  type ConditionalValue,
  type GroupMatch,
  type TemplatePart,
  type WriteOptions,
  type ClassListValue,
  CLASS_LIST_LIMITS,
  emitClassListExpression,
  parseClassListValue,
  quoteOf,
  readClassListExpression,
} from '../../editor/conditionalValue';
import { titled } from './loopCatalog';

/** How a prop is tested: a choice of options, a switch, words or a number. */
export type ConditionPropKind = 'option' | 'switch' | 'text' | 'number';

/** A prop a condition can test, by the name the markup reads it by. */
export interface ConditionProp {
  readonly name: string;
  readonly label: string;
  readonly kind: ConditionPropKind;
  /** The values an option prop can take; empty for every other kind. */
  readonly options: readonly string[];
}

/** The schema as the catalog reads it: a field's type and, for a choice, its options. */
export type ConditionSchemaField = Pick<SchemaField, 'name' | 'type' | 'options'>;

/**
 * The props a condition can test: every prop the component destructures
 * (by its local name) and every other prop its `interface Props` declares,
 * less those whose value is structure (a slot, a list, code, attributes).
 */
export function conditionProps(frontmatter: string, schema: readonly ConditionSchemaField[]): readonly ConditionProp[] {
  assert(schema.length <= LIMITS.propSchemaFieldsMax, 'conditionProps: the schema is bounded');
  const entries = readPropsDestructure(frontmatter)?.entries ?? [];
  const out: ConditionProp[] = [];
  const seen = new Set<string>();
  const add = (key: string, local: string): void => {
    const field = schema.find((candidate) => candidate.name === key);
    const kind = kindOf(field);
    if (kind === undefined || seen.has(local) || !isReferencePath(local)) {
      return;
    }
    seen.add(local);
    out.push({ name: local, label: titled(local), kind, options: kind === 'option' ? (field?.options ?? []) : [] });
  };
  for (const entry of entries) {
    add(entry.key, entry.local);
  }
  const aliased = new Set(entries.map((entry) => entry.key));
  for (const field of schema) {
    if (!aliased.has(field.name)) {
      add(field.name, field.name);
    }
  }
  assert(out.length <= entries.length + schema.length, 'conditionProps: one entry per prop at most');
  return out;
}

function kindOf(field: ConditionSchemaField | undefined): ConditionPropKind | undefined {
  const type = field?.type;
  if (type === undefined || type === 'string' || type === 'text' || type === 'prop' || type === 'other') {
    return 'text';
  }
  if (type === 'boolean') {
    return 'switch';
  }
  if (type === 'number') {
    return 'number';
  }
  if (type === 'enum') {
    return (field?.options?.length ?? 0) > 0 ? 'option' : 'text';
  }
  return undefined; // Structure: a slot, a list, an object, code or attributes.
}

/** The catalog's entry for `subject`, or one made up for a name the catalog does not hold (code may test any name in scope). */
export function propOf(catalog: readonly ConditionProp[], subject: string): ConditionProp {
  const found = catalog.find((prop) => prop.name === subject);
  return found ?? { name: subject, label: titled(subject), kind: 'text', options: [] };
}

// ---------------------------------------------------------------------------
// Operators.
// ---------------------------------------------------------------------------

export type DraftOperator = Condition['operator'];

/** The "all / any" choice of a group, with its words. */
export function matchOptions(translate: Translator = ENGLISH_TRANSLATE): readonly { readonly value: GroupMatch; readonly label: string }[] {
  return [
    { value: 'all', label: translate('props.conditional.match.all') },
    { value: 'any', label: translate('props.conditional.match.any') },
  ];
}

/** The operators a kind of prop offers, in menu order, with their words. */
export function operatorsFor(
  kind: ConditionPropKind,
  translate: Translator = ENGLISH_TRANSLATE,
): readonly { readonly value: DraftOperator; readonly label: string }[] {
  switch (kind) {
    case 'option':
      return [
        { value: 'in', label: translate('props.conditional.operator.isAny') },
        { value: 'notIn', label: translate('props.conditional.operator.isNotAny') },
        { value: 'truthy', label: translate('props.conditional.operator.isSet') },
        { value: 'falsy', label: translate('props.conditional.operator.isEmpty') },
      ];
    case 'switch':
      return [
        { value: 'truthy', label: translate('props.conditional.operator.isTrue') },
        { value: 'falsy', label: translate('props.conditional.operator.isFalse') },
      ];
    case 'text':
    case 'number':
      return [
        { value: 'in', label: translate('props.conditional.operator.equals') },
        { value: 'notIn', label: translate('props.conditional.operator.notEquals') },
        { value: 'truthy', label: translate('props.conditional.operator.isSet') },
        { value: 'falsy', label: translate('props.conditional.operator.isEmpty') },
      ];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Whether `operator` compares with values (and so needs some). */
export function takesValues(operator: DraftOperator): boolean {
  return operator === 'in' || operator === 'notIn';
}

// ---------------------------------------------------------------------------
// The draft.
// ---------------------------------------------------------------------------

/** A condition as it is being chosen: no prop yet, or a comparison with no value yet. */
export interface ConditionDraft {
  readonly subject: string | undefined;
  readonly operator: DraftOperator;
  readonly values: readonly ConditionLiteral[];
}

export interface GroupDraft {
  readonly match: GroupMatch;
  readonly conditions: readonly ConditionDraft[];
  readonly value: ConditionalResult;
}

export interface ConditionalDraft {
  readonly groups: readonly GroupDraft[];
  readonly otherwise: ConditionalResult;
}

/** The draft a model opens as. */
export function draftOf(model: ConditionalValue): ConditionalDraft {
  return {
    otherwise: model.otherwise,
    groups: model.groups.map((group) => ({
      match: group.match,
      value: group.value,
      conditions: group.conditions.map((condition) => ({
        subject: condition.subject,
        operator: condition.operator,
        values: condition.kind === 'compare' ? condition.values : [],
      })),
    })),
  };
}

/**
 * The model a draft applies as: a condition not yet chosen in full is left
 * out, and so is a group left with none, so closing the editor half-way
 * writes only what was finished.
 */
export function modelOf(draft: ConditionalDraft): ConditionalValue {
  assert(draft.groups.length <= CONDITIONAL_LIMITS.groupsMax, 'modelOf: the groups are bounded');
  const groups = draft.groups
    .map((group) => ({ match: group.match, value: group.value, conditions: group.conditions.flatMap((condition) => completed(condition)) }))
    .filter((group) => group.conditions.length > 0);
  const parsed = parseConditionalValue({ groups, otherwise: draft.otherwise });
  assert(parsed.ok, `modelOf: a finished draft is a valid model (${parsed.ok ? '' : parsed.error})`);
  return parsed.value;
}

function completed(condition: ConditionDraft): readonly Condition[] {
  const subject = condition.subject;
  if (subject === undefined) {
    return [];
  }
  switch (condition.operator) {
    case 'truthy':
    case 'falsy':
      return [{ kind: 'test', subject, operator: condition.operator }];
    case 'in':
    case 'notIn':
      return condition.values.length === 0 ? [] : [{ kind: 'compare', subject, operator: condition.operator, values: condition.values }];
    default: {
      const exhaustive: never = condition.operator;
      return exhaustive;
    }
  }
}

/** A new condition: on the first prop, with that prop's first operator. */
export function newCondition(catalog: readonly ConditionProp[]): ConditionDraft {
  const [first] = catalog;
  const [operator] = operatorsFor(first?.kind ?? 'text');
  assert(operator !== undefined, 'newCondition: every kind has an operator');
  return { subject: first?.name, operator: operator.value, values: [] };
}

/** A new group: one new condition, leaving the attribute out until a value is typed. */
export function newGroup(catalog: readonly ConditionProp[]): GroupDraft {
  return { match: 'all', conditions: [newCondition(catalog)], value: { kind: 'none', word: 'undefined' } };
}

/** The draft with a group added at the end, while the bound allows one. */
export function withGroupAdded(draft: ConditionalDraft, catalog: readonly ConditionProp[]): ConditionalDraft {
  if (draft.groups.length >= CONDITIONAL_LIMITS.groupsMax) {
    return draft;
  }
  const next = { ...draft, groups: [...draft.groups, newGroup(catalog)] };
  assert(next.groups.length <= CONDITIONAL_LIMITS.groupsMax, 'withGroupAdded: the groups stay bounded');
  return next;
}

/**
 * The draft with group `source` placed at drop slot `target`, measured before
 * removal as the list reorder measures it (useListReorder.ts). Order is the
 * order groups are tried in: the first that holds gives the value.
 */
export function withGroupMoved(draft: ConditionalDraft, source: number, target: number): ConditionalDraft {
  assert(source >= 0, 'withGroupMoved: a moved group has a place');
  assert(source < draft.groups.length, 'withGroupMoved: the moved group exists');
  assert(target >= 0, 'withGroupMoved: a drop slot has a place');
  assert(target <= draft.groups.length, 'withGroupMoved: the drop slot is inside the list');
  const groups = [...draft.groups];
  const [group] = groups.splice(source, 1);
  assert(group !== undefined, 'withGroupMoved: the group was taken out');
  groups.splice(target > source ? target - 1 : target, 0, group);
  return { ...draft, groups };
}

export function withGroupRemoved(draft: ConditionalDraft, groupIndex: number): ConditionalDraft {
  assert(groupIndex >= 0, 'withGroupRemoved: an index is never negative');
  assert(groupIndex < draft.groups.length, 'withGroupRemoved: the group exists');
  return { ...draft, groups: draft.groups.filter((_, index) => index !== groupIndex) };
}

/** The draft with group `groupIndex` replaced by what `change` makes of it. */
export function withGroup(draft: ConditionalDraft, groupIndex: number, change: (group: GroupDraft) => GroupDraft): ConditionalDraft {
  assert(groupIndex >= 0, 'withGroup: an index is never negative');
  assert(groupIndex < draft.groups.length, 'withGroup: the group exists');
  return { ...draft, groups: draft.groups.map((group, index) => (index === groupIndex ? change(group) : group)) };
}

export function withConditionAdded(group: GroupDraft, catalog: readonly ConditionProp[]): GroupDraft {
  if (group.conditions.length >= CONDITIONAL_LIMITS.conditionsPerGroupMax) {
    return group;
  }
  return { ...group, conditions: [...group.conditions, newCondition(catalog)] };
}

/** The group without condition `conditionIndex`; a group's last condition goes with the group (withGroupRemoved). */
export function withConditionRemoved(group: GroupDraft, conditionIndex: number): GroupDraft {
  assert(conditionIndex >= 0, 'withConditionRemoved: an index is never negative');
  assert(conditionIndex < group.conditions.length, 'withConditionRemoved: the condition exists');
  return { ...group, conditions: group.conditions.filter((_, index) => index !== conditionIndex) };
}

export function withCondition(group: GroupDraft, conditionIndex: number, condition: ConditionDraft): GroupDraft {
  assert(conditionIndex >= 0, 'withCondition: an index is never negative');
  assert(conditionIndex < group.conditions.length, 'withCondition: the condition exists');
  return { ...group, conditions: group.conditions.map((current, index) => (index === conditionIndex ? condition : current)) };
}

/** The condition on another prop: its operator kept when the new prop offers it, its values only when the kind is the same. */
export function withSubject(condition: ConditionDraft, catalog: readonly ConditionProp[], subject: string): ConditionDraft {
  const before = condition.subject === undefined ? undefined : propOf(catalog, condition.subject);
  const after = propOf(catalog, subject);
  const offered = operatorsFor(after.kind);
  const [first] = offered;
  assert(first !== undefined, 'withSubject: every kind has an operator');
  const operator = offered.some((option) => option.value === condition.operator) ? condition.operator : first.value;
  const values = before?.kind === after.kind && takesValues(operator) ? condition.values : [];
  return { subject, operator, values };
}

/** The condition with one more value, unless it already holds it or holds as many as allowed. */
export function withValueAdded(condition: ConditionDraft, value: ConditionLiteral): ConditionDraft {
  if (condition.values.some((current) => sameLiteral(current, value))) {
    return condition;
  }
  if (condition.values.length >= CONDITIONAL_LIMITS.valuesPerConditionMax) {
    return condition;
  }
  return { ...condition, values: [...condition.values, value] };
}

/** What a typed value is for a prop of `kind`: a number for a number prop, when it reads as one. */
export function literalOfInput(kind: ConditionPropKind, text: string): ConditionLiteral | undefined {
  const trimmed = text.trim();
  if (kind !== 'number') {
    return text.length === 0 || text.length > LIMITS.attrCharsMax ? undefined : { kind: 'string', value: text };
  }
  if (trimmed === '') {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? { kind: 'number', value } : undefined;
}

// ---------------------------------------------------------------------------
// Fields: what a field's value starts a conditional from, and the attribute a
// conditional is written back as.
// ---------------------------------------------------------------------------

/** The conditional a field's value is, or undefined for any other value. */
export function conditionalOfAttr(value: Attr | undefined): ConditionalValue | undefined {
  return value?.type === 'expr' ? readConditionalExpression(value.value) : undefined;
}

/**
 * The value a field holds now as a branch's value: words, a name in scope,
 * words with values in them, or no value. Undefined for code a branch cannot
 * hold (a call, an escape in a template), so making it conditional is not
 * offered rather than offered and lossy.
 */
export function resultOfAttr(value: Attr | undefined): ConditionalResult | undefined {
  // No attribute is a branch that leaves it out; a bare one (`hidden`) is there, empty.
  if (value === undefined) {
    return { kind: 'none', word: 'undefined' };
  }
  if (value.type === 'bare') {
    return { kind: 'text', text: '' };
  }
  switch (value.type) {
    case 'string':
      return { kind: 'text', text: value.value };
    case 'expr':
      return resultOfCode(value.value.trim());
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

// One branch value as code, read by the model's own reader: `x ? <code> : ''`
// holds exactly the branches it can read, so the two can never disagree.
function resultOfCode(code: string): ConditionalResult | undefined {
  if (code === '') {
    return { kind: 'text', text: '' };
  }
  const read = readConditionalExpression(`x ? ${code} : ''`);
  const [only] = read?.groups ?? [];
  return read?.groups.length === 1 ? only?.value : undefined;
}

/** The model the editor opens on for a field: its conditional, or a new one whose Else is what the field holds. */
export function startingConditional(value: Attr | undefined, catalog: readonly ConditionProp[]): ConditionalDraft | undefined {
  const existing = conditionalOfAttr(value);
  if (existing !== undefined) {
    return draftOf(existing);
  }
  const otherwise = resultOfAttr(value);
  return otherwise === undefined ? undefined : { groups: [newGroup(catalog)], otherwise };
}

/** What closing the editor writes: nothing when the field already holds it, else the attribute (undefined leaves it out). */
export type AppliedValue = { readonly kind: 'unchanged' } | { readonly kind: 'write'; readonly value: Attr | undefined };

export function appliedAttr(draft: ConditionalDraft, before: Attr | undefined, options: WriteOptions = { quote: "'" }): AppliedValue {
  const next = conditionalAttr(modelOf(draft), options);
  return sameAttr(next, before) ? { kind: 'unchanged' } : { kind: 'write', value: next };
}

/**
 * How a field's code is written: in the quote its own code uses, else the one
 * the file's frontmatter uses, else single quotes.
 */
export function writeOptionsFor(before: Attr | undefined, frontmatter: string): WriteOptions {
  const own = before?.type === 'expr' ? quoteOf(before.value) : undefined;
  return { quote: own ?? quoteOf(frontmatter) ?? "'" };
}

/** A branch value as the attribute a field holds, for the field that edits it (BindField). */
export function attrOfResult(result: ConditionalResult): Attr | undefined {
  return conditionalAttr({ groups: [], otherwise: result });
}

function sameAttr(left: Attr | undefined, right: Attr | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.type === 'bare' || right.type === 'bare') {
    return left.type === right.type;
  }
  return left.type === right.type && left.value.trim() === right.value.trim();
}

// ---------------------------------------------------------------------------
// The summary.
// ---------------------------------------------------------------------------

/** One line of a conditional's summary: `If all are true`, its conditions, and the value it gives. */
export interface SummaryLine {
  readonly heading: string;
  readonly bullets: readonly string[];
  readonly value: ConditionalResult;
}

/** The summary a conditional field shows: one line per group, then the Else. */
export function summaryLines(model: ConditionalValue, catalog: readonly ConditionProp[], translate: Translator = ENGLISH_TRANSLATE): readonly SummaryLine[] {
  const lines: SummaryLine[] = model.groups.map((group) => {
    const words = group.conditions.map((condition) => conditionWords(condition, catalog, translate));
    const [only] = words;
    if (words.length === 1 && only !== undefined) {
      return { heading: translate('props.conditional.summary.if', { condition: only }), bullets: [], value: group.value };
    }
    return {
      heading: group.match === 'all' ? translate('props.conditional.summary.allTrue') : translate('props.conditional.summary.anyTrue'),
      bullets: words,
      value: group.value,
    };
  });
  lines.push({ heading: translate('props.conditional.summary.else'), bullets: [], value: model.otherwise });
  assert(lines.length === model.groups.length + 1, 'summaryLines: one line per group and the Else');
  return lines;
}

/** A condition in words: `Theme = Dark`, `Padding Top ≠ Small`, `Shown is true`. */
export function conditionWords(condition: Condition, catalog: readonly ConditionProp[], translate: Translator = ENGLISH_TRANSLATE): string {
  const prop = propOf(catalog, condition.subject);
  switch (condition.kind) {
    case 'test':
      if (condition.operator === 'truthy') {
        return translate(prop.kind === 'switch' ? 'props.conditional.words.isTrue' : 'props.conditional.words.isSet', { subject: prop.label });
      }
      return translate(prop.kind === 'switch' ? 'props.conditional.words.isFalse' : 'props.conditional.words.isEmpty', { subject: prop.label });
    case 'compare': {
      const values = condition.values.map((value) => literalWords(value, prop.kind));
      const [only] = values;
      if (values.length === 1 && only !== undefined) {
        return translate(condition.operator === 'in' ? 'props.conditional.words.equals' : 'props.conditional.words.notEquals', {
          subject: prop.label,
          value: only,
        });
      }
      return translate(condition.operator === 'in' ? 'props.conditional.words.isAnyOf' : 'props.conditional.words.isNoneOf', {
        subject: prop.label,
        values: values.join(', '),
      });
    }
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * The language a field's words are in, which its branch values are edited and
 * shown in: a style attribute's declarations, or plain words.
 */
export type ValueLanguage = 'text' | 'css';

/** The language of the field named `name`: a style attribute holds declarations. */
export function valueLanguageOf(name: string): ValueLanguage {
  return name.trim().toLowerCase() === 'style' ? 'css' : 'text';
}

/** A branch's words with `${name}` where its values go, as a code field edits them. */
export function bodyOfResult(result: ConditionalResult): string {
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'reference':
      return `\${${result.path}}`;
    case 'template':
      return result.parts.map((part) => (part.kind === 'text' ? part.text : `\${${part.path}}`)).join('');
    case 'none':
      return '';
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

const HOLE = /\$\{([^{}]*)\}/g;

/**
 * The branch value a code field's text is: words, or words with `${name}`
 * values in them. Undefined for text the model cannot hold as it is (a hole
 * that is not a name, a backtick or a backslash in a template).
 */
export function resultOfBody(body: string): ConditionalResult | undefined {
  if (body.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const match of body.matchAll(HOLE)) {
    const path = (match[1] ?? '').trim();
    if (!isReferencePath(path) || parts.length + 2 > CONDITIONAL_LIMITS.templatePartsMax) {
      return undefined;
    }
    if (match.index > at) {
      parts.push({ kind: 'text', text: body.slice(at, match.index) });
    }
    parts.push({ kind: 'reference', path });
    at = match.index + match[0].length;
  }
  if (at < body.length) {
    parts.push({ kind: 'text', text: body.slice(at) });
  }
  if (!parts.some((part) => part.kind === 'reference')) {
    return { kind: 'text', text: body };
  }
  const parsed = parseConditionalValue({ groups: [], otherwise: { kind: 'template', parts } });
  return parsed.ok ? parsed.value.otherwise : undefined;
}

/** A branch value in words, for a screen reader and a title: No value, a template's text with its names in braces. */
export function resultWords(result: ConditionalResult): string {
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'reference':
      return `{${result.path}}`;
    case 'template':
      return result.parts.map((part) => (part.kind === 'text' ? part.text : `{${part.path}}`)).join('');
    case 'none':
      return '(left out)';
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/** A literal as the menus show it: an option titled as its menu titles it, words and numbers as they are. */
export function literalWords(value: ConditionLiteral, kind: ConditionPropKind): string {
  if (value.kind === 'number') {
    return String(value.value);
  }
  return kind === 'option' ? titled(value.value) : value.value;
}

// ---------------------------------------------------------------------------
// Class lists (`class:list`): entries, each a class given always or only when.
// ---------------------------------------------------------------------------

/** A class-list entry as it is edited: its class may still be empty (`none`), its conditions half-chosen. */
export interface ClassEntryDraft {
  readonly value: ConditionalResult;
  readonly match: GroupMatch;
  readonly when: readonly ConditionDraft[];
}

export interface ClassListDraft {
  readonly entries: readonly ClassEntryDraft[];
}

/** The class list a `class:list` value is, or undefined for any other value. */
export function classListOfAttr(value: Attr | undefined): ClassListValue | undefined {
  return value?.type === 'expr' ? readClassListExpression(value.value) : undefined;
}

export function classDraftOf(model: ClassListValue): ClassListDraft {
  return {
    entries: model.entries.map((entry) => ({
      value: entry.value,
      match: entry.match,
      when: entry.when.map((condition) => ({
        subject: condition.subject,
        operator: condition.operator,
        values: condition.kind === 'compare' ? condition.values : [],
      })),
    })),
  };
}

/** The class list a draft applies as: an entry with no class is left out, and so is a condition not chosen in full. */
export function classModelOf(draft: ClassListDraft): ClassListValue {
  assert(draft.entries.length <= CLASS_LIST_LIMITS.entriesMax, 'classModelOf: the entries are bounded');
  const entries = draft.entries.flatMap((entry) =>
    entry.value.kind === 'none' || (entry.value.kind === 'text' && entry.value.text === '')
      ? []
      : [{ value: entry.value, match: entry.match, when: entry.when.flatMap((condition) => completed(condition)) }],
  );
  const parsed = parseClassListValue({ entries });
  assert(parsed.ok, `classModelOf: a finished draft is a valid class list (${parsed.ok ? '' : parsed.error})`);
  return parsed.value;
}

/** What closing the class-list editor writes: nothing when unchanged, the attribute left out when no class is left. */
export function appliedClassList(draft: ClassListDraft, before: Attr | undefined, options: WriteOptions): AppliedValue {
  const model = classModelOf(draft);
  const next: Attr | undefined = model.entries.length === 0 ? undefined : { type: 'expr', value: emitClassListExpression(model, options) };
  return sameAttr(next, before) ? { kind: 'unchanged' } : { kind: 'write', value: next };
}

/** A new entry: an empty class given always. */
export function newClassEntry(): ClassEntryDraft {
  return { value: { kind: 'none', word: 'undefined' }, match: 'all', when: [] };
}

export function withClassEntryAdded(draft: ClassListDraft): ClassListDraft {
  if (draft.entries.length >= CLASS_LIST_LIMITS.entriesMax) {
    return draft;
  }
  return { entries: [...draft.entries, newClassEntry()] };
}

export function withClassEntry(draft: ClassListDraft, index: number, change: (entry: ClassEntryDraft) => ClassEntryDraft): ClassListDraft {
  assert(index >= 0, 'withClassEntry: an index is never negative');
  assert(index < draft.entries.length, 'withClassEntry: the entry exists');
  return { entries: draft.entries.map((entry, at) => (at === index ? change(entry) : entry)) };
}

export function withClassEntryRemoved(draft: ClassListDraft, index: number): ClassListDraft {
  assert(index >= 0, 'withClassEntryRemoved: an index is never negative');
  assert(index < draft.entries.length, 'withClassEntryRemoved: the entry exists');
  return { entries: draft.entries.filter((_, at) => at !== index) };
}

/** The list with entry `source` placed at drop slot `target`, measured before removal (useListReorder.ts). */
export function withClassEntryMoved(draft: ClassListDraft, source: number, target: number): ClassListDraft {
  assert(source >= 0, 'withClassEntryMoved: a moved entry has a place');
  assert(source < draft.entries.length, 'withClassEntryMoved: the moved entry exists');
  assert(target >= 0, 'withClassEntryMoved: a drop slot has a place');
  assert(target <= draft.entries.length, 'withClassEntryMoved: the drop slot is inside the list');
  const entries = [...draft.entries];
  const [entry] = entries.splice(source, 1);
  assert(entry !== undefined, 'withClassEntryMoved: the entry was taken out');
  entries.splice(target > source ? target - 1 : target, 0, entry);
  return { entries };
}

/** An entry's condition added, while its bound allows one. */
export function withWhenAdded(entry: ClassEntryDraft, catalog: readonly ConditionProp[]): ClassEntryDraft {
  if (entry.when.length >= CLASS_LIST_LIMITS.conditionsPerEntryMax) {
    return entry;
  }
  return { ...entry, when: [...entry.when, newCondition(catalog)] };
}

/** "only when Variant ≠ Inherit and …" (or "… or …" for any), or undefined for a class given always. */
export function whenWords(
  when: readonly Condition[],
  match: GroupMatch,
  catalog: readonly ConditionProp[],
  translate: Translator = ENGLISH_TRANSLATE,
): string | undefined {
  if (when.length === 0) {
    return undefined;
  }
  const joinKey = match === 'all' ? 'props.conditional.joinAnd' : 'props.conditional.joinOr';
  const words = when.map((condition) => conditionWords(condition, catalog, translate));
  const joined = words.reduce((left, right) => translate(joinKey, { left, right }));
  return translate('props.conditional.when', { conditions: joined });
}
