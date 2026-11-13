// A field's validation as the Studio would run it, for the rules its schema
// states (sanityRules.ts): what is wrong, said plainly, and whether it blocks
// publishing. The checks are the rule builder's own meanings — a minimum on
// text is characters, on a list is items, on a number is the value.

import { assert } from '../../../shared/core/assert';
import { remoteList, remoteObject, type RemoteRule, type RemoteSchemaField, type RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteDocument } from '../../../shared/properties/cmsRemote';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { fieldTitle, isEmptyValue } from './remoteValues';

export interface RemoteProblem {
  readonly level: RemoteRule['level'];
  /** The rule that is broken, so a caller can tell `required` apart without comparing words. */
  readonly rule: RemoteRule['kind'];
  readonly message: string;
}

/** What is wrong with one field's value, by its rules; nothing when it passes. */
export function problemsOf(
  field: Pick<RemoteSchemaField, 'rules'>,
  value: RemoteValue | undefined,
  translate: Translator = ENGLISH_TRANSLATE,
): RemoteProblem[] {
  const problems: RemoteProblem[] = [];
  for (const rule of field.rules) {
    const message = check(rule, value, translate);
    if (message !== undefined) {
      problems.push({ level: rule.level, rule: rule.kind, message });
    }
  }
  assert(problems.length <= field.rules.length, 'Each rule reports at most once');
  return problems;
}

/** The errors that keep a document from being published, each named by its field. */
export function publishBlockers(document: RemoteDocument, translate: Translator = ENGLISH_TRANSLATE): string[] {
  return document.fields.flatMap((field) =>
    problemsOf(field, field.value, translate)
      .filter((problem) => problem.level === 'error')
      .map((problem) => translate('cmsRemote.validation.fieldProblem', { field: fieldTitle(field), problem: problem.message })),
  );
}

/**
 * The required fields whose value is empty, by name, in the order the fields
 * come: blank or whitespace-only text, an empty list, an unset image or
 * reference (isEmptyValue). A field that is optional, defaulted or nullable is
 * never required (astroRemoteSchema.ts sets `required` from the schema), so it
 * never appears here. One rule for both the create and the save path of an
 * Astro content entry; a Sanity draft may be saved with them empty, and only
 * Publish waits for them (publishBlockers).
 */
export function requiredFieldsMissing(
  fields: readonly Pick<RemoteSchemaField, 'name' | 'required'>[],
  values: ReadonlyMap<string, RemoteValue | undefined>,
): readonly string[] {
  const missing = fields.filter((field) => field.required && isEmptyValue(values.get(field.name))).map((field) => field.name);
  assert(missing.length <= fields.length, 'Only given fields are missing');
  assert(new Set(missing).size === missing.length, 'Each field is missing once');
  return missing;
}

/** A document's values by field name, as requiredFieldsMissing reads them. */
export function valuesOf(document: Pick<RemoteDocument, 'fields'>): ReadonlyMap<string, RemoteValue | undefined> {
  const values = new Map(document.fields.map((field) => [field.name, field.value] as const));
  assert(values.size <= document.fields.length, 'One value per field');
  return values;
}

/**
 * Whether one field's edit to an existing entry may be written: refused while
 * it would leave that required field empty. Another field already empty does
 * not refuse it, since writing this one leaves the file no less complete.
 */
export function saveRefused(field: Pick<RemoteSchemaField, 'name' | 'required'>, value: RemoteValue | undefined): boolean {
  const missing = requiredFieldsMissing([field], new Map([[field.name, value]]));
  assert(missing.length <= 1, 'One field checked');
  return missing.length === 1;
}

/** What an empty required field says under its control. */
export function requiredMessage(field: Pick<RemoteSchemaField, 'name' | 'title'>, translate: Translator = ENGLISH_TRANSLATE): string {
  return translate('cmsRemote.validation.requiredField', { field: fieldTitle(field) });
}

function check(rule: RemoteRule, value: RemoteValue | undefined, translate: Translator): string | undefined {
  // An empty field breaks only `required`; every other rule checks a value that is there.
  if (isEmptyValue(value)) {
    return rule.kind === 'required' ? translate('cmsRemote.validation.required') : undefined;
  }
  switch (rule.kind) {
    case 'required':
      return undefined;
    case 'min':
    case 'max':
    case 'length':
      return limitProblem(rule.kind, rule.limit, value, translate);
    case 'email':
      return typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? translate('cmsRemote.validation.email') : undefined;
    case 'uri':
      return typeof value === 'string' && !validLink(value, rule) ? translate('cmsRemote.validation.link') : undefined;
    case 'unique':
      return duplicated(value) ? translate('cmsRemote.validation.unique') : undefined;
    case 'integer':
      return typeof value === 'number' && !Number.isInteger(value) ? translate('cmsRemote.validation.integer') : undefined;
    case 'positive':
      return typeof value === 'number' && value < 0 ? translate('cmsRemote.validation.positive') : undefined;
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function limitProblem(kind: 'min' | 'max' | 'length', limit: number, value: RemoteValue | undefined, translate: Translator): string | undefined {
  const list = remoteList(value);
  const measured = list?.length ?? (typeof value === 'string' ? value.length : value);
  if (typeof measured !== 'number') {
    return undefined;
  }
  // What the limit counts: items of a list, characters of a text, or the number itself.
  const unit = list !== undefined ? 'Items' : typeof value === 'string' ? 'Characters' : 'Value';
  if (kind === 'min') {
    return measured < limit ? limitMessage('atLeast', unit, limit, translate) : undefined;
  }
  if (kind === 'max') {
    return measured > limit ? limitMessage('atMost', unit, limit, translate) : undefined;
  }
  return measured === limit ? undefined : limitMessage('exactly', unit, limit, translate);
}

// "At least 3 items", "At most 80 characters", "Exactly 5": counted units take a plural, a bare number does not.
function limitMessage(bound: 'atLeast' | 'atMost' | 'exactly', unit: 'Items' | 'Characters' | 'Value', limit: number, translate: Translator): string {
  switch (unit) {
    case 'Items':
      return translate(`cmsRemote.validation.${bound}Items`, { count: limit });
    case 'Characters':
      return translate(`cmsRemote.validation.${bound}Characters`, { count: limit });
    case 'Value':
      return translate(`cmsRemote.validation.${bound}Value`, { limit });
    default: {
      const exhaustive: never = unit;
      return exhaustive;
    }
  }
}

function validLink(value: string, rule: Extract<RemoteRule, { kind: 'uri' }>): boolean {
  if (value.startsWith('/')) {
    return rule.relative;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return false;
  }
  return rule.schemes.includes(scheme);
}

// Items compared by content, ignoring the keys Sanity gives each one.
function duplicated(value: RemoteValue | undefined): boolean {
  const items = remoteList(value) ?? [];
  const seen = new Set(
    items.map((item) => {
      const object = remoteObject(item);
      if (object === undefined) {
        return JSON.stringify(item);
      }
      return JSON.stringify(Object.entries(object).filter(([key]) => key !== '_key'));
    }),
  );
  return seen.size < items.length;
}
