// A content collection's schema, read from and written back to the project's
// content config as text. The config is parsed with TypeScript (no code runs),
// the collection found by its key in `export const collections = { … }`
// (written inline, by name, or as shorthand), and its `z.object({ … })` read
// field by field. A change rewrites only the spans it touches — a key, one
// field's chain, the object's property list — so the rest of the file comes
// back as it was written.
//
// A field's chain is understood as a base type (`z.string()`, `image()`,
// `reference('team')`, `z.array(…)`) followed by methods. The settings own
// `.min()`, `.max()`, `.describe()` and optionality (`.optional()`,
// `.nullish()`, `.default()`); other validators (`.email()`, `.url()`) are kept
// in place; a transform or refinement makes the field read-only to the form.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import type { Result } from '../../shared/core/result';
import { readChain, writeChain, type Chain, type ChainStep } from './astroSchemaChecks';
import {
  CHAIN_STEPS_MAX,
  propertyList,
  referenceTarget,
  locate,
  collectionsObject,
  defineCall,
  schemaProperty,
  schemaObject,
  propertyName,
  keyText,
  quoteOf,
  unwrap,
  applyEdits,
  type SpanEdit,
  type Located,
} from './astroSchemaSyntax';

import type {
  FieldUpdate,
  NewFieldKind,
  SettingsChange,
  SettingsField,
  SettingsFieldKind,
} from '../../shared/properties/collectionSettings';

/** What reading a collection found: its fields, and where its glob folder is named. */
export interface SchemaRead {
  readonly fields: readonly SettingsField[];
  readonly source: string | undefined;
}

/** A change's new config text, and the folder a renamed glob collection moves to. */
export interface SchemaEdit {
  readonly text: string;
  readonly move: { readonly from: string; readonly to: string } | undefined;
}

export function readCollectionSchema(
  source: string,
  collection: string,
): Result<SchemaRead, string> {
  const located = locate(source, collection);
  if (!located.ok) {
    return located;
  }
  const { object, call, file } = located.value;
  const fields =
    object === undefined ? [] : object.properties.flatMap((property) => fieldOf(property, file));
  return { ok: true, value: { fields, source: loaderSource(call, file) } };
}

/** The config with `change` made to `collection`'s schema, or why it cannot be. */
export function editCollectionSchema(
  source: string,
  collection: string,
  change: SettingsChange,
): Result<SchemaEdit, string> {
  const located = locate(source, collection);
  if (!located.ok) {
    return located;
  }
  if (change.kind === 'renameCollection') {
    return renameCollection(source, located.value, { from: collection, to: change.to });
  }
  if (change.kind === 'deleteCollection') {
    return deleteCollection(source, collection);
  }
  const { object } = located.value;
  if (object === undefined) {
    return {
      ok: false,
      error: `${collection} has no z.object({ … }) schema in the config to edit.`,
    };
  }
  const edits = fieldEdits(located.value, object, change);
  if (!edits.ok) {
    return edits;
  }
  return { ok: true, value: { text: applyEdits(source, edits.value), move: undefined } };
}

function fieldEdits(
  located: Located,
  object: ts.ObjectLiteralExpression,
  change: Exclude<SettingsChange, { readonly kind: 'renameCollection' | 'deleteCollection' }>,
): Result<readonly SpanEdit[], string> {
  const { file } = located;
  const named = (name: string) =>
    object.properties.find((property) => propertyName(property) === name);
  switch (change.kind) {
    case 'reorder':
      return reorderFields(object, file, change.order);
    case 'renameField': {
      const property = named(change.from);
      if (property === undefined || property.name === undefined) {
        return { ok: false, error: `There is no field ${change.from}.` };
      }
      if (named(change.to) !== undefined) {
        return { ok: false, error: `A field named ${change.to} already exists.` };
      }
      const key = keyText(change.to, { quoted: ts.isStringLiteral(property.name) });
      return {
        ok: true,
        value: [{ start: property.name.getStart(file), end: property.name.getEnd(), text: key }],
      };
    }
    case 'updateField':
      return updateField(named(change.update.name), file, change.update);
    case 'addField':
      return addField(located, object, change, named(change.name));
    case 'removeField': {
      const kept = object.properties.filter((property) => propertyName(property) !== change.name);
      if (kept.length === object.properties.length) {
        return { ok: false, error: `There is no field ${change.name}.` };
      }
      return {
        ok: true,
        value: [
          propertyList(
            object,
            file,
            kept.map((property) => property.getText(file)),
          ),
        ],
      };
    }
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function reorderFields(
  object: ts.ObjectLiteralExpression,
  file: ts.SourceFile,
  order: readonly string[],
): Result<readonly SpanEdit[], string> {
  const byName = new Map(object.properties.map((property) => [propertyName(property), property]));
  const known = order.every((name) => byName.has(name));
  if (!known || order.length !== object.properties.length) {
    return { ok: false, error: 'The fields changed since they were listed. Reopen the settings.' };
  }
  const texts = order.map((name) => byName.get(name)?.getText(file) ?? '');
  assert(
    texts.every((part) => part.length > 0),
    'Every reordered field has its text',
  );
  return { ok: true, value: [propertyList(object, file, texts)] };
}

function updateField(
  property: ts.ObjectLiteralElementLike | undefined,
  file: ts.SourceFile,
  update: FieldUpdate,
): Result<readonly SpanEdit[], string> {
  if (property === undefined || !ts.isPropertyAssignment(property)) {
    return { ok: false, error: `There is no field ${update.name}.` };
  }
  const chain = chainOf(property.initializer, file);
  if (chain === undefined || !readChain(chain).editable) {
    return {
      ok: false,
      error: `${update.name}’s schema is written by hand; edit it in the config.`,
    };
  }
  const text = writeChain(chain, update);
  return {
    ok: true,
    value: [
      { start: property.initializer.getStart(file), end: property.initializer.getEnd(), text },
    ],
  };
}

// A new field, optional until its settings say otherwise, with what its schema
// needs: `image` from the schema's function, `reference` from astro:content.
function addField(
  located: Located,
  object: ts.ObjectLiteralExpression,
  field: {
    readonly name: string;
    readonly fieldKind: NewFieldKind;
    readonly target: string | undefined;
  },
  existing: ts.ObjectLiteralElementLike | undefined,
): Result<readonly SpanEdit[], string> {
  const { file } = located;
  if (existing !== undefined) {
    return { ok: false, error: `A field named ${field.name} already exists.` };
  }
  const target = field.target ?? '';
  const pointing = field.fieldKind === 'reference' || field.fieldKind === 'multiReference';
  if (
    pointing &&
    !collectionsObject(file)?.properties.some((property) => propertyName(property) === target)
  ) {
    return { ok: false, error: `${target} is not a collection in the content config.` };
  }
  const key = keyText(field.name, { quoted: false });
  const added = `${key}: ${newFieldText(field.fieldKind, target)}`;
  const texts = [...object.properties.map((property) => property.getText(file)), added];
  const imaging = field.fieldKind === 'image' || field.fieldKind === 'multiImage';
  const scope = imaging ? imageScope(located) : { ok: true as const, value: [] };
  if (!scope.ok) {
    return scope;
  }
  const imported = pointing ? referenceImport(file) : [];
  return { ok: true, value: [propertyList(object, file, texts), ...scope.value, ...imported] };
}

/** The schema a new field of `kind` is written as. */
export function newFieldText(kind: NewFieldKind, target: string): string {
  const pointed = `reference(${JSON.stringify(target)})`;
  const schemas: Readonly<Record<NewFieldKind, string>> = {
    text: 'z.string()',
    richText: 'z.string()',
    image: 'image()',
    multiImage: 'z.array(image())',
    videoLink: 'z.string().url()',
    link: 'z.string().url()',
    email: 'z.string().email()',
    phone: 'z.string()',
    number: 'z.number()',
    date: 'z.coerce.date()',
    switch: 'z.boolean()',
    color: 'z.string().regex(/^#[0-9a-fA-F]{6}$/)',
    option: "z.enum(['Option 1', 'Option 2'])",
    file: 'z.string()',
    reference: pointed,
    multiReference: `z.array(${pointed})`,
    list: 'z.array(z.string())',
    group: 'z.object({ title: z.string().optional() })',
    keyValue: 'z.record(z.string(), z.string())',
    constant: "z.literal('value')",
    any: 'z.unknown()',
  };
  return `${schemas[kind]}.optional()`;
}

// `image()` comes from the schema's function: a schema written as an object becomes
// one, and a function that does not take `image` takes it too.
function imageScope(located: Located): Result<readonly SpanEdit[], string> {
  const { file } = located;
  const schema = schemaProperty(located.call);
  if (schema === undefined) {
    return { ok: false, error: 'This collection has no schema to add an image field to.' };
  }
  const value = schema.initializer;
  if (!ts.isArrowFunction(value)) {
    return {
      ok: true,
      value: [{ start: value.getStart(file), end: value.getStart(file), text: '({ image }) => ' }],
    };
  }
  const parameter = value.parameters[0];
  if (parameter === undefined) {
    const open = value.getStart(file);
    return {
      ok: true,
      value: [
        { start: open, end: value.equalsGreaterThanToken.getStart(file), text: '({ image }) ' },
      ],
    };
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    return {
      ok: false,
      error: 'Add `image` to the schema’s function by hand, then add the field.',
    };
  }
  const names = parameter.name.elements.map((element) => element.name.getText(file));
  if (names.includes('image')) {
    return { ok: true, value: [] };
  }
  const first = parameter.name.elements[0];
  const at = first === undefined ? parameter.name.getStart(file) + 1 : first.getStart(file);
  return {
    ok: true,
    value: [{ start: at, end: at, text: first === undefined ? ' image ' : 'image, ' }],
  };
}

// `reference` imported from astro:content, beside what the config imports from it already.
function referenceImport(file: ts.SourceFile): readonly SpanEdit[] {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== 'astro:content') {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    if (bindings.elements.some((element) => element.name.text === 'reference')) {
      return [];
    }
    const last = bindings.elements.at(-1);
    if (last !== undefined) {
      return [{ start: last.getEnd(), end: last.getEnd(), text: ', reference' }];
    }
  }
  return [{ start: 0, end: 0, text: "import { reference } from 'astro:content';\n" }];
}

function renameCollection(
  source: string,
  located: Located,
  rename: { readonly from: string; readonly to: string },
): Result<SchemaEdit, string> {
  const { entry, file, call } = located;
  const collections = entry.parent;
  assert(ts.isObjectLiteralExpression(collections), 'A collection is listed in an object');
  if (collections.properties.some((property) => propertyName(property) === rename.to)) {
    return { ok: false, error: `A collection named ${rename.to} already exists.` };
  }
  const edits: SpanEdit[] = [];
  if (ts.isShorthandPropertyAssignment(entry)) {
    edits.push({
      start: entry.getStart(file),
      end: entry.getEnd(),
      text: `${keyText(rename.to, { quoted: false })}: ${entry.name.text}`,
    });
  } else if (entry.name !== undefined) {
    edits.push({
      start: entry.name.getStart(file),
      end: entry.name.getEnd(),
      text: keyText(rename.to, { quoted: ts.isStringLiteral(entry.name) }),
    });
  }
  // A glob collection kept in a folder named for it moves with its name.
  const base = globBase(call);
  const folder = base === undefined ? undefined : base.text.replace(/^\.\//, '').replace(/\/$/, '');
  const named = folder !== undefined && folder.split('/').at(-1) === rename.from;
  const moved =
    named && folder !== undefined
      ? `${folder.split('/').slice(0, -1).join('/')}/${rename.to}`
      : undefined;
  if (base !== undefined && moved !== undefined) {
    const prefix = base.text.startsWith('./') ? './' : '';
    edits.push({
      start: base.getStart(file),
      end: base.getEnd(),
      text: JSON.stringify(`${prefix}${moved}`).replace(/"/g, quoteOf(base, file)),
    });
  }
  return {
    ok: true,
    value: {
      text: applyEdits(source, edits),
      move: moved !== undefined && folder !== undefined ? { from: folder, to: moved } : undefined,
    },
  };
}

/**
 * The config without collection `name`: first every field of another
 * collection that points at it (so nothing is left referring to it), then its
 * entry in `collections`, and the const that declared it when nothing else uses it.
 */
function deleteCollection(source: string, name: string): Result<SchemaEdit, string> {
  const first = ts.createSourceFile(
    'content.config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const collections = collectionsObject(first);
  if (collections === undefined) {
    return {
      ok: false,
      error: 'Stacki could not find `export const collections = { … }` in the content config.',
    };
  }
  const unlinked: SpanEdit[] = [];
  for (const entry of collections.properties) {
    const object = schemaObject(defineCall(entry, first));
    if (propertyName(entry) === name || object === undefined) {
      continue;
    }
    const kept = object.properties.filter((property) => referenceTarget(property) !== name);
    if (kept.length < object.properties.length) {
      unlinked.push(
        propertyList(
          object,
          first,
          kept.map((property) => property.getText(first)),
        ),
      );
    }
  }
  const text = applyEdits(source, unlinked);
  const located = locate(text, name);
  if (!located.ok) {
    return located;
  }
  const { entry, file } = located.value;
  const listed = entry.parent;
  assert(ts.isObjectLiteralExpression(listed), 'A collection is listed in an object');
  const others = listed.properties.filter((property) => property !== entry);
  const edits = [
    propertyList(
      listed,
      file,
      others.map((property) => property.getText(file)),
    ),
  ];
  const declared = declarationOf(entry, file);
  if (declared !== undefined) {
    edits.push(declared);
  }
  return { ok: true, value: { text: applyEdits(text, edits), move: undefined } };
}

// The `const x = defineCollection(…)` an entry names, as a span to remove, when
// nothing else in the file uses `x`.
function declarationOf(
  entry: ts.ObjectLiteralElementLike,
  file: ts.SourceFile,
): SpanEdit | undefined {
  const named = ts.isShorthandPropertyAssignment(entry)
    ? entry.name.text
    : ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.initializer)
      ? entry.initializer.text
      : undefined;
  if (named === undefined) {
    return undefined;
  }
  const statement = file.statements.find(
    (each) =>
      ts.isVariableStatement(each) &&
      each.declarationList.declarations.length === 1 &&
      each.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === named,
      ),
  );
  if (statement === undefined) {
    return undefined;
  }
  const uses = (file.text.match(new RegExp(`(?<![\\w$])${named}(?![\\w$])`, 'g')) ?? []).length;
  // Declared once and listed once: nothing else would miss it.
  if (uses > 2) {
    return undefined;
  }
  const end =
    file.text.charAt(statement.getEnd()) === '\n' ? statement.getEnd() + 1 : statement.getEnd();
  return { start: statement.getStart(file), end, text: '' };
}

function loaderSource(
  call: ts.CallExpression | undefined,
  file: ts.SourceFile,
): string | undefined {
  const base = globBase(call);
  if (base !== undefined) {
    return base.text.replace(/^\.\//, '');
  }
  const loader = loaderCall(call);
  const first = loader?.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first)
    ? first.text.replace(/^\.\//, '')
    : loader?.getText(file);
}

function globBase(call: ts.CallExpression | undefined): ts.StringLiteralLike | undefined {
  const loader = loaderCall(call);
  if (
    loader === undefined ||
    !ts.isIdentifier(loader.expression) ||
    loader.expression.text !== 'glob'
  ) {
    return undefined;
  }
  const options = loader.arguments[0];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }
  const base = options.properties.find((property) => propertyName(property) === 'base');
  const value = base !== undefined && ts.isPropertyAssignment(base) ? base.initializer : undefined;
  return value !== undefined && ts.isStringLiteralLike(value) ? value : undefined;
}

function loaderCall(call: ts.CallExpression | undefined): ts.CallExpression | undefined {
  const options = call?.arguments[0];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }
  const loader = options.properties.find((property) => propertyName(property) === 'loader');
  const value =
    loader !== undefined && ts.isPropertyAssignment(loader)
      ? unwrap(loader.initializer)
      : undefined;
  return value !== undefined && ts.isCallExpression(value) ? value : undefined;
}

// One field: its name, its kind, and the settings its chain states.
function fieldOf(property: ts.ObjectLiteralElementLike, file: ts.SourceFile): SettingsField[] {
  const name = propertyName(property);
  if (name === undefined || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return [];
  }
  const chain = ts.isPropertyAssignment(property) ? chainOf(property.initializer, file) : undefined;
  if (chain === undefined) {
    return [
      {
        name,
        kind: 'other',
        description: undefined,
        required: false,
        checks: {},
        options: undefined,
        defaultValue: undefined,
        editable: false,
      },
    ];
  }
  return [{ name, kind: chain.kind, ...readChain(chain), target: referenceTarget(property) }];
}

// `z.string().min(1).optional()` → base `z.string()`, steps min and optional.
function chainOf(expression: ts.Expression, file: ts.SourceFile): Chain | undefined {
  const steps: ChainStep[] = [];
  let node: ts.Expression = expression;
  for (let depth = 0; depth < CHAIN_STEPS_MAX; depth += 1) {
    if (!ts.isCallExpression(node)) {
      return undefined;
    }
    const callee = node.expression;
    const kind = baseKind(callee);
    if (kind !== undefined) {
      const ordered = steps.reverse();
      return {
        base: node.getText(file),
        baseNode: node,
        kind: refinedKind(kind, node, ordered),
        steps: ordered,
      };
    }
    if (!ts.isPropertyAccessExpression(callee)) {
      return undefined;
    }
    const inner = callee.expression;
    steps.push({
      name: callee.name.text,
      text: file.text.slice(inner.getEnd(), node.getEnd()),
      args: [...node.arguments],
    });
    node = inner;
  }
  return undefined;
}

// A string read by its validators, a list by what it lists.
function refinedKind(
  kind: SettingsFieldKind,
  base: ts.CallExpression,
  steps: readonly ChainStep[],
): SettingsFieldKind {
  const has = (name: string) => steps.some((step) => step.name === name);
  if (kind === 'text') {
    return has('email') ? 'email' : has('url') ? 'link' : has('regex') ? 'color' : 'text';
  }
  if (kind !== 'list') {
    return kind;
  }
  const item = base.arguments[0];
  const callee = item !== undefined && ts.isCallExpression(item) ? item.expression : undefined;
  if (callee !== undefined && ts.isIdentifier(callee)) {
    return callee.text === 'image'
      ? 'multiImage'
      : callee.text === 'reference'
        ? 'multiReference'
        : 'list';
  }
  return 'list';
}

// The kind a base call makes, or undefined when `callee` is not a base.
function baseKind(callee: ts.LeftHandSideExpression): SettingsFieldKind | undefined {
  if (ts.isIdentifier(callee)) {
    return callee.text === 'image'
      ? 'image'
      : callee.text === 'reference'
        ? 'reference'
        : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const root = callee.expression.getText();
  if (root !== 'z' && root !== 'z.coerce') {
    return undefined;
  }
  switch (callee.name.text) {
    case 'string':
      return 'text';
    case 'literal':
      return 'constant';
    case 'object':
      return 'group';
    case 'record':
      return 'keyValue';
    case 'unknown':
    case 'any':
      return 'any';
    case 'enum':
      return 'option';
    case 'number':
      return 'number';
    case 'boolean':
      return 'switch';
    case 'date':
      return 'date';
    case 'array':
      return 'list';
    default:
      return 'other';
  }
}
