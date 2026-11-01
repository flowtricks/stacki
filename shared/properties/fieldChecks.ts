// The checks a content collection's field can state, each one a zod method in
// the content config (astroSchemaEdit.ts writes and reads them):
//
//   text      .min() .max() .length()  characters; .regex() a pattern;
//             .startsWith() .endsWith() .includes(); .trim(); .toLowerCase()
//             or .toUpperCase()
//   number    .min() .max(); .gt() .lt() (exclusive); .int(); .positive()
//             .negative() .nonnegative() .nonpositive(); .multipleOf()
//   date      .min(new Date(…)) .max(new Date(…))
//   list      .min() .max() .length()  items
//   image     a width and height range, as Astro's docs refine an image
//   any       .nullable()
//
// with, beside them, an option field's values (`z.enum([…])`) and a default
// (`.default(…)`). Image file size is not among them: Astro's image metadata
// holds a width, a height and a format, not a size.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import type { SettingsFieldKind } from './collectionSettings';

export const FIELD_CHECK_LIMITS = {
  textCharsMax: 500,
  optionsMax: 100,
  optionCharsMax: 200,
} as const;

/** Every check, with the kind of value it takes. */
export const FIELD_CHECKS = {
  min: 'number',
  max: 'number',
  length: 'number',
  gt: 'number',
  lt: 'number',
  multipleOf: 'number',
  integer: 'flag',
  sign: 'sign',
  pattern: 'text',
  startsWith: 'text',
  endsWith: 'text',
  includes: 'text',
  trim: 'flag',
  letterCase: 'case',
  minDate: 'date',
  maxDate: 'date',
  minWidth: 'number',
  maxWidth: 'number',
  minHeight: 'number',
  maxHeight: 'number',
  nullable: 'flag',
} as const;

export type FieldCheckKey = keyof typeof FIELD_CHECKS;
export type NumberSign = 'positive' | 'negative' | 'nonnegative' | 'nonpositive';
export type LetterCase = 'lower' | 'upper';

type CheckValue<K extends FieldCheckKey> = {
  readonly number: number;
  readonly flag: boolean;
  readonly sign: NumberSign;
  readonly text: string;
  readonly case: LetterCase;
  readonly date: string;
}[(typeof FIELD_CHECKS)[K]];

/** A field's checks: each one set, or absent. */
export type FieldChecks = { readonly [K in FieldCheckKey]?: CheckValue<K> };

/** A default as a config can write it: text, a number, or a switch's state. */
export type FieldDefault = string | number | boolean;

const SIGNS: readonly NumberSign[] = ['positive', 'negative', 'nonnegative', 'nonpositive'];
const CASES: readonly LetterCase[] = ['lower', 'upper'];
const CHECK_KEYS = Object.keys(FIELD_CHECKS).filter(isCheckKey);

/** The checks a field of `kind` offers, in the order its settings show them. */
export function checksFor(kind: SettingsFieldKind): readonly FieldCheckKey[] {
  switch (kind) {
    case 'text':
    case 'richText':
    case 'link':
    case 'videoLink':
    case 'email':
    case 'phone':
    case 'color':
    case 'file':
      return [
        'min',
        'max',
        'length',
        'pattern',
        'startsWith',
        'endsWith',
        'includes',
        'trim',
        'letterCase',
        'nullable',
      ];
    case 'number':
      return ['min', 'max', 'integer', 'sign', 'gt', 'lt', 'multipleOf', 'nullable'];
    case 'date':
      return ['minDate', 'maxDate', 'nullable'];
    case 'image':
      return ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'nullable'];
    case 'multiImage':
    case 'multiReference':
    case 'list':
      return ['min', 'max', 'length', 'nullable'];
    case 'switch':
    case 'option':
    case 'reference':
    case 'group':
    case 'keyValue':
    case 'constant':
    case 'any':
      return ['nullable'];
    case 'other':
      return [];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** A field's checks from the wire: known keys, values of their kinds, ranges in order. */
export function parseFieldChecks(input: unknown): FieldChecks {
  const value = input === undefined ? {} : record(input);
  const checks: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isCheckKey(key)) {
      throw new Error(`Unknown field check ${key}.`);
    }
    if (entry !== undefined) {
      checks[key] = checkValue(key, entry);
    }
  }
  const parsed = fromRecord(checks);
  ordered(parsed.min, parsed.max, 'The minimum is larger than the maximum.');
  ordered(parsed.minWidth, parsed.maxWidth, 'The minimum width is larger than the maximum.');
  ordered(parsed.minHeight, parsed.maxHeight, 'The minimum height is larger than the maximum.');
  if (
    parsed.minDate !== undefined &&
    parsed.maxDate !== undefined &&
    parsed.minDate > parsed.maxDate
  ) {
    throw new Error('The earliest date is after the latest.');
  }
  return parsed;
}

/** An option field's values: a few, each a short line, none twice. */
export function parseFieldOptions(input: unknown): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > FIELD_CHECK_LIMITS.optionsMax) {
    throw new Error('An option field has 1 to 100 options.');
  }
  const items: readonly unknown[] = input;
  const options = items.map((item) => text(item).trim());
  if (
    options.some(
      (option) => option.length === 0 || option.length > FIELD_CHECK_LIMITS.optionCharsMax,
    )
  ) {
    throw new Error('An option is 1 to 200 characters.');
  }
  if (new Set(options).size !== options.length) {
    throw new Error('An option is listed twice.');
  }
  assert(options.length <= FIELD_CHECK_LIMITS.optionsMax, 'Options are bounded');
  return options;
}

export function parseFieldDefault(input: unknown): FieldDefault | undefined {
  if (input === undefined || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  const value = text(input);
  if (value.length > FIELD_CHECK_LIMITS.textCharsMax) {
    throw new Error('A default is at most 500 characters.');
  }
  return value;
}

function checkValue(key: FieldCheckKey, input: unknown): unknown {
  switch (FIELD_CHECKS[key]) {
    case 'number':
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        throw new Error(`${key} is a number.`);
      }
      return input;
    case 'flag':
      if (typeof input !== 'boolean') {
        throw new Error(`${key} is on or off.`);
      }
      return input;
    case 'sign':
      return oneOf(SIGNS, input, key);
    case 'case':
      return oneOf(CASES, input, key);
    case 'date': {
      const date = text(input);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        throw new Error(`${key} is a date.`);
      }
      return date;
    }
    case 'text': {
      const value = text(input);
      if (value.length === 0 || value.length > FIELD_CHECK_LIMITS.textCharsMax) {
        throw new Error(`${key} is 1 to 500 characters.`);
      }
      if (key === 'pattern') {
        assertPattern(value);
      }
      return value;
    }
    default:
      throw new Error(`Unknown field check ${key}.`);
  }
}

// A pattern is written into the config as a regular expression literal: it must be one.
function assertPattern(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new Error('The pattern is not a valid regular expression.');
  }
  if (pattern.includes('/') && !pattern.includes('\\/')) {
    throw new Error('Write a / in a pattern as \\/.');
  }
}

function oneOf<T extends string>(values: readonly T[], input: unknown, key: string): T {
  const found = values.find((value) => value === input);
  if (found === undefined) {
    throw new Error(`${key} is one of ${values.join(', ')}.`);
  }
  return found;
}

function ordered(low: number | undefined, high: number | undefined, message: string): void {
  if (low !== undefined && high !== undefined && low > high) {
    throw new Error(message);
  }
}

// The record's values were each checked against their key's kind just above.
function fromRecord(checks: Record<string, unknown>): FieldChecks {
  const out: { -readonly [K in FieldCheckKey]?: CheckValue<K> } = {};
  for (const key of CHECK_KEYS) {
    const value = checks[key];
    if (value !== undefined) {
      Object.assign(out, { [key]: value });
    }
  }
  return out;
}

function isCheckKey(key: string): key is FieldCheckKey {
  return Object.hasOwn(FIELD_CHECKS, key);
}
