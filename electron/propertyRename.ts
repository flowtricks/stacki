// Rename only parsed component attributes and Astro.props accesses. Text, CSS,
// unrelated components, and lexical aliases retain their original spelling.
import { parse } from '@astrojs/compiler/sync';
import type { Node, AttributeNode } from '@astrojs/compiler/types';
import ts from 'typescript';
import { readPropertyContracts } from './propertyContracts';
import { assert } from '../shared/assert';
import { PROPERTY_LIMITS } from '../shared/component-properties';
import type { PropertyOptionRename } from '../shared/component-properties';
import { err, ok, type Result } from '../shared/result';
import {
  applySourceEdits,
  isAstroProps,
  propertyKey,
  readPropertySyntax,
  syntaxNodes,
} from './propertySyntax';
import type { SourceEdit } from './propertySyntax';

export interface PropertyRename {
  readonly from: string;
  readonly to: string;
}

type OptionScalar =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean };
interface ParsedOptionRename {
  readonly from: OptionScalar;
  readonly to: OptionScalar;
  readonly replacement: string;
}

type PropertyReferenceEdit =
  | {
      readonly kind: 'rename';
      readonly from: string;
      readonly to: string;
      readonly typeNames: ReadonlySet<string>;
    }
  | {
      readonly kind: 'default';
      readonly from: string;
      readonly binding: string;
      readonly declarationEnd: number;
      readonly local: string;
    };

export function renameComponentReferences(
  source: string,
  names: ReadonlySet<string>,
  rename: PropertyRename,
  owner: 'definition' | 'consumer'
): Result<string> {
  const typeNames =
    owner === 'definition'
      ? readPropertyContracts(readPropertySyntax(source)).names
      : new Set<string>();
  return editComponentReferences(
    source,
    names,
    { kind: 'rename', ...rename, typeNames: new Set(['Props', ...typeNames]) },
    owner
  );
}

export function renameComponentOptionValues(
  source: string,
  names: ReadonlySet<string>,
  propertyName: string,
  renames: readonly PropertyOptionRename[]
): Result<string> {
  const parsed = parseOptionRenames(renames);
  if (!parsed.ok) {
    return parsed;
  }
  const root = parseAstroRenameSource(source);
  if (!root.ok) {
    return root;
  }
  const edits: SourceEdit[] = [];
  const pending: Node[] = [root.value];
  for (let index = 0; index < pending.length; index += 1) {
    assert(pending.length <= PROPERTY_LIMITS.nodesMax, 'Astro option rename node budget');
    const node = pending[index];
    assert(node !== undefined, 'Queued Astro option node exists');
    const result = renameNodeOptions(source, node, names, propertyName, parsed.value);
    if (!result.ok) {
      return result;
    }
    edits.push(...result.value);
    if ('children' in node) {
      if (node.type === 'element' && ['script', 'style'].includes(node.name)) {
        continue;
      }
      pending.push(...node.children);
    }
  }
  return ok(applySourceEdits(source, edits));
}

function parseAstroRenameSource(source: string): Result<Node> {
  try {
    const result = parse(source, { position: true });
    const diagnostic = result.diagnostics.find((entry) => entry.severity === 1);
    return diagnostic ? err({ code: 'syntax', message: diagnostic.text }) : ok(result.ast);
  } catch (error: unknown) {
    return err({ code: 'syntax', message: String(error) });
  }
}

function parseOptionRenames(
  renames: readonly PropertyOptionRename[]
): Result<readonly ParsedOptionRename[]> {
  assert(renames.length <= PROPERTY_LIMITS.fieldsMax, 'Option rename count is bounded');
  const parsed: ParsedOptionRename[] = [];
  const sources = new Set<string>();
  for (const rename of renames) {
    const from = optionScalar(rename.from);
    const to = optionScalar(rename.to);
    if (!from || !to) {
      return err({
        code: 'option',
        message: 'Option renames require literal values.',
      });
    }
    const key = optionScalarKey(from);
    if (sources.has(key)) {
      return err({
        code: 'option',
        message: 'An option value is renamed more than once.',
      });
    }
    sources.add(key);
    parsed.push({ from, to, replacement: rename.to });
  }
  return ok(parsed);
}

function renameNodeOptions(
  source: string,
  node: Node,
  names: ReadonlySet<string>,
  propertyName: string,
  renames: readonly ParsedOptionRename[]
): Result<readonly SourceEdit[]> {
  if (!('attributes' in node) || node.type !== 'component' || !names.has(node.name)) {
    return ok([]);
  }
  const edits: SourceEdit[] = [];
  for (const attribute of node.attributes) {
    const result = renameOptionAttribute(source, attribute, propertyName, renames);
    if (!result.ok) {
      return result;
    }
    edits.push(...result.value);
  }
  return ok(edits);
}

function renameOptionAttribute(
  source: string,
  attribute: AttributeNode,
  propertyName: string,
  renames: readonly ParsedOptionRename[]
): Result<readonly SourceEdit[]> {
  const start = offset(source, attribute);
  if (attribute.kind === 'spread') {
    return renameOptionSpread(source, attribute, propertyName, renames, start);
  }
  if (attribute.name !== propertyName) {
    return ok([]);
  }
  if (attribute.kind === 'quoted') {
    return renameQuotedOption(source, attribute, renames, start);
  }
  if (attribute.kind !== 'expression' && attribute.kind !== 'template-literal') {
    return ok([]);
  }
  const position = source.indexOf(attribute.value, start + attribute.name.length);
  if (position < 0) {
    return positionError();
  }
  return ok(renameOptionExpression(attribute.value, position, renames));
}

function renameQuotedOption(
  source: string,
  attribute: AttributeNode,
  renames: readonly ParsedOptionRename[],
  start: number
): Result<readonly SourceEdit[]> {
  const rename = renames.find(
    (entry) => entry.from.kind === 'string' && entry.from.value === attribute.value
  );
  if (!rename) {
    return ok([]);
  }
  const raw = attribute.raw;
  if (raw === undefined) {
    return positionError();
  }
  const position = source.indexOf(raw, start + attribute.name.length);
  if (position < 0) {
    return positionError();
  }
  const text =
    rename.to.kind === 'string' ? JSON.stringify(rename.to.value) : `{${rename.replacement}}`;
  return ok([{ start: position, end: position + raw.length, text }]);
}

function renameOptionSpread(
  source: string,
  attribute: AttributeNode,
  propertyName: string,
  renames: readonly ParsedOptionRename[],
  position: number
): Result<readonly SourceEdit[]> {
  const prefix = 'const spread = (';
  const syntax = ts.createSourceFile(
    'spread.ts',
    prefix + attribute.name + ');',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const object = syntaxNodes(syntax).find(ts.isObjectLiteralExpression);
  if (!object || optionSpreadIsDynamic(object)) {
    return err({
      code: 'spread',
      message:
        'An instance uses a dynamic prop spread. ' +
        'Make its props explicit before renaming this option.',
    });
  }
  const start = source.indexOf(attribute.name, Math.max(0, position - attribute.name.length - 4));
  if (start < 0 || start > position + attribute.name.length + 4) {
    return positionError();
  }
  const edits: SourceEdit[] = [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyKey(property.name) !== propertyName) {
      continue;
    }
    edits.push(...renameOptionExpressionNode(property.initializer, start - prefix.length, renames));
  }
  return ok(edits);
}

function optionSpreadIsDynamic(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && ts.isComputedPropertyName(property.name))
  );
}

function renameOptionExpression(
  expression: string,
  start: number,
  renames: readonly ParsedOptionRename[]
): readonly SourceEdit[] {
  const prefix = 'const value = (';
  const syntax = ts.createSourceFile(
    'option.ts',
    prefix + expression + ');',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const declaration = syntaxNodes(syntax).find(ts.isVariableDeclaration);
  const initializer = declaration?.initializer;
  assert(initializer !== undefined, 'Option expression has an initializer');
  const value = ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer;
  return renameOptionExpressionNode(value, start - prefix.length, renames);
}

function renameOptionExpressionNode(
  expression: ts.Expression,
  start: number,
  renames: readonly ParsedOptionRename[]
): readonly SourceEdit[] {
  const edits: SourceEdit[] = [];
  for (const node of syntaxNodes(expression)) {
    if (ts.isNumericLiteral(node) && ts.isPrefixUnaryExpression(node.parent)) {
      continue;
    }
    const scalar = optionScalarNode(node);
    const rename = scalar
      ? renames.find((entry) => optionScalarKey(entry.from) === optionScalarKey(scalar))
      : undefined;
    if (rename) {
      edits.push({
        start: start + node.getStart(),
        end: start + node.end,
        text: rename.replacement,
      });
    }
  }
  return edits;
}

function optionScalar(expression: string): OptionScalar | undefined {
  const prefix = 'const value = (';
  const syntax = ts.createSourceFile(
    'literal.ts',
    prefix + expression + ');',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = syntaxNodes(syntax).find(ts.isVariableDeclaration);
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isParenthesizedExpression(initializer)) {
    return undefined;
  }
  return optionScalarNode(initializer.expression);
}

function optionScalarNode(node: ts.Node): OptionScalar | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', value: node.text };
  }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isFinite(value) ? { kind: 'number', value } : undefined;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = ts.isNumericLiteral(node.operand) ? -Number(node.operand.text) : Number.NaN;
    return Number.isFinite(value) ? { kind: 'number', value } : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'boolean', value: node.kind === ts.SyntaxKind.TrueKeyword };
  }
  return undefined;
}

function optionScalarKey(value: OptionScalar): string {
  return `${value.kind}:${String(value.value)}`;
}

export function bindComponentDefault(
  source: string,
  name: string,
  binding: string
): Result<string> {
  const document = readPropertySyntax(source);
  const declaration = syntaxNodes(document.syntax).find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) =>
          ts.isObjectBindingPattern(item.name) &&
          item.name.elements.some(
            (element) => ts.isIdentifier(element.name) && element.name.text === binding
          )
      )
  );
  assert(declaration !== undefined, 'A default has an Astro.props binding');
  const alias = defaultBindingName(source);
  return editComponentReferences(
    source,
    new Set(),
    {
      kind: 'default',
      from: name,
      binding: alias,
      local: binding,
      declarationEnd: document.start + declaration.end,
    },
    'definition'
  );
}

function editComponentReferences(
  source: string,
  names: ReadonlySet<string>,
  rename: PropertyReferenceEdit,
  owner: 'definition' | 'consumer'
): Result<string> {
  let root: Node;
  try {
    const result = parse(source, { position: true });
    const diagnostic = result.diagnostics.find((entry) => entry.severity === 1);
    if (diagnostic) {
      return err({ code: 'syntax', message: diagnostic.text });
    }
    root = result.ast;
  } catch (error: unknown) {
    return err({ code: 'syntax', message: String(error) });
  }
  const edits: SourceEdit[] = [];
  if (owner === 'definition') {
    const document = readPropertySyntax(source);
    const result = renameAstroAccess(document.frontmatter, document.start, rename);
    if (!result.ok) {
      return result;
    }
    edits.push(...result.value);
  }
  const nodes = editAstroNodes(source, root, names, rename, owner);
  if (!nodes.ok) {
    return nodes;
  }
  edits.push(...nodes.value);
  if (rename.kind === 'default' && edits.length > 0) {
    if (edits.some((edit) => edit.start < rename.declarationEnd)) {
      return err({
        code: 'default-order',
        message:
          'A prop read precedes its default. ' +
          'Move the Astro.props binding before that read in source.',
      });
    }
    // A unique alias prevents a template loop variable from shadowing the defaulted prop.
    edits.push({
      start: rename.declarationEnd,
      end: rename.declarationEnd,
      text: `\nconst ${rename.binding} = ${rename.local};`,
    });
  }
  return ok(applySourceEdits(source, edits));
}

function editAstroNodes(
  source: string,
  root: Node,
  names: ReadonlySet<string>,
  rename: PropertyReferenceEdit,
  owner: 'definition' | 'consumer'
): Result<readonly SourceEdit[]> {
  const edits: SourceEdit[] = [];
  const pending: { readonly node: Node; readonly expression: boolean }[] = [
    { node: root, expression: false },
  ];
  for (let index = 0; index < pending.length; index += 1) {
    assert(pending.length <= PROPERTY_LIMITS.nodesMax, 'Astro rename node budget');
    const entry = pending[index];
    assert(entry !== undefined, 'Queued Astro node exists');
    const result = renameNode(source, entry.node, names, rename, owner, entry.expression);
    if (!result.ok) {
      return result;
    }
    edits.push(...result.value);
    if ('children' in entry.node) {
      if (entry.node.type === 'element' && ['script', 'style'].includes(entry.node.name)) {
        continue;
      }
      for (const child of entry.node.children) {
        pending.push({
          node: child,
          expression: entry.node.type === 'expression',
        });
      }
    }
  }
  return ok(edits);
}

function renameNode(
  source: string,
  node: Node,
  names: ReadonlySet<string>,
  rename: PropertyReferenceEdit,
  owner: 'definition' | 'consumer',
  expression: boolean
): Result<readonly SourceEdit[]> {
  const edits: SourceEdit[] = [];
  if ('attributes' in node) {
    const target = rename.kind === 'rename' && node.type === 'component' && names.has(node.name);
    if (
      target &&
      rename.kind === 'rename' &&
      node.attributes.some((attribute) => attribute.name === rename.to)
    ) {
      return err({
        code: 'collision',
        message: `An instance already passes ${rename.to}.`,
      });
    }
    for (const attribute of node.attributes) {
      if (target && rename.kind === 'rename') {
        const result = renameAttribute(source, attribute, rename);
        if (!result.ok) {
          return result;
        }
        edits.push(...result.value);
      }
      if (owner === 'definition') {
        if (attribute.kind === 'expression' || attribute.kind === 'template-literal') {
          const position = source.indexOf(attribute.value, offset(source, attribute));
          if (position < 0) {
            return positionError();
          }
          const result = renameAstroAccess(attribute.value, position, rename);
          if (!result.ok) {
            return result;
          }
          edits.push(...result.value);
        }
      }
    }
  }
  if (owner === 'definition' && expression && node.type === 'text') {
    const position = offset(source, node);
    if (source.slice(position, position + node.value.length) !== node.value) {
      return positionError();
    }
    return renameAstroAccess(node.value, position, rename);
  }
  return ok(edits);
}

function offset(source: string, node: { readonly position?: Node['position'] }): number {
  const position = node.position?.start.offset;
  assert(position !== undefined, 'Astro parser supplies requested source positions');
  // Astro uses UTF-8 byte offsets; TypeScript and String.slice use UTF-16 offsets.
  assert(position <= Buffer.byteLength(source), 'Astro source position is in bounds');
  return Buffer.from(source).subarray(0, position).toString('utf8').length;
}
function positionError(): Result<never> {
  return err({
    code: 'position',
    message: 'Could not locate a source range safely; no files changed.',
  });
}

function renameAttribute(
  source: string,
  attribute: AttributeNode,
  rename: PropertyRename
): Result<readonly SourceEdit[]> {
  const start = offset(source, attribute);
  if (attribute.kind === 'spread') {
    return renameSpread(source, attribute, rename, start);
  }
  if (attribute.name !== rename.from) {
    return ok([]);
  }
  if (source.slice(start, start + attribute.name.length) !== attribute.name) {
    return positionError();
  }
  if (attribute.kind === 'shorthand') {
    if (source[start - 1] !== '{' || source[start + attribute.name.length] !== '}') {
      return positionError();
    }
    return ok([
      {
        start: start - 1,
        end: start + attribute.name.length + 1,
        text: `${rename.to}={${rename.from}}`,
      },
    ]);
  }
  return ok([{ start, end: start + attribute.name.length, text: rename.to }]);
}

function renameSpread(
  source: string,
  attribute: AttributeNode,
  rename: PropertyRename,
  position: number
): Result<readonly SourceEdit[]> {
  const prefix = 'const spread = (';
  const object = literalSpreadObject(attribute.name, prefix);
  if (!object) {
    return err({
      code: 'spread',
      message:
        'An instance uses a dynamic prop spread. ' +
        'Make its props explicit before editing this property.',
    });
  }
  const start = source.indexOf(attribute.name, Math.max(0, position - attribute.name.length - 4));
  if (start < 0 || start > position + attribute.name.length + 4) {
    return positionError();
  }
  if (object.properties.some((property) => propertyKey(property.name) === rename.to)) {
    return err({
      code: 'collision',
      message: `A spread already contains ${rename.to}.`,
    });
  }
  const edits: SourceEdit[] = [];
  for (const property of object.properties) {
    if (propertyKey(property.name) !== rename.from || !property.name) {
      continue;
    }
    const text = ts.isShorthandPropertyAssignment(property)
      ? `${rename.to}: ${rename.from}`
      : ts.isStringLiteral(property.name)
      ? JSON.stringify(rename.to)
      : rename.to;
    edits.push({
      start: start + property.name.getStart() - prefix.length,
      end: start + property.name.end - prefix.length,
      text,
    });
  }
  return ok(edits);
}

function literalSpreadObject(
  expression: string,
  prefix: string
): ts.ObjectLiteralExpression | undefined {
  const syntax = ts.createSourceFile(
    'spread.ts',
    prefix + expression + ');',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const nodes = syntaxNodes(syntax);
  const object = nodes.find(ts.isObjectLiteralExpression);
  const initializer = nodes.find(ts.isVariableDeclaration)?.initializer;
  if (!object || !initializer || !ts.isParenthesizedExpression(initializer)) {
    return undefined;
  }
  if (initializer.expression !== object || optionSpreadIsDynamic(object)) {
    return undefined;
  }
  return object;
}

function renameAstroAccess(
  source: string,
  start: number,
  rename: PropertyReferenceEdit
): Result<readonly SourceEdit[]> {
  const syntax = ts.createSourceFile(
    'expression.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const edits: SourceEdit[] = [];
  for (const node of syntaxNodes(syntax)) {
    if (rename.kind === 'rename') {
      const typeEdit = renameIndexedPropType(node, start, rename, rename.typeNames);
      if (typeEdit) {
        edits.push(typeEdit);
      }
    }
    if (!isAstroProps(node)) {
      continue;
    }
    // Wrappers are visited separately; only the outermost expression owns its consumer.
    if (ts.isAsExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) {
      continue;
    }
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent)) {
      if (parent.name.text === rename.from) {
        edits.push(astroReferenceEdit(parent, parent.name, start, rename));
      }
    } else if (ts.isElementAccessExpression(parent)) {
      if (!ts.isStringLiteral(parent.argumentExpression)) {
        return err({
          code: 'computed',
          message:
            'Astro.props has a computed key. ' +
            'Make that access explicit before editing this property.',
        });
      }
      if (parent.argumentExpression.text === rename.from) {
        edits.push(astroReferenceEdit(parent, parent.argumentExpression, start, rename));
      }
    } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
      // The declaration editor already renamed keys and retained local aliases.
      continue;
    } else {
      return err({
        code: 'alias',
        message:
          'Astro.props is forwarded or aliased. ' +
          'Update that code explicitly before editing this property.',
      });
    }
  }
  return ok(edits);
}

function astroReferenceEdit(
  access: ts.Node,
  key: ts.Node,
  start: number,
  change: PropertyReferenceEdit
): SourceEdit {
  if (change.kind === 'default') {
    return {
      start: start + access.getStart(),
      end: start + access.end,
      text: change.binding,
    };
  }
  return {
    start: start + key.getStart(),
    end: start + key.end,
    text: ts.isStringLiteral(key) ? JSON.stringify(change.to) : change.to,
  };
}

function defaultBindingName(source: string): string {
  for (let index = 0; index <= PROPERTY_LIMITS.fieldsMax; index += 1) {
    const name = `_stackiDefault${index}`;
    if (!source.includes(name)) {
      return name;
    }
  }
  assert(false, 'Default alias generation is bounded');
}

function renameIndexedPropType(
  node: ts.Node,
  start: number,
  rename: PropertyRename,
  typeNames: ReadonlySet<string>
): SourceEdit | undefined {
  if (
    !ts.isLiteralTypeNode(node) ||
    !ts.isStringLiteral(node.literal) ||
    node.literal.text !== rename.from
  ) {
    return undefined;
  }
  let parent = node.parent;
  if (ts.isUnionTypeNode(parent)) {
    parent = parent.parent;
  }
  const indexed =
    ts.isIndexedAccessTypeNode(parent) &&
    ts.isTypeReferenceNode(parent.objectType) &&
    typeNames.has(parent.objectType.typeName.getText());
  const picked =
    ts.isTypeReferenceNode(parent) &&
    ['Pick', 'Omit'].includes(parent.typeName.getText()) &&
    typeNames.has(parent.typeArguments?.[0]?.getText() ?? '');
  if (!indexed && !picked) {
    return undefined;
  }
  return {
    start: start + node.literal.getStart(),
    end: start + node.literal.end,
    text: JSON.stringify(rename.to),
  };
}
