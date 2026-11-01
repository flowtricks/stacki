import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { toRecord } from '../../../shared/core/record';
import { parseContentSchema } from './contentSchemaBoundary';
import type { ContentSchema, Control, Constraints, ConstraintBuilder, FieldBuilder, FieldDescriptor, FieldMember, FieldOptions } from './contentSchemaTypes';
export type { FieldDescriptor, FieldMember, Control } from './contentSchemaTypes';

// Deep structures are described one level at a time: a recursive schema has no
// bottom, and a form only ever draws the level it is showing. Six levels cover
// every hand-written content schema; deeper ones open level by level.
const CONTENT_SCHEMA_LIMITS = { descriptorDepthMax: 6 } as const;

interface SchemaOptions {
  readonly root?: unknown;
  readonly required?: boolean;
  readonly depth?: number;
}
export function describeField(input: unknown, key: string | undefined, options: SchemaOptions = {}): FieldDescriptor {
  assert(Number.isSafeInteger(options.depth ?? 0), 'Schema depth must be an integer');
  assert((options.depth ?? 0) >= 0, 'Schema depth must be nonnegative');
  const root = options.root ? parseContentSchema(options.root) : undefined;
  return describeFieldParsed(input ? parseContentSchema(input) : {}, key, { ...options, root });
}
export function fieldsOf(input: unknown, options: SchemaOptions = {}): readonly FieldDescriptor[] {
  const schema = input ? parseContentSchema(input) : undefined;
  assert(Number.isSafeInteger(options.depth ?? 0), 'Schema depth must be an integer');
  assert((options.depth ?? 0) >= 0, 'Schema depth must be nonnegative');
  const root = options.root ? parseContentSchema(options.root) : schema;
  return fieldsOfParsed(schema, { ...options, root });
}

// A collection's schema, turned into the fields an editor can draw.
//
// What arrives from the main process is JSON Schema — zod's own rendering of
// the project's content config (see electron/content/workers/introspect.mjs). It says
// everything, in a shape meant for validators rather than forms: optionality
// lives in a list of required keys somewhere above the field, nullability is an
// anyOf with a null branch, a union is a bare oneOf, and recursion is a $ref.
//
// This turns that into one descriptor per field: what control to draw, what it
// may hold, and what has to be true before it can be saved. Three states that
// most editors collapse into one are kept apart here, because they mean
// different things in the file:
//
//   optional  the key may be absent      → offer to add it, and to remove it
//   nullable  the key must be there      → offer an explicit "none" that
//             but may be null              writes null
//   default   the key may be absent and  → show the value as a placeholder and
//             the value is filled in       do not write it unless it is chosen.

const labelize = (key: unknown): string =>
  String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (first) => first.toUpperCase());

// Names that say a string is really something else. Nothing in a zod schema
// marks a string as markdown or as code, and the difference decides whether the
// control is a paragraph box or an editor with a monospace font.
const MARKDOWN_KEYS = /^(markdown|body|answer|content|richText|excerpt)$/i;
const CODE_KEYS = /^(example|snippet|code|markup|payload|query)$/i;
const LONG_KEYS = /^(description|summary|bio|quote|abstract|intro|blurb|tagline)$/i;

// A pattern, said in words. A regular expression in an error message tells an
// editor nothing they can act on.
const PATTERN_HINTS: readonly (readonly [RegExp, string])[] = [
  [/^\^#\(\?:\)?\[0-9a-f\]\{6\}\$$/i, 'a six-digit hex colour, like #2f6df6'],
  [/^\^#\[0-9a-f\]\{6\}\$$/i, 'a six-digit hex colour, like #2f6df6'],
  [/^\^\\d\+\\\.x\$$/, 'a major version, like 7.x'],
  [/^\^\\\/\.\*$/, 'a path starting with /'],
  [/^\^\[A-Z\]\{3\}-\[A-Z\]\+\$$/, 'three capitals, a dash, then capitals — like BCN-STD'],
  [/^\^\[a-z0-9-\]\+\$$/, 'lowercase letters, numbers and dashes'],
];

export function patternHint(pattern: string | undefined): string | undefined {
  if (!pattern) {
    return undefined;
  }
  for (const [test, hint] of PATTERN_HINTS) {
    if (test.test(pattern)) {
      return hint;
    }
  }
  return undefined;
}

const isNullBranch = (node: ContentSchema) => node && node.type === 'null';

// anyOf [X, null] is how zod writes .nullable(); unwrap it so the field is X
// and knows it may also be nothing.
function unwrapNullable(node: ContentSchema): {
  readonly node: ContentSchema;
  readonly nullable: boolean;
} {
  const branches = node?.anyOf || node?.oneOf;
  if (!branches || branches.length !== 2) {
    return { node, nullable: false };
  }
  const nulls = branches.filter(isNullBranch);
  const rest = branches.filter((branch) => !isNullBranch(branch));
  if (nulls.length !== 1 || rest.length !== 1) {
    return { node, nullable: false };
  }
  const only = rest[0];
  assert(only !== undefined, 'Nullable schema must have one value branch');
  return { node: { ...only, default: node.default ?? only.default }, nullable: true };
}

const definitionsOf = (root: ContentSchema | undefined) => root?.$defs || {};

function deref(node: ContentSchema | undefined, root: ContentSchema | undefined): ContentSchema | undefined {
  if (!node?.$ref) {
    return node;
  }
  const name = String(node.$ref).split('/').pop();
  if (name === undefined) {
    return node;
  }
  return { ...definitionsOf(root)[name], recursive: name };
}

const branchesOf = (node: ContentSchema | undefined) => node?.oneOf || node?.anyOf || undefined;

// A union is a type switcher when every branch agrees on a key that is a single
// literal — that key is what the user picks, and it decides the rest of the
// form.
function discriminatorOf(branches: readonly ContentSchema[] | undefined): string | undefined {
  if (!branches || branches.length < 2) {
    return undefined;
  }
  const first = branches[0]?.properties || {};
  for (const key of Object.keys(first)) {
    const values = branches.map((branch) => branch?.properties?.[key]);
    if (values.every((value) => value && value.const !== undefined)) {
      return key;
    }
  }
  return undefined;
}

function controlFor(node: ContentSchema | undefined, key: string, { nullable }: { readonly nullable: boolean }): Control {
  if (!node || node.recursiveOnly) {
    return 'unknown';
  }
  if (node.astroImage) {
    return 'image';
  }
  if (node.astroReference) {
    return 'reference';
  }
  if (node.astroDate) {
    return 'date';
  }
  if (node.enum) {
    return 'enum';
  }
  if (node.const !== undefined) {
    return 'const';
  }

  const type = typeof node.type === 'string' ? node.type : node.type?.find((name) => name !== 'null');
  if (type === 'boolean') {
    return 'boolean';
  }
  if (type === 'integer' || type === 'number') {
    return 'number';
  }
  if (type === 'array') {
    const items = node.items || {};
    if (items.astroReference) {
      return 'references';
    }
    if (items.type === 'string' && !items.properties) {
      return 'tags';
    }
    return 'list';
  }
  if (type === 'object') {
    if (!node.properties && node.additionalProperties && typeof node.additionalProperties === 'object') {
      return 'record';
    }
    return 'object';
  }
  if (branchesOf(node)) {
    return 'union';
  }
  if (type === 'string') {
    return stringControlFor(node, key);
  }
  // No type at all: a value zod could not describe on the way in. It is still
  // the user's data, so it is shown as what it looks like rather than hidden.
  return nullable ? 'text' : 'unknown';
}

// A string's control: its key and its format say what kind of text it holds.
function stringControlFor(node: ContentSchema, key: string): Control {
  if (MARKDOWN_KEYS.test(key)) {
    return 'markdown';
  }
  if (CODE_KEYS.test(key)) {
    return 'code';
  }
  if (node.format === 'uri') {
    return 'url';
  }
  if (node.format === 'email') {
    return 'email';
  }
  if ((node.maxLength && node.maxLength > 200) || LONG_KEYS.test(key)) {
    return 'longtext';
  }
  return 'text';
}

function constraintsOf(node: ContentSchema): Constraints {
  const out: ConstraintBuilder = {};
  if (node.minLength !== undefined) {
    out.minLength = node.minLength;
  }
  if (node.maxLength !== undefined) {
    out.maxLength = node.maxLength;
  }
  if (node.minimum !== undefined) {
    out.min = node.minimum;
  }
  if (node.maximum !== undefined) {
    out.max = node.maximum;
  }
  if (node.exclusiveMinimum !== undefined) {
    out.min = node.exclusiveMinimum + (node.type === 'integer' ? 1 : 0);
  }
  if (node.exclusiveMaximum !== undefined) {
    out.max = node.exclusiveMaximum - (node.type === 'integer' ? 1 : 0);
  }
  if (node.type === 'integer') {
    out.integer = true;
  }
  if (node.pattern) {
    out.pattern = node.pattern;
    out.patternHint = patternHint(node.pattern);
  }
  if (node.minItems !== undefined) {
    out.minItems = node.minItems;
  }
  if (node.maxItems !== undefined) {
    out.maxItems = node.maxItems;
  }
  // A number whose maximum is the largest integer JavaScript has is not really
  // bounded; zod writes that for .int(), and showing it as a rule would be a
  // lie.
  if (out.max === Number.MAX_SAFE_INTEGER) {
    delete out.max;
  }
  if (out.min === -Number.MAX_SAFE_INTEGER) {
    delete out.min;
  }
  return out;
}

/**
 * One field descriptor. `key` is undefined for the item type of an array.
 */
function describeFieldParsed(
  rawNode: ContentSchema | undefined,
  key: string | undefined,
  { required = false, root, depth = 0, visit = descriptorBudget() }: FieldOptions = {},
): FieldDescriptor {
  visit();
  const resolved = deref(rawNode, root);
  const { node, nullable } = unwrapNullable(resolved || {});
  const control = controlFor(node, key || '', { nullable });

  const field: FieldBuilder = {
    key,
    label: key ? labelize(key) : undefined,
    control,
    required,
    nullable,
    description: node.description || undefined,
    constraints: constraintsOf(node),
    transform: !!node.astroTransform,
    coerced: !!node.astroCoerced,
    ...schemaExtras(node),
  };

  if (depth > CONTENT_SCHEMA_LIMITS.descriptorDepthMax) {
    return field;
  }

  if (control === 'object') {
    field.fields = fieldsOfParsed(node, { root, depth: depth + 1, visit });
  } else if (control === 'record') {
    field.value = describeFieldParsed(typeof node.additionalProperties === 'object' ? node.additionalProperties : {}, undefined, {
      root,
      depth: depth + 1,
      visit,
    });
  } else if (control === 'list') {
    field.item = describeFieldParsed(node.items || {}, undefined, {
      root,
      depth: depth + 1,
      visit,
    });
  } else if (control === 'union') {
    const branches = branchesOf(node) || [];
    const discriminator = discriminatorOf(branches);
    field.discriminator = discriminator;
    field.members = branches.map((branch, index) => {
      const value = discriminator ? branch.properties?.[discriminator]?.const : index;
      return {
        value,
        label: labelize(String(value ?? `Option ${index + 1}`)),
        fields: fieldsOfParsed(branch, { root, depth: depth + 1, visit }).filter((member) => member.key !== discriminator),
      };
    });
  }
  return field;
}

type SchemaExtras = Pick<FieldBuilder, 'default' | 'options' | 'const' | 'target' | 'recursive'>;

// What a field's schema says beyond its control, each only when the schema says it.
function schemaExtras(node: ContentSchema): SchemaExtras {
  const extras: SchemaExtras = {};
  if ('default' in node) {
    extras.default = node.default;
  }
  if (node.enum) {
    extras.options = node.enum;
  }
  if (node.const !== undefined) {
    extras.const = node.const;
  }
  if (node.astroReference) {
    extras.target = node.astroReference;
  }
  if (node.items?.astroReference) {
    extras.target = node.items.astroReference;
  }
  if (node.recursive) {
    extras.recursive = node.recursive;
  }
  return extras;
}

/** The fields of an object schema, in the order the schema declares them. */
function fieldsOfParsed(
  schema: ContentSchema | undefined,
  { root = schema, depth = 0, visit = descriptorBudget() }: FieldOptions = {},
): readonly FieldDescriptor[] {
  const node = deref(schema, root) || {};
  const properties = node.properties || {};
  const required = new Set(node.required || []);
  return Object.entries(properties).map(([key, child]) => describeFieldParsed(child, key, { required: required.has(key), root, depth, visit }));
}

/**
 * The fields of a whole collection. An entry-level union (settings files, where
 * each entry is a different kind of thing) is reported as one union field so
 * the form can switch on it.
 */
export function collectionFields(input: unknown) {
  const schema = input ? parseContentSchema(input) : undefined;
  if (!schema) {
    return { fields: [], freeform: true };
  }
  const branches = branchesOf(schema);
  if (branches) {
    const field = describeFieldParsed(schema, undefined, { root: schema });
    return { fields: [], union: field, freeform: false };
  }
  return { fields: fieldsOfParsed(schema), freeform: false };
}

/** Which union member a value is, by its discriminator. */
export function memberFor(union: FieldDescriptor | undefined, value: unknown): FieldMember | undefined {
  if (!union?.members?.length) {
    return undefined;
  }
  const key = union.discriminator;
  const record = toRecord(value);
  if (key && record) {
    const found = union.members.find((member) => member.value === record[key]);
    if (found) {
      return found;
    }
  }
  return union.members[0];
}

/**
 * A field's own rules, checked as the user types. The schema's whole-entry
 * rules are checked by zod itself (see validateContentEntry) — this is the part
 * that can answer without a round trip.
 */
export function fieldIssue(field: FieldDescriptor, value: unknown): string | undefined {
  const rules = field.constraints || {};
  // A stored `null` is the nullable field's explicit "none", so it reads as empty.
  if (value === undefined || value === null || value === '') {
    if (field.required && !field.nullable) {
      return 'Required';
    }
    return undefined;
  }
  if (typeof value === 'string') {
    if (rules.minLength && value.length < rules.minLength) {
      return `At least ${rules.minLength} characters`;
    }
    if (rules.maxLength && value.length > rules.maxLength) {
      return `At most ${rules.maxLength} characters`;
    }
    if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
      return rules.patternHint ? `Needs ${rules.patternHint}` : `Does not match ${rules.pattern}`;
    }
    if (field.control === 'url' && !/^https?:\/\//i.test(value)) {
      return 'Needs a full URL, starting with http';
    }
    if (field.control === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return 'Needs an email address';
    }
  }
  if (typeof value === 'number') {
    if (rules.integer && !Number.isInteger(value)) {
      return 'Whole numbers only';
    }
    if (rules.min !== undefined && value < rules.min) {
      return `At least ${rules.min}`;
    }
    if (rules.max !== undefined && value > rules.max) {
      return `At most ${rules.max}`;
    }
  }
  if (Array.isArray(value)) {
    if (rules.minItems && value.length < rules.minItems) {
      return `At least ${rules.minItems}`;
    }
    if (rules.maxItems && value.length > rules.maxItems) {
      return `At most ${rules.maxItems}`;
    }
  }
  return undefined;
}

/** A short line under a field saying what it will take. */
export function hintFor(field: FieldDescriptor): string | undefined {
  const rules = field.constraints || {};
  const bits = [];
  if (field.description) {
    bits.push(field.description);
  }
  if (rules.patternHint) {
    bits.push(rules.patternHint);
  } else if (rules.pattern) {
    bits.push(`matches ${rules.pattern}`);
  }
  if (rules.minLength && rules.maxLength) {
    bits.push(`${rules.minLength}–${rules.maxLength} characters`);
  } else if (rules.maxLength) {
    bits.push(`up to ${rules.maxLength} characters`);
  } else if (rules.minLength) {
    bits.push(`at least ${rules.minLength} characters`);
  }
  if (rules.min !== undefined && rules.max !== undefined) {
    bits.push(`${rules.min}–${rules.max}`);
  } else if (rules.min !== undefined) {
    bits.push(`${rules.min} or more`);
  } else if (rules.max !== undefined) {
    bits.push(`up to ${rules.max}`);
  }
  if (rules.minItems && rules.maxItems) {
    bits.push(`${rules.minItems}–${rules.maxItems} items`);
  } else if (rules.maxItems) {
    bits.push(`up to ${rules.maxItems} items`);
  } else if (rules.minItems) {
    bits.push(`at least ${rules.minItems}`);
  }
  if (field.transform) {
    bits.push('stored differently in the file than it reads here');
  }
  return bits.join(' · ') || undefined;
}

/**
 * The edits that turn `before` into `after`: one per changed path, and nothing
 * for a key neither of them has. This is what keeps a save from writing a
 * schema's defaults into every file it touches — a value the user did not set
 * is a value that was never in the file, and it stays that way.
 */
export function editsBetween(before: unknown, after: unknown, path: readonly string[] = []): readonly ContentEdit[] {
  let remaining = BOUNDARY_LIMITS.itemsMax;
  const visit = (depth: number): void => {
    assert(depth <= BOUNDARY_LIMITS.depthMax, 'Content edit exceeds depth limit');
    assert(--remaining >= 0, 'Content edit exceeds item limit');
  };
  return editsBetweenVisit(before, after, path, visit);
}
interface ContentEdit {
  readonly path: readonly string[];
  readonly value: unknown;
}
function editsBetweenVisit(before: unknown, after: unknown, path: readonly string[], visit: (depth: number) => void): readonly ContentEdit[] {
  const depth = path.length;
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'Content edit exceeds depth limit');
  visit(depth);
  const edits: ContentEdit[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> => toRecord(value) !== undefined;

  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      edits.push({ path, value: after });
    }
    return edits;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) {
        edits.push({ path: [...path, key], value: undefined });
        continue;
      }
      if (!(key in before)) {
        edits.push({ path: [...path, key], value: after[key] });
        continue;
      }
      edits.push(...editsBetweenVisit(before[key], after[key], [...path, key], visit));
    }
    return edits;
  }
  if (before !== after) {
    edits.push({ path, value: after });
  }
  return edits;
}

export { labelize };

// A small recursive definition may expand into a wide form, so rendering also
// needs a work budget independent of the wire schema's own size and depth.
function descriptorBudget(): () => void {
  let remaining = BOUNDARY_LIMITS.itemsMax;
  return () => {
    assert(--remaining >= 0, 'Content descriptors exceed item limit');
  };
}
