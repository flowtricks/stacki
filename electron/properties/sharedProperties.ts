// Props a component takes from a type another file owns. BaseLayout's
// `type Props = SeoProps & { theme?: … }` reads SeoProps from src/types.ts, and
// BaseHead's `type Props = SeoProps` reads the same one. The panel lists the
// type's members as the component's props, each carrying where it is declared
// and who else reads it (PropertyShare), and an edit writes the shared file:
// its name, type, flags and tooltip live there. A default lives in each
// component's own destructure, so it is written in the component being
// edited, and only when that component destructures the prop.
//
// A rename reaches every file the type's name reaches: the member in the
// shared file; in each component using the type, its destructure, its
// `Astro.props.x` reads and its rest variable's `seo.x` reads; and every
// instance of those components. The batch is planned in full before anything
// is written and committed as one, so Undo reverts all of it. What cannot be
// renamed safely (a computed key, a rest variable passed on in code, a
// consumer the rename planner refuses) refuses the rename, naming the file,
// and leaves every other kind of edit available.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import type {
  ComponentProperties,
  ComponentProperty,
  PropertyChange,
  PropertyOptionRename,
  PropertyShare,
  PropertyShareDefault,
} from '../../shared/properties/propertyEditing';
import { literalOptions } from '../../shared/properties/propertyOptions';
import { toPosix } from '../lib/mainHelpers';
import { sameFilesystemPath } from '../lib/platform';
import { resolveImportPath } from './importPaths';
import { projectSources, readBoundedSource, readPropertyConsumers } from './propertyConsumers';
import { bindingEdits, memberComment, memberEdits, sameDeclaration } from './propertyMemberEdits';
import { renameComponentOptionValues, renameComponentReferences, renamePropertyLocal } from './propertyRename';
import {
  applySourceEdits,
  isAstroProps,
  propertyKey,
  readPropertySyntax,
  replaceFrontmatter,
  syntaxError,
  syntaxNodes,
  validatePropertyCode,
} from './propertySyntax';
import type { PropertySyntax, SourceEdit } from './propertySyntax';
import { createPropertyTypeReader, optionAliasOf } from './propertyTypes';

export interface SharedLocation {
  readonly projectPath: string;
  readonly file: string;
}
export interface SharedFileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/** An imported name the component's Props is built from: `SeoProps` from "@/types.ts". */
interface SharedReference {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}
/** The shared declaration, read from its own file. */
interface SharedType {
  readonly typeName: string;
  readonly file: string;
  readonly source: string;
  readonly syntax: ts.SourceFile;
  readonly members: readonly ts.PropertySignature[];
}
/** A component whose Props uses the shared type. */
interface SharedUser {
  readonly file: string;
  readonly source: string;
}

const SHARED_TYPES_MAX = 16;
const SHARED_EXTENSIONS = /\.(?:ts|mts|cts)$/;

/**
 * The component's properties with its shared types' members listed among
 * them. A member the component also declares itself stays the component's
 * own (it combines two declarations, and the contract reader restricts it).
 */
export function withSharedProperties(location: SharedLocation, data: ComponentProperties): Result<ComponentProperties> {
  const types = readSharedTypes(location, data.source);
  if (types.length === 0) {
    return ok(data);
  }
  const local = readPropertySyntax(data.source);
  const declared = new Set(localMemberNames(local.syntax));
  const properties = new Map(data.properties.map((property) => [property.name, property]));
  for (const type of types) {
    const users = sharedTypeUsers(location.projectPath, type);
    if (!users.ok) {
      return users;
    }
    const share = sharedShare(location.projectPath, type, users.value);
    for (const member of type.members) {
      const name = propertyKey(member.name);
      assert(name !== undefined, 'A shared member has a plain name');
      if (declared.has(name)) {
        continue;
      }
      properties.set(name, sharedProperty(type, member, local, { ...share, defaults: sharedDefaults(location.projectPath, users.value, name) }));
    }
  }
  assert(properties.size <= PROPERTY_LIMITS.fieldsMax, 'Shared properties are bounded');
  // Own props first, in their order; then each shared type's, in its declaration order.
  const own = data.properties.filter((property) => properties.get(property.name)?.shared === undefined);
  const shared = [...properties.values()].filter((property) => property.shared !== undefined);
  return ok({ ...data, properties: [...own, ...shared] });
}

/**
 * The batch a change to a shared prop writes, or undefined when the change is
 * not to one (the component's own declaration takes it).
 */
export function planSharedPropertyChange(location: SharedLocation, source: string, change: PropertyChange): Result<readonly SharedFileChange[]> | undefined {
  const name = sharedChangeName(change);
  if (name === undefined) {
    return undefined;
  }
  const type = readSharedTypes(location, source).find((candidate) => candidate.members.some((member) => propertyKey(member.name) === name));
  if (type === undefined) {
    return undefined;
  }
  const local = readPropertySyntax(source);
  if (localMemberNames(local.syntax).includes(name)) {
    return undefined;
  }
  switch (change.kind) {
    case 'remove':
      return err({
        code: 'shared',
        message: `${name} is declared in ${type.typeName} (${toPosix(path.relative(location.projectPath, type.file))}). Delete it there in source.`,
      });
    case 'options':
    case 'save':
      return planSharedSave(location, source, type, sharedSaveOf(change, type, local));
    case 'order':
    case 'source':
      return undefined;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function sharedChangeName(change: PropertyChange): string | undefined {
  switch (change.kind) {
    case 'save':
      return change.originalName === '' ? undefined : change.originalName;
    case 'remove':
    case 'options':
      return change.name;
    case 'order':
    case 'source':
      return undefined;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

interface SharedSave {
  readonly originalName: string;
  readonly property: ComponentProperty;
  readonly optionRenames: readonly PropertyOptionRename[];
}

function sharedSaveOf(change: Extract<PropertyChange, { readonly kind: 'save' | 'options' }>, type: SharedType, local: PropertySyntax): SharedSave {
  if (change.kind === 'save') {
    return { originalName: change.originalName, property: change.property, optionRenames: change.optionRenames ?? [] };
  }
  const member = type.members.find((item) => propertyKey(item.name) === change.name);
  assert(member !== undefined, 'An options change names a shared member');
  const previous = sharedProperty(type, member, local, undefined);
  return { originalName: change.name, property: { ...previous, type: change.type }, optionRenames: [] };
}

// The whole save: the shared file's declaration, this component's default, and,
// on a rename or an option rename, every user and instance.
function planSharedSave(location: SharedLocation, source: string, type: SharedType, save: SharedSave): Result<readonly SharedFileChange[]> {
  const { originalName, property } = save;
  const member = type.members.find((item) => propertyKey(item.name) === originalName);
  assert(member !== undefined, 'A shared save names a shared member');
  const valid = validatePropertyCode(property.type, property.defaultValue);
  if (!valid.ok) {
    return valid;
  }
  const local = readPropertySyntax(source);
  const previous = sharedProperty(type, member, local, undefined);
  const users = sharedTypeUsers(location.projectPath, type);
  if (!users.ok) {
    return users;
  }
  const texts = new Map<string, { readonly before: string; after: string }>();
  texts.set(location.file, { before: source, after: source });
  const declaration = sharedDeclarationEdit(type, member, previous, property);
  if (!declaration.ok) {
    return declaration;
  }
  if (declaration.value !== type.source) {
    texts.set(type.file, { before: type.source, after: declaration.value });
  }
  const fallback = sharedDefaultEdit(location, type, users.value, source, previous, property);
  if (!fallback.ok) {
    return fallback;
  }
  setText(texts, location.file, fallback.value);
  if (property.name !== originalName) {
    const collision = sharedNameCollision(location.projectPath, type, users.value, property.name);
    if (collision !== undefined) {
      return err({ code: 'duplicate', message: collision });
    }
    const renamed = planSharedRename(location.projectPath, users.value, texts, { from: originalName, to: property.name });
    if (!renamed.ok) {
      return renamed;
    }
  }
  if (save.optionRenames.length > 0) {
    const renamed = planSharedOptionRenames(location.projectPath, users.value, texts, property, previous, save.optionRenames);
    if (!renamed.ok) {
      return renamed;
    }
  }
  const changes = [...texts.entries()].map(([file, text]) => ({ file, before: text.before, after: text.after }));
  assert(changes.length <= PROPERTY_LIMITS.filesMax, 'A shared batch is bounded');
  assert(
    changes.some((entry) => sameFilesystemPath(entry.file, location.file)),
    'A shared batch includes the component edited',
  );
  return ok(changes.filter((entry) => entry.before !== entry.after || sameFilesystemPath(entry.file, location.file)));
}

function setText(texts: Map<string, { readonly before: string; after: string }>, file: string, after: string): void {
  const entry = [...texts.entries()].find(([key]) => sameFilesystemPath(key, file))?.[1];
  assert(entry !== undefined, 'A text is set on a file the batch read');
  entry.after = after;
}

function textOf(texts: Map<string, { readonly before: string; after: string }>, file: string): Result<string> {
  const entry = [...texts.entries()].find(([key]) => sameFilesystemPath(key, file))?.[1];
  if (entry !== undefined) {
    return ok(entry.after);
  }
  const read = readBoundedSource(file);
  if (!read.ok) {
    return read;
  }
  texts.set(file, { before: read.value, after: read.value });
  return read;
}

// The shared file with the member's name, type, flags and tooltip changed in place.
function sharedDeclarationEdit(type: SharedType, member: ts.PropertySignature, previous: ComponentProperty, property: ComponentProperty): Result<string> {
  if (sameDeclaration(previous, property)) {
    return ok(type.source);
  }
  const alias = optionAliasOf(type.syntax, member);
  const target = alias !== undefined && literalOptions(property.type) !== undefined ? alias.declaration.type : member.type;
  const edits = memberEdits(type.source, member, previous, property, target);
  const output = applySourceEdits(type.source, edits);
  const error = syntaxError(output);
  if (error !== undefined) {
    return err({ code: 'syntax', message: `${path.basename(type.file)}: ${error}` });
  }
  assert(output !== type.source, 'A changed shared declaration writes its change');
  return ok(output);
}

// A default is the component's own: its destructure's `= value`. One that
// passes the prop on in a rest (`...seo`) has no entry to give one, and adding
// one would take the prop out of what it forwards.
function sharedDefaultEdit(
  location: SharedLocation,
  type: SharedType,
  users: readonly SharedUser[],
  source: string,
  previous: ComponentProperty,
  property: ComponentProperty,
): Result<string> {
  if (property.defaultValue.trim() === previous.defaultValue.trim()) {
    return ok(source);
  }
  const document = readPropertySyntax(source);
  const binding = propsBindings(document.syntax).find((item) => propertyKey(item.propertyName ?? item.name) === previous.name);
  if (binding === undefined) {
    const where = sharedDefaults(location.projectPath, users, previous.name).map((entry) => `${entry.path} (${entry.expression})`);
    const elsewhere = where.length > 0 ? ` It has one in ${where.join(', ')}.` : '';
    return err({
      code: 'default',
      message: `This component passes ${previous.name} on to ${type.typeName}'s other users without destructuring it, so it has no default of its own.${elsewhere}`,
    });
  }
  const edits = bindingEdits(binding, previous, { ...previous, defaultValue: property.defaultValue });
  const frontmatter = applySourceEdits(document.frontmatter, edits);
  const error = syntaxError(frontmatter);
  if (error !== undefined) {
    return err({ code: 'syntax', message: error });
  }
  return ok(replaceFrontmatter(document, frontmatter));
}

function sharedNameCollision(projectPath: string, type: SharedType, users: readonly SharedUser[], name: string): string | undefined {
  if (type.members.some((member) => propertyKey(member.name) === name)) {
    return `${type.typeName} already declares ${name}.`;
  }
  for (const user of users) {
    if (localMemberNames(readPropertySyntax(user.source).syntax).includes(name)) {
      return `${toPosix(path.relative(projectPath, user.file))} already declares a prop named ${name}.`;
    }
  }
  return undefined;
}

// Every user's own reads, then every instance of every user.
function planSharedRename(
  projectPath: string,
  users: readonly SharedUser[],
  texts: Map<string, { readonly before: string; after: string }>,
  rename: { readonly from: string; readonly to: string },
): Result<void> {
  assert(rename.from !== rename.to, 'A shared rename changes the name');
  assert(users.length <= PROPERTY_LIMITS.filesMax, 'Shared users are bounded');
  const forwarded = new Map(users.map((user) => [user.file, restLocals(readPropertySyntax(user.source).syntax)]));
  for (const user of users) {
    const text = textOf(texts, user.file);
    if (!text.ok) {
      return text;
    }
    const renamed = renameSharedUser(text.value, rename, forwarded.get(user.file) ?? new Set());
    if (!renamed.ok) {
      return err({ code: renamed.error.code, message: `${toPosix(path.relative(projectPath, user.file))}: ${renamed.error.message}` });
    }
    setText(texts, user.file, renamed.value);
  }
  for (const user of users) {
    const consumers = readPropertyConsumers({ projectPath, file: user.file });
    if (!consumers.ok) {
      return consumers;
    }
    for (const consumer of consumers.value) {
      if (sameFilesystemPath(consumer.file, user.file) || consumer.names.size === 0) {
        continue;
      }
      const text = textOf(texts, consumer.file);
      if (!text.ok) {
        return text;
      }
      const spreads = [...forwarded.entries()].find(([file]) => sameFilesystemPath(file, consumer.file))?.[1] ?? new Set<string>();
      const renamed = renameComponentReferences(text.value, consumer.names, rename, 'consumer', spreads);
      if (!renamed.ok) {
        return err({ code: renamed.error.code, message: `${toPosix(path.relative(projectPath, consumer.file))}: ${renamed.error.message}` });
      }
      setText(texts, consumer.file, renamed.value);
    }
  }
  return ok(undefined);
}

// One user: its destructure entry, its `Astro.props.x` reads, and its rest's `seo.x` reads.
function renameSharedUser(source: string, rename: { readonly from: string; readonly to: string }, rests: ReadonlySet<string>): Result<string> {
  let text = source;
  const binding = propsBindings(readPropertySyntax(text).syntax).find((item) => propertyKey(item.propertyName ?? item.name) === rename.from);
  if (binding !== undefined && ts.isIdentifier(binding.name) && binding.name.text === rename.from) {
    // `{ title }` becomes `{ title: heading }` with every read of the local renamed by scope.
    const local = renamePropertyLocal(text, rename);
    if (!local.ok) {
      return local;
    }
    text = local.value;
  }
  const keyed = renameBindingKey(text, rename);
  if (!keyed.ok) {
    return keyed;
  }
  const reads = renameComponentReferences(keyed.value, new Set(), rename, 'definition');
  if (!reads.ok) {
    return reads;
  }
  return renameRestReads(reads.value, rename, rests);
}

// `{ title: heading }` → `{ heading }`, `{ title: label }` → `{ heading: label }`.
function renameBindingKey(source: string, rename: { readonly from: string; readonly to: string }): Result<string> {
  const document = readPropertySyntax(source);
  const binding = propsBindings(document.syntax).find((item) => propertyKey(item.propertyName ?? item.name) === rename.from);
  if (binding === undefined) {
    return ok(source);
  }
  const fallback = binding.initializer?.getText() ?? '';
  const previous = { name: rename.from, defaultValue: fallback };
  const property: ComponentProperty = { name: rename.to, type: '', required: false, readonly: false, defaultValue: fallback, description: '' };
  const frontmatter = applySourceEdits(document.frontmatter, bindingEdits(binding, previous, property));
  return ok(replaceFrontmatter(document, frontmatter));
}

// Reads of a rest variable (`seo.title`, `seo["title"]`) follow the member; a
// computed read or any other use of the variable could reach it by a name this
// cannot see, so the rename is refused. Spreads (`{...seo}`) carry the type.
function renameRestReads(source: string, rename: { readonly from: string; readonly to: string }, rests: ReadonlySet<string>): Result<string> {
  if (rests.size === 0) {
    return ok(source);
  }
  const document = readPropertySyntax(source);
  const edits: SourceEdit[] = [];
  for (const node of syntaxNodes(document.syntax)) {
    if (!ts.isIdentifier(node) || !rests.has(node.text)) {
      continue;
    }
    const parent = node.parent;
    if (ts.isBindingElement(parent) && parent.dotDotDotToken !== undefined) {
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === rename.from) {
        edits.push({ start: document.start + parent.name.getStart(), end: document.start + parent.name.end, text: rename.to });
      }
      continue;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteral(parent.argumentExpression)) {
      if (parent.argumentExpression.text === rename.from) {
        const key = parent.argumentExpression;
        edits.push({ start: document.start + key.getStart(), end: document.start + key.end, text: JSON.stringify(rename.to) });
      }
      continue;
    }
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) {
      continue;
    }
    return err({ code: 'rest', message: `${node.text} is used in code in a way a rename cannot follow. Rename ${rename.from} there in source.` });
  }
  const template = source.slice(document.end);
  const offset = document.end;
  for (const rest of rests) {
    const escaped = rest.replace(/[$]/g, '\\$');
    for (const match of template.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\b(\\s*\\.\\s*([\\w$]+)|\\s*\\[)?`, 'g'))) {
      const access = match[1];
      const key = match[2];
      const before = template.slice(Math.max(0, match.index - 3), match.index);
      if (access === undefined) {
        // A spread forwards the whole rest, which carries the renamed type.
        if (before.endsWith('...')) {
          continue;
        }
        return err({ code: 'rest', message: `${rest} is used in the template in a way a rename cannot follow. Rename ${rename.from} there in source.` });
      }
      if (key === undefined) {
        return err({ code: 'computed', message: `${rest} is read with a computed key. Make that read explicit before renaming ${rename.from}.` });
      }
      if (key === rename.from) {
        const start = offset + match.index + match[0].length - key.length;
        edits.push({ start, end: start + key.length, text: rename.to });
      }
    }
  }
  return ok(applySourceEdits(source, edits));
}

function planSharedOptionRenames(
  projectPath: string,
  users: readonly SharedUser[],
  texts: Map<string, { readonly before: string; after: string }>,
  property: ComponentProperty,
  previous: ComponentProperty,
  renames: readonly PropertyOptionRename[],
): Result<void> {
  const before = literalOptions(previous.type);
  const after = literalOptions(property.type);
  if (before === undefined || after === undefined) {
    return err({ code: 'option', message: 'Option renames require an editable literal union.' });
  }
  for (const rename of renames) {
    if (!before.includes(rename.from) || !after.includes(rename.to)) {
      return err({ code: 'option', message: 'An option rename does not match the saved union.' });
    }
  }
  for (const user of users) {
    const consumers = readPropertyConsumers({ projectPath, file: user.file });
    if (!consumers.ok) {
      return consumers;
    }
    for (const consumer of consumers.value) {
      if (sameFilesystemPath(consumer.file, user.file) || consumer.names.size === 0) {
        continue;
      }
      const text = textOf(texts, consumer.file);
      if (!text.ok) {
        return text;
      }
      const renamed = renameComponentOptionValues(text.value, consumer.names, property.name, renames);
      if (!renamed.ok) {
        return err({ code: renamed.error.code, message: `${toPosix(path.relative(projectPath, consumer.file))}: ${renamed.error.message}` });
      }
      setText(texts, consumer.file, renamed.value);
    }
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Reading shared types and their users
// ---------------------------------------------------------------------------

function readSharedTypes(location: SharedLocation, source: string): readonly SharedType[] {
  const document = readPropertySyntax(source);
  const types: SharedType[] = [];
  for (const reference of sharedReferences(document.syntax)) {
    const type = readSharedType(location, reference);
    if (type !== undefined && !types.some((existing) => sameFilesystemPath(existing.file, type.file) && existing.typeName === type.typeName)) {
      types.push(type);
    }
  }
  assert(types.length <= SHARED_TYPES_MAX, 'Shared types per component are bounded');
  return types;
}

// The imported names `Props` is directly built from: the parts of its
// intersection, the type it aliases, or the interfaces it extends. A name
// nested in a union, a generic or a mapped type is not one: its members are
// conditional or computed.
function sharedReferences(syntax: ts.SourceFile): readonly SharedReference[] {
  const imports = new Map<string, SharedReference>();
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (specifier === 'astro/types' || bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      imports.set(element.name.text, { local: element.name.text, imported: (element.propertyName ?? element.name).text, specifier });
    }
  }
  const declaration = syntax.statements.find(
    (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === 'Props',
  );
  if (declaration === undefined || declaration.typeParameters !== undefined) {
    return [];
  }
  const parts: ts.Node[] = ts.isTypeAliasDeclaration(declaration)
    ? [declaration.type]
    : (declaration.heritageClauses ?? []).flatMap((clause) => [...clause.types]);
  const references: SharedReference[] = [];
  for (let index = 0; index < parts.length && index < PROPERTY_LIMITS.fieldsMax; index += 1) {
    const part = parts[index];
    assert(part !== undefined, 'A Props part exists');
    if (ts.isIntersectionTypeNode(part)) {
      parts.push(...part.types);
    } else if (ts.isParenthesizedTypeNode(part)) {
      parts.push(part.type);
    } else {
      const name = referenceName(part);
      const reference = name === undefined ? undefined : imports.get(name);
      if (reference !== undefined && references.length < SHARED_TYPES_MAX) {
        references.push(reference);
      }
    }
  }
  return references;
}

function referenceName(node: ts.Node): string | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined) {
    return node.typeName.text;
  }
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) && node.typeArguments === undefined) {
    return node.expression.text;
  }
  return undefined;
}

// The exported declaration, when it is a plain object of named members in a
// TypeScript file inside the project's src: one the panel can read and write.
function readSharedType(location: SharedLocation, reference: SharedReference): SharedType | undefined {
  const resolved = resolveImportPath(location.projectPath, location.file, reference.specifier);
  if (resolved === undefined || !SHARED_EXTENSIONS.test(resolved) || resolved.endsWith('.d.ts')) {
    return undefined;
  }
  const file = projectSourceFile(location.projectPath, resolved);
  if (file === undefined) {
    return undefined;
  }
  const source = readBoundedSource(file);
  if (!source.ok) {
    return undefined;
  }
  const syntax = ts.createSourceFile(file, source.value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = syntax.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === reference.imported,
  );
  const declaration = declarations[0];
  if (declarations.length !== 1 || declaration === undefined || declaration.typeParameters !== undefined) {
    return undefined;
  }
  if (!(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)) {
    return undefined;
  }
  const container = sharedContainer(declaration);
  if (container === undefined) {
    return undefined;
  }
  const members = container.members.filter(ts.isPropertySignature);
  if (members.length !== container.members.length || members.length > PROPERTY_LIMITS.fieldsMax) {
    return undefined;
  }
  if (members.some((member) => member.name === undefined || !ts.isIdentifier(member.name))) {
    return undefined;
  }
  return { typeName: reference.imported, file, source: source.value, syntax, members };
}

function sharedContainer(declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined {
  if (ts.isInterfaceDeclaration(declaration)) {
    // An interface that extends another inherits members this file does not hold.
    return declaration.heritageClauses === undefined ? declaration : undefined;
  }
  return ts.isTypeLiteralNode(declaration.type) ? declaration.type : undefined;
}

function projectSourceFile(projectPath: string, file: string): string | undefined {
  try {
    const root = fs.realpathSync(path.join(projectPath, 'src'));
    const real = fs.realpathSync(file);
    const relative = path.relative(root, real);
    return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : real;
  } catch {
    // A file that cannot be resolved is not one to edit.
    return undefined;
  }
}

// The Astro components whose Props is built from the type, read once each.
function sharedTypeUsers(projectPath: string, type: SharedType): Result<readonly SharedUser[]> {
  const files = projectSources(projectPath);
  if (!files.ok) {
    return files;
  }
  const users: SharedUser[] = [];
  let total = 0;
  for (const file of files.value) {
    if (!file.endsWith('.astro')) {
      continue;
    }
    const read = readBoundedSource(file);
    if (!read.ok) {
      return read;
    }
    total += read.value.length;
    if (total > PROPERTY_LIMITS.totalCharsMax) {
      return err({ code: 'limit', message: 'Project exceeds the shared property source limit.' });
    }
    if (!read.value.includes(type.typeName)) {
      continue;
    }
    const uses = sharedReferences(readPropertySyntax(read.value).syntax).some((reference) => {
      if (reference.imported !== type.typeName) {
        return false;
      }
      const resolved = resolveImportPath(projectPath, file, reference.specifier);
      const real = resolved === undefined ? undefined : projectSourceFile(projectPath, resolved);
      return real !== undefined && sameFilesystemPath(real, type.file);
    });
    if (uses) {
      users.push({ file: fs.realpathSync(file), source: read.value });
    }
  }
  assert(users.length <= PROPERTY_LIMITS.filesMax, 'Shared users are bounded');
  return ok(users);
}

function sharedShare(projectPath: string, type: SharedType, users: readonly SharedUser[]): Omit<PropertyShare, 'defaults'> {
  const instances = new Set<string>();
  for (const user of users) {
    // A consumer the rename planner refuses still shows; the rename says why when it is tried.
    const consumers = readPropertyConsumers({ projectPath, file: user.file });
    if (consumers.ok) {
      for (const consumer of consumers.value) {
        if (consumer.names.size > 0 && !sameFilesystemPath(consumer.file, user.file)) {
          instances.add(projectRelative(projectPath, consumer.file));
        }
      }
    }
  }
  return {
    typeName: type.typeName,
    path: projectRelative(projectPath, type.file),
    users: users.map((user) => projectRelative(projectPath, user.file)),
    instances: [...instances].sort(),
  };
}

function sharedDefaults(projectPath: string, users: readonly SharedUser[], name: string): readonly PropertyShareDefault[] {
  const defaults: PropertyShareDefault[] = [];
  for (const user of users) {
    const binding = propsBindings(readPropertySyntax(user.source).syntax).find((item) => propertyKey(item.propertyName ?? item.name) === name);
    if (binding?.initializer !== undefined) {
      defaults.push({ path: projectRelative(projectPath, user.file), expression: binding.initializer.getText() });
    }
  }
  return defaults;
}

function projectRelative(projectPath: string, file: string): string {
  let root = projectPath;
  try {
    root = fs.realpathSync(projectPath);
  } catch {
    // An unresolvable root leaves the path as given.
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  assert(!relative.startsWith('..'), 'A shared file is inside the project');
  return relative;
}

// The member as the component's prop: declared by the shared file, defaulted by this component.
function sharedProperty(type: SharedType, member: ts.PropertySignature, local: PropertySyntax, share: PropertyShare | undefined): ComponentProperty {
  const name = propertyKey(member.name);
  assert(name !== undefined, 'A shared member has a plain name');
  const binding = propsBindings(local.syntax).find((item) => propertyKey(item.propertyName ?? item.name) === name);
  const readType = createPropertyTypeReader(type.syntax);
  const property: ComponentProperty = {
    name,
    type: member.type === undefined ? 'unknown' : readType(member.type),
    required: member.questionToken === undefined,
    readonly: member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
    defaultValue: binding?.initializer?.getText() ?? '',
    description: memberComment(type.source, member)?.description ?? '',
    editing: { kind: 'editable' },
  };
  return share === undefined ? property : { ...property, shared: share };
}

function propsBindings(syntax: ts.SourceFile): readonly ts.BindingElement[] {
  return syntaxNodes(syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer))
    .map((node) => node.name)
    .filter(ts.isObjectBindingPattern)
    .flatMap((pattern) => pattern.elements)
    .filter((binding) => binding.dotDotDotToken === undefined);
}

function restLocals(syntax: ts.SourceFile): ReadonlySet<string> {
  const rests = syntaxNodes(syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer))
    .map((node) => node.name)
    .filter(ts.isObjectBindingPattern)
    .flatMap((pattern) => pattern.elements)
    .filter((binding) => binding.dotDotDotToken !== undefined && ts.isIdentifier(binding.name))
    .map((binding) => binding.name.getText());
  return new Set(rests);
}

// The names the component's own `Props` declares, outside any shared type.
function localMemberNames(syntax: ts.SourceFile): readonly string[] {
  const declaration = syntax.statements.find(
    (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === 'Props',
  );
  if (declaration === undefined) {
    return [];
  }
  const roots: ts.Node[] = ts.isTypeAliasDeclaration(declaration) ? [declaration.type] : [declaration];
  const names: string[] = [];
  for (let index = 0; index < roots.length && index < PROPERTY_LIMITS.nodesMax; index += 1) {
    const node = roots[index];
    assert(node !== undefined, 'A Props part exists');
    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
      roots.push(...node.types);
    } else if (ts.isParenthesizedTypeNode(node)) {
      roots.push(node.type);
    } else if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        const name = ts.isPropertySignature(member) ? propertyKey(member.name) : undefined;
        if (name !== undefined) {
          names.push(name);
        }
      }
    }
  }
  return names;
}
