import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import type { PropertyEditing } from '../../shared/properties/propertyEditing';
import { isAstroProps, propertyKey, syntaxNodes } from './propertySyntax';
import type { PropertySyntax } from './propertySyntax';

type Declaration = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
interface Usage {
  readonly member: ts.PropertySignature;
  readonly conditional: boolean;
}
interface Work {
  readonly node: ts.Node;
  readonly conditional: boolean;
  readonly path: readonly string[];
}
interface Branch {
  /** Which branch of the union: the discriminating field and its value (code), or its position when no field tells them apart. */
  readonly condition: { readonly kind: 'named'; readonly label: string } | { readonly kind: 'numbered'; readonly number: number };
  readonly fields: ReadonlyMap<string, ts.PropertySignature>;
}
interface Contract {
  readonly members: ReadonlyMap<string, readonly Usage[]>;
  readonly names: ReadonlySet<string>;
  readonly branches: readonly (readonly Branch[])[];
  readonly inheritedAttributes: boolean;
}
export interface PropertyContracts {
  readonly names: ReadonlySet<string>;
  /** The declaration that states a prop's tooltip and required mark: the public one outside any variant, else the first variant's that is not `never`. */
  readonly primary: ReadonlyMap<string, ts.PropertySignature>;
  /** Every declaration of a prop (public variants, separate intersected types, runtime assertions), the primary first: a save writes all of them. */
  readonly declared: ReadonlyMap<string, readonly ts.PropertySignature[]>;
  readonly editing: (name: string) => PropertyEditing;
  readonly conditions: (name: string) => readonly Described[];
}

// A common member is one declaration in the public contract. When the runtime
// assertion (`Astro.props as AllProps`) declares it again as its own member,
// that declaration is a mirror: an edit writes both, so the two types cannot
// drift apart. Editing it preserves every variant and runtime type.
export function readPropertyContracts(document: PropertySyntax): PropertyContracts {
  const declarations = new Map<string, Declaration>();
  for (const statement of document.syntax.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      // A repeated name is a source error the compiler reports; the first declaration speaks for it.
      if (!declarations.has(statement.name.text)) {
        declarations.set(statement.name.text, statement);
      }
    }
  }
  const assertions = syntaxNodes(document.syntax)
    .filter(ts.isAsExpression)
    .filter((node) => isAstroProps(node.expression));
  const attributes = htmlAttributeImports(document.syntax);
  const imports = importedTypeNames(document.syntax);
  const publicContract = readContract(declarations.get('Props'), declarations, attributes, imports);
  // Other types the props are checked against: a cast (`Astro.props as All`), an annotation
  // (`const { a }: Shape = Astro.props`), and a second declaration of `Props` that merges with the first.
  const annotations = syntaxNodes(document.syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer) && node.type !== undefined)
    .flatMap((node) => (node.type === undefined ? [] : [node.type]));
  const merged = document.syntax.statements.filter(
    (statement): statement is Declaration =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name.text === 'Props' &&
      statement !== declarations.get('Props'),
  );
  const runtimeContracts = [...assertions.map((node) => node.type), ...annotations, ...merged].map((root) =>
    readContract(root, declarations, attributes, imports),
  );
  const contracts = [publicContract, ...runtimeContracts];
  const primary = new Map<string, ts.PropertySignature>();
  const declared = new Map<string, readonly ts.PropertySignature[]>();
  for (const name of new Set([...publicContract.members.keys(), ...runtimeContracts.flatMap((contract) => [...contract.members.keys()])])) {
    const members = [...new Set(contracts.flatMap((contract) => (contract.members.get(name) ?? []).map((usage) => usage.member)))];
    const first = bestPrimary(publicContract.members.get(name) ?? []) ?? members[0];
    assert(first !== undefined, 'A declared prop has a declaration');
    primary.set(name, first);
    declared.set(name, [first, ...members.filter((member) => member !== first)]);
  }
  assert(primary.size <= PROPERTY_LIMITS.fieldsMax, 'Contract fields are bounded');
  return {
    names: new Set(contracts.flatMap((contract) => [...contract.names])),
    primary,
    declared,
    // Every prop is editable; one the file only inherits is declared locally on its first save.
    editing: (name) =>
      !declared.has(name) && inheritedAttributeCanOverride(name, contracts)
        ? withReason('override', described('props.contract.override'))
        : { kind: 'editable' },
    conditions: (name) => contractConditions(publicContract, name),
  };
}

// The declaration that speaks for a prop: outside any variant when there is one, else the first that is not `never`.
function bestPrimary(usages: readonly Usage[]): ts.PropertySignature | undefined {
  const common = usages.find((usage) => !usage.conditional && usage.member.type?.kind !== ts.SyntaxKind.NeverKeyword);
  const allowed = usages.find((usage) => usage.member.type?.kind !== ts.SyntaxKind.NeverKeyword);
  return (common ?? allowed ?? usages[0])?.member;
}

/** An override permission, its reason in English and as a reference the window translates. */
export function withReason(kind: 'override', reason: Described): PropertyEditing {
  return { kind, reason: reason.message, reasonRef: reason.messageRef };
}

function inheritedAttributeCanOverride(name: string, contracts: readonly Contract[]): boolean {
  const publicContract = contracts[0];
  if (!publicContract?.inheritedAttributes) {
    return false;
  }
  return contracts.every((contract) => contract.inheritedAttributes && !contract.members.has(name));
}

function readContract(
  root: ts.Node | undefined,
  declarations: ReadonlyMap<string, Declaration>,
  attributes: ReadonlySet<string>,
  imports: ReadonlySet<string>,
): Contract {
  const work: Work[] = root ? [{ node: root, conditional: false, path: [] }] : [];
  const members = new Map<string, readonly Usage[]>();
  const names = new Set<string>();
  const branches: (readonly Branch[])[] = [];
  let inheritedAttributes = false;
  for (let count = 0; count < PROPERTY_LIMITS.nodesMax && work.length > 0; count++) {
    const item = work.pop();
    assert(item !== undefined, 'Contract traversal has a work item');
    inheritedAttributes ||= isInheritedAstroAttributes(item.node, declarations, attributes);
    if (ts.isPropertySignature(item.node)) {
      const name = propertyKey(item.node.name);
      if (name) {
        const usages = members.get(name) ?? [];
        assert(usages.length < PROPERTY_LIMITS.fieldsMax, 'Contract field usages are bounded');
        members.set(name, [...usages, { member: item.node, conditional: item.conditional }]);
      }
    } else {
      if (ts.isTypeAliasDeclaration(item.node) || ts.isInterfaceDeclaration(item.node)) {
        names.add(item.node.name.text);
      }
      if (ts.isUnionTypeNode(item.node)) {
        branches.push(unionBranches(item.node));
      }
      const children = contractChildren(item, declarations, attributes, imports);
      // A computed or cyclic part adds no members this scan can see; the rest still counts.
      if (children !== undefined && children !== 'opaque') {
        work.push(...children);
      }
    }
    assert(work.length <= PROPERTY_LIMITS.nodesMax, 'Contract traversal queue is bounded');
  }
  assert(work.length === 0, 'Contract traversal completes within its budget');
  assert(members.size <= PROPERTY_LIMITS.fieldsMax, 'Contract field count is bounded');
  return { members, names, branches, inheritedAttributes };
}

function isInheritedAstroAttributes(node: ts.Node, declarations: ReadonlyMap<string, Declaration>, attributes: ReadonlySet<string>): boolean {
  if (!ts.isTypeReferenceNode(node) && !ts.isExpressionWithTypeArguments(node)) {
    return false;
  }
  const name = ts.isTypeReferenceNode(node) ? node.typeName.getText() : node.expression.getText();
  return attributes.has(name) && !declarations.has(name);
}

// What a contract node contributes: the nodes beneath it; 'opaque', a named
// type declared elsewhere (imported, global, generic, exported) whose fields
// this file cannot see; or undefined, a computed or cyclic type that makes the
// contract incomplete. An opaque part sits beside the local members in an
// intersection: it can add fields but never remove a sibling's, so the local
// members stay editable (`type Props = SeoProps & { theme?: … }`). A computed
// part (a mapped, conditional or indexed type) can produce any key, so it
// still makes every member read-only.
type ContractChildren = readonly Work[] | 'opaque' | undefined;

function contractChildren(
  item: Work,
  declarations: ReadonlyMap<string, Declaration>,
  attributes: ReadonlySet<string>,
  imports: ReadonlySet<string>,
): ContractChildren {
  const { node } = item;
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    if (item.path.includes(node.name.text) || item.path.length >= 64) {
      return undefined;
    }
    // Other files may import an exported declaration, so its members are not this file's to edit.
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      return 'opaque';
    }
    const next = { ...item, path: [...item.path, node.name.text] };
    if (ts.isTypeAliasDeclaration(node)) {
      return [{ ...next, node: node.type }];
    }
    return [
      ...node.members.map((member) => ({ ...next, node: member })),
      ...(node.heritageClauses ?? []).flatMap((clause) => clause.types).map((type) => ({ ...next, node: type })),
    ];
  }
  if (ts.isTypeLiteralNode(node)) {
    return node.members.map((member) => ({ ...item, node: member }));
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.map((type) => ({
      ...item,
      node: type,
      conditional: item.conditional || ts.isUnionTypeNode(node),
    }));
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return [{ ...item, node: node.type }];
  }
  if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
    const name = ts.isTypeReferenceNode(node) ? node.typeName.getText() : node.expression.getText();
    // DOM attributes are inherited, but locally authored members remain editable.
    if (attributes.has(name) && !declarations.has(name)) {
      return [];
    }
    // Omit only narrows known Astro attributes, so it cannot hide another local declaration.
    if (ts.isTypeReferenceNode(node) && isOmittedAstroAttributes(node, declarations, attributes, imports)) {
      return [];
    }
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      // Imported or global: its fields live in another file.
      return 'opaque';
    }
    if (node.typeArguments !== undefined) {
      // A local generic instantiated here: its fields depend on the arguments, and stay in source.
      return 'opaque';
    }
    return [{ ...item, node: declaration }];
  }
  return undefined;
}

function isOmittedAstroAttributes(
  node: ts.TypeReferenceNode,
  declarations: ReadonlyMap<string, Declaration>,
  attributes: ReadonlySet<string>,
  imports: ReadonlySet<string>,
): boolean {
  if (node.typeName.getText() !== 'Omit') {
    return false;
  }
  if (declarations.has('Omit')) {
    return false;
  }
  if (imports.has('Omit')) {
    return false;
  }
  const argumentsList = node.typeArguments;
  if (argumentsList?.length !== 2) {
    return false;
  }
  const inherited = argumentsList[0];
  if (!inherited || !ts.isTypeReferenceNode(inherited)) {
    return false;
  }
  const inheritedName = inherited.typeName.getText();
  if (!attributes.has(inheritedName)) {
    return false;
  }
  return !declarations.has(inheritedName);
}

function htmlAttributeImports(syntax: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of syntax.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (statement.moduleSpecifier.text === 'astro/types' && bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if ((specifier.propertyName ?? specifier.name).text === 'HTMLAttributes') {
            names.add(specifier.name.text);
          }
        }
      }
    }
  }
  return names;
}

function importedTypeNames(syntax: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of syntax.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) {
        names.add(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        names.add(bindings.name.text);
      } else if (bindings) {
        for (const specifier of bindings.elements) {
          names.add(specifier.name.text);
        }
      }
    }
  }
  return names;
}

function unionBranches(node: ts.UnionTypeNode): readonly Branch[] {
  const fields = node.types.map(branchFields);
  const discriminator = [...(fields[0]?.keys() ?? [])].find((name) => fields.every((branch) => literalBranchValue(branch.get(name)?.type) !== undefined));
  return fields.map((branch, index) => ({
    fields: branch,
    condition: discriminator
      ? { kind: 'named', label: `${discriminator} = ${literalBranchValue(branch.get(discriminator)?.type)}` }
      : { kind: 'numbered', number: index + 1 },
  }));
}

function branchFields(root: ts.TypeNode): ReadonlyMap<string, ts.PropertySignature> {
  const work = [root];
  const fields = new Map<string, ts.PropertySignature>();
  for (let count = 0; count < PROPERTY_LIMITS.nodesMax && work.length; count++) {
    const node = work.pop();
    assert(node !== undefined, 'Variant branch work item exists');
    if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          const name = propertyKey(member.name);
          if (name) {
            fields.set(name, member);
          }
        }
      }
    } else if (ts.isIntersectionTypeNode(node)) {
      work.push(...node.types);
    } else if (ts.isParenthesizedTypeNode(node)) {
      work.push(node.type);
    }
  }
  assert(work.length === 0, 'Variant branch traversal is bounded');
  return fields;
}

function literalBranchValue(type: ts.TypeNode | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const types = ts.isUnionTypeNode(type) ? type.types : [type];
  return types.every((value) => ts.isLiteralTypeNode(value)) ? type.getText() : undefined;
}

function contractConditions(contract: Contract, name: string): readonly Described[] {
  const common = contract.members.get(name)?.find((usage) => !usage.conditional)?.member;
  const conditions = contract.branches
    .filter((branches) => branches.some((branch) => branch.fields.has(name)))
    .flatMap((branches) =>
      branches.map((branch) => {
        const member = branch.fields.get(name) ?? common;
        const state = member ? (member.type?.kind === ts.SyntaxKind.NeverKeyword ? 'Never' : member.questionToken ? 'Optional' : 'Required') : 'Undeclared';
        return branch.condition.kind === 'named'
          ? described(`props.contract.condition.named${state}`, { branch: branch.condition.label })
          : described(`props.contract.condition.numbered${state}`, { number: branch.condition.number });
      }),
    );
  assert(conditions.length <= PROPERTY_LIMITS.fieldsMax, 'Property variant conditions are bounded');
  return conditions;
}
