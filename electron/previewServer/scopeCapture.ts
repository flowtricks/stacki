// What each file's frontmatter computed on its last render, kept for the
// binding picker (preview/markerConfig.ts, SCOPE_SOURCE, reads it back).
//
// A loop's list can come from anywhere: `await fetch(url).then((r) => r.json())`,
// a JSON import, `Astro.glob`, a CMS client's query, a literal. Running any of
// those again to see what it holds would repeat the page's network reads with
// arguments the editor would have to guess. The render has already run them,
// with the right arguments, for the canvas. So the marked copy of each file
// (previewMarkers.ts) ends its frontmatter with one statement that files the
// file's own top-level bindings under its path: an object of getters, so the
// statement reads nothing and calls nothing while the page renders. A value is
// only read, and then sampled, when the editor asks for it.
//
// The record lives in the dev server's memory, bounded by a file count, and
// one render's record replaces the last. Nothing is written anywhere, nothing
// is fetched, and the project's own build never sees the statement: only the
// in-memory marked module carries it.
//
// It runs inside the project's dev server, a plain Node process, so like the
// marker module it requires only what is unpacked beside the archive.
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { PREVIEW_SCOPE_LIMITS, SCOPE_STORE_KEY } from '../../shared/page/previewScope';

export const SCOPE_CAPTURE_LIMITS = {
  // The record's own bound on names (shared/page/previewScope.ts).
  bindingsMax: PREVIEW_SCOPE_LIMITS.namesMax,
  // A frontmatter longer than this is not parsed for its bindings.
  frontmatterCharsMax: 200_000,
  // Destructuring patterns nest; deeper than this is not a page's frontmatter.
  patternDepthMax: 16,
} as const;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Modules whose imports are markup or styles, never data a loop goes through.
const NON_DATA_MODULE = /\.(?:astro|css|scss|sass|less|styl|stylus|pcss|postcss)(?:\?.*)?$/i;
// The local the capture statement holds the record in: one no page names.
const STORE_LOCAL = '__stackiScope';

/**
 * The names `frontmatter` binds at its top level and that hold values: its
 * `const`/`let`/`var` declarations (destructured names included) and its value
 * imports. Type-only names, ambient declarations, functions and classes are
 * left out: a type has no value to read, and code is not data.
 */
export function frontmatterBindings(frontmatter: string): readonly string[] {
  if (SCOPE_CAPTURE_LIMITS.frontmatterCharsMax < frontmatter.length) {
    return [];
  }
  const file = parseFrontmatter(frontmatter);
  if (file === undefined) {
    return [];
  }
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (SCOPE_CAPTURE_LIMITS.bindingsMax <= names.size) {
      break;
    }
    if (ts.isImportDeclaration(statement)) {
      importBindings(statement, names);
    } else if (ts.isVariableStatement(statement)) {
      variableBindings(statement, names);
    }
  }
  const bindings = [...names].filter((name) => IDENTIFIER.test(name) && name !== STORE_LOCAL).slice(0, SCOPE_CAPTURE_LIMITS.bindingsMax);
  assert(bindings.length <= SCOPE_CAPTURE_LIMITS.bindingsMax, 'Captured bindings are bounded');
  return bindings;
}

/**
 * The statement that files `names` under `file` when the frontmatter reaches
 * its end. One line, opened with `;` so a last statement written without one
 * cannot run into it, and wrapped in a block so its one local stays its own.
 */
export function scopeCaptureStatement(file: string, names: readonly string[]): string {
  assert(names.length > 0, 'A capture names at least one binding');
  assert(names.length <= SCOPE_CAPTURE_LIMITS.bindingsMax, 'A capture names a bounded number of bindings');
  for (const name of names) {
    assert(IDENTIFIER.test(name), 'A captured binding is an identifier');
    assert(name !== STORE_LOCAL, 'A captured binding is not the capture’s own local');
  }
  const key = JSON.stringify(SCOPE_STORE_KEY);
  const target = JSON.stringify(file);
  const getters = names.map((name) => `get ${name}(){return ${name}}`).join(',');
  // Delete before set: a Map iterates in insertion order, so the file rendered
  // longest ago is the first key, and that is the one dropped past the bound.
  return (
    `;{const ${STORE_LOCAL}=globalThis[Symbol.for(${key})]||(globalThis[Symbol.for(${key})]=new Map());` +
    `${STORE_LOCAL}.delete(${target});${STORE_LOCAL}.set(${target},{at:Date.now(),values:{${getters}}});` +
    `if(${STORE_LOCAL}.size>${PREVIEW_SCOPE_LIMITS.filesMax}){${STORE_LOCAL}.delete(${STORE_LOCAL}.keys().next().value)}}`
  );
}

/**
 * `marked` (a marked .astro module, which always opens with its frontmatter
 * fence) with the capture statement as the frontmatter's last line, or
 * `marked` unchanged when its frontmatter binds nothing.
 */
export function withScopeCapture(marked: string, file: string): string {
  const fence = /\r?\n---\r?\n/.exec(marked.slice(3));
  if (!marked.startsWith('---') || fence === null) {
    return marked;
  }
  const close = 3 + fence.index;
  const names = frontmatterBindings(marked.slice(3, close));
  if (names.length === 0) {
    return marked;
  }
  const statement = scopeCaptureStatement(file, names);
  const captured = `${marked.slice(0, close)}\n${statement}${marked.slice(close)}`;
  assert(captured.startsWith('---'), 'The capture leaves the frontmatter fence first');
  assert(captured.length === marked.length + statement.length + 1, 'The capture only adds its own line');
  return captured;
}

function parseFrontmatter(frontmatter: string): ts.SourceFile | undefined {
  // Parser recursion is a resource failure caused by project source. Only
  // that library call is caught; our own assertions must remain loud.
  try {
    return ts.createSourceFile('frontmatter.ts', frontmatter, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

function importBindings(statement: ts.ImportDeclaration, names: Set<string>): void {
  const clause = statement.importClause;
  const from = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
  if (clause === undefined || clause.isTypeOnly || NON_DATA_MODULE.test(from)) {
    return;
  }
  if (clause.name !== undefined) {
    names.add(clause.name.text);
  }
  const named = clause.namedBindings;
  if (named === undefined) {
    return;
  }
  if (ts.isNamespaceImport(named)) {
    names.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    if (!element.isTypeOnly) {
      names.add(element.name.text);
    }
  }
}

function variableBindings(statement: ts.VariableStatement, names: Set<string>): void {
  const ambient = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
  if (ambient) {
    return;
  }
  for (const declaration of statement.declarationList.declarations) {
    bindingNames(declaration.name, names, 0);
  }
}

// Every name a binding pattern introduces: `{ data: { items }, ...rest }`
// binds `items` and `rest`.
function bindingNames(name: ts.BindingName, names: Set<string>, depth: number): void {
  assert(depth <= SCOPE_CAPTURE_LIMITS.patternDepthMax, 'Binding patterns nest within their bound');
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      if (depth < SCOPE_CAPTURE_LIMITS.patternDepthMax) {
        bindingNames(element.name, names, depth + 1);
      }
    }
  }
}
