// A data file's plain variables, read and edited as TypeScript syntax: the
// exported constants of `src/consts.ts`, or the constants a page declares in its
// frontmatter. The CMS panel's file settings list them and add new ones
// (src/features/cms/CmsFileFields.tsx); the new statement is written the way the
// file already writes its constants (quotes, semicolons, `as const`, annotations,
// description comments, blank lines, indent, line endings, naming), right after
// the last of them, and nothing else in the file is touched.
//
// Nothing here runs the file. It is parsed with the TypeScript compiler's parser,
// and a file the parser reports any syntax error in is refused rather than
// edited: an edit spliced into code that does not parse could land anywhere.
// Every edit is parsed again afterwards and asserted to hold what it should.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import { indentUnitOf } from '../../shared/core/indent';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import {
  CMS_CONSTANT_LIMITS,
  constantNameProblem,
  constantStatement,
  type ConstantField,
  type ConstantHost,
  type ConstantListing,
  type ConstantNaming,
  type ConstantRefusal,
  type ConstantScript,
  type ConstantStyle,
  type ConstantSummary,
} from '../../shared/properties/cmsConstants';
import { readFence } from './astroFence';

/** Which kind of file a source is: a data module (by its extension) or a page. */
export interface ConstantFile {
  readonly host: ConstantHost;
  readonly script: ConstantScript;
}

/** The file kind for a project path: `.astro` is a page, any other script is a module. */
export function constantFileOf(fileName: string): ConstantFile | undefined {
  const extension = /\.([A-Za-z]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : FILE_KINDS.get(extension);
}

const FILE_KINDS: ReadonlyMap<string, ConstantFile> = new Map([
  ['astro', { host: 'page', script: 'ts' }],
  ['ts', { host: 'module', script: 'ts' }],
  ['mts', { host: 'module', script: 'ts' }],
  ['cts', { host: 'module', script: 'ts' }],
  ['tsx', { host: 'module', script: 'tsx' }],
  ['js', { host: 'module', script: 'js' }],
  ['mjs', { host: 'module', script: 'js' }],
  ['cjs', { host: 'module', script: 'js' }],
  ['jsx', { host: 'module', script: 'jsx' }],
]);

/** The file's variables, the names it binds and the way it writes them; refused when it does not parse. */
export function readConstants(source: string, file: ConstantFile): Result<ConstantListing, ConstantRefusal> {
  const parsed = parsedRegion(source, file);
  if (!parsed.ok) {
    return parsed;
  }
  const { syntax } = parsed.value;
  const fields = constantStatements(syntax, file.host)
    .flatMap((statement) => statement.declarationList.declarations)
    .flatMap((declaration) => summaryOf(declaration, syntax))
    .slice(0, CMS_CONSTANT_LIMITS.fieldsMax);
  const taken = takenNames(syntax, file.host);
  assert(
    fields.every((field) => taken.includes(field.name)),
    'readConstants: every listed variable is a taken name',
  );
  return ok({ style: styleOfRegion(syntax, file), fields, taken });
}

/** How the file writes its constants, read from the ones it has; defaults where it has none. */
export function styleOfConstants(source: string, file: ConstantFile): Result<ConstantStyle, ConstantRefusal> {
  const parsed = parsedRegion(source, file);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(styleOfRegion(parsed.value.syntax, file));
}

/**
 * `source` with `field` declared after the file's last constant (a page's: inside
 * its frontmatter, before the markup), in `style`. A page without frontmatter
 * gets a fence at the top. Refused, with the file unchanged, when the file does
 * not parse or the name is invalid, reserved or already bound.
 */
export function insertConstant(source: string, field: ConstantField, style: ConstantStyle): Result<string, ConstantRefusal> {
  const file: ConstantFile = { host: style.host, script: style.script };
  const parsed = parsedRegion(source, file);
  if (!parsed.ok) {
    return parsed;
  }
  const { syntax, region } = parsed.value;
  const problem = constantNameProblem(field.name, takenNames(syntax, file.host));
  if (problem !== undefined) {
    return err(problem);
  }
  const newline = style.newline === 'crlf' ? '\r\n' : '\n';
  const statement = constantStatement(field, style);
  const next =
    region.kind === 'absent' ? `---${newline}${statement}${newline}---${newline}${source}` : spliced(source, region, insertion(syntax, statement, style));
  const check = parsedRegion(next, file);
  assert(check.ok, 'insertConstant: the edited file parses');
  assert(
    constantStatements(check.value.syntax, file.host).some((candidate) => declaredNames(candidate).includes(field.name)),
    'insertConstant: the new variable is declared',
  );
  return ok(next);
}

/**
 * `source` without the constant `name`: its statement, its description comment
 * and its line. Refused when the file still uses the name (in its code, or a
 * page's markup), when the statement declares other names too, or when there is
 * no such constant.
 */
export function removeConstant(source: string, name: string, file: ConstantFile): Result<string, ConstantRefusal> {
  const parsed = parsedRegion(source, file);
  if (!parsed.ok) {
    return parsed;
  }
  const { syntax, region } = parsed.value;
  const statement = constantStatements(syntax, file.host).find((candidate) => declaredNames(candidate).includes(name));
  if (statement === undefined) {
    return err('missing');
  }
  if (statement.declarationList.declarations.length !== 1) {
    return err('compound');
  }
  if (usesName(syntax, name, statement) || markupUses(source, region, name)) {
    return err('inUse');
  }
  const span = statementLines(syntax.text, statement.getStart(syntax, true), statement.getEnd());
  const next = spliced(source, region, { at: span.start, remove: span.end - span.start, text: '' });
  const check = parsedRegion(next, file);
  assert(check.ok, 'removeConstant: the edited file parses');
  assert(
    !constantStatements(check.value.syntax, file.host).some((candidate) => declaredNames(candidate).includes(name)),
    'removeConstant: the variable is gone',
  );
  return ok(next);
}

/**
 * `source` with its constants declared in `order` (every constant's name, once).
 * Each constant moves with its own text: the comments directly above it (no
 * blank line between) and a comment after it on its line. The constants trade
 * places, so the blank lines between them and every other statement stay where
 * they were. Refused, unchanged, when the file does not parse, a statement
 * declares several names, `order` is not exactly the file's constants, or a
 * declaration would come before a constant it reads at once (it would throw:
 * a `const` cannot be read before its declaration runs).
 */
export function reorderConstants(source: string, order: readonly string[], file: ConstantFile): Result<string, ConstantRefusal> {
  const parsed = parsedRegion(source, file);
  if (!parsed.ok) {
    return parsed;
  }
  const { syntax, region } = parsed.value;
  const statements = constantStatements(syntax, file.host);
  if (statements.some((statement) => statement.declarationList.declarations.length !== 1)) {
    return err('compound');
  }
  const names = statements.map((statement) => declaredNames(statement)[0] ?? '');
  if (order.length !== names.length || !order.every((name) => names.includes(name))) {
    return err('missing');
  }
  if (readsBeforeDeclared(syntax, statements, names, order)) {
    return err('dependency');
  }
  const code = syntax.text;
  const chunks = statements.map((statement) => chunkOf(code, statement, syntax));
  // Two constants on one line share it; there is no line of its own to move.
  if (chunks.some((chunk, index) => index > 0 && (chunks[index - 1]?.end ?? 0) >= chunk.start)) {
    return err('compound');
  }
  // Back to front, each slot takes the chunk of the constant now in its place.
  let next = code;
  for (let slot = chunks.length - 1; slot >= 0; slot--) {
    const target = chunks[slot];
    const moved = chunks[names.indexOf(order[slot] ?? '')];
    assert(target !== undefined, 'reorderConstants: every slot has a chunk');
    assert(moved !== undefined, 'reorderConstants: every name has a chunk');
    next = next.slice(0, target.start) + code.slice(moved.start, moved.end) + next.slice(target.end);
  }
  const result = region.kind === 'code' ? source.slice(0, region.start) + next + source.slice(region.end) : source;
  const check = parsedRegion(result, file);
  assert(check.ok, 'reorderConstants: the edited file parses');
  assert(
    constantStatements(check.value.syntax, file.host)
      .map((statement) => declaredNames(statement)[0])
      .every((name, index) => name === order[index]),
    'reorderConstants: the constants are declared in the order asked for',
  );
  return ok(result);
}

// A constant's own text: from the first comment of the block right above it to
// the end of its line, which holds any comment written after it.
function chunkOf(code: string, statement: ts.VariableStatement, syntax: ts.SourceFile): { readonly start: number; readonly end: number } {
  let start = statement.getStart(syntax, false);
  const comments = ts.getLeadingCommentRanges(code, statement.getFullStart()) ?? [];
  for (const comment of [...comments].reverse()) {
    const gap = code.slice(comment.end, start);
    const ownLine = code.slice(code.lastIndexOf('\n', comment.pos - 1) + 1, comment.pos).trim().length === 0;
    if (/\n[ \t]*\r?\n/.test(gap) || !ownLine) {
      break;
    }
    start = comment.pos;
  }
  const end = lineEnd(code, statement.getEnd());
  assert(start <= statement.getStart(syntax, false), 'chunkOf: a chunk starts at or before its statement');
  assert(end >= statement.getEnd(), 'chunkOf: a chunk ends at or after its statement');
  return { start, end };
}

// Whether, in the new order, a top-level statement would read a constant that
// is then declared after it. Code in functions runs later, so only what runs
// as the file loads counts: variable initializers and expression statements.
function readsBeforeDeclared(syntax: ts.SourceFile, statements: readonly ts.VariableStatement[], names: readonly string[], order: readonly string[]): boolean {
  // Each top-level statement's position after the move: a constant takes the slot of the one it replaces.
  const slotOf = new Map<ts.Statement, number>();
  const declaredAt = new Map<string, number>();
  const slots = statements.map((statement) => syntax.statements.indexOf(statement));
  statements.forEach((statement, index) => {
    const name = names[index] ?? '';
    const slot = slots[order.indexOf(name)];
    assert(slot !== undefined, 'readsBeforeDeclared: every constant has a slot');
    slotOf.set(statement, slot);
    declaredAt.set(name, slot);
  });
  return syntax.statements.some((statement, index) => {
    if (!ts.isVariableStatement(statement) && !ts.isExpressionStatement(statement)) {
      return false;
    }
    const position = slotOf.get(statement) ?? index;
    return readNames(statement).some((name) => (declaredAt.get(name) ?? -1) > position);
  });
}

// The names a statement reads as it runs, outside any function it defines.
function readNames(statement: ts.Statement): readonly string[] {
  const names: string[] = [];
  visitBounded(statement, (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      names.push(node.text);
    }
    return true;
  });
  return names;
}

// ---------------------------------------------------------------------------
// Regions and parsing
// ---------------------------------------------------------------------------

/** Where the code is: the whole module, a page's frontmatter, or nowhere yet (a page with no fence). */
type Region = { readonly kind: 'code'; readonly start: number; readonly end: number } | { readonly kind: 'absent' };

interface ParsedRegion {
  readonly region: Region;
  readonly syntax: ts.SourceFile;
}

function regionOf(source: string, host: ConstantHost): Result<Region, ConstantRefusal> {
  if (host === 'module') {
    return ok({ kind: 'code', start: 0, end: source.length });
  }
  const fence = readFence(source);
  switch (fence.kind) {
    case 'none':
      return ok({ kind: 'absent' });
    case 'unreadable':
      return err('fence');
    case 'fence':
      return ok({ kind: 'code', start: fence.codeStart, end: fence.codeEnd });
    default: {
      const exhaustive: never = fence;
      return exhaustive;
    }
  }
}

function parsedRegion(source: string, file: ConstantFile): Result<ParsedRegion, ConstantRefusal> {
  assert(source.length <= LIMITS.sourceBytesMax, 'constantFields: the source is bounded');
  const region = regionOf(source, file.host);
  if (!region.ok) {
    return region;
  }
  const code = region.value.kind === 'code' ? source.slice(region.value.start, region.value.end) : '';
  const syntax = ts.createSourceFile(`constants.${file.script}`, code, ts.ScriptTarget.Latest, true, scriptKindOf(file.script));
  // The parser's own diagnostics are not public API; the editor reads them the same way elsewhere (astroMapSyntax.ts).
  const diagnostics: unknown = Reflect.get(syntax, 'parseDiagnostics');
  if (!Array.isArray(diagnostics)) {
    return err('syntax');
  }
  if (diagnostics.length > 0) {
    return err('syntax');
  }
  return ok({ region: region.value, syntax });
}

function scriptKindOf(script: ConstantScript): ts.ScriptKind {
  switch (script) {
    case 'ts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'js':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default: {
      const exhaustive: never = script;
      return exhaustive;
    }
  }
}

interface Splice {
  /** Offset in the region's code. */
  readonly at: number;
  readonly remove: number;
  readonly text: string;
}

function spliced(source: string, region: Region, splice: Splice): string {
  assert(region.kind === 'code', 'constantFields: a splice lands in code');
  const at = region.start + splice.at;
  assert(at + splice.remove <= region.end, 'constantFields: a splice stays inside the code');
  return source.slice(0, at) + splice.text + source.slice(at + splice.remove);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The statements that hold the file's variables: a module's exported `const`s, a page's top-level `const`s. */
function constantStatements(syntax: ts.SourceFile, host: ConstantHost): readonly ts.VariableStatement[] {
  return syntax.statements.filter(ts.isVariableStatement).filter((statement) => {
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return false;
    }
    return host === 'page' || isExported(statement);
  });
}

function isExported(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function declaredNames(statement: ts.VariableStatement): readonly string[] {
  return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
}

// Destructured names nest as deep as the pattern is written; the tree bound caps it.
function bindingNames(name: ts.BindingName): readonly string[] {
  const names: string[] = [];
  const pending: ts.BindingName[] = [name];
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited++) {
    const next = pending.pop();
    if (next === undefined) {
      return names;
    }
    if (ts.isIdentifier(next)) {
      names.push(next.text);
    } else {
      for (const element of next.elements) {
        if (ts.isBindingElement(element)) {
          pending.push(element.name);
        }
      }
    }
  }
  assert(false, 'bindingNames: a pattern holds fewer names than the tree bound');
}

/** Every name the top level binds: variables, functions, classes, types and imports; a page also has `Astro`. */
function takenNames(syntax: ts.SourceFile, host: ConstantHost): readonly string[] {
  const names = new Set<string>(host === 'page' ? ['Astro'] : []);
  for (const statement of syntax.statements) {
    for (const name of statementNames(statement)) {
      names.add(name);
    }
  }
  return [...names];
}

function statementNames(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement)) {
    return declaredNames(statement);
  }
  if (ts.isImportDeclaration(statement)) {
    return importNames(statement);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return [statement.name.text];
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  }
  return [];
}

function importNames(statement: ts.ImportDeclaration): readonly string[] {
  const clause = statement.importClause;
  if (clause === undefined) {
    return [];
  }
  const names = clause.name === undefined ? [] : [clause.name.text];
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return names;
  }
  if (ts.isNamespaceImport(bindings)) {
    return [...names, bindings.name.text];
  }
  return [...names, ...bindings.elements.map((element) => element.name.text)];
}

function summaryOf(declaration: ts.VariableDeclaration, syntax: ts.SourceFile): readonly ConstantSummary[] {
  if (!ts.isIdentifier(declaration.name)) {
    return [];
  }
  const initializer = declaration.initializer;
  if (initializer === undefined) {
    return [];
  }
  const source = initializer.getText(syntax).replace(/\s+/g, ' ');
  const preview = source.length > CMS_CONSTANT_LIMITS.previewCharsMax ? source.slice(0, CMS_CONSTANT_LIMITS.previewCharsMax) + '…' : source;
  return [{ name: declaration.name.text, type: literalType(initializer), preview }];
}

function literalType(expression: ts.Expression): ConstantSummary['type'] {
  const value = unwrapped(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return 'string';
  }
  if (ts.isNumericLiteral(value)) {
    return 'number';
  }
  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.MinusToken) {
      return ts.isNumericLiteral(value.operand) ? 'number' : 'code';
    }
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (ts.isArrayLiteralExpression(value)) {
    return 'array';
  }
  if (ts.isObjectLiteralExpression(value)) {
    return 'object';
  }
  return 'code';
}

// `x as const`, `x satisfies T` and `(x)` are the value `x` written with a note.
function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (let depth = 0; depth < LIMITS.treeDepthMax; depth++) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
  return current;
}

function isAsConst(expression: ts.Expression): boolean {
  return (
    ts.isAsExpression(expression) &&
    ts.isTypeReferenceNode(expression.type) &&
    ts.isIdentifier(expression.type.typeName) &&
    expression.type.typeName.text === 'const'
  );
}

/** Whether `name` is used in the code anywhere but its own declaration. */
function usesName(syntax: ts.SourceFile, name: string, declaration: ts.VariableStatement): boolean {
  let used = false;
  visitBounded(syntax, (node) => {
    if (node === declaration) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === name) {
        used = true;
      }
    }
    return !used;
  });
  return used;
}

// A page's markup reads its frontmatter's names in `{…}` expressions. A word
// match is conservative: a name that only appears in text refuses the removal,
// which the person can still make in code; it never removes a name in use.
function markupUses(source: string, region: Region, name: string): boolean {
  if (region.kind === 'absent') {
    return false;
  }
  const markup = source.slice(0, region.start) + ' ' + source.slice(region.end);
  return new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`).test(markup);
}

// Children first-to-last; `visit` answers whether to go into a node. The tree bound caps the walk.
function visitBounded(root: ts.Node, visit: (node: ts.Node) => boolean): void {
  const pending: ts.Node[] = [root];
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited++) {
    const node = pending.pop();
    if (node === undefined) {
      return;
    }
    if (visit(node)) {
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => {
        children.push(child);
      });
      pending.push(...children.reverse());
    }
  }
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

function styleOfRegion(syntax: ts.SourceFile, file: ConstantFile): ConstantStyle {
  const statements = constantStatements(syntax, file.host);
  const declarations = statements.flatMap((statement) => statement.declarationList.declarations);
  const initializers = declarations.flatMap((declaration) => (declaration.initializer === undefined ? [] : [declaration.initializer]));
  const code = syntax.text;
  const style: ConstantStyle = {
    host: file.host,
    script: file.script,
    quote: quoteOf(initializers.length > 0 ? initializers : [syntax], syntax),
    semicolons: semicolonsOf(statements.length > 0 ? statements : syntax.statements, syntax),
    asConst: majority(initializers, isAsConst),
    typeAnnotations: majority(declarations, (declaration) => declaration.type !== undefined),
    descriptionComments: majority(statements, (statement) => hasDescriptionComment(statement, code)),
    trailingCommas: trailingCommasOf(initializers.length > 0 ? initializers : [syntax], syntax),
    blankLineBetween: blankLinesBetween(statements, syntax),
    indent: indentUnitOf(code.replace(/\r\n/g, '\n')),
    newline: code.includes('\r\n') ? 'crlf' : 'lf',
    naming: namingOf(
      declarations.flatMap((declaration) => bindingNames(declaration.name)),
      file.host,
    ),
  };
  assert(style.indent.length > 0, 'styleOfConstants: an indent step is never empty');
  assert(style.indent.trim().length === 0, 'styleOfConstants: an indent step is only whitespace');
  return style;
}

function majority<T>(items: readonly T[], holds: (item: T) => boolean): boolean {
  const holding = items.filter(holds).length;
  return holding * 2 > items.length;
}

// The quote most of the file's strings use; double quotes when it has none to go by.
function quoteOf(roots: readonly ts.Node[], syntax: ts.SourceFile): ConstantStyle['quote'] {
  let single = 0;
  let double = 0;
  for (const root of roots) {
    visitBounded(root, (node) => {
      if (ts.isStringLiteral(node)) {
        if (node.getText(syntax).startsWith("'")) {
          single += 1;
        } else {
          double += 1;
        }
      }
      return true;
    });
  }
  return single > double ? 'single' : 'double';
}

// Semicolons unless most statements go without; an empty file gets them.
function semicolonsOf(statements: readonly ts.Statement[], syntax: ts.SourceFile): boolean {
  if (statements.length === 0) {
    return true;
  }
  const without = statements.filter((statement) => !statement.getText(syntax).endsWith(';')).length;
  return without * 2 <= statements.length;
}

function hasDescriptionComment(statement: ts.Statement, code: string): boolean {
  const comments = ts.getLeadingCommentRanges(code, statement.getFullStart()) ?? [];
  return comments.some((comment) => code.startsWith('/**', comment.pos));
}

// Whether lists and objects written across lines end with a comma; Prettier's default (yes) without one to go by.
function trailingCommasOf(roots: readonly ts.Node[], syntax: ts.SourceFile): boolean {
  let withComma = 0;
  let withoutComma = 0;
  for (const root of roots) {
    visitBounded(root, (node) => {
      if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
        const items = ts.isArrayLiteralExpression(node) ? node.elements : node.properties;
        if (items.length > 0 && node.getText(syntax).includes('\n')) {
          if (items.hasTrailingComma) {
            withComma += 1;
          } else {
            withoutComma += 1;
          }
        }
      }
      return true;
    });
  }
  return withoutComma <= withComma;
}

// A blank line between most neighbouring constants; with fewer than two, none.
function blankLinesBetween(statements: readonly ts.VariableStatement[], syntax: ts.SourceFile): boolean {
  const gaps = statements.slice(1).map((statement, index) => {
    const previous = statements[index];
    assert(previous !== undefined, 'blankLinesBetween: each later statement has one before it');
    return /\n[ \t]*\r?\n/.test(syntax.text.slice(previous.getEnd(), statement.getStart(syntax, true)));
  });
  return majority(gaps, (blank) => blank);
}

function namingOf(names: readonly string[], host: ConstantHost): ConstantNaming {
  if (names.length === 0) {
    return host === 'module' ? 'screamingSnake' : 'camel';
  }
  if (names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))) {
    return 'screamingSnake';
  }
  if (names.every((name) => /^[a-z][A-Za-z0-9]*$/.test(name))) {
    return 'camel';
  }
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// The new statement goes on its own line after the last constant (and anything
// after it on that line, such as a comment), with the file's blank line between
// constants. Without a constant to follow, it ends the code, a blank line below
// whatever is there.
function insertion(syntax: ts.SourceFile, statement: string, style: ConstantStyle): Splice {
  const newline = style.newline === 'crlf' ? '\r\n' : '\n';
  const code = syntax.text;
  const last = constantStatements(syntax, style.host).at(-1);
  if (last !== undefined) {
    const at = lineEnd(code, last.getEnd());
    return { at, remove: 0, text: newline + (style.blankLineBetween ? newline : '') + statement };
  }
  if (code.trim().length === 0) {
    // An empty module or frontmatter holds only the new line; any blank lines it had stay below.
    return { at: 0, remove: 0, text: statement + newline };
  }
  const endsWithBreak = code.endsWith('\n');
  return { at: code.length, remove: 0, text: (endsWithBreak ? newline : newline + newline) + statement + (endsWithBreak ? newline : '') };
}

// The offset of the line break that ends the line holding `offset`, before a `\r`.
function lineEnd(code: string, offset: number): number {
  const lineFeed = code.indexOf('\n', offset);
  if (lineFeed === -1) {
    return code.length;
  }
  return code.charAt(lineFeed - 1) === '\r' ? lineFeed - 1 : lineFeed;
}

// The whole lines a statement fills, from its line's start (when only indent is
// before it) through its line break, plus one neighbouring blank line when it
// stood between two, so removing it leaves the spacing the file had.
function statementLines(code: string, start: number, end: number): { readonly start: number; readonly end: number } {
  const lineStart = code.lastIndexOf('\n', start - 1) + 1;
  const from = code.slice(lineStart, start).trim().length === 0 ? lineStart : start;
  const lineFeed = code.indexOf('\n', end);
  const to = lineFeed === -1 ? code.length : lineFeed + 1;
  const blankBefore = /(?:^|\n)[ \t]*\r?\n$/.test(code.slice(0, from));
  const blankAfter = /^[ \t]*\r?\n/.exec(code.slice(to));
  if (blankBefore && blankAfter !== null) {
    return { start: from, end: to + blankAfter[0].length };
  }
  // The last statement of the code takes the blank line above it, which only separated it.
  if (blankBefore && to === code.length) {
    const blankStart = code.slice(0, from).search(/\r?\n[ \t]*\r?\n$/);
    if (blankStart !== -1) {
      return { start: code.indexOf('\n', blankStart) + 1, end: to };
    }
  }
  assert(from <= start, 'statementLines: the span starts at or before the statement');
  assert(to >= end, 'statementLines: the span ends at or after the statement');
  return { start: from, end: to };
}
