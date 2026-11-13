// The syntax under a content config's collection edits (astroSchemaEdit.ts):
// finding a collection in `export const collections = { … }`, the
// defineCollection call it names and its schema's z.object, reading keys, and
// writing span edits back in the layout the file already has. Nothing here
// runs the config: it is parsed as TypeScript text.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import { indentUnitOf } from '../../shared/core/indent';
import { err, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';

export interface SpanEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface Located {
  readonly file: ts.SourceFile;
  /** The collection's entry in `collections`: its key node, and how it is written. */
  readonly entry: ts.ObjectLiteralElementLike;
  readonly call: ts.CallExpression | undefined;
  readonly object: ts.ObjectLiteralExpression | undefined;
}

export const CONFIG_CHARS_MAX = 2_000_000;

export const CHAIN_STEPS_MAX = 32;

// The object's properties written as `texts`, in the layout it already has: one
// per line when it spans lines, side by side when it is written on one.
export function propertyList(object: ts.ObjectLiteralExpression, file: ts.SourceFile, texts: readonly string[]): SpanEdit {
  const open = object.getStart(file);
  const close = object.getEnd();
  const inner = file.text.slice(open + 1, close - 1);
  if (texts.length === 0) {
    return { start: open, end: close, text: '{}' };
  }
  if (!inner.includes('\n')) {
    return { start: open, end: close, text: `{ ${texts.join(', ')} }` };
  }
  const first = object.properties[0];
  const closing = lineIndent(file.text, close - 1);
  const indent = first === undefined ? closing + indentUnitOf(file.text) : lineIndent(file.text, first.getStart(file));
  const trailing = object.properties.hasTrailingComma || object.properties.length === 0 ? ',' : '';
  const body = texts.map((part) => `${indent}${part}`).join(',\n');
  return { start: open, end: close, text: `{\n${body}${trailing}\n${closing}}` };
}

/** The collection a field's reference (or list of them) points at. */
export function referenceTarget(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  const pending: ts.Node[] = [property.initializer];
  for (let visited = 0; pending.length > 0 && visited < CHAIN_STEPS_MAX * 4; visited += 1) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'reference') {
      const first = node.arguments[0];
      return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
    }
    pending.push(...node.getChildren());
  }
  return undefined;
}

// Finding the collection: the `collections` export, its key, and the schema's z.object.
export function locate(source: string, collection: string): Result<Located, Described> {
  if (source.length > CONFIG_CHARS_MAX) {
    return err(described('cmsBackend.config.tooLarge'));
  }
  const file = ts.createSourceFile('content.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const collections = collectionsObject(file);
  if (collections === undefined) {
    return err(described('cmsBackend.config.noCollections'));
  }
  const entry = collections.properties.find((property) => propertyName(property) === collection);
  if (entry === undefined) {
    return err(described('cmsBackend.config.notListed', { collection }));
  }
  const call = defineCall(entry, file);
  return { ok: true, value: { file, entry, call, object: schemaObject(call) } };
}

export function collectionsObject(file: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'collections') {
        const value = unwrap(declaration.initializer);
        return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
      }
    }
  }
  return undefined;
}

// The defineCollection call a collection's entry names: inline, or by a const.
export function defineCall(entry: ts.ObjectLiteralElementLike, file: ts.SourceFile): ts.CallExpression | undefined {
  const value = ts.isPropertyAssignment(entry) ? unwrap(entry.initializer) : ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
  if (value !== undefined && ts.isCallExpression(value)) {
    return value;
  }
  if (value === undefined || !ts.isIdentifier(value)) {
    return undefined;
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initial = unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && declaration.name.text === value.text && initial !== undefined && ts.isCallExpression(initial)) {
          return initial;
        }
      }
    }
  }
  return undefined;
}

export function schemaProperty(call: ts.CallExpression | undefined): ts.PropertyAssignment | undefined {
  const options = call?.arguments[0];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }
  const schema = options.properties.find((property) => propertyName(property) === 'schema');
  return schema !== undefined && ts.isPropertyAssignment(schema) ? schema : undefined;
}

export function schemaObject(call: ts.CallExpression | undefined): ts.ObjectLiteralExpression | undefined {
  const schema = schemaProperty(call);
  if (schema === undefined) {
    return undefined;
  }
  let node: ts.Node | undefined = unwrap(schema.initializer);
  if (node !== undefined && ts.isArrowFunction(node)) {
    node = ts.isBlock(node.body) ? returned(node.body) : unwrap(node.body);
  }
  // Down the chain (`z.object({…}).passthrough()`) to the z.object call itself.
  for (let step = 0; step < CHAIN_STEPS_MAX && node !== undefined && ts.isCallExpression(node); step += 1) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'object' && callee.expression.getText() === 'z') {
      const shape = node.arguments[0];
      return shape !== undefined && ts.isObjectLiteralExpression(shape) ? shape : undefined;
    }
    node = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : undefined;
  }
  return undefined;
}

export function returned(block: ts.Block): ts.Expression | undefined {
  const statement = block.statements.find(ts.isReturnStatement);
  return unwrap(statement?.expression);
}

export function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

// A key as the config writes it: bare when it can be, quoted when it must be or was.
export function keyText(name: string, style: { readonly quoted: boolean }): string {
  return !style.quoted && /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

export function quoteOf(literal: ts.StringLiteralLike, file: ts.SourceFile): string {
  return file.text.charAt(literal.getStart(file)) === "'" ? "'" : '"';
}

export function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  for (let depth = 0; depth < CHAIN_STEPS_MAX && current !== undefined; depth += 1) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
  return current;
}

export function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

/** Applies span edits, the last first, so earlier offsets hold. */
export function applyEdits(source: string, edits: readonly SpanEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let text = source;
  for (const edit of ordered) {
    assert(edit.start <= edit.end, 'An edit spans forward');
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}
