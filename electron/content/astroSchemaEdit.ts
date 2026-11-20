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
// the checks, `.describe()` and optionality (`.optional()`, `.nullish()`,
// `.default()`); writing them changes only the methods for the settings that
// changed (astroSchemaChecks.ts), so other validators (`.email()`), a
// transform or refinement, and a base kept in a constant stay as written.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import { err, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
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
  objectShape,
  propertyName,
  keyText,
  quoteOf,
  unwrap,
  applyEdits,
  type SpanEdit,
  type Located,
} from './astroSchemaSyntax';

import type {
  FieldSettings,
  FieldUpdate,
  ItemKind,
  NewFieldKind,
  SettingsChange,
  SettingsField,
  SettingsFieldKind,
  SettingsMember,
} from '../../shared/properties/collectionSettings';
import {
  COLLECTION_SETTINGS_LIMITS,
  holdsMembers,
  ITEM_KINDS,
  memberSettings,
  newFieldMembers,
  newFieldSettings,
  SETTINGS_FIELD_KINDS,
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

export function readCollectionSchema(source: string, collection: string): Result<SchemaRead, Described> {
  const located = locate(source, collection);
  if (!located.ok) {
    return located;
  }
  const { object, call, file } = located.value;
  const fields = object === undefined ? [] : object.properties.flatMap((property) => fieldOf(property, file));
  return { ok: true, value: { fields, source: loaderSource(call, file) } };
}

/** The config with `change` made to `collection`'s schema, or why it cannot be. */
export function editCollectionSchema(source: string, collection: string, change: SettingsChange): Result<SchemaEdit, Described> {
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
    return err(described('cmsBackend.schema.noObject', { collection }));
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
): Result<readonly SpanEdit[], Described> {
  const { file } = located;
  const named = (name: string) => object.properties.find((property) => propertyName(property) === name);
  switch (change.kind) {
    case 'reorder':
      return reorderFields(object, file, change.order);
    case 'renameField': {
      const property = named(change.from);
      if (property === undefined || property.name === undefined) {
        return err(described('cmsBackend.schema.noField', { name: change.from }));
      }
      if (named(change.to) !== undefined) {
        return err(described('cmsBackend.schema.fieldExists', { name: change.to }));
      }
      const key = keyText(change.to, { quoted: ts.isStringLiteral(property.name) });
      // A shorthand field names its schema's constant: that name stays as its value.
      const text = ts.isShorthandPropertyAssignment(property) ? `${key}: ${property.name.text}` : key;
      return {
        ok: true,
        value: [{ start: property.name.getStart(file), end: property.name.getEnd(), text }],
      };
    }
    case 'updateField':
      return updateField(located, named(change.update.name), change.update);
    case 'addField':
      return addField(located, object, change, named(change.name));
    case 'removeField': {
      const kept = object.properties.filter((property) => propertyName(property) !== change.name);
      if (kept.length === object.properties.length) {
        return err(described('cmsBackend.schema.noField', { name: change.name }));
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

function reorderFields(object: ts.ObjectLiteralExpression, file: ts.SourceFile, order: readonly string[]): Result<readonly SpanEdit[], Described> {
  const byName = new Map(object.properties.map((property) => [propertyName(property), property]));
  const known = order.every((name) => byName.has(name));
  if (!known || order.length !== object.properties.length) {
    return err(described('cmsBackend.schema.fieldsChanged'));
  }
  const texts = order.map((name) => byName.get(name)?.getText(file) ?? '');
  assert(
    texts.every((part) => part.length > 0),
    'Every reordered field has its text',
  );
  return { ok: true, value: [propertyList(object, file, texts)] };
}

function updateField(located: Located, property: ts.ObjectLiteralElementLike | undefined, update: FieldUpdate): Result<readonly SpanEdit[], Described> {
  const { file } = located;
  if (property === undefined) {
    return err(described('cmsBackend.schema.noField', { name: update.name }));
  }
  const schema = schemaOf(property);
  const chain = schema === undefined ? undefined : chainOf(schema, file);
  if (schema === undefined || chain === undefined) {
    return err(described('cmsBackend.schema.tooComplex', { name: update.name }));
  }
  const current = readItemKind(chain, file);
  const swapped = update.itemKind !== undefined && current !== undefined && update.itemKind !== current;
  const members = swapped
    ? swappedItems(located, chain, update)
    : update.members === undefined
      ? undefined
      : rewrittenMembers(located, chain, { name: update.name, members: update.members });
  if (members !== undefined && !members.ok) {
    return members;
  }
  const text = writeChain(members === undefined ? chain : { ...chain, base: members.value.base }, update);
  assert(text.length > 0, 'A field is written with a schema');
  const scope = members === undefined ? [] : members.value.scope;
  // A shorthand field becomes `name: constant…` once its chain holds more than the name.
  if (ts.isShorthandPropertyAssignment(property)) {
    const written = text === chain.base ? text : `${property.name.text}: ${text}`;
    const span = { start: property.getStart(file), end: property.getEnd() };
    return { ok: true, value: [{ ...span, text: written }, ...scope] };
  }
  return { ok: true, value: [{ start: schema.getStart(file), end: schema.getEnd(), text }, ...scope] };
}

// A list given another kind of item: its items are written again, a group's with its fields (a title when none are given).
function swappedItems(located: Located, chain: Chain, update: FieldUpdate): Result<{ readonly base: string; readonly scope: readonly SpanEdit[] }, Described> {
  const item = update.itemKind ?? 'text';
  const members = item === 'group' ? (update.members ?? newFieldMembers('repeater')) : undefined;
  const fresh = (members ?? []).filter((member) => member.kind !== 'other');
  const texts = fresh.map((member) => newMemberText(member, 1));
  if (texts.some((text) => text === undefined) || fresh.length !== (members ?? []).length) {
    return err(described('cmsBackend.schema.tooComplex', { name: update.name }));
  }
  const shape = texts.length === 0 ? '{ title: z.string().optional() }' : `{ ${texts.join(', ')} }`;
  const imaging = usesImage(fresh);
  const scope = imaging ? imageScope(located) : { ok: true as const, value: [] };
  if (!scope.ok) {
    return scope;
  }
  assert(chain.kind === 'list' || chain.kind === 'repeater', 'Only a list has its items swapped');
  return { ok: true, value: { base: `z.array(${itemSchema(item, shape)})`, scope: scope.value } };
}

// The `{ … }` a group's or repeater's fields are written in.
function membersShape(chain: Chain): ts.ObjectLiteralExpression | undefined {
  if (chain.kind === 'group') {
    return objectShape(chain.baseNode);
  }
  if (chain.kind === 'repeater' && ts.isCallExpression(chain.baseNode)) {
    return objectShape(chain.baseNode.arguments[0]);
  }
  return undefined;
}

// A group's or repeater's fields as the config states them: a field the form
// cannot read (a key it cannot name, a spread) is not listed and is kept.
function readMembers(chain: Chain, file: ts.SourceFile, depth = 0): readonly SettingsMember[] | undefined {
  if (depth >= COLLECTION_SETTINGS_LIMITS.memberDepthMax) {
    return undefined; // Deeper than the form nests: kept as written, listed as having no fields.
  }
  const shape = membersShape(chain);
  return shape?.properties.flatMap((property) => memberOf(property, file, depth));
}

// What a list holds, as its form names it: `other` for items written some other way.
function readItemKind(chain: Chain, file: ts.SourceFile): ItemKind | 'other' | undefined {
  if (chain.kind === 'repeater') {
    return 'group';
  }
  if (chain.kind !== 'list' || !ts.isCallExpression(chain.baseNode)) {
    return undefined;
  }
  const item = chain.baseNode.arguments[0];
  const read = item === undefined ? undefined : chainOf(item, file);
  const plain: readonly SettingsFieldKind[] = ['text', 'number', 'link', 'email', 'switch', 'date'];
  const found = ITEM_KINDS.find((candidate) => candidate === read?.kind && plain.includes(candidate));
  return found ?? 'other';
}

function memberOf(property: ts.ObjectLiteralElementLike, file: ts.SourceFile, depth = 0): SettingsMember[] {
  const name = propertyName(property);
  if (name === undefined || !MEMBER_NAME.test(name)) {
    return [];
  }
  const schema = schemaOf(property);
  const chain = schema === undefined ? undefined : chainOf(schema, file);
  if (chain === undefined) {
    return [{ name, kind: 'other', required: false, from: name, editable: false }];
  }
  return [
    {
      name,
      kind: chain.kind,
      ...readChain(chain),
      from: name,
      editable: true,
      members: holdsMembers(chain.kind) ? readMembers(chain, file, depth + 1) : undefined,
      itemKind: readItemKind(chain, file),
    },
  ];
}

// Whether a fresh member, however deep, is an image, which the config's schema function must provide.
function usesImage(members: readonly SettingsMember[], depth = 0): boolean {
  if (depth > COLLECTION_SETTINGS_LIMITS.memberDepthMax) {
    return false;
  }
  return members.some(
    (member) => (member.from === undefined && (member.kind === 'image' || member.kind === 'multiImage')) || usesImage(member.members ?? [], depth + 1),
  );
}

const MEMBER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * A chain's base with its fields rewritten as `members` say: each kept one
 * stays as written unless its name or whether it is required changed, each
 * new one is written fresh, one left out of the list is removed. The
 * `image` function a new image field needs comes with it, as `scope`.
 */
function rewrittenMembers(
  located: Located,
  chain: Chain,
  rewrite: { readonly name: string; readonly members: readonly SettingsMember[] },
  depth = 0,
): Result<{ readonly base: string; readonly scope: readonly SpanEdit[] }, Described> {
  assert(depth <= COLLECTION_SETTINGS_LIMITS.memberDepthMax, 'A group nests within its bound');
  const { file } = located;
  const { members } = rewrite;
  const shape = membersShape(chain);
  if (shape === undefined) {
    return err(described('cmsBackend.schema.tooComplex', { name: rewrite.name }));
  }
  const existing = new Map(shape.properties.map((property) => [propertyName(property), property]));
  const written = new Map<SettingsMember, string>();
  for (const member of members) {
    const text = memberText(member, member.from === undefined ? undefined : existing.get(member.from), { located, depth: depth + 1 });
    if (!text.ok) {
      return text;
    }
    written.set(member, text.value);
  }
  // Each field of the form stays where the config has it, with what the form cannot list
  // (a spread, an odd key) between them, so a save that changes nothing changes no text;
  // a form that reordered the fields, or put a new one among them, writes them in its order.
  const listed = shape.properties.filter((property) => memberOf(property, file).length > 0).map((property) => propertyName(property));
  const kept = members.filter((member) => member.from !== undefined);
  const added = members.filter((member) => member.from === undefined);
  const inPlace =
    members.every((member, index) => member === [...kept, ...added][index]) &&
    JSON.stringify(kept.map((member) => member.from)) === JSON.stringify(listed.filter((name) => kept.some((member) => member.from === name)));
  const texts: string[] = [];
  if (inPlace) {
    for (const property of shape.properties) {
      const member = kept.find((each) => each.from === propertyName(property));
      if (memberOf(property, file).length === 0) {
        texts.push(property.getText(file));
      } else if (member !== undefined) {
        texts.push(written.get(member) ?? '');
      }
    }
    texts.push(...added.map((member) => written.get(member) ?? ''));
  } else {
    texts.push(...members.map((member) => written.get(member) ?? ''));
    texts.push(...shape.properties.filter((property) => memberOf(property, file).length === 0).map((property) => property.getText(file)));
  }
  assert(
    texts.every((text) => text.length > 0),
    'Every field of a group is written',
  );
  const edit = propertyList(shape, file, texts);
  const baseStart = chain.baseNode.getStart(file);
  const base = chain.base.slice(0, edit.start - baseStart) + edit.text + chain.base.slice(edit.end - baseStart);
  const scope = depth === 0 && usesImage(members) ? imageScope(located) : { ok: true as const, value: [] };
  if (!scope.ok) {
    return scope;
  }
  assert(base.length >= chain.base.length - (edit.end - edit.start), 'A rewritten shape keeps the rest of its base');
  return { ok: true, value: { base, scope: scope.value } };
}

// One field of a group, as the config writes it: a new one fresh, a kept one with only what the form changed.
function memberText(
  member: SettingsMember,
  property: ts.ObjectLiteralElementLike | undefined,
  within: { readonly located: Located; readonly depth: number },
): Result<string, Described> {
  const { file } = within.located;
  if (member.from === undefined) {
    const fresh = newMemberText(member, within.depth);
    return fresh === undefined ? err(described('cmsBackend.schema.tooComplex', { name: member.name })) : { ok: true, value: fresh };
  }
  if (property === undefined || property.name === undefined) {
    return err(described('cmsBackend.schema.noField', { name: member.from }));
  }
  const schema = schemaOf(property);
  const chain = schema === undefined ? undefined : chainOf(schema, file);
  const renamed = member.name !== member.from;
  const key = renamed ? keyText(member.name, { quoted: ts.isStringLiteral(property.name) }) : undefined;
  let value = schema?.getText(file) ?? '';
  if (chain !== undefined) {
    const settings = readChain(chain);
    // A member that carries no settings (an older caller) only has its requiredness applied.
    const next =
      member.checks === undefined
        ? { ...settings, required: member.required, defaultValue: member.required ? undefined : settings.defaultValue }
        : { ...memberSettings(member), options: member.options ?? settings.options };
    let working = chain;
    if (holdsMembers(chain.kind) && member.members !== undefined && readMembers(chain, file, within.depth) !== undefined) {
      const inner = rewrittenMembers(within.located, chain, { name: member.name, members: member.members }, within.depth);
      if (!inner.ok) {
        return inner;
      }
      working = { ...chain, base: inner.value.base };
    }
    if (working !== chain || JSON.stringify(next) !== JSON.stringify(settings)) {
      value = writeChain(working, next);
    }
  }
  if (key === undefined) {
    // A shorthand member names its schema's constant, which only a rename has to spell out.
    return { ok: true, value: value === schema?.getText(file) ? property.getText(file) : `${property.name.getText(file)}: ${value}` };
  }
  return { ok: true, value: `${key}: ${value}` };
}

// A new field of a group, with its settings and (for a group, a repeater or a list) its fields or items.
function newMemberText(member: SettingsMember, depth: number): string | undefined {
  assert(depth <= COLLECTION_SETTINGS_LIMITS.memberDepthMax + 1, 'A group nests within its bound');
  const kind = SETTINGS_FIELD_KIND_NEW.find((candidate) => candidate === member.kind);
  if (kind === undefined || kind === 'reference' || kind === 'multiReference') {
    return undefined;
  }
  const contents: Contents = {
    members: holdsMembers(kind) ? member.members : undefined,
    itemKind: kind === 'list' && member.itemKind !== 'other' ? member.itemKind : undefined,
    depth,
  };
  return `${keyText(member.name, { quoted: false })}: ${settledFieldText(kind, '', memberSettings(member), contents)}`;
}

const SETTINGS_FIELD_KIND_NEW: readonly NewFieldKind[] = SETTINGS_FIELD_KINDS.filter((kind): kind is NewFieldKind => kind !== 'other');

// A field's schema as written: `name: schema`, or `name` alone naming a constant.
function schemaOf(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
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
    readonly settings: FieldSettings;
    readonly members?: readonly SettingsMember[] | undefined;
    readonly itemKind?: ItemKind | undefined;
  },
  existing: ts.ObjectLiteralElementLike | undefined,
): Result<readonly SpanEdit[], Described> {
  const { file } = located;
  if (existing !== undefined) {
    return err(described('cmsBackend.schema.fieldExists', { name: field.name }));
  }
  const target = field.target ?? '';
  const pointing = field.fieldKind === 'reference' || field.fieldKind === 'multiReference';
  if (pointing && !collectionsObject(file)?.properties.some((property) => propertyName(property) === target)) {
    return err(described('cmsBackend.schema.notCollection', { name: target }));
  }
  const key = keyText(field.name, { quoted: false });
  const added = `${key}: ${settledFieldText(field.fieldKind, target, field.settings, { members: holdsMembers(field.fieldKind) ? field.members : undefined, itemKind: field.itemKind })}`;
  const texts = [...object.properties.map((property) => property.getText(file)), added];
  const imaging = field.fieldKind === 'image' || field.fieldKind === 'multiImage' || usesImage(field.members ?? []);
  const scope = imaging ? imageScope(located) : { ok: true as const, value: [] };
  if (!scope.ok) {
    return scope;
  }
  const imported = pointing ? referenceImport(file) : [];
  return { ok: true, value: [propertyList(object, file, texts), ...scope.value, ...imported] };
}

/** A new field's schema with its settings written in, as an existing field's would be. */
export function settledFieldText(kind: NewFieldKind, target: string, settings: FieldSettings, contents: Contents = {}): string {
  const plain = newFieldText(kind, target, contents);
  const file = ts.createSourceFile('field.ts', `(${plain})`, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  assert(statement !== undefined, 'A new field’s schema parses');
  assert(ts.isExpressionStatement(statement), 'A new field’s schema is an expression');
  const schema = unwrap(statement.expression);
  const chain = schema === undefined ? undefined : chainOf(schema, file);
  assert(chain !== undefined, 'A new field’s schema reads as a chain');
  // The form starts from newFieldSettings: it must be what the plain schema states.
  assert(JSON.stringify(readChain(chain)) === JSON.stringify(newFieldSettings(kind)), `A new ${kind} field reads back as its starting settings`);
  return writeChain(chain, settings);
}

/** The schema a new field of `kind` is written as. */
export function newFieldText(kind: NewFieldKind, target: string, contents: Contents = {}): string {
  const pointed = `reference(${JSON.stringify(target)})`;
  const shape = membersText(contents.members, contents.depth ?? 0);
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
    list: `z.array(${itemSchema(contents.itemKind ?? 'text', shape)})`,
    repeater: `z.array(${itemSchema('group', shape)})`,
    group: `z.object(${shape})`,
    keyValue: 'z.record(z.string(), z.string())',
    constant: "z.literal('value')",
    any: 'z.unknown()',
  };
  return `${schemas[kind]}.optional()`;
}

/** What a new group or list is written with beyond its kind: a group's fields, a list's item kind. */
export interface Contents {
  readonly members?: readonly SettingsMember[] | undefined;
  readonly itemKind?: ItemKind | undefined;
  /** How deep the group being written sits, for the bound on nesting. */
  readonly depth?: number | undefined;
}

// One list item's schema: a plain value, or a group written with `shape`.
function itemSchema(item: ItemKind, shape: string): string {
  const schemas: Readonly<Record<ItemKind, string>> = {
    text: 'z.string()',
    number: 'z.number()',
    link: 'z.string().url()',
    email: 'z.string().email()',
    switch: 'z.boolean()',
    date: 'z.coerce.date()',
    group: `z.object(${shape})`,
  };
  return schemas[item];
}

// A new group's fields as the `{ … }` it is written with; with none given, a title.
function membersText(members: readonly SettingsMember[] | undefined, depth: number): string {
  if (members === undefined) {
    return '{ title: z.string().optional() }';
  }
  const texts = members.map((member) => newMemberText(member, depth + 1));
  assert(
    texts.every((text) => text !== undefined),
    'A new group holds only fields a form can make',
  );
  return `{ ${texts.join(', ')} }`;
}

// `image()` comes from the schema's function: a schema written as an object becomes
// one, and a function that does not take `image` takes it too.
function imageScope(located: Located): Result<readonly SpanEdit[], Described> {
  const { file } = located;
  const schema = schemaProperty(located.call);
  if (schema === undefined) {
    return err(described('cmsBackend.schema.noImageSchema'));
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
      value: [{ start: open, end: value.equalsGreaterThanToken.getStart(file), text: '({ image }) ' }],
    };
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    return err(described('cmsBackend.schema.imageByHand'));
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
      // i18n-ignore: Source code written into the user's content config.
      return [{ start: last.getEnd(), end: last.getEnd(), text: ', reference' }];
    }
  }
  return [{ start: 0, end: 0, text: "import { reference } from 'astro:content';\n" }];
}

function renameCollection(source: string, located: Located, rename: { readonly from: string; readonly to: string }): Result<SchemaEdit, Described> {
  const { entry, file, call } = located;
  const collections = entry.parent;
  assert(ts.isObjectLiteralExpression(collections), 'A collection is listed in an object');
  if (collections.properties.some((property) => propertyName(property) === rename.to)) {
    return err(described('cmsBackend.schema.collectionExists', { name: rename.to }));
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
  const moved = named && folder !== undefined ? `${folder.split('/').slice(0, -1).join('/')}/${rename.to}` : undefined;
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
function deleteCollection(source: string, name: string): Result<SchemaEdit, Described> {
  const first = ts.createSourceFile('content.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const collections = collectionsObject(first);
  if (collections === undefined) {
    return err(described('cmsBackend.config.noCollections'));
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
function declarationOf(entry: ts.ObjectLiteralElementLike, file: ts.SourceFile): SpanEdit | undefined {
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
      each.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === named),
  );
  if (statement === undefined) {
    return undefined;
  }
  // Declared once and listed once: nothing else would miss it. Only names in
  // code count; the same word in a string (a loader's `./src/content/team`) or
  // as a property key (`team: teamCollection`) is no use of the const.
  const uses = identifierUses(file, named);
  assert(uses >= 2, 'A listed collection const is declared and listed');
  if (uses > 2) {
    return undefined;
  }
  const end = file.text.charAt(statement.getEnd()) === '\n' ? statement.getEnd() + 1 : statement.getEnd();
  return { start: statement.getStart(file), end, text: '' };
}

// How often `name` appears in the file as an identifier that names a value:
// a declaration or a reference, never a property key or a member name.
function identifierUses(file: ts.SourceFile, name: string): number {
  let uses = 0;
  const pending: ts.Node[] = [file];
  // Every node is visited once; a config file is bounded by the read limit.
  for (let visited = 0; visited < IDENTIFIER_NODES_MAX; visited++) {
    const node = pending.pop();
    if (node === undefined) {
      return uses;
    }
    if (ts.isIdentifier(node) && node.text === name && namesValue(node)) {
      uses++;
    }
    pending.push(...node.getChildren(file));
  }
  throw new Error('The content config is too large to edit.');
}

const IDENTIFIER_NODES_MAX = 1_000_000;

function namesValue(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) {
    return parent.name !== identifier;
  }
  if (ts.isPropertyAccessExpression(parent)) {
    return parent.expression === identifier;
  }
  return true;
}

function loaderSource(call: ts.CallExpression | undefined, file: ts.SourceFile): string | undefined {
  const base = globBase(call);
  if (base !== undefined) {
    return base.text.replace(/^\.\//, '');
  }
  const loader = loaderCall(call);
  const first = loader?.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text.replace(/^\.\//, '') : loader?.getText(file);
}

function globBase(call: ts.CallExpression | undefined): ts.StringLiteralLike | undefined {
  const loader = loaderCall(call);
  if (loader === undefined || !ts.isIdentifier(loader.expression) || loader.expression.text !== 'glob') {
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
  const value = loader !== undefined && ts.isPropertyAssignment(loader) ? unwrap(loader.initializer) : undefined;
  return value !== undefined && ts.isCallExpression(value) ? value : undefined;
}

// One field: its name, its kind, and the settings its chain states.
function fieldOf(property: ts.ObjectLiteralElementLike, file: ts.SourceFile): SettingsField[] {
  const name = propertyName(property);
  if (name === undefined || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return [];
  }
  const schema = schemaOf(property);
  const chain = schema === undefined ? undefined : chainOf(schema, file);
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
  return [
    {
      name,
      kind: chain.kind,
      ...readChain(chain),
      editable: true,
      target: referenceTarget(property),
      members: holdsMembers(chain.kind) ? readMembers(chain, file) : undefined,
      itemKind: readItemKind(chain, file),
    },
  ];
}

// `z.string().min(1).optional()` → base `z.string()`, steps min and optional.
// Anything else at the root — a schema kept in a constant (`titleSchema`), a
// helper's call (`slugField()`) — is a base of its own, kept as written.
function chainOf(expression: ts.Expression, file: ts.SourceFile): Chain | undefined {
  const steps: ChainStep[] = [];
  let node: ts.Expression = expression;
  for (let depth = 0; depth < CHAIN_STEPS_MAX; depth += 1) {
    const callee = ts.isCallExpression(node) ? node.expression : undefined;
    const kind = callee === undefined ? undefined : baseKind(callee);
    if (kind !== undefined && ts.isCallExpression(node)) {
      const ordered = steps.reverse();
      return {
        base: node.getText(file),
        baseNode: node,
        kind: refinedKind(kind, node, ordered),
        steps: ordered,
      };
    }
    if (callee === undefined || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(callee)) {
      return { base: node.getText(file), baseNode: node, kind: 'other', steps: steps.reverse() };
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
function refinedKind(kind: SettingsFieldKind, base: ts.CallExpression, steps: readonly ChainStep[]): SettingsFieldKind {
  const has = (name: string) => steps.some((step) => step.name === name);
  if (kind === 'text') {
    return has('email') ? 'email' : has('url') ? 'link' : has('regex') ? 'color' : 'text';
  }
  if (kind !== 'list') {
    return kind;
  }
  const item = base.arguments[0];
  // A list of groups is a repeater, however its items are chained.
  if (objectShape(item) !== undefined) {
    return 'repeater';
  }
  const callee = item !== undefined && ts.isCallExpression(item) ? item.expression : undefined;
  if (callee !== undefined && ts.isIdentifier(callee)) {
    return callee.text === 'image' ? 'multiImage' : callee.text === 'reference' ? 'multiReference' : 'list';
  }
  return 'list';
}

// The kind a base call makes, or undefined when `callee` is not a base.
function baseKind(callee: ts.LeftHandSideExpression): SettingsFieldKind | undefined {
  if (ts.isIdentifier(callee)) {
    return callee.text === 'image' ? 'image' : callee.text === 'reference' ? 'reference' : undefined;
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
