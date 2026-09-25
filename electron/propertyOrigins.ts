import ts from 'typescript';
import { assert } from '../shared/assert';
import { PROPERTY_LIMITS } from '../shared/component-properties';
import type { PropertyOrigin, PropertySource } from '../shared/component-properties';
import { propertyKey, syntaxNodes } from './propertySyntax';
import type { PropertySyntax } from './propertySyntax';

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
interface Work {
  readonly node: ts.Node;
  readonly owner: string;
}
export interface PropertyOrigins {
  readonly members: ReadonlyMap<string, readonly ts.PropertySignature[]>;
  readonly origin: (name: string, binding: ts.BindingElement | undefined) => PropertyOrigin;
}

// Trace only the prop contract graph: similarly named fields in unrelated objects are not sources.
// Props is authoritative; a widened Astro.props assertion supplies missing fields only.
export function readPropertyOrigins(document: PropertySyntax): PropertyOrigins {
  const declarations = new Map<string, Declaration>();
  for (const statement of document.syntax.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement);
    }
  }
  const roots = [
    'Props',
    ...syntaxNodes(document.syntax)
      .filter(ts.isAsExpression)
      .filter((node) => node.expression.getText() === 'Astro.props')
      .map((node) => node.type.getText()),
  ];
  const members = new Map<string, readonly ts.PropertySignature[]>();
  const sources = new Map<string, readonly PropertySource[]>();
  assert(roots.length <= PROPERTY_LIMITS.nodesMax, 'Property origin roots are bounded');
  for (const root of new Set(roots)) {
    const found = readOriginMembers(declarations.get(root), declarations);
    for (const [name, entries] of found) {
      if (!members.has(name)) {
        members.set(
          name,
          entries.map((entry) => entry.member)
        );
        sources.set(
          name,
          entries.map((entry) =>
            originSource(
              document,
              entry.member,
              `${entry.owner}.${name}`,
              entry.member.type?.getText() ?? 'unknown'
            )
          )
        );
      }
    }
  }
  assert(members.size <= PROPERTY_LIMITS.fieldsMax, 'Property origin fields are bounded');
  return {
    members,
    origin: (name, binding) => ({
      declarations: sources.get(name) ?? [],
      ...(binding?.initializer
        ? {
            defaultValue: originSource(
              document,
              binding,
              `Astro.props.${name}`,
              binding.initializer.getText()
            ),
          }
        : {}),
    }),
  };
}

interface OriginMember {
  readonly member: ts.PropertySignature;
  readonly owner: string;
}
function readOriginMembers(
  root: Declaration | undefined,
  declarations: ReadonlyMap<string, Declaration>
): ReadonlyMap<string, readonly OriginMember[]> {
  const work: Work[] = root ? [{ node: root, owner: root.name.text }] : [];
  const seen = new Set<ts.Node>();
  const members = new Map<string, readonly OriginMember[]>();
  for (let count = 0; count < PROPERTY_LIMITS.nodesMax && work.length > 0; count++) {
    const item = work.pop();
    assert(item !== undefined, 'A property origin work item exists');
    if (seen.has(item.node)) {
      continue;
    }
    seen.add(item.node);
    if (ts.isPropertySignature(item.node)) {
      const name = propertyKey(item.node.name);
      if (name) {
        const previous = members.get(name) ?? [];
        assert(previous.length < PROPERTY_LIMITS.fieldsMax, 'Property source count is bounded');
        members.set(name, [...previous, { member: item.node, owner: item.owner }]);
      }
    } else {
      work.push(...originChildren(item, declarations).reverse());
      assert(work.length <= PROPERTY_LIMITS.nodesMax, 'Property origin queue is bounded');
    }
  }
  assert(work.length === 0, 'Property origin traversal completes within bounds');
  return members;
}

function originChildren(item: Work, declarations: ReadonlyMap<string, Declaration>): Work[] {
  const { node, owner } = item;
  if (ts.isTypeAliasDeclaration(node)) {
    return [{ node: node.type, owner: node.name.text }];
  }
  if (ts.isInterfaceDeclaration(node)) {
    return [
      ...node.members.map((member) => ({ node: member, owner: node.name.text })),
      ...(node.heritageClauses ?? [])
        .flatMap((clause) => clause.types)
        .flatMap((type) => originReference(type.expression.getText(), declarations)),
    ];
  }
  if (ts.isTypeLiteralNode(node)) {
    return node.members.map((member) => ({ node: member, owner }));
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.map((type) => ({ node: type, owner }));
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return [{ node: node.type, owner }];
  }
  if (ts.isTypeReferenceNode(node)) {
    // Generic transformations can rename or omit fields; do not invent per-field provenance.
    return node.typeArguments ? [] : originReference(node.typeName.getText(), declarations);
  }
  return [];
}

function originReference(name: string, declarations: ReadonlyMap<string, Declaration>): Work[] {
  const declaration = declarations.get(name);
  return declaration ? [{ node: declaration, owner: name }] : [];
}

function originSource(
  document: PropertySyntax,
  node: ts.Node,
  label: string,
  expression: string
): PropertySource {
  const offset = node.getStart(document.syntax);
  assert(offset >= 0, 'Property source offset is nonnegative');
  assert(offset <= document.frontmatter.length, 'Property source offset is inside frontmatter');
  return {
    label,
    expression,
    line:
      document.syntax.getLineAndCharacterOfPosition(offset).line +
      document.source.slice(0, document.start).split('\n').length,
  };
}
