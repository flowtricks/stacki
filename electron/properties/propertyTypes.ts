import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';

interface TypeWork {
  readonly node: ts.TypeNode;
  readonly aliases: readonly string[];
}
const ALIAS_DEPTH_MAX = 64;

// Resolve local option aliases for visual controls without rewriting their declarations.
// Imported, generic, and recursive types retain their authored expression.
export function createPropertyTypeReader(document: ts.SourceFile): (type: ts.TypeNode) => string {
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  const duplicates = new Set<string>();
  assert(document.statements.length <= PROPERTY_LIMITS.nodesMax, 'Type declarations are bounded');
  for (const statement of document.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      if (aliases.has(statement.name.text)) {
        duplicates.add(statement.name.text);
      }
      aliases.set(statement.name.text, statement);
    }
  }
  return (type) => readPropertyType(type, aliases, duplicates);
}

function readPropertyType(type: ts.TypeNode, aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>, duplicates: ReadonlySet<string>): string {
  const work: TypeWork[] = [{ node: type, aliases: [] }];
  const values: string[] = [];
  for (let count = 0; count < PROPERTY_LIMITS.nodesMax && work.length > 0; count++) {
    const item = work.pop();
    assert(item !== undefined, 'A pending type node exists');
    const children = expandPropertyType(item, aliases, duplicates);
    if (children === undefined) {
      return type.getText();
    }
    if (children.length === 0) {
      values.push(item.node.getText());
    } else {
      work.push(...[...children].reverse());
    }
    if (work.length + values.length > PROPERTY_LIMITS.fieldsMax) {
      return type.getText();
    }
  }
  if (work.length > 0) {
    return type.getText();
  }
  const resolved = values.join(' | ');
  return resolved.length <= PROPERTY_LIMITS.textCharsMax ? resolved : type.getText();
}

function expandPropertyType(
  item: TypeWork,
  aliases: ReadonlyMap<string, ts.TypeAliasDeclaration>,
  duplicates: ReadonlySet<string>,
): readonly TypeWork[] | undefined {
  const node = item.node;
  if (ts.isParenthesizedTypeNode(node)) {
    return [{ ...item, node: node.type }];
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.map((child) => ({ ...item, node: child }));
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    const alias = aliases.get(name);
    if (!alias || alias.typeParameters || node.typeArguments || duplicates.has(name)) {
      return undefined;
    }
    if (item.aliases.includes(name) || item.aliases.length >= ALIAS_DEPTH_MAX) {
      return undefined;
    }
    return [{ node: alias.type, aliases: [...item.aliases, name] }];
  }
  if (ts.isLiteralTypeNode(node)) {
    return [];
  }
  const primitives = [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword];
  return primitives.includes(node.kind) ? [] : undefined;
}
