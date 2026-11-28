// The statements of a module (a page's frontmatter, a data file, an MDX file's imports) as a role without a code
// permission may change them: statements the project already holds move, repeat and go; new ones only import project
// files or declare data; and a changed one differs only in its data (codeGuard.ts).
import ts from 'typescript';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { LIST_ITEMS_HELPER, LIST_ITEMS_NAME } from '../../../vendor/stacki/src/editor/listItemsHelper';
import { bindingNames, parseTypeScript, safeExpression, syntaxErrors, type CodeScope } from './codeExpression';

export interface ModuleCode {
  readonly statements: readonly ts.Statement[];
  readonly errors: number;
}

const STATEMENTS_MAX = 5_000;
const DEPTH_MAX = 100;
/** Astro's own modules a page may start importing from. */
const ASTRO_MODULES: ReadonlySet<string> = new Set(['astro:assets', 'astro:content', 'astro:components', 'astro:transitions']);
const QUERY_NAMES: ReadonlySet<string> = new Set(['getCollection', 'getEntry', 'getEntries', 'render', 'getImage']);

export function readModule(code: string): ModuleCode {
  const file = parseTypeScript(code);
  assert(file.statements.length <= STATEMENTS_MAX, 'A module is bounded');
  return { statements: [...file.statements], errors: syntaxErrors(file) };
}

export const statementKey = (statement: ts.Statement): string => `statement:${statement.getText()}`;

// The loop settings write one fixed helper into a page (listItemsHelper.ts), indented as the page is.
const unindented = (code: string): string => code.replace(/^\s+/gm, '').trim();
const LIST_HELPER = unindented(parseTypeScript(LIST_ITEMS_HELPER).statements[0]?.getText() ?? '');
const isListHelper = (statement: ts.Statement): boolean => unindented(statement.getText()) === LIST_HELPER;

function isDeclared(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

interface Names {
  readonly names: Set<string>;
  readonly queries: Set<string>;
}

// Only what exists when the code runs: a `declare` or a type import declares nothing, so neither makes a global readable.
function collectNames(statement: ts.Statement, found: Names): void {
  if (isDeclared(statement)) {
    return;
  }
  if (ts.isImportDeclaration(statement)) {
    importedNames(statement, found);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      patternNames(declaration.name, found.names);
    }
  } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
    found.names.add(statement.name.text);
  }
}

function importedNames(statement: ts.ImportDeclaration, found: Names): void {
  const clause = statement.importClause;
  if (clause === undefined || clause.isTypeOnly) {
    return;
  }
  if (clause.name !== undefined) {
    found.names.add(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    found.names.add(bindings.name.text);
    return;
  }
  const from = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
  for (const element of bindings.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    found.names.add(element.name.text);
    if ((from === 'astro:content' || from === 'astro:assets') && QUERY_NAMES.has((element.propertyName ?? element.name).text)) {
      found.queries.add(element.name.text);
    }
  }
}

function patternNames(name: ts.BindingName, names: Set<string>): void {
  const pending: ts.BindingName[] = [name];
  for (let index = 0; index < pending.length && index < STATEMENTS_MAX; index++) {
    const entry = pending[index];
    if (entry === undefined) {
      break;
    }
    if (ts.isIdentifier(entry)) {
      names.add(entry.text);
    } else {
      pending.push(...entry.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : [element.name])));
    }
  }
}

/** What code in a module with these statements may read. `trusted` comes from the module as it was. */
export function moduleScope(statements: readonly ts.Statement[], trusted: ReadonlySet<string>): CodeScope {
  const found: Names = { names: new Set(), queries: new Set() };
  for (const statement of statements) {
    collectNames(statement, found);
    if (isListHelper(statement)) {
      found.queries.add(LIST_ITEMS_NAME);
    }
  }
  return { names: found.names, queries: found.queries, trusted };
}

/** The data sources a module already reads: each constant's value, and what its chain of methods starts from. */
export function trustedSources(statements: readonly ts.Statement[]): readonly string[] {
  const found: string[] = [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer !== undefined) {
        found.push(...chainSources(declaration.initializer));
      }
    }
  }
  return found;
}

/** `value` and every receiver along its method chain. */
export function chainSources(value: ts.Expression): readonly string[] {
  const found: string[] = [];
  let current: ts.Expression | undefined = value;
  for (let depth = 0; current !== undefined && depth < DEPTH_MAX; depth++) {
    found.push(current.getText());
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      current = current.expression.expression;
    } else {
      current = undefined;
    }
  }
  return found;
}

export interface ImportRules {
  /** The file the import is written in, to resolve a relative path from. */
  readonly file: string;
  /** Whether the project already imports this module somewhere. */
  readonly imported: (specifier: string) => boolean;
}

/** Whether a new import of `specifier` only brings in one of the project's own files, or a module it already uses. */
export function safeSpecifier(specifier: string, rules: ImportRules): boolean {
  if (ASTRO_MODULES.has(specifier)) {
    return true;
  }
  if (/[?#:\\\u0000-\u001f]/.test(specifier)) {
    return false;
  }
  if (specifier.startsWith('.')) {
    const segments = rules.file.split('/').slice(0, -1);
    for (const part of specifier.split('/')) {
      if (part === '..') {
        if (segments.pop() === undefined) {
          return false;
        }
      } else if (part !== '.' && part !== '') {
        segments.push(part);
      }
    }
    return (segments[0] === 'src' || segments[0] === 'public') && segments.every((part) => !part.startsWith('.') && part !== 'node_modules');
  }
  const parts = specifier.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === 'node_modules')) {
    return false;
  }
  if (specifier.startsWith('/')) {
    return specifier.startsWith('/src/');
  }
  return specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.endsWith('.astro') || rules.imported(specifier);
}

export function importSpecifier(statement: ts.Statement): string | undefined {
  return ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
}

/** Whether a statement the project never held is only a type, an import of a project file, or a declaration of data. */
export function safeStatement(statement: ts.Statement, scope: CodeScope, rules: ImportRules): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement) || isListHelper(statement)) {
    return true;
  }
  const specifier = importSpecifier(statement);
  if (specifier !== undefined && ts.isImportDeclaration(statement)) {
    return statement.importClause?.isTypeOnly === true || safeSpecifier(specifier, rules);
  }
  if (ts.isExportAssignment(statement)) {
    return safeExpression(statement.expression, scope);
  }
  if (!ts.isVariableStatement(statement) || isDeclared(statement)) {
    return false;
  }
  if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
    return false;
  }
  return statement.declarationList.declarations.every(
    (declaration) =>
      bindingNames(declaration.name, scope) !== undefined && (declaration.initializer === undefined || safeExpression(declaration.initializer, scope)),
  );
}

/**
 * Whether `after` is `before` with only its data changed: an entry of an array or object written by a developer
 * may sit beside calls this would never allow as new, and editing its neighbour must keep working.
 */
export function onlyDataChanged(before: ts.Statement, after: ts.Statement, scope: CodeScope): boolean {
  if (!ts.isVariableStatement(before) || !ts.isVariableStatement(after)) {
    return ts.isExportAssignment(before) && ts.isExportAssignment(after) && changedValue(before.expression, after.expression, scope, 0);
  }
  const left = before.declarationList.declarations;
  const right = after.declarationList.declarations;
  const head = (statement: ts.VariableStatement) => `${statement.modifiers?.map((item) => item.kind).join() ?? ''} ${statement.declarationList.flags}`;
  if (head(before) !== head(after) || left.length !== right.length) {
    return false;
  }
  return right.every((declaration, index) => {
    const old = left[index];
    if (old === undefined || old.name.getText() !== declaration.name.getText() || old.type?.getText() !== declaration.type?.getText()) {
      return false;
    }
    const was = old.initializer;
    const now = declaration.initializer;
    return was === undefined || now === undefined ? was === now : changedValue(was, now, scope, 0);
  });
}

function changedValue(before: ts.Expression, after: ts.Expression, scope: CodeScope, depth: number): boolean {
  if (before.getText() === after.getText() || safeExpression(after, scope)) {
    return true;
  }
  if (depth > DEPTH_MAX || before.kind !== after.kind) {
    return false;
  }
  const next = (left: ts.Expression, right: ts.Expression) => changedValue(left, right, scope, depth + 1);
  if (ts.isArrayLiteralExpression(before) && ts.isArrayLiteralExpression(after)) {
    return changedElements(before, after, scope, depth);
  }
  if (ts.isObjectLiteralExpression(before) && ts.isObjectLiteralExpression(after)) {
    return changedProperties(before, after, scope, depth);
  }
  if (
    (ts.isParenthesizedExpression(before) && ts.isParenthesizedExpression(after)) ||
    (ts.isAwaitExpression(before) && ts.isAwaitExpression(after)) ||
    (ts.isAsExpression(before) && ts.isAsExpression(after)) ||
    (ts.isSatisfiesExpression(before) && ts.isSatisfiesExpression(after))
  ) {
    return next(before.expression, after.expression);
  }
  if (!ts.isCallExpression(before) || !ts.isCallExpression(after) || before.expression.getText() !== after.expression.getText()) {
    return false;
  }
  // Only the data lists a call was handed may change: a changed string argument could point the call elsewhere.
  return (
    before.arguments.length === after.arguments.length &&
    after.arguments.every((argument, index) => {
      const old = before.arguments[index];
      const container = ts.isArrayLiteralExpression(argument) || ts.isObjectLiteralExpression(argument);
      return old !== undefined && (old.getText() === argument.getText() || (container && next(old, argument)));
    })
  );
}

const ELEMENTS_MAX = 5_000;

function changedElements(before: ts.ArrayLiteralExpression, after: ts.ArrayLiteralExpression, scope: CodeScope, depth: number): boolean {
  if (after.elements.length > ELEMENTS_MAX) {
    return false;
  }
  const held = new Set(before.elements.map((element) => element.getText()));
  return after.elements.every((element, index) => {
    if (held.has(element.getText()) || safeExpression(element, scope)) {
      return true;
    }
    // An entry edited in place, or one beside a removed or added neighbour.
    return [index, index - 1, index + 1].some((at) => {
      const old = before.elements[at];
      return old !== undefined && changedValue(old, element, scope, depth + 1);
    });
  });
}

function changedProperties(before: ts.ObjectLiteralExpression, after: ts.ObjectLiteralExpression, scope: CodeScope, depth: number): boolean {
  const held = new Map(before.properties.map((property) => [property.name?.getText() ?? property.getText(), property]));
  return after.properties.every((property) => {
    const name = property.name?.getText() ?? property.getText();
    const old = held.get(name);
    if (old?.getText() === property.getText()) {
      return true;
    }
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || name === '__proto__') {
      return false;
    }
    if (old === undefined || !ts.isPropertyAssignment(old)) {
      return safeExpression(property.initializer, scope);
    }
    return changedValue(old.initializer, property.initializer, scope, depth + 1);
  });
}
