// The expressions a role without a code permission may write: data, and the shaping of data that the editor's own
// controls produce (literals, bindings, loop filters and sorts, conditions, collection queries). It is an allowlist
// over the syntax tree, never a list of forbidden words: a name must be one the file declares or a harmless global,
// a call must be a known data method, and anything this does not recognise is code. The preview server runs the site's
// code with its whole environment, so "unrecognised" must mean refused (codeGuard.ts).
import ts from 'typescript';
import { assert } from '../../../vendor/stacki/shared/core/assert';

export interface CodeScope {
  /** Runtime names the code may read: the file's own bindings and the enclosing callbacks' parameters. */
  readonly names: ReadonlySet<string>;
  /** Local names of Astro's own data functions (`getCollection`), which may be called. */
  readonly queries: ReadonlySet<string>;
  /** Texts of expressions the file already held, which may be read through a new data method. */
  readonly trusted: ReadonlySet<string>;
}

const DEPTH_MAX = 200;

const GLOBALS: ReadonlySet<string> = new Set(['undefined', 'NaN', 'Infinity']);
/**
 * Globals usable only as `Name.member`, so the object itself is never handed around, with the members each may
 * read; undefined is every member. `Object` and the rest also hold ways into the language's machinery.
 */
const NAMESPACES: ReadonlyMap<string, ReadonlySet<string> | undefined> = new Map([
  ['Math', undefined],
  ['Intl', undefined],
  ['JSON', new Set(['parse', 'stringify'])],
  ['Object', new Set(['keys', 'values', 'entries'])],
  ['Array', new Set(['from', 'isArray'])],
  ['Number', new Set(['isInteger', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'EPSILON'])],
  ['String', new Set(['fromCharCode', 'fromCodePoint'])],
  ['Date', new Set(['now', 'parse', 'UTC'])],
]);
const CALLABLE: ReadonlySet<string> = new Set([
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isNaN',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
]);
const CONSTRUCTORS: ReadonlySet<string> = new Set(['Date', 'URL', 'URLSearchParams', 'Set', 'Map']);
const ASTRO_MEMBERS: ReadonlySet<string> = new Set(['props', 'url', 'params', 'site', 'currentLocale', 'preferredLocale', 'routePattern', 'slots']);
/** Members that reach the language's own machinery from any value. */
const DENIED_MEMBERS: ReadonlySet<string> = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);
// Data methods that take no function: their arguments are values.
const VALUE_METHODS: ReadonlySet<string> = new Set(
  (
    'abs at ceil charAt concat endsWith entries floor format formatRange getDate getDay getFullYear getHours getMinutes ' +
    'getMonth getSeconds getTime has includes indexOf isArray join keys lastIndexOf localeCompare match matchAll max min normalize ' +
    'padEnd padStart random repeat reverse round slice split startsWith substring test toDateString toFixed toISOString ' +
    'toLocaleDateString toLocaleLowerCase toLocaleString toLocaleTimeString toLocaleUpperCase toLowerCase toPrecision toReversed ' +
    'toString toTimeString toUpperCase trim trimEnd trimStart toSpliced valueOf values flat'
  ).split(' '),
);
// Methods that call what they are given: the function must be written here, as an arrow.
const CALLBACK_METHODS: ReadonlyMap<string, number> = new Map(
  ['every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'map', 'some', 'sort', 'toSorted', 'reduce'].map((name) => [name, 0]),
);
const CONVERTERS: ReadonlySet<string> = new Set(['Boolean', 'Number', 'String']);
/**
 * Property names that are run when something calls a method, converts or awaits a value. A new object may hold only
 * data under them: any other value could be a function, which the call would then run.
 */
const CALLED_NAMES: ReadonlySet<string> = new Set([
  ...VALUE_METHODS,
  ...CALLBACK_METHODS.keys(),
  ...['fetch', 'from', 'parse', 'stringify', 'replace', 'replaceAll', 'then', 'toJSON', 'toString', 'valueOf'],
]);

// A page is checked after every keystroke, and nearly all of its expressions are the ones just read.
const PARSED_MAX = 5_000;
const parsed = new Map<string, ts.Expression | undefined>();

/** Parses one expression, or undefined when `code` is not exactly one. */
export function parseExpression(code: string): ts.Expression | undefined {
  if (parsed.has(code)) {
    return parsed.get(code);
  }
  const expression = parseFresh(code);
  if (parsed.size >= PARSED_MAX) {
    const oldest = parsed.keys().next();
    if (!oldest.done) {
      parsed.delete(oldest.value);
    }
  }
  parsed.set(code, expression);
  return expression;
}

function parseFresh(code: string): ts.Expression | undefined {
  const file = parseTypeScript(`(\n${code}\n);`);
  if (syntaxErrors(file) > 0) {
    return undefined;
  }
  const [statement, extra] = file.statements;
  if (extra !== undefined || statement === undefined || !ts.isExpressionStatement(statement)) {
    return undefined;
  }
  return ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
}

export function parseTypeScript(code: string): ts.SourceFile {
  return ts.createSourceFile('code.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** How many syntax errors the TypeScript parser found. The list is on the tree it built, outside its public type. */
export function syntaxErrors(file: ts.SourceFile): number {
  const found: unknown = Reflect.get(file, 'parseDiagnostics');
  assert(Array.isArray(found), 'The TypeScript parser lists its syntax errors on the tree');
  return found.length;
}

/** The scope inside something that binds `bound`: those names are now its own values, never Astro's functions. */
export function innerScope(scope: CodeScope, bound: Iterable<string>): CodeScope {
  const names = new Set(scope.names);
  const queries = new Set(scope.queries);
  for (const name of bound) {
    names.add(name);
    queries.delete(name);
  }
  return { names, queries, trusted: scope.trusted };
}

/** Whether `node` only reads and shapes data. */
export function safeExpression(node: ts.Expression, scope: CodeScope, depth = 0): boolean {
  if (depth > DEPTH_MAX) {
    return false;
  }
  const next = (child: ts.Expression) => safeExpression(child, scope, depth + 1);
  if (isLiteral(node)) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return scope.names.has(node.text) || GLOBALS.has(node.text);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeOfExpression(node) ||
    ts.isVoidExpression(node)
  ) {
    return next(node.expression);
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((span) => next(span.expression));
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return safeMember(node, scope, depth);
  }
  if (ts.isCallExpression(node)) {
    return safeCall(node, scope, depth);
  }
  return safeCompound(node, scope, depth);
}

function safeCompound(node: ts.Expression, scope: CodeScope, depth: number): boolean {
  const next = (child: ts.Expression) => safeExpression(child, scope, depth + 1);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => ts.isOmittedExpression(element) || next(ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => safeProperty(property, scope, depth));
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    const assigns = operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
    return !assigns && operator !== ts.SyntaxKind.CommaToken && next(node.left) && next(node.right);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const writes = node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
    return !writes && next(node.operand);
  }
  if (ts.isConditionalExpression(node)) {
    return next(node.condition) && next(node.whenTrue) && next(node.whenFalse);
  }
  if (ts.isArrowFunction(node)) {
    return safeArrow(node, scope, depth);
  }
  if (ts.isNewExpression(node)) {
    return safeConstruction(node, scope, depth);
  }
  if (ts.isAwaitExpression(node)) {
    // Awaiting runs nothing by itself: what is awaited is judged like any other expression.
    return next(node.expression);
  }
  return false;
}

function isLiteral(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

// The name a member access reads, when it is written out: `a.b`, `a['b']`, `a[0]`.
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  const key = node.argumentExpression;
  return ts.isStringLiteral(key) || ts.isNumericLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
}

function safeMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, scope: CodeScope, depth: number): boolean {
  const name = memberName(node);
  if (name === undefined || DENIED_MEMBERS.has(name)) {
    return false;
  }
  const object = node.expression;
  if (ts.isIdentifier(object) && !scope.names.has(object.text)) {
    if (object.text === 'Astro') {
      return ASTRO_MEMBERS.has(name);
    }
    if (NAMESPACES.has(object.text)) {
      return NAMESPACES.get(object.text)?.has(name) ?? true;
    }
  }
  return safeExpression(object, scope, depth + 1);
}

function safeCall(node: ts.CallExpression, scope: CodeScope, depth: number): boolean {
  const callee = node.expression;
  const next = (child: ts.Expression) => safeExpression(child, scope, depth + 1);
  const values = node.arguments.map((argument) => (ts.isSpreadElement(argument) ? argument.expression : argument));
  if (ts.isIdentifier(callee)) {
    if (scope.queries.has(callee.text)) {
      return values.every(next);
    }
    return CALLABLE.has(callee.text) && !scope.names.has(callee.text) && values.every(next);
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const method = callee.name.text;
  if (method === 'fetch') {
    return sanityQuery(callee.expression, values, scope);
  }
  // `X.slice(0, 3)` over a source the file already read is a new shape of old data, whatever built it.
  const receiver = scope.trusted.has(callee.expression.getText()) || safeMember(callee, scope, depth);
  if (!receiver) {
    return false;
  }
  if (method === 'from' || method === 'parse' || method === 'stringify') {
    return plainArguments(values, scope, depth, method === 'from' ? 1 : -1);
  }
  if (method === 'replace' || method === 'replaceAll') {
    const written = values[1];
    return values.every(next) && written !== undefined && (ts.isStringLiteralLike(written) || ts.isTemplateExpression(written) || ts.isArrowFunction(written));
  }
  const position = CALLBACK_METHODS.get(method);
  if (position !== undefined) {
    const callback = values[position];
    if (method === 'map' && pickedByPosition(callee.expression, values)) {
      return true;
    }
    const converter = callback !== undefined && ts.isIdentifier(callback) && CONVERTERS.has(callback.text) && !scope.names.has(callback.text);
    const written = callback === undefined || ts.isArrowFunction(callback) || converter;
    return written && values.every((value, index) => (index === position && ts.isIdentifier(value) ? true : next(value)));
  }
  return VALUE_METHODS.has(method) && values.every(next);
}

// The picked items of a list, as the loop settings write them: `[0, 2].map((index) => items[index])`. This one
// computed read is safe because every key is a number written right there.
function pickedByPosition(receiver: ts.Expression, values: readonly ts.Expression[]): boolean {
  const [callback, extra] = values;
  if (extra !== undefined || callback === undefined || !ts.isArrowFunction(callback) || !ts.isArrayLiteralExpression(receiver)) {
    return false;
  }
  const [parameter, second] = callback.parameters;
  if (second !== undefined || parameter === undefined || !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined) {
    return false;
  }
  const body = callback.body;
  if (ts.isBlock(body) || !ts.isElementAccessExpression(body) || !ts.isIdentifier(body.expression)) {
    return false;
  }
  const key = body.argumentExpression;
  const counted = ts.isIdentifier(key) && key.text === parameter.name.text && body.expression.text !== key.text;
  return counted && receiver.elements.every((element) => ts.isNumericLiteral(element));
}

// A Sanity loop's query, as the loop settings write it: one written-out GROQ query, asked of a client the page imports.
function sanityQuery(client: ts.Expression, values: readonly ts.Expression[], scope: CodeScope): boolean {
  const [query, extra] = values;
  const named = ts.isIdentifier(client) && scope.names.has(client.text) && /(?:client|sanity)$/i.test(client.text);
  return named && extra === undefined && query !== undefined && ts.isStringLiteralLike(query) && /^\s*(?:\*|\(|count\()/.test(query.text);
}

// `Array.from(items, (item) => …)` and `JSON.stringify(value, null, 2)`: no argument may be a function from elsewhere.
function plainArguments(values: readonly ts.Expression[], scope: CodeScope, depth: number, callbackAt: number): boolean {
  return values.every((value, index) => {
    if (index === 0) {
      return safeExpression(value, scope, depth + 1);
    }
    if (index === callbackAt) {
      return ts.isArrowFunction(value) && safeExpression(value, scope, depth + 1);
    }
    const data = value.kind === ts.SyntaxKind.NullKeyword || ts.isNumericLiteral(value) || ts.isStringLiteral(value);
    return data || (ts.isArrayLiteralExpression(value) && safeExpression(value, scope, depth + 1));
  });
}

function safeConstruction(node: ts.NewExpression, scope: CodeScope, depth: number): boolean {
  const target = node.expression;
  const known = ts.isIdentifier(target)
    ? CONSTRUCTORS.has(target.text) && !scope.names.has(target.text)
    : ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Intl';
  return known && (node.arguments ?? []).every((argument) => safeExpression(argument, scope, depth + 1));
}

function safeProperty(property: ts.ObjectLiteralElementLike, scope: CodeScope, depth: number): boolean {
  if (ts.isSpreadAssignment(property)) {
    return safeExpression(property.expression, scope, depth + 1);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    const plain = property.objectAssignmentInitializer === undefined && !CALLED_NAMES.has(property.name.text);
    return plain && safeExpression(property.name, scope, depth + 1);
  }
  if (!ts.isPropertyAssignment(property)) {
    return false;
  }
  const name = property.name;
  if (ts.isComputedPropertyName(name)) {
    return false;
  }
  const written = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
  if (written === undefined || written === '__proto__') {
    return false;
  }
  if (CALLED_NAMES.has(written) && !writtenData(property.initializer, depth + 1)) {
    return false;
  }
  return safeExpression(property.initializer, scope, depth + 1);
}

// A value that is data as written: no name, call or member that could stand for a function.
function writtenData(node: ts.Expression, depth: number): boolean {
  if (depth > DEPTH_MAX) {
    return false;
  }
  if (isLiteral(node)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => !ts.isSpreadElement(element) && writtenData(element, depth + 1));
  }
  return (
    ts.isObjectLiteralExpression(node) && node.properties.every((property) => ts.isPropertyAssignment(property) && writtenData(property.initializer, depth + 1))
  );
}

/** The names a binding pattern introduces, or undefined when the pattern runs or reaches something it may not. */
export function bindingNames(name: ts.BindingName, scope: CodeScope, depth = 0): readonly string[] | undefined {
  if (depth > DEPTH_MAX) {
    return undefined;
  }
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  const found: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    const key = element.propertyName;
    if (key !== undefined && (ts.isComputedPropertyName(key) || ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && DENIED_MEMBERS.has(key.text)))) {
      return undefined;
    }
    if (key === undefined && ts.isIdentifier(element.name) && DENIED_MEMBERS.has(element.name.text)) {
      return undefined;
    }
    const inner = bindingNames(element.name, scope, depth + 1);
    const fallback = element.initializer;
    if (inner === undefined || (fallback !== undefined && !safeExpression(fallback, scope, depth + 1))) {
      return undefined;
    }
    found.push(...inner);
  }
  return found;
}

function safeArrow(node: ts.ArrowFunction, scope: CodeScope, depth: number): boolean {
  const names = new Set<string>();
  for (const parameter of node.parameters) {
    const bound = bindingNames(parameter.name, scope, depth);
    const fallback = parameter.initializer;
    if (bound === undefined || (fallback !== undefined && !safeExpression(fallback, scope, depth + 1))) {
      return false;
    }
    for (const name of bound) {
      names.add(name);
    }
  }
  const inner = innerScope(scope, names);
  return ts.isBlock(node.body) ? safeBlock(node.body.statements, inner, depth + 1) : safeExpression(node.body, inner, depth + 1);
}

// A callback body: constants, conditions and returns.
function safeBlock(statements: ts.NodeArray<ts.Statement>, scope: CodeScope, depth: number): boolean {
  if (depth > DEPTH_MAX) {
    return false;
  }
  let inner = scope;
  return statements.every((statement) => {
    if (ts.isReturnStatement(statement)) {
      return statement.expression === undefined || safeExpression(statement.expression, inner, depth + 1);
    }
    if (ts.isIfStatement(statement)) {
      const branches = [statement.thenStatement, ...(statement.elseStatement === undefined ? [] : [statement.elseStatement])];
      const nodes = ts.factory.createNodeArray(branches.flatMap((branch) => (ts.isBlock(branch) ? [...branch.statements] : [branch])));
      return safeExpression(statement.expression, inner, depth + 1) && safeBlock(nodes, inner, depth + 1);
    }
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) {
      return false;
    }
    return statement.declarationList.declarations.every((declaration) => {
      const bound = bindingNames(declaration.name, inner, depth + 1);
      const value = declaration.initializer;
      if (bound === undefined || (value !== undefined && !safeExpression(value, inner, depth + 1))) {
        return false;
      }
      inner = innerScope(inner, bound);
      return true;
    });
  });
}
