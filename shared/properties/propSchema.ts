// Component schemas travel as arrays over IPC and as Maps in local symbol reads.
// Parse the metadata the props panel consumes, including branch-specific defaults,
// rather than carrying unknown shapes into control and visibility decisions.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { toArray, toRecord } from '../core/record';
import { definedFields } from '../core/boundary';

export type PropDefault = string | number | boolean;
export interface DefaultRule {
  readonly prop: string;
  readonly is: string;
  readonly then: string;
  readonly otherwise: string;
}
export interface UnionBranch {
  readonly forbids: readonly string[];
  readonly pins: Readonly<Record<string, readonly string[]>>;
  readonly defaults: Readonly<Record<string, string | number>>;
  readonly rules: Readonly<Record<string, DefaultRule>>;
  readonly docs: Readonly<Record<string, string>>;
}
export interface PropUnion {
  readonly names: readonly string[];
  readonly branches: readonly UnionBranch[];
}
export interface PropShapeField {
  readonly name: string;
  readonly type: string;
}
// What a value only code can give is (see the scan's normalizeType): an object,
// a function (an action) or a type no field can fill in (`any`, a promise).
export const CODE_KINDS = ['object', 'function', 'opaque'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];
export interface PropField {
  readonly name: string;
  // Type text stays open: local schema readers may retain the authored type name.
  readonly type: string;
  readonly optional: boolean;
  readonly options?: readonly string[];
  readonly numeric?: boolean;
  // Options of a mixed choice written as expressions (`flag={true}`), not strings.
  readonly expressionOptions?: readonly string[];
  readonly codeKind?: CodeKind;
  // The declared type as written, one line, on props whose value is set in code.
  readonly typeText?: string;
  readonly default?: PropDefault | undefined;
  readonly defaultExpr?: boolean;
  // The project file an expression default imports, for its thumbnail only:
  // the default itself is still the expression.
  readonly defaultAsset?: string;
  readonly hint?: string;
  readonly doc?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly minExclusive?: boolean;
  readonly maxExclusive?: boolean;
  readonly shape?: readonly PropShapeField[];
  readonly shapeIsList?: boolean;
  readonly unions?: readonly PropUnion[];
}
export type PropSchema = ReadonlyMap<string, PropField>;

export function parseField(input: unknown, where: string): PropField {
  const value = schemaRecord(input, where);
  const name = schemaText(value['name'], `${where}.name`);
  if (!name.length) {
    fail(where, 'name: expected non-empty string');
  }
  const field = {
    name,
    type: schemaText(value['type'], `${where}.type`),
    optional: schemaBoolean(value['optional'], `${where}.optional`),
    ...schemaOptionalMetadata(value, where),
    ...definedFields({
      options: schemaOptional(value, 'options', where, (input, at) => schemaStrings(input, at, LIMITS.propOptionsMax)),
      expressionOptions: schemaOptional(value, 'expressionOptions', where, (input, at) => schemaStrings(input, at, LIMITS.propOptionsMax)),
      codeKind: schemaOptional(value, 'codeKind', where, schemaCodeKind),
      shape: schemaOptional(value, 'shape', where, schemaShape),
      unions: schemaOptional(value, 'unions', where, (input, at) => schemaArray(input, at, LIMITS.propOptionsMax).map((union) => schemaUnion(union, at))),
    }),
  };
  // An explicit undefined default is part of the existing in-process protocol.
  return 'default' in value
    ? {
        ...field,
        default: value['default'] === undefined ? undefined : schemaDefault(value['default'], `${where}.default`),
      }
    : field;
}

export function parsePropSchema(input: unknown): PropSchema {
  if (!(input instanceof Map)) {
    fail('root', 'expected Map');
  }
  if (input.size > LIMITS.propSchemaFieldsMax) {
    fail('root', `exceeds ${LIMITS.propSchemaFieldsMax} fields`);
  }
  const entries: ReadonlyMap<unknown, unknown> = input;
  const out = new Map<string, PropField>();
  for (const [key, value] of entries) {
    if (typeof key !== 'string') {
      fail('root', 'expected string keys');
    }
    const field = parseField(value, key);
    if (field.name !== key) {
      fail(key, `field name ${JSON.stringify(field.name)} does not match its key`);
    }
    out.set(key, field);
  }
  assert(out.size === entries.size, 'parsePropSchema: every key becomes one field');
  return out;
}

function fail(where: string, what: string): never {
  throw new Error(`PropSchema.${where}: ${what}`);
}
function schemaRecord(input: unknown, where: string): Record<string, unknown> {
  const value = toRecord(input);
  if (!value) {
    fail(where, 'expected object');
  }
  if (Object.keys(value).length > LIMITS.propSchemaFieldsMax) {
    fail(where, 'too many fields');
  }
  return value;
}
function schemaText(input: unknown, where: string): string {
  if (typeof input !== 'string') {
    if (where.endsWith('.name')) {
      fail(where, 'expected non-empty string');
    }
    fail(where, 'expected string');
  }
  if (input.length > LIMITS.attrCharsMax) {
    fail(where, 'string exceeds limit');
  }
  return input;
}
function schemaBoolean(input: unknown, where: string): boolean {
  if (typeof input !== 'boolean') {
    fail(where, 'expected boolean');
  }
  return input;
}
function schemaNumber(input: unknown, where: string): number {
  if (typeof input !== 'number') {
    fail(where, 'expected number');
  }
  if (!Number.isFinite(input)) {
    fail(where, 'expected finite number');
  }
  return input;
}
function schemaDefault(input: unknown, where: string): PropDefault {
  if (typeof input === 'string') {
    return schemaText(input, where);
  }
  if (typeof input === 'boolean') {
    return input;
  }
  return schemaNumber(input, where);
}
function schemaArray(input: unknown, where: string, maximum: number): readonly unknown[] {
  const value = toArray(input);
  if (!value) {
    fail(where, 'expected array');
  }
  if (value.length > maximum) {
    if (where.endsWith('.options')) {
      fail(where, `options exceed ${maximum}`);
    }
    fail(where, `array exceeds ${maximum}`);
  }
  return value;
}
function schemaStrings(input: unknown, where: string, maximum: number): readonly string[] {
  const values = schemaArray(input, where, maximum);
  if (values.some((value) => typeof value !== 'string')) {
    fail(where, 'expected string array');
  }
  const strings = values.map((value) => schemaText(value, where));
  assert(strings.length === values.length, 'schemaStrings: every value is kept');
  return strings;
}

// Undefined metadata is omitted because absence has meaning to the field renderer.
function schemaOptional<T>(record: Readonly<Record<string, unknown>>, key: string, where: string, parse: (input: unknown, where: string) => T): T | undefined {
  return record[key] === undefined ? undefined : parse(record[key], `${where}.${key}`);
}
function schemaOptionalMetadata(value: Readonly<Record<string, unknown>>, where: string) {
  return definedFields({
    numeric: schemaOptional(value, 'numeric', where, schemaBoolean),
    defaultExpr: schemaOptional(value, 'defaultExpr', where, schemaBoolean),
    shapeIsList: schemaOptional(value, 'shapeIsList', where, schemaBoolean),
    minExclusive: schemaOptional(value, 'minExclusive', where, schemaBoolean),
    maxExclusive: schemaOptional(value, 'maxExclusive', where, schemaBoolean),
    min: schemaOptional(value, 'min', where, schemaNumber),
    max: schemaOptional(value, 'max', where, schemaNumber),
    step: schemaOptional(value, 'step', where, schemaNumber),
    doc: schemaOptional(value, 'doc', where, schemaText),
    defaultAsset: schemaOptional(value, 'defaultAsset', where, schemaText),
    hint: schemaOptional(value, 'hint', where, schemaText),
    typeText: schemaOptional(value, 'typeText', where, schemaText),
  });
}
function schemaCodeKind(input: unknown, where: string): CodeKind {
  const kind = CODE_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    fail(where, `expected one of ${CODE_KINDS.join(', ')}`);
  }
  return kind;
}
function schemaShape(input: unknown, where: string): readonly PropShapeField[] {
  return schemaArray(input, where, LIMITS.propSchemaFieldsMax).map((item) => {
    const value = schemaRecord(item, where);
    return {
      name: schemaText(value['name'], `${where}.name`),
      type: schemaText(value['type'], `${where}.type`),
    };
  });
}
function schemaDictionary<T>(input: unknown, where: string, parse: (value: unknown, where: string) => T): Readonly<Record<string, T>> {
  const record = schemaRecord(input === undefined ? {} : input, where);
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [schemaText(key, where), parse(value, `${where}.${key}`)]));
}
function schemaUnion(input: unknown, where: string): PropUnion {
  const value = schemaRecord(input, where);
  return {
    names: schemaStrings(value['names'], `${where}.names`, LIMITS.propSchemaFieldsMax),
    branches: schemaArray(value['branches'], `${where}.branches`, LIMITS.propOptionsMax).map((branch) => schemaBranch(branch, where)),
  };
}
function schemaBranch(input: unknown, where: string): UnionBranch {
  const value = schemaRecord(input, where);
  return {
    forbids: schemaStrings(value['forbids'], `${where}.forbids`, LIMITS.propSchemaFieldsMax),
    pins: schemaDictionary(value['pins'], `${where}.pins`, (input, at) => schemaStrings(input, at, LIMITS.propOptionsMax)),
    defaults: schemaDictionary(value['defaults'], `${where}.defaults`, (input, at) =>
      typeof input === 'string' ? schemaText(input, at) : schemaNumber(input, at),
    ),
    rules: schemaDictionary(value['rules'], `${where}.rules`, schemaRule),
    docs: schemaDictionary(value['docs'], `${where}.docs`, schemaText),
  };
}
function schemaRule(input: unknown, where: string): DefaultRule {
  const value = schemaRecord(input, where);
  return {
    prop: schemaText(value['prop'], `${where}.prop`),
    is: schemaText(value['is'], `${where}.is`),
    then: schemaText(value['then'], `${where}.then`),
    otherwise: schemaText(value['otherwise'], `${where}.otherwise`),
  };
}
