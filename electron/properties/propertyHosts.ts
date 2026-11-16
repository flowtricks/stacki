// Where a prop the file does not yet declare gets its declaration, so that no
// component shape leaves the Properties panel read-only. The declaration goes
// into the type the component already has, as one edit beside the others of a
// save: a member inside `interface Props` or a type literal, or `& { … }`
// appended to a type that is not a literal (an alias of other types, an
// annotation, the type of an `Astro.props as X` assertion). A component whose
// `Props` is imported keeps its import under another name and gains a local
// `type Props` that adds to it. Only a component with no type for its props
// at all returns undefined; the caller then writes a new `interface Props`.

import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { ok, type Result } from '../../shared/core/result';
import { isAstroProps, syntaxNodes } from './propertySyntax';
import type { SourceEdit } from './propertySyntax';

/** One new member as text: `block` for the inside of an interface or literal, `inline` for `& { … }`. */
export interface NewMemberText {
  readonly block: string;
  readonly inline: string;
}

/** The edits that declare a member in the component's own props type, or undefined when it has none. */
export function declareInHost(syntax: ts.SourceFile, member: NewMemberText): Result<readonly SourceEdit[]> | undefined {
  const declarations = typeDeclarations(syntax);
  const props = declarations.get('Props');
  if (props !== undefined) {
    return ok(appendToDeclaration(props, member));
  }
  const annotated = syntaxNodes(syntax)
    .filter(ts.isVariableDeclaration)
    .find((node) => isAstroProps(node.initializer) && node.type !== undefined);
  if (annotated?.type !== undefined) {
    return ok(appendToType(annotated.type, member));
  }
  const imported = importedProps(syntax);
  if (imported !== undefined) {
    return importedPropsEdits(syntax, imported, member);
  }
  const assertion = syntaxNodes(syntax)
    .filter(ts.isAsExpression)
    .find((node) => isAstroProps(node.expression));
  if (assertion === undefined) {
    return undefined;
  }
  const named = ts.isTypeReferenceNode(assertion.type) ? declarations.get(assertion.type.typeName.getText()) : undefined;
  return ok(named === undefined ? appendToType(assertion.type, member) : appendToDeclaration(named, member));
}

function typeDeclarations(syntax: ts.SourceFile): ReadonlyMap<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration> {
  const found = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const statement of syntax.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && !found.has(statement.name.text)) {
      found.set(statement.name.text, statement);
    }
  }
  return found;
}

function appendToDeclaration(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, member: NewMemberText): readonly SourceEdit[] {
  if (ts.isInterfaceDeclaration(declaration)) {
    const close = declaration.end - 1;
    return [{ start: close, end: close, text: member.block }];
  }
  return appendToType(declaration.type, member);
}

function appendToType(type: ts.TypeNode, member: NewMemberText): readonly SourceEdit[] {
  if (ts.isTypeLiteralNode(type)) {
    return [{ start: type.end - 1, end: type.end - 1, text: member.block }];
  }
  const addition = ` & { ${member.inline} }`;
  if (ts.isTypeReferenceNode(type) || ts.isIntersectionTypeNode(type) || ts.isParenthesizedTypeNode(type)) {
    return [{ start: type.end, end: type.end, text: addition }];
  }
  // A union, conditional or other type binds looser than `&`: it is wrapped first.
  return [
    { start: type.getStart(), end: type.getStart(), text: '(' },
    { start: type.end, end: type.end, text: `)${addition}` },
  ];
}

function importedProps(syntax: ts.SourceFile): { readonly statement: ts.ImportDeclaration; readonly specifier: ts.ImportSpecifier } | undefined {
  for (const statement of syntax.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (statement.kind === ts.SyntaxKind.ImportDeclaration && bindings !== undefined && ts.isNamedImports(bindings)) {
      const specifier = bindings.elements.find((element) => element.name.text === 'Props');
      if (specifier !== undefined && ts.isImportDeclaration(statement)) {
        return { statement, specifier };
      }
    }
  }
  return undefined;
}

const IMPORTED_NAME_TRIES = 100;

// `ImportedProps`, or the first of `ImportedProps2`… the file does not use.
function freeImportedName(syntax: ts.SourceFile): string {
  const taken = new Set(
    syntaxNodes(syntax)
      .filter(ts.isIdentifier)
      .map((node) => node.text),
  );
  for (let attempt = 1; attempt <= IMPORTED_NAME_TRIES; attempt++) {
    const name = attempt === 1 ? 'ImportedProps' : `ImportedProps${attempt}`;
    if (!taken.has(name)) {
      return name;
    }
  }
  assert(false, 'A free name for the imported Props type is found within its bound');
  return 'ImportedProps';
}

function importedPropsEdits(
  syntax: ts.SourceFile,
  imported: { readonly statement: ts.ImportDeclaration; readonly specifier: ts.ImportSpecifier },
  member: NewMemberText,
): Result<readonly SourceEdit[]> {
  const { specifier, statement } = imported;
  assert(specifier.name.text === 'Props', 'The imported specifier is the Props type');
  const alias = freeImportedName(syntax);
  const rename: SourceEdit = {
    start: specifier.name.getStart(),
    end: specifier.name.end,
    text: specifier.propertyName === undefined ? `Props as ${alias}` : alias,
  };
  return ok([rename, { start: statement.end, end: statement.end, text: `\ntype Props = ${alias} & { ${member.inline} };` }]);
}
