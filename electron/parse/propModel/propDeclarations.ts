// Where a component declares its props, read on the TypeScript syntax tree:
// the `Props` interface or alias (or the type `Astro.props as X` names, or a
// destructure's own annotation), the member blocks it is made of with local
// aliases and interfaces followed, each member's doc comment, and the unions
// of prop shapes it declares (`{ kind: 'link'; href: string } | { kind:
// 'button' }`), which the instance panel weighs one branch at a time.

import ts from 'typescript';
import { assert } from '../../../shared/core/assert';
import { PROP_MODEL_LIMITS, type PropsDeclaration } from '../../../shared/properties/propModel';
import type { DefaultRule, PropUnion, UnionBranch } from '../../../shared/properties/propSchema';
import { isAstroProps, syntaxNodes } from '../astroSyntax';
import { commentDocumentation, statedDefault } from './propProse';
import {
  PROP_TYPE_LIMITS,
  flattenParts,
  isNullish,
  literalOf,
  memberKey,
  referencedDeclaration,
  type FiledSignature,
  type TypeDeclaration,
  type TypeScope,
} from './propTypes';

/** The type that describes the props, and how the component wrote it. */
export interface PropsType {
  readonly declaration: PropsDeclaration;
  // The member blocks, in source order: each is the members of one object type.
  readonly blocks: readonly (readonly FiledSignature[])[];
  readonly unions: readonly PropUnion[];
}

/** A `const { … } = Astro.props` (or `= props`, a name that holds them) and its annotation. */
export interface PropsPattern {
  readonly pattern: ts.ObjectBindingPattern;
  readonly annotation: ts.TypeNode | undefined;
}

/** The props type of a component: frontmatter first, then the imported declarations. */
export function readPropsType(frontmatter: ts.SourceFile, prelude: ts.SourceFile, scope: TypeScope, patterns: readonly PropsPattern[]): PropsType {
  const declared = propsDeclaration(frontmatter) ?? propsDeclaration(prelude);
  const asserted = assertedType(frontmatter);
  const blocks: (readonly FiledSignature[])[] = [];
  const unions: PropUnion[] = [];
  if (declared !== undefined) {
    if (ts.isInterfaceDeclaration(declared.node)) {
      for (const clause of declared.node.heritageClauses ?? []) {
        for (const heritage of clause.types) {
          heritageBlocks(heritage, scope, new Set(), blocks);
        }
      }
      blocks.push(declared.node.members.filter(ts.isPropertySignature).map((member) => ({ member, file: declared.file })));
    } else {
      typeBlocks(declared.node.type, declared.file, scope, new Set(), blocks);
      collectUnions(declared.node.type, declared.file, scope, new Set(), unions);
    }
  }
  if (asserted !== undefined) {
    const named = scope.declarations.get(asserted);
    if (named !== undefined) {
      declarationBlocks(named, scope, new Set([asserted]), blocks);
      if (named.kind === 'alias') {
        collectUnions(named.node.type, named.file, scope, new Set([asserted]), unions);
      }
    }
  }
  // `const { a }: { a: string } = Astro.props` declares the props in the
  // annotation; it is the Props type when there is no other.
  const annotation = declared === undefined && asserted === undefined ? patterns.find((entry) => entry.annotation !== undefined)?.annotation : undefined;
  if (annotation !== undefined) {
    typeBlocks(annotation, frontmatter, scope, new Set(), blocks);
  }
  return {
    declaration: declarationKind(declared, asserted, annotation),
    blocks,
    unions: unions.slice(0, PROP_MODEL_LIMITS.unionsMax),
  };
}

function declarationKind(declared: DeclaredProps | undefined, asserted: string | undefined, annotation: ts.TypeNode | undefined): PropsDeclaration {
  if (declared !== undefined) {
    return ts.isInterfaceDeclaration(declared.node) ? 'interface' : 'type';
  }
  if (asserted !== undefined) {
    return 'assertion';
  }
  return annotation === undefined ? 'none' : 'annotation';
}

interface DeclaredProps {
  readonly node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
  readonly file: ts.SourceFile;
}

function propsDeclaration(file: ts.SourceFile): DeclaredProps | undefined {
  for (const statement of file.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === 'Props') {
      return { node: statement, file };
    }
  }
  return undefined;
}

// `Astro.props as CardProps` names the props type outright.
function assertedType(frontmatter: ts.SourceFile): string | undefined {
  const found = syntaxNodes(frontmatter)
    .filter(ts.isAsExpression)
    .filter((node) => isAstroProps(node.expression) && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName))
    .sort((first, second) => first.pos - second.pos)[0];
  if (found === undefined || !ts.isTypeReferenceNode(found.type) || !ts.isIdentifier(found.type.typeName)) {
    return undefined;
  }
  return found.type.typeName.text;
}

// The object types a type is made of: its own type literals, and those of the
// local aliases and interfaces it names (in a union, an intersection or as a
// type argument: `Omit<Base, 'x'>` still describes Base's members). `seen`
// gains one name per alias followed, so its size is the depth gone.
function typeBlocks(node: ts.TypeNode, file: ts.SourceFile, scope: TypeScope, seen: Set<string>, out: (readonly FiledSignature[])[]): void {
  const aliasDepth = seen.size;
  if (aliasDepth > PROP_TYPE_LIMITS.aliasDepthMax) {
    return;
  }
  if (ts.isTypeLiteralNode(node)) {
    out.push(node.members.filter(ts.isPropertySignature).map((member) => ({ member, file })));
    return;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    typeBlocks(node.type, file, scope, seen, out);
    return;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const child of node.types) {
      typeBlocks(child, file, scope, seen, out);
    }
    return;
  }
  if (!ts.isTypeReferenceNode(node)) {
    return;
  }
  if (ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    const declaration = scope.declarations.get(name);
    if (declaration !== undefined && !seen.has(name)) {
      seen.add(name);
      declarationBlocks(declaration, scope, seen, out);
    }
  }
  for (const argument of node.typeArguments ?? []) {
    typeBlocks(argument, file, scope, seen, out);
  }
}

function heritageBlocks(heritage: ts.ExpressionWithTypeArguments, scope: TypeScope, seen: Set<string>, out: (readonly FiledSignature[])[]): void {
  if (ts.isIdentifier(heritage.expression)) {
    const name = heritage.expression.text;
    const declaration = scope.declarations.get(name);
    if (declaration !== undefined && !seen.has(name) && seen.size <= PROP_TYPE_LIMITS.aliasDepthMax) {
      seen.add(name);
      declarationBlocks(declaration, scope, seen, out);
    }
  }
  for (const argument of heritage.typeArguments ?? []) {
    typeBlocks(argument, heritage.getSourceFile(), scope, seen, out);
  }
}

function declarationBlocks(declaration: TypeDeclaration, scope: TypeScope, seen: Set<string>, out: (readonly FiledSignature[])[]): void {
  if (declaration.kind === 'alias') {
    typeBlocks(declaration.node.type, declaration.file, scope, seen, out);
    return;
  }
  for (const clause of declaration.node.heritageClauses ?? []) {
    for (const heritage of clause.types) {
      heritageBlocks(heritage, scope, seen, out);
    }
  }
  out.push(declaration.node.members.filter(ts.isPropertySignature).map((member) => ({ member, file: declaration.file })));
}

/**
 * A member's doc comment: the comments right above it. A comment on the line
 * of the member before belongs to that member, not this one, unless this
 * member opens the line (`{ /** Tip. *\/ title: string }`).
 */
export function memberDocumentation(signature: FiledSignature): string {
  const text = signature.file.text;
  const start = signature.member.getStart(signature.file);
  const ranges = (ts.getLeadingCommentRanges(text, signature.member.pos) ?? []).filter((range) => {
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1;
    const ownLine = text.slice(lineStart, range.pos).trim() === '';
    const trailsPrevious = !ownLine && text.slice(range.end, start).includes('\n');
    return !trailsPrevious;
  });
  return commentDocumentation(text, start, ranges);
}

// ---------------------------------------------------------------------------
// Unions of prop shapes
// ---------------------------------------------------------------------------

// Each top-level `A | B` of object types in the props type is one table: a
// branch per arm, saying what the arm forbids (`never`, or a member the other
// arms tell apart by a literal field and this one leaves out), what it pins
// to literal values, and the fallbacks its own doc comments state.
function collectUnions(node: ts.TypeNode, file: ts.SourceFile, scope: TypeScope, seen: Set<string>, out: PropUnion[]): void {
  const aliasDepth = seen.size;
  if (aliasDepth > PROP_TYPE_LIMITS.aliasDepthMax || out.length >= PROP_MODEL_LIMITS.unionsMax) {
    return;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    collectUnions(node.type, file, scope, seen, out);
    return;
  }
  if (ts.isIntersectionTypeNode(node)) {
    for (const child of node.types) {
      collectUnions(child, file, scope, seen, out);
    }
    return;
  }
  if (ts.isUnionTypeNode(node) && node.types.length >= 2) {
    const branches = node.types.map((arm) => {
      const blocks: (readonly FiledSignature[])[] = [];
      typeBlocks(arm, file, scope, new Set(), blocks);
      return blocks;
    });
    if (branches.every((blocks) => blocks.length > 0)) {
      const union = unionTable(branches, scope);
      if (union !== undefined) {
        out.push(union);
      }
      return;
    }
  }
  const declaration = referencedDeclaration(node, scope);
  if (declaration?.kind === 'alias' && !seen.has(declaration.node.name.text)) {
    seen.add(declaration.node.name.text);
    collectUnions(declaration.node.type, declaration.file, scope, seen, out);
  }
}

function unionTable(branchBlocks: readonly (readonly (readonly FiledSignature[])[])[], scope: TypeScope): PropUnion | undefined {
  if (branchBlocks.length > PROP_MODEL_LIMITS.propVariantsMax) {
    return undefined;
  }
  const entries = branchBlocks.map((blocks) => {
    const members = new Map<string, FiledSignature>();
    const docs = new Map<string, string>();
    for (const signature of blocks.flat()) {
      const name = memberKey(signature.member.name);
      if (name === undefined) {
        continue;
      }
      members.set(name, signature);
      const documentation = memberDocumentation(signature).slice(0, PROP_MODEL_LIMITS.docCharsMax);
      if (documentation !== '') {
        docs.set(name, documentation);
      }
    }
    return { members, docs };
  });
  const names = [...new Set(entries.flatMap((entry) => [...entry.members.keys()]))];
  const branches = entries.map(({ members, docs }) => {
    const forbids: string[] = [];
    const pins: Record<string, readonly string[]> = {};
    for (const name of names) {
      const signature = members.get(name);
      const type = signature?.member.type;
      if (signature === undefined || type === undefined) {
        continue;
      }
      if (type.kind === ts.SyntaxKind.NeverKeyword) {
        forbids.push(name);
        continue;
      }
      // A branch PINS a prop when it fixes it to a known set of values — one
      // (`variant: "autofit"`) or several, which is still a discriminant,
      // just a wider one. Anything with a non-literal member fixes nothing.
      const values = flattenParts(type, signature.file, scope).filter((part) => !isNullish(part));
      const literals = values.map(literalOf);
      if (
        values.length > 0 &&
        values.length <= PROP_MODEL_LIMITS.optionsMax &&
        literals.every((literal) => literal !== undefined && literal.text.length <= PROP_MODEL_LIMITS.textCharsMax)
      ) {
        pins[name] = literals.map((literal) => (literal?.form === 'string' ? literal.value : (literal?.text ?? '')));
      }
    }
    return { forbids, pins, ...branchDocs(docs) };
  });
  // In a union told apart by a literal field, a member one branch leaves out
  // is not part of that branch: TypeScript rejects `disabled` beside
  // `kind="link"`. It is forbidden there just as `disabled?: never` would say.
  const told = discriminated(branches.map((branch) => branch.pins));
  const finished: UnionBranch[] = branches.map((branch, index) => {
    const members = entries[index]?.members;
    assert(members !== undefined, 'unionTable: every branch has its members');
    const missing = told ? names.filter((name) => !members.has(name) && !branch.forbids.includes(name)) : [];
    return { ...branch, forbids: [...branch.forbids, ...missing] };
  });
  // A union that forbids nothing and pins nothing tells the panel nothing.
  const telling = finished.some(
    (branch) =>
      branch.forbids.length > 0 || Object.keys(branch.pins).length > 0 || Object.keys(branch.defaults).length > 0 || Object.keys(branch.rules).length > 0,
  );
  return telling ? { names, branches: finished } : undefined;
}

// What one union branch's own doc comments say each prop falls back to. A label
// that reads Play in the play branch and Close in the close one has no single
// answer for the field, but it has one per branch.
function branchDocs(documentation: ReadonlyMap<string, string>): Pick<UnionBranch, 'defaults' | 'rules' | 'docs'> {
  const defaults: Record<string, string | number> = {};
  const rules: Record<string, DefaultRule> = {};
  const docs: Record<string, string> = {};
  for (const [name, text] of documentation) {
    docs[name] = text;
    const said = statedDefault(text);
    if (said.value !== undefined) {
      defaults[name] = said.value;
    }
    if (said.when) {
      rules[name] = said.when;
    }
  }
  return { defaults, rules, docs };
}

// Whether one field tells the branches apart: pinned in every one of them
// (two or more), to values no two of them share.
function discriminated(pins: readonly Readonly<Record<string, readonly string[]>>[]): boolean {
  const names = new Set(pins.flatMap((branch) => Object.keys(branch)));
  for (const name of names) {
    const pinned = pins.map((branch) => branch[name]).filter((values) => values !== undefined);
    const values = pinned.flat();
    if (pinned.length >= 2 && pinned.length === pins.length && new Set(values).size === values.length) {
      return true;
    }
  }
  return false;
}

/**
 * The props a union branch's doc promises a different fallback for in each
 * branch: there is no single answer for the field, so the field claims none
 * and the branch tables carry the per-branch answers.
 */
export function splitFallbacks(unions: readonly PropUnion[]): ReadonlySet<string> {
  const split = new Set<string>();
  for (const union of unions) {
    for (const name of union.names) {
      const seen = new Set<string | number>();
      for (const branch of union.branches) {
        const value = branch.defaults[name];
        if (value !== undefined) {
          seen.add(value);
        }
        if (branch.rules[name] !== undefined) {
          seen.add(`rule:${name}`);
        }
      }
      if (seen.size > 1) {
        split.add(name);
      }
    }
  }
  return split;
}
