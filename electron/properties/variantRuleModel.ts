// Reads a component's variant rules from its frontmatter: the discriminated
// unions its `Props` combines, each keyed by one controller prop whose string
// literal picks the option (shared/properties/variantRules.ts, docs/props-variant-rules.md).
//
//   type Props = { render?: boolean } & Tag & Kind;
//   type Kind = { variant?: "main"; label?: never } | { variant: "play"; label?: string };
//
// The reader keeps the syntax nodes the writer edits (variantRuleEdits.ts):
// each option's own object type, its controller literal, and each prop's
// declaration in it. What it cannot model faithfully is still read, for the
// panel to draw, but marked read-only with a one-word reason, so the writer
// never rewrites text it does not understand. Unions with no string-literal
// controller are not groups at all; the panel keeps their old read-only
// conditions (propertyContracts.ts).
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { VARIANT_LIMITS } from '../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantOption, VariantRule } from '../../shared/properties/variantRules';
import { isAstroProps, propertyKey, readPropertySyntax, syntaxNodes } from './propertySyntax';
import type { PropertySyntax } from './propertySyntax';

/** One option: a member of the union. */
export interface VariantMemberSyntax {
  /** The member as written in the union, parentheses included. */
  readonly node: ts.TypeNode;
  /** The member's own object type: where its props are declared and new ones go. */
  readonly literal: ts.TypeLiteralNode;
  readonly discriminant: ts.PropertySignature;
  /** The controller's literal in this member: a string (`"main"`), or `true` / `false` for a boolean controller. */
  readonly literalNode: ControllerLiteral;
  readonly value: string;
  /** Each prop the member declares, by name, the controller included. */
  readonly fields: ReadonlyMap<string, ts.PropertySignature>;
}

/** One discriminated union of the props. */
export interface VariantGroupSyntax {
  readonly union: ts.UnionTypeNode;
  readonly controller: string;
  readonly members: readonly VariantMemberSyntax[];
  readonly props: readonly string[];
  readonly reason: VariantGroupReason | undefined;
}

/** The runtime type (`Astro.props as AllProps`): its flat members, kept in step with the union. */
export interface VariantRuntimeSyntax {
  readonly members: ReadonlyMap<string, ts.PropertySignature>;
  /** The object type a new prop's runtime declaration goes into: the last one written. */
  readonly literal: ts.TypeLiteralNode | undefined;
}

export interface VariantSyntax {
  readonly document: PropertySyntax;
  readonly groups: readonly VariantGroupSyntax[];
  /** Undefined when the props are read as `Props` itself: nothing else to keep in step. */
  readonly runtime: VariantRuntimeSyntax | undefined;
  /** The one destructure of `Astro.props`, when there is exactly one. */
  readonly pattern: ts.ObjectBindingPattern | undefined;
  /**
   * The props every option shares: declared in an object type `Props`
   * intersects outside any union (`{ render?: boolean } & Tag & Kind`), in this
   * file and not exported. Each can be given variant rules (`attachProp`).
   */
  readonly common: ReadonlyMap<string, ts.PropertySignature>;
  /** The shared object types themselves, in written order: where a prop detached from a group goes. */
  readonly commonLiterals: readonly ts.TypeLiteralNode[];
  /** The `type Props` alias, when it is one this reader follows: a new group is intersected onto it. */
  readonly props: ts.TypeAliasDeclaration | undefined;
  /**
   * With no group yet, the shared props that could become one's controller:
   * a string-literal union of two or more options (`size?: "s" | "m"`).
   */
  readonly candidates: readonly VariantCandidateSyntax[];
}

/** A controller's literal: a string option, or a boolean one. */
export type ControllerLiteral = ts.StringLiteral | ts.TrueLiteral | ts.FalseLiteral;

/**
 * A prop that could control a new group: one of string options
 * (`size?: "s" | "l"`, or a local alias of them) or a boolean. `field` is its
 * declaration in the shared object type, which leaves it when the group is
 * made; a prop another group rules has none, and keeps its declarations.
 */
export interface VariantCandidateSyntax {
  readonly controller: string;
  readonly field: ts.PropertySignature | undefined;
  readonly values: readonly string[];
  /** How an option is written: quoted with this quote, or bare (`true`). */
  readonly spelling: { readonly kind: 'string'; readonly quote: string } | { readonly kind: 'boolean' };
  readonly optional: boolean;
  /** The option that applies when the controller is not passed: the destructure's default, else the first; none when it is required. */
  readonly fallback: string | undefined;
}

type Declaration = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

interface Candidate {
  readonly union: ts.UnionTypeNode;
  readonly exported: boolean;
}

interface PropsParts {
  readonly candidates: readonly Candidate[];
  readonly common: ReadonlyMap<string, ts.PropertySignature>;
  readonly commonLiterals: readonly ts.TypeLiteralNode[];
}

const NO_COMMON: ReadonlyMap<string, ts.PropertySignature> = new Map();

/** The variant groups of a component's source, as the panel draws them. */
export function readVariantGroups(source: string): readonly VariantGroup[] {
  return variantGroupsOf(readVariantSyntax(readPropertySyntax(source)));
}

export function readVariantSyntax(document: PropertySyntax): VariantSyntax {
  const declarations = localDeclarations(document.syntax);
  const runtime = readRuntime(document.syntax, declarations);
  const patterns = syntaxNodes(document.syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer))
    .map((node) => node.name)
    .filter(ts.isObjectBindingPattern);
  const pattern = patterns.length === 1 ? patterns[0] : undefined;
  const props = declarations?.get('Props');
  if (declarations === undefined || props === undefined || !ts.isTypeAliasDeclaration(props) || props.typeParameters !== undefined) {
    return { document, groups: [], runtime: runtime.syntax, pattern, common: NO_COMMON, commonLiterals: [], props: undefined, candidates: [] };
  }
  const groups: VariantGroupSyntax[] = [];
  const parts = propsParts(props, declarations);
  for (const candidate of parts.candidates) {
    const group = readGroup(candidate, declarations);
    if (group !== undefined) {
      assert(groups.length < VARIANT_LIMITS.groupsMax, 'readVariantSyntax: variant groups are bounded');
      const reason = group.reason ?? runtimeReason(group, runtime, patterns.length);
      groups.push({ ...group, reason });
    }
  }
  assert(
    new Set(groups.map((group) => group.controller)).size === groups.length || groups.every((group) => group.reason !== undefined),
    'Editable groups have distinct controllers',
  );
  const exported = isExported(props);
  const candidates = exported ? [] : controllerCandidates(parts.common, groups, declarations, pattern);
  return {
    document,
    groups: distinctControllers(groups),
    runtime: runtime.syntax,
    pattern,
    common: parts.common,
    commonLiterals: parts.commonLiterals,
    props: exported ? undefined : props,
    candidates,
  };
}

// The props that could pick the option of a new group: string options or a
// boolean, shared or ruled by another group, and not a controller already
// (a controller another prop could control would make a cycle).
function controllerCandidates(
  common: ReadonlyMap<string, ts.PropertySignature>,
  groups: readonly VariantGroupSyntax[],
  declarations: ReadonlyMap<string, Declaration>,
  pattern: ts.ObjectBindingPattern | undefined,
): readonly VariantCandidateSyntax[] {
  const controllers = new Set(groups.map((group) => group.controller));
  const declared = new Map<string, { readonly field: ts.PropertySignature; readonly shared: boolean }>();
  for (const [name, field] of common) {
    declared.set(name, { field, shared: true });
  }
  for (const group of groups) {
    for (const prop of group.props) {
      const field = group.members
        .map((member) => member.fields.get(prop))
        .find((item) => item?.type !== undefined && item.type.kind !== ts.SyntaxKind.NeverKeyword);
      if (field !== undefined && !declared.has(prop)) {
        declared.set(prop, { field, shared: false });
      }
    }
  }
  const candidates: VariantCandidateSyntax[] = [];
  for (const [controller, { field, shared }] of declared) {
    const options = controllers.has(controller) ? undefined : optionsOfType(field.type, declarations);
    if (options !== undefined) {
      const binding = pattern?.elements.find(
        (element) => element.dotDotDotToken === undefined && propertyKey(element.propertyName ?? element.name) === controller,
      );
      const initial = binding?.initializer;
      const defaulted = initial === undefined ? undefined : literalValueOf(initial);
      const optional = field.questionToken !== undefined;
      const fallback = optional ? (defaulted !== undefined && options.values.includes(defaulted) ? defaulted : options.values[0]) : undefined;
      candidates.push({ controller, field: shared ? field : undefined, values: options.values, spelling: options.spelling, optional, fallback });
    }
  }
  assert(candidates.length <= PROPERTY_LIMITS.fieldsMax, 'controllerCandidates: candidates are bounded');
  return candidates;
}

// A type's options when it can key a group: two or more distinct string
// literals (written, or in a local alias), or a boolean.
function optionsOfType(
  type: ts.TypeNode | undefined,
  declarations: ReadonlyMap<string, Declaration>,
): Pick<VariantCandidateSyntax, 'values' | 'spelling'> | undefined {
  if (type === undefined) {
    return undefined;
  }
  if (type.kind === ts.SyntaxKind.BooleanKeyword) {
    return { values: ['true', 'false'], spelling: { kind: 'boolean' } };
  }
  let resolved: ts.TypeNode = type;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeArguments === undefined) {
    const alias = declarations.get(type.typeName.text);
    if (alias === undefined || !ts.isTypeAliasDeclaration(alias) || alias.typeParameters !== undefined || isExported(alias)) {
      return undefined;
    }
    resolved = alias.type;
  }
  const parts = ts.isUnionTypeNode(resolved) ? resolved.types : [];
  const literals = parts.map((part) => stringLiteralOf(part)).filter((literal): literal is ts.StringLiteral => literal !== undefined);
  const values = literals.map((literal) => literal.text);
  if (literals.length < 2 || literals.length !== parts.length || new Set(values).size !== values.length || values.length > VARIANT_LIMITS.optionsMax) {
    return undefined;
  }
  return { values, spelling: { kind: 'string', quote: literals[0]?.getText().slice(0, 1) ?? '"' } };
}

/** An option's text for a literal expression or type literal: a string's value, or `true` / `false`. */
export function literalValueOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return 'true';
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return 'false';
  }
  return undefined;
}

/** The panel's model of the groups: names, options and each prop's rule, no syntax. */
export function variantGroupsOf(syntax: VariantSyntax): readonly VariantGroup[] {
  const groups = syntax.groups.map((group): VariantGroup => {
    const options = group.members.map((member): VariantOption => ({
      value: member.value,
      fallback: member.discriminant.questionToken !== undefined,
      rules: group.props.map((prop) => ruleOf(member, prop)),
    }));
    assert(options.length === group.members.length, 'variantGroupsOf: one option per member');
    // A prop this group does not rule yet can be given its rules: shared, or
    // ruled by another group (both rules then hold). No controller is.
    const attachable = group.reason === undefined ? attachableProps(syntax).filter((name) => !group.props.includes(name)) : [];
    return {
      controller: group.controller,
      props: group.props,
      attachable,
      options,
      editing: group.reason === undefined ? { kind: 'editable' } : { kind: 'readonly', reason: group.reason },
    };
  });
  // A candidate is drawn as a group with no rules yet: choosing it for a prop creates the group.
  const candidates = syntax.candidates.slice(0, Math.max(0, VARIANT_LIMITS.groupsMax - groups.length)).map((candidate): VariantGroup => ({
    controller: candidate.controller,
    props: [],
    attachable: attachableProps(syntax).filter((name) => name !== candidate.controller),
    options: candidate.values.map((value) => ({ value, fallback: value === candidate.fallback, rules: [] })),
    editing: { kind: 'candidate' },
  }));
  assert(groups.length <= VARIANT_LIMITS.groupsMax, 'variantGroupsOf: groups are bounded');
  return [...groups, ...candidates];
}

/** The props a group could rule: shared or ruled by an editable group, never a controller. */
export function attachableProps(syntax: VariantSyntax): readonly string[] {
  const controllers = new Set(syntax.groups.map((group) => group.controller));
  const names = new Set([...syntax.common.keys(), ...syntax.groups.filter((group) => group.reason === undefined).flatMap((group) => group.props)]);
  return [...names].filter((name) => !controllers.has(name));
}

/** A prop's rule in one option: its state there, as the member's declaration says. */
export function ruleOf(member: VariantMemberSyntax, prop: string): VariantRule {
  const field = member.fields.get(prop);
  if (field === undefined) {
    return { prop, state: 'forbidden', listed: false, type: '' };
  }
  const type = field.type;
  assert(type !== undefined, 'ruleOf: a modelled declaration has a type');
  if (type.kind === ts.SyntaxKind.NeverKeyword) {
    return { prop, state: 'forbidden', listed: true, type: '' };
  }
  return { prop, state: field.questionToken === undefined ? 'required' : 'optional', listed: true, type: type.getText() };
}

/** The declarations a type name can mean, or undefined when one is declared twice (merged: not this reader's to follow). */
function localDeclarations(syntax: ts.SourceFile): ReadonlyMap<string, Declaration> | undefined {
  const declarations = new Map<string, Declaration>();
  for (const statement of syntax.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      if (declarations.has(statement.name.text)) {
        return undefined;
      }
      declarations.set(statement.name.text, statement);
    }
  }
  return declarations;
}

// The unions `Props` intersects, through local aliases: `Props = A & Tag & Kind`
// or `Props = Kind`. A union nested deeper (inside a member) belongs to that
// member, and makes its own group read-only instead (readMember).
function propsParts(props: ts.TypeAliasDeclaration, declarations: ReadonlyMap<string, Declaration>): PropsParts {
  const candidates: Candidate[] = [];
  const common = new Map<string, ts.PropertySignature>();
  const commonLiterals: ts.TypeLiteralNode[] = [];
  const work: { readonly node: ts.TypeNode; readonly exported: boolean; readonly path: readonly string[] }[] = [
    { node: props.type, exported: isExported(props), path: ['Props'] },
  ];
  for (let steps = 0; steps < PROPERTY_LIMITS.nodesMax && work.length > 0; steps++) {
    const item = work.pop();
    assert(item !== undefined, 'propsParts: a work item exists');
    const node = item.node;
    if (ts.isParenthesizedTypeNode(node)) {
      work.push({ ...item, node: node.type });
    } else if (ts.isIntersectionTypeNode(node)) {
      // Pushed in reverse, so the parts are met in the order they are written.
      work.push(...[...node.types].reverse().map((type) => ({ ...item, node: type })));
    } else if (ts.isUnionTypeNode(node)) {
      candidates.push({ union: node, exported: item.exported });
    } else if (ts.isTypeLiteralNode(node) && !item.exported) {
      commonLiterals.push(node);
      for (const field of node.members) {
        const name = ts.isPropertySignature(field) ? plainName(field) : undefined;
        if (name !== undefined && ts.isPropertySignature(field) && field.type !== undefined && !common.has(name)) {
          common.set(name, field);
        }
      }
    } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined) {
      const declaration = declarations.get(node.typeName.text);
      // A cycle stops at the first repeat; an interface holds no union.
      if (declaration !== undefined && ts.isTypeAliasDeclaration(declaration) && declaration.typeParameters === undefined) {
        if (!item.path.includes(declaration.name.text)) {
          work.push({ node: declaration.type, exported: item.exported || isExported(declaration), path: [...item.path, declaration.name.text] });
        }
      }
    }
    assert(work.length <= PROPERTY_LIMITS.nodesMax, 'propsParts: the queue is bounded');
  }
  assert(work.length === 0, 'propsParts: the walk finishes within its budget');
  assert(common.size <= PROPERTY_LIMITS.fieldsMax, 'propsParts: shared props are bounded');
  return { candidates, common, commonLiterals };
}

interface MemberReading {
  readonly literals: readonly ts.TypeLiteralNode[];
  readonly reason: VariantGroupReason | undefined;
}

function readGroup(
  candidate: Candidate,
  declarations: ReadonlyMap<string, Declaration>,
): (Omit<VariantGroupSyntax, 'reason'> & { readonly reason: VariantGroupReason | undefined }) | undefined {
  const union = candidate.union;
  if (union.types.length > VARIANT_LIMITS.optionsMax) {
    return undefined;
  }
  const readings = union.types.map((member) => readMember(member, declarations));
  const fieldMaps = readings.map((reading) => fieldsOf(reading.literals));
  const controller = controllerOf(fieldMaps);
  if (controller === undefined) {
    return undefined;
  }
  const members: VariantMemberSyntax[] = [];
  let reason: VariantGroupReason | undefined = candidate.exported ? 'shared' : undefined;
  for (const [index, node] of union.types.entries()) {
    const reading = readings[index];
    const fields = fieldMaps[index];
    assert(reading !== undefined, 'readGroup: each member was read');
    assert(fields !== undefined, 'readGroup: each member has fields');
    const discriminant = fields.get(controller);
    assert(discriminant !== undefined, 'readGroup: the controller is in every member');
    const literalNode = controllerLiteralOf(discriminant.type);
    assert(literalNode !== undefined, 'readGroup: the controller is a literal in every member');
    const literal = reading.literals.find((candidate) => candidate.members.includes(discriminant));
    assert(literal !== undefined, 'readGroup: the controller is declared in one of the member object types');
    reason ??= reading.reason ?? (reading.literals.length === 1 ? undefined : 'shape');
    const value = literalValueOf(literalNode);
    assert(value !== undefined, 'readGroup: a controller literal has a value');
    members.push({ node, literal, discriminant, literalNode, value, fields });
  }
  const props = groupProps(members, controller);
  reason ??= members.some((member) => [...member.fields.values()].some((field) => field.type === undefined)) ? 'shape' : undefined;
  return { union, controller, members, props, reason };
}

// A member's object types, and why the writer could not edit it, if it could
// not. Attribute types beside the object type (`HTMLAttributes<"a"> & {…}`,
// `Omit<HTMLAttributes<"a">, "type">`) pass through untouched: they are
// declared in another file, and add attributes without naming the group's props.
function readMember(member: ts.TypeNode, declarations: ReadonlyMap<string, Declaration>): MemberReading {
  const literals: ts.TypeLiteralNode[] = [];
  let reason: VariantGroupReason | undefined;
  const work: ts.TypeNode[] = [member];
  for (let steps = 0; steps < PROPERTY_LIMITS.nodesMax && work.length > 0; steps++) {
    const node = work.pop();
    assert(node !== undefined, 'readMember: a work item exists');
    if (ts.isParenthesizedTypeNode(node)) {
      work.push(node.type);
    } else if (ts.isIntersectionTypeNode(node)) {
      work.push(...[...node.types].reverse());
    } else if (ts.isTypeLiteralNode(node)) {
      literals.push(node);
      reason ??= node.members.every((field) => ts.isPropertySignature(field) && plainName(field) !== undefined) ? undefined : 'shape';
    } else if (ts.isUnionTypeNode(node)) {
      reason ??= 'nested';
    } else if (ts.isTypeReferenceNode(node)) {
      reason ??= passThrough(node, declarations) ? undefined : 'shape';
    } else {
      reason ??= 'shape';
    }
  }
  assert(work.length === 0, 'readMember: the walk finishes within its budget');
  return { literals, reason };
}

// A reference the writer may leave as it is: a type this file does not declare
// (an import or a global, which cannot name the group's props as locals do),
// or `Omit`/`Pick` of one.
function passThrough(reference: ts.TypeReferenceNode, declarations: ReadonlyMap<string, Declaration>): boolean {
  let node: ts.TypeNode = reference;
  // `Omit<Pick<…>>` nests a wrapper or two; deeper is not a designer's type.
  for (let depth = 0; depth < PASS_THROUGH_DEPTH_MAX; depth++) {
    if (!ts.isTypeReferenceNode(node)) {
      return false;
    }
    const name = node.typeName.getText();
    if (declarations.has(name.split('.')[0] ?? name)) {
      return false;
    }
    if (name !== 'Omit' && name !== 'Pick') {
      return true;
    }
    const inner = node.typeArguments?.[0];
    if (inner === undefined) {
      return false;
    }
    node = inner;
  }
  return false;
}
const PASS_THROUGH_DEPTH_MAX = 8;

function fieldsOf(literals: readonly ts.TypeLiteralNode[]): ReadonlyMap<string, ts.PropertySignature> {
  const fields = new Map<string, ts.PropertySignature>();
  for (const literal of literals) {
    for (const member of literal.members) {
      const name = ts.isPropertySignature(member) ? plainName(member) : undefined;
      if (name !== undefined && ts.isPropertySignature(member) && !fields.has(name)) {
        fields.set(name, member);
      }
    }
  }
  assert(fields.size <= PROPERTY_LIMITS.fieldsMax, 'fieldsOf: a member declares a bounded number of props');
  return fields;
}

function plainName(member: ts.PropertySignature): string | undefined {
  if (!ts.isIdentifier(member.name)) {
    return undefined;
  }
  return propertyKey(member.name);
}

// The controller: the first prop every member declares as one literal of
// the same kind (all strings, or `true` / `false`), a different one in each.
// `element?: "button"` counts, so a member that is the fallback still names its option.
function controllerOf(members: readonly ReadonlyMap<string, ts.PropertySignature>[]): string | undefined {
  const first = members[0];
  if (first === undefined || members.length < 2) {
    return undefined;
  }
  for (const name of first.keys()) {
    const literals = members.map((fields) => controllerLiteralOf(fields.get(name)?.type));
    const known = literals.filter((literal): literal is ControllerLiteral => literal !== undefined);
    const kinds = new Set(known.map((literal) => (ts.isStringLiteral(literal) ? 'string' : 'boolean')));
    const values = known.map((literal) => literalValueOf(literal));
    if (known.length === members.length && kinds.size === 1 && new Set(values).size === known.length) {
      return name;
    }
  }
  return undefined;
}

/** The literal a controller member declares, string or boolean. */
export function controllerLiteralOf(type: ts.TypeNode | undefined): ControllerLiteral | undefined {
  if (type === undefined || !ts.isLiteralTypeNode(type)) {
    return undefined;
  }
  const literal = type.literal;
  if (ts.isStringLiteral(literal)) {
    return literal;
  }
  return isBooleanLiteral(literal) ? literal : undefined;
}

function isBooleanLiteral(node: ts.Node): node is ts.TrueLiteral | ts.FalseLiteral {
  return node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

export function stringLiteralOf(type: ts.TypeNode | undefined): ts.StringLiteral | undefined {
  if (type === undefined || !ts.isLiteralTypeNode(type)) {
    return undefined;
  }
  return ts.isStringLiteral(type.literal) ? type.literal : undefined;
}

function groupProps(members: readonly VariantMemberSyntax[], controller: string): readonly string[] {
  const props: string[] = [];
  for (const member of members) {
    for (const name of member.fields.keys()) {
      if (name !== controller && !props.includes(name)) {
        props.push(name);
      }
    }
  }
  assert(props.length <= PROPERTY_LIMITS.fieldsMax, 'groupProps: a group rules a bounded number of props');
  assert(!props.includes(controller), 'groupProps: the controller is not one of its own props');
  return props;
}

// Two editable groups keyed by the same prop would each write it: both are
// shown, neither edited.
function distinctControllers(groups: readonly VariantGroupSyntax[]): readonly VariantGroupSyntax[] {
  return groups.map((group) =>
    groups.filter((other) => other.controller === group.controller).length > 1 ? { ...group, reason: group.reason ?? 'shape' } : group,
  );
}

interface RuntimeReading {
  readonly syntax: VariantRuntimeSyntax | undefined;
  /** The runtime type cannot be kept in step: there are several, or it holds a union. */
  readonly unreadable: boolean;
}

// The type `Astro.props` is asserted as, when it is not `Props`: the flat
// runtime declarations (`type AllProps = HTMLAttributes<"button"> & { variant?: "main" | "play"; … }`)
// the component destructures. An edit to the union is mirrored in them.
function readRuntime(syntax: ts.SourceFile, declarations: ReadonlyMap<string, Declaration> | undefined): RuntimeReading {
  const assertions = syntaxNodes(syntax)
    .filter(ts.isAsExpression)
    .filter((node) => isAstroProps(node.expression));
  if (assertions.length === 0) {
    return { syntax: undefined, unreadable: false };
  }
  const first = assertions[0];
  if (assertions.length > 1 || first === undefined || declarations === undefined) {
    return { syntax: undefined, unreadable: true };
  }
  if (ts.isTypeReferenceNode(first.type) && first.type.typeName.getText() === 'Props') {
    return { syntax: undefined, unreadable: false };
  }
  const members = new Map<string, ts.PropertySignature>();
  let literal: ts.TypeLiteralNode | undefined;
  let unreadable = false;
  const work: { readonly node: ts.TypeNode; readonly path: readonly string[] }[] = [{ node: first.type, path: [] }];
  for (let steps = 0; steps < PROPERTY_LIMITS.nodesMax && work.length > 0; steps++) {
    const item = work.pop();
    assert(item !== undefined, 'readRuntime: a work item exists');
    const node = item.node;
    if (ts.isParenthesizedTypeNode(node)) {
      work.push({ ...item, node: node.type });
    } else if (ts.isIntersectionTypeNode(node)) {
      work.push(...[...node.types].reverse().map((type) => ({ ...item, node: type })));
    } else if (ts.isTypeLiteralNode(node)) {
      literal = node;
      for (const field of node.members) {
        const name = ts.isPropertySignature(field) ? plainName(field) : undefined;
        if (name !== undefined && ts.isPropertySignature(field)) {
          unreadable ||= members.has(name);
          members.set(name, field);
        }
      }
    } else if (ts.isUnionTypeNode(node)) {
      unreadable = true;
    } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const declaration = declarations.get(node.typeName.text);
      if (declaration !== undefined && ts.isTypeAliasDeclaration(declaration) && !item.path.includes(declaration.name.text)) {
        if (declaration.typeParameters !== undefined || isExported(declaration)) {
          unreadable = true;
        } else {
          work.push({ node: declaration.type, path: [...item.path, declaration.name.text] });
        }
      } else if (declaration !== undefined) {
        unreadable = true;
      }
    }
  }
  assert(work.length === 0, 'readRuntime: the walk finishes within its budget');
  return { syntax: { members, literal }, unreadable };
}

function runtimeReason(group: Omit<VariantGroupSyntax, 'reason'>, runtime: RuntimeReading, patterns: number): VariantGroupReason | undefined {
  if (runtime.unreadable) {
    return 'runtime';
  }
  if (patterns > 1) {
    return 'runtime';
  }
  assert(group.members.length > 0, 'runtimeReason: a group has members');
  return undefined;
}

function isExported(declaration: Declaration): boolean {
  return declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
