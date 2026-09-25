// Source text is the revision token: edits cannot overwrite a newer disk revision.
import { boolean, count, list, object, optional, text } from './boundary';
import { LIMITS } from './limits';
import { toRecord } from './record';
import type { Result } from './result';

export const PROPERTY_LIMITS = {
  fieldsMax: LIMITS.propSchemaFieldsMax,
  sourceCharsMax: 2 * 1024 * 1024,
  textCharsMax: 32768,
  nameCharsMax: 128,
  filesMax: 10000,
  totalCharsMax: 32 * 1024 * 1024,
  nodesMax: 200000,
} as const;

export interface ComponentProperty {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly defaultValue: string;
  readonly description: string;
  readonly origin?: PropertyOrigin;
  readonly editing?: PropertyEditing;
  readonly conditions?: readonly string[];
}
export type PropertyEditing =
  | { readonly kind: 'editable' }
  | { readonly kind: 'override'; readonly reason: string }
  | { readonly kind: 'restricted'; readonly reason: string };
export interface PropertySource {
  readonly label: string;
  readonly expression: string;
  readonly line: number;
}
export interface PropertyOrigin {
  readonly declarations: readonly PropertySource[];
  readonly defaultValue?: PropertySource;
}
export interface ComponentProperties {
  readonly source: string;
  readonly properties: readonly ComponentProperty[];
  readonly frontmatter: string;
  readonly advanced: boolean;
}
export interface PropertyOptionRename {
  readonly from: string;
  readonly to: string;
}
export type PropertyChange =
  | {
      readonly kind: 'save';
      readonly originalName: string;
      readonly property: ComponentProperty;
      readonly optionRenames?: readonly PropertyOptionRename[];
    }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'order'; readonly names: readonly string[] }
  | { readonly kind: 'options'; readonly name: string; readonly type: string }
  | { readonly kind: 'source'; readonly frontmatter: string };

export function propertyText(input: unknown): string {
  const value = text(input);
  if (value.length > PROPERTY_LIMITS.textCharsMax) {
    throw new Error('Property text exceeds limit');
  }
  return value;
}
export function propertySource(input: unknown): string {
  const value = text(input);
  if (value.length > PROPERTY_LIMITS.sourceCharsMax) {
    throw new Error('Component source exceeds limit');
  }
  return value;
}
export function propertyName(input: unknown): string {
  const value = propertyText(input);
  if (value.length > PROPERTY_LIMITS.nameCharsMax) {
    throw new Error('Property name exceeds limit');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw new Error('Use a TypeScript identifier for the property name');
  }
  return value;
}
export function parseComponentProperty(input: unknown): ComponentProperty {
  return object({
    name: propertyLabel,
    type: propertyText,
    required: boolean,
    readonly: boolean,
    defaultValue: propertyText,
    description: propertyText,
    origin: optional(parsePropertyOrigin),
    editing: optional(parsePropertyEditing),
    conditions: optional((value) => propertyList(value, propertyText)),
  })(input);
}

function parsePropertyEditing(input: unknown): PropertyEditing {
  const value = toRecord(input);
  if (value?.['kind'] === 'editable') {
    return { kind: 'editable' };
  }
  if (value?.['kind'] === 'override' || value?.['kind'] === 'restricted') {
    const reason = propertyText(value['reason']);
    if (reason.trim()) {
      return { kind: value['kind'], reason };
    }
  }
  throw new Error('Invalid property editing permission');
}

function parsePropertyOrigin(input: unknown): PropertyOrigin {
  return object({
    declarations: (value) => propertyList(value, parsePropertySource),
    defaultValue: optional(parsePropertySource),
  })(input);
}

function parsePropertySource(input: unknown): PropertySource {
  const source = object({
    label: propertyText,
    expression: propertyText,
    line: count,
  })(input);
  if (!source.label.trim()) {
    throw new Error('Property source label must be nonempty');
  }
  if (source.line < 1 || source.line > PROPERTY_LIMITS.sourceCharsMax) {
    throw new Error('Property source line is out of bounds');
  }
  return source;
}
export function propertyList<T>(input: unknown, parse: (input: unknown) => T): readonly T[] {
  const values = list(parse)(input);
  if (values.length > PROPERTY_LIMITS.fieldsMax) {
    throw new Error('Too many component properties');
  }
  return values;
}
export function parsePropertyChange(input: unknown): PropertyChange {
  const value = toRecord(input);
  switch (value?.['kind']) {
    case 'save': {
      const saved = {
        kind: 'save',
        ...object({
          originalName: propertyText,
          property: parseEditableProperty,
        })(input),
      } as const;
      const optionRenames = optional((item) => propertyList(item, parsePropertyOptionRename))(
        value['optionRenames']
      );
      return optionRenames === undefined ? saved : { ...saved, optionRenames };
    }
    case 'remove':
      return { kind: 'remove', name: propertyName(value['name']) };
    case 'order':
      return {
        kind: 'order',
        names: propertyList(value['names'], propertyName),
      };
    case 'options':
      return {
        kind: 'options',
        name: propertyName(value['name']),
        type: propertyText(value['type']),
      };
    case 'source':
      return {
        kind: 'source',
        frontmatter: propertySource(value['frontmatter']),
      };
    default:
      throw new Error('Unknown component property change');
  }
}

function parsePropertyOptionRename(input: unknown): PropertyOptionRename {
  const rename = object({ from: propertyText, to: propertyText })(input);
  if (!rename.from.trim() || !rename.to.trim()) {
    throw new Error('Property option rename values must be nonempty');
  }
  if (rename.from === rename.to) {
    throw new Error('Property option rename must change the value');
  }
  return rename;
}
export function parseComponentProperties(input: unknown): ComponentProperties {
  return object({
    source: propertySource,
    frontmatter: propertySource,
    advanced: boolean,
    properties: (value) => propertyList(value, parseComponentProperty),
  })(input);
}
export function parsePropertiesResult<T>(input: unknown, parse: (value: unknown) => T): Result<T> {
  const value = toRecord(input);
  if (value?.['ok'] === true) {
    return { ok: true, value: parse(value['value']) };
  }
  if (value?.['ok'] === false) {
    return {
      ok: false,
      error: object({ code: propertyText, message: propertyText })(value['error']),
    };
  }
  throw new Error('Invalid component properties result');
}

function propertyLabel(input: unknown): string {
  const value = propertyText(input);
  if (value.length === 0 || value.length > PROPERTY_LIMITS.nameCharsMax) {
    throw new Error('Property name must be nonempty and within the name limit');
  }
  return value;
}
function parseEditableProperty(input: unknown): ComponentProperty {
  const property = parseComponentProperty(input);
  return { ...property, name: propertyName(property.name) };
}
