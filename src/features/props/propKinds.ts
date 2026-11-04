// What a prop's declared type asks the instance panel for, beyond its plain
// type: whether its value can only be set in code (an action, `any`, a
// promise), whether an object prop can be edited as its fields, which choices
// are written as expressions, and whether a string prop is a link. Pure, so
// PropField.tsx can ask and the tests can pin each answer.

import type { Attr } from '../../../shared/page/pageNode';
import type { FieldDefinition } from './propRules';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { objectFields } from './arrayValue';
import { isLinkName } from '../../editor/fieldNames';

/** How a prop whose value is set in code is shown: as a read-only row, as its fields, or as usual. */
export type CodeRowKind = 'action' | 'code' | undefined;

/**
 * Whether the field shows the read-only "Set in code" row. An action
 * (a function) always does: a designer never authors one, and the text box it
 * fell back to wrote a string the component then called. A value no field can
 * fill in (`any`, `unknown`, `object`, a promise) does while it is unset; once
 * set, it is shown as the expression it is.
 */
export function codeRowKind(field: Pick<FieldDefinition, 'codeKind'>, value: Attr | undefined): CodeRowKind {
  if (field.codeKind === 'function') {
    return 'action';
  }
  if (field.codeKind === 'opaque') {
    return value === undefined ? 'code' : undefined;
  }
  return undefined;
}

/** What the row shows as the prop's value: the value set, else the default, as code. */
export function codeRowValue(field: Pick<FieldDefinition, 'default'>, value: Attr | undefined): string | undefined {
  if (value !== undefined) {
    return value.type === 'bare' ? 'true' : value.type === 'string' ? JSON.stringify(value.value) : value.value;
  }
  if (field.default === undefined) {
    return undefined;
  }
  return typeof field.default === 'string' ? field.default : String(field.default);
}

// The starting value for each simple member type of an object with no value yet.
const BLANK_MEMBER: Readonly<Record<string, string>> = { string: '""', number: '0', boolean: 'false' };

/**
 * The object literal an object prop is edited from: the value set, else its
 * default, else one built from its members when each is a word, a number or a
 * yes/no (`{ label: "", count: 0, open: false }`). Undefined when it cannot be
 * shown as fields — a nested object, a call, a member of another kind — which
 * leaves it to code.
 */
export function objectSeed(field: Pick<FieldDefinition, 'default' | 'shape' | 'shapeIsList'>, valueText: string | undefined): string | undefined {
  if (valueText !== undefined && valueText !== '') {
    return objectFields(valueText) ? valueText : undefined;
  }
  if (typeof field.default === 'string') {
    return objectFields(field.default) ? field.default : undefined;
  }
  const members = field.shapeIsList === true ? undefined : field.shape;
  if (members === undefined || members.length === 0 || members.length > LIMITS.propSchemaFieldsMax) {
    return undefined;
  }
  const entries: string[] = [];
  for (const member of members) {
    const blank = BLANK_MEMBER[member.type];
    if (blank === undefined || !/^[A-Za-z_$][\w$]*$/.test(member.name)) {
      return undefined;
    }
    entries.push(`${member.name}: ${blank}`);
  }
  const seed = `{ ${entries.join(', ')} }`;
  assert(objectFields(seed)?.length === members.length, 'objectSeed: every member becomes a field');
  return seed;
}

// What a choice field says about how its options are written.
interface ChoiceWriting {
  readonly numeric?: boolean | undefined;
  readonly expressionOptions?: readonly string[] | undefined;
}

/** How a chosen option is written: `flag={true}` for an expression option, `size="sm"` for a word. */
export function optionAttr(field: ChoiceWriting, option: string): Attr {
  assert(option !== '', 'optionAttr: an option is never empty');
  const expression = field.numeric === true || (field.expressionOptions?.includes(option) ?? false);
  return { type: expression ? 'expr' : 'string', value: option };
}

/**
 * The value an option stands for, as the canvas preview takes it: a number for
 * a numeric option, the word otherwise. Undefined for `true` and `false`,
 * which the preview cannot carry; a choice holding them is not previewed.
 */
export function optionValue(field: ChoiceWriting, option: string): string | number | undefined {
  const expression = field.numeric === true || (field.expressionOptions?.includes(option) ?? false);
  if (!expression) {
    return option;
  }
  const number = Number(option);
  return Number.isFinite(number) ? number : undefined;
}

/** Whether every option of a choice can be previewed on the canvas (see optionValue). */
export function previewsOptions(field: ChoiceWriting): boolean {
  return !(field.expressionOptions ?? []).some((option) => option === 'true' || option === 'false');
}

/** Whether a string prop is a link: its name ends in `href`, `url` or `link` (fieldNames.ts). */
export function isLinkProp(field: Pick<FieldDefinition, 'name' | 'type'>): boolean {
  if (field.type !== 'string' && field.type !== 'other') {
    return false;
  }
  return isLinkName(field.name);
}
