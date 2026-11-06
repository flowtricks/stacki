// Which name means what in a piece of JavaScript: its scopes, the bindings each
// holds, and every read with the scope it was read from. loopSyntax.ts keeps the
// shapes a query is made of; a rename needs the opposite, the exact tokens a name
// is spelled with, so an inner `(items) =>` is told apart from the `items` around
// it and `{ items: 1 }`, `x.items`, a string and a comment are not names at all.
//
// Lezer parses here for the reasons it does there: it is already in the renderer
// for the code editors, it reads TypeScript, and it never throws. The TypeScript
// compiler lives in the main process and ts-morph is not a dependency, while this
// runs on every commit of a field, in the renderer and in Studio. It sits in
// shared/ because a prop's rename plans here too, in main and in Studio's server:
// the process that holds the file and its parser (propertyRename.ts).

import { parser } from '@lezer/javascript';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';

const frontmatterParser = parser.configure({ dialect: 'ts' });
const templateParser = parser.configure({ dialect: 'ts jsx' });

// Past this the code is reported as unreadable, which refuses a rename rather
// than walking for long; a page's frontmatter is far smaller in practice.
export const JS_SCOPE_LIMITS = { sourceCharsMax: 200_000, ancestorsMax: 256 } as const;

export interface JsScope {
  readonly from: number;
  readonly to: number;
  readonly parent: JsScope | undefined;
  /** Names bound here. Written only while the scope is being read. */
  readonly names: Set<string>;
  /** Whether a `var` declared inside lands here. */
  readonly hoists: boolean;
}

export type JsDefinitionForm =
  /** The name alone is the binding: `const x`, `{ a: x }`, `import x from`. */
  | 'plain'
  /** `{ x }` in a pattern: the key is the name, so a new name keeps the key. */
  | 'shorthand'
  /** `import { x }`: the export is the name, so a new name keeps the export. */
  | 'import-member';

export interface JsDefinition {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly form: JsDefinitionForm;
  readonly scope: JsScope;
}

export interface JsReference {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** `{ x }` in an object literal, where the key must survive a new name. */
  readonly shorthand: boolean;
  /** The scope it is read from, which the binding is looked for upward of. */
  readonly scope: JsScope;
  /** Whether this use changes the value: `x = 1`, `x.y++`, `x.push(1)`. */
  readonly written: boolean;
}

/** A name used as a type, which a value's read never finds. */
export interface JsTypeRead {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

export type JsStatementKind =
  | 'import'
  | 'const'
  | 'let'
  | 'var'
  | 'function'
  | 'class'
  /** A type or an interface, exported or not: erased at build, so it stops nothing. */
  | 'type'
  /** Anything else `export` declares, which other code can ask for by name. */
  | 'export'
  /** Code that runs for what it does rather than for a name it declares. */
  | 'effect';

/** One statement at the top of a module, with the comments that belong to it. */
export interface JsStatement {
  readonly from: number;
  readonly to: number;
  readonly kind: JsStatementKind;
  /** The types it declares, which have a namespace of their own. */
  readonly typeNames: readonly string[];
  /** A function, or a variable holding one: what it reads is read when it is called. */
  readonly callable: boolean;
  /** Whether it waits on something: work worth not repeating. */
  readonly awaits: boolean;
  /** Whether a second run could answer differently: a clock, a random number, a request. */
  readonly volatile: boolean;
  /** Whether it reads `import.meta`, whose paths and URL are the file's own. */
  readonly readsImportMeta: boolean;
}

export interface JsAnalysis {
  /** False when the code has a syntax error or runs past the limits. */
  readonly valid: boolean;
  readonly root: JsScope;
  readonly scopes: readonly JsScope[];
  readonly definitions: readonly JsDefinition[];
  readonly references: readonly JsReference[];
  /** Names used as a tag, `<Name>` or `<Name.Part>`: not rewritable as a token alone. */
  readonly tags: readonly { readonly name: string; readonly scope: JsScope }[];
  /** Names used as types, read apart from values because TypeScript keeps them apart. */
  readonly typeReads: readonly JsTypeRead[];
  /** Names leaving the module, which other code can ask for by name. */
  readonly exported: ReadonlySet<string>;
}

/** The nearest scope binding `name` from `scope` upward, or undefined when nothing does. */
export function bindingScope(scope: JsScope, name: string): JsScope | undefined {
  let at: JsScope | undefined = scope;
  for (let count = 0; at !== undefined && count < JS_SCOPE_LIMITS.ancestorsMax; count++) {
    if (at.names.has(name)) {
      return at;
    }
    at = at.parent;
  }
  return undefined;
}

/** The innermost scope around `position`. */
export function scopeAt(analysis: JsAnalysis, position: number): JsScope {
  assert(position >= analysis.root.from, 'A position lies inside the code it was read from');
  assert(position < analysis.root.to, 'A position lies before the end of the code it was read from');
  let found = analysis.root;
  for (const scope of analysis.scopes) {
    // Scopes are listed outermost first, so the last match is the innermost.
    if (scope.from <= position && position < scope.to) {
      found = scope;
    }
  }
  assert(found.from <= position, 'The scope found starts at or before the position');
  assert(position < found.to, 'The scope found ends after the position');
  return found;
}

/** What is bound at `scope` by anything below the code's own top level. */
export function innerNamesAt(analysis: JsAnalysis, scope: JsScope): ReadonlySet<string> {
  assertNested(scope, analysis.root);
  const names = new Set<string>();
  let at: JsScope | undefined = scope;
  for (let count = 0; at !== undefined && at !== analysis.root && count < JS_SCOPE_LIMITS.ancestorsMax; count++) {
    for (const name of at.names) {
      names.add(name);
    }
    at = at.parent;
  }
  return names;
}

/** The frontmatter, as a module: its top level is the file's own bindings. */
export function readModuleScope(source: string): JsAnalysis {
  return readScopes(source, frontmatterParser);
}

/** The frontmatter's top-level statements in source order, or none when it runs past the limits. */
export function readModuleStatements(source: string): readonly JsStatement[] {
  if (source.length > JS_SCOPE_LIMITS.sourceCharsMax) {
    return [];
  }
  const statements: JsStatement[] = [];
  let comment: { readonly from: number; readonly to: number } | undefined = undefined;
  let node = frontmatterParser.parse(source).topNode.firstChild ?? undefined;
  for (let count = 0; node !== undefined && count < LIMITS.treeNodesMax; count++) {
    if (COMMENT_NODES.has(node.name)) {
      const last = statements[statements.length - 1];
      if (last !== undefined && sameLine(source, last.to, node.from)) {
        statements[statements.length - 1] = { ...last, to: node.to };
      } else {
        comment =
          comment !== undefined && directlyAbove(source, comment.to, node.from) ? { from: comment.from, to: node.to } : { from: node.from, to: node.to };
      }
    } else {
      const from = comment !== undefined && directlyAbove(source, comment.to, node.from) ? comment.from : node.from;
      statements.push(readStatement(node, from, source));
      comment = undefined;
    }
    node = node.nextSibling ?? undefined;
  }
  // Broken code is user input, not a broken invariant: the parser can recover
  // with a node that holds nothing, and such a node is simply no statement.
  return statements.filter((statement) => statement.from < statement.to);
}

/** One expression of the template, where markup can stand as a value. */
export function readTemplateScope(source: string): JsAnalysis {
  return readScopes(source, templateParser);
}

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration']);
const BLOCK_NODES = new Set(['Block', 'ForStatement', 'CatchClause', 'SwitchBody', 'ClassDeclaration', 'ClassExpression']);
// A declaration's own name lands outside the scope the declaration opens.
const OUTER_NAMED_NODES = new Set(['FunctionDeclaration', 'ClassDeclaration']);
const VALUE_TYPE_NODES = new Set(['EnumDeclaration', 'NamespaceDeclaration']);
const TAG_NODES = new Set(['JSXOpenTag', 'JSXSelfClosingTag']);
const COMMENT_NODES = new Set(['LineComment', 'BlockComment']);
// A literal on an assignment's left is a pattern, `[x] = …`, so a write reaches
// through it. Anywhere else it is a new value: `[...x].sort()` leaves `x` alone.
const PATTERN_NODES = new Set(['ArrayExpression', 'ObjectExpression', 'Property', 'Spread']);
// The methods that change what they are called on. `.filter()` and friends return
// something new, so they are left out, and a chain through one reads as a read.
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
// Callees whose answer can differ between two runs of the same statement.
const VOLATILE_CALLS: ReadonlySet<string> = new Set(['Date.now', 'Math.random', 'crypto.getRandomValues', 'crypto.randomUUID', 'fetch', 'performance.now']);

interface Reading {
  readonly source: string;
  readonly stack: JsScope[];
  readonly scopes: JsScope[];
  readonly definitions: JsDefinition[];
  readonly references: JsReference[];
  readonly tags: { readonly name: string; readonly scope: JsScope }[];
  readonly typeReads: JsTypeRead[];
  readonly exported: Set<string>;
}

function readScopes(source: string, reader: typeof frontmatterParser): JsAnalysis {
  const root: JsScope = { from: 0, to: source.length + 1, parent: undefined, names: new Set(), hoists: true };
  const reading: Reading = { source, stack: [root], scopes: [root], definitions: [], references: [], tags: [], typeReads: [], exported: new Set() };
  const empty = { valid: false, root, scopes: reading.scopes, definitions: [], references: [], tags: [], typeReads: [], exported: reading.exported };
  if (source.length > JS_SCOPE_LIMITS.sourceCharsMax) {
    return empty;
  }
  let valid = true;
  let visited = 0;
  reader.parse(source).iterate({
    enter: (node) => {
      visited += 1;
      if (visited > LIMITS.treeNodesMax) {
        valid = false;
        return false;
      }
      if (node.type.isError) {
        valid = false;
      }
      enterNode(node, reading);
      return true;
    },
    leave: (node) => {
      if (opensScope(node.name)) {
        reading.stack.pop();
      }
    },
  });
  assert(reading.stack.length === 1 || !valid, 'Every scope opened was closed');
  assert(reading.stack[0] === root, 'The top level stays at the bottom of the scopes');
  assert(reading.scopes[0] === root, 'The top level is the first scope listed');
  return {
    valid,
    root,
    scopes: reading.scopes,
    definitions: reading.definitions,
    references: reading.references,
    tags: reading.tags,
    typeReads: reading.typeReads,
    exported: reading.exported,
  };
}

function opensScope(name: string): boolean {
  return FUNCTION_NODES.has(name) || BLOCK_NODES.has(name);
}

function enterNode(node: SyntaxNodeRef, reading: Reading): void {
  if (opensScope(node.name)) {
    openScope(node, reading);
    return;
  }
  switch (node.name) {
    case 'VariableDefinition':
      readVariableDefinition(node.node, reading);
      return;
    case 'TypeDefinition':
      // Types have a namespace of their own, but an enum or a namespace is a value too.
      if (VALUE_TYPE_NODES.has(node.node.parent?.name ?? '')) {
        define(reading, node.node, { form: 'plain', scope: currentScope(reading) });
      }
      return;
    case 'PropertyName':
      readPatternKey(node.node, reading);
      return;
    case 'PropertyDefinition':
      readObjectKey(node.node, reading);
      return;
    case 'VariableName':
      readVariableName(node.node, reading);
      return;
    case 'JSXIdentifier':
      readTag(node.node, reading);
      return;
    case 'TypeName':
      reading.typeReads.push({ name: reading.source.slice(node.from, node.to), from: node.from, to: node.to });
      return;
    default:
      return;
  }
}

function openScope(node: SyntaxNodeRef, reading: Reading): void {
  assert(opensScope(node.name), 'openScope: only a scope-opening node opens one');
  const scope: JsScope = { from: node.from, to: node.to, parent: currentScope(reading), names: new Set(), hoists: FUNCTION_NODES.has(node.name) };
  assertNested(scope, currentScope(reading));
  reading.stack.push(scope);
  reading.scopes.push(scope);
}

function currentScope(reading: Reading): JsScope {
  const scope = reading.stack[reading.stack.length - 1];
  assert(scope !== undefined, 'The top level is always open');
  return scope;
}

// Both halves are what lookups by position rely on: a child scope lies inside its parent.
function assertNested(scope: JsScope, parent: JsScope): void {
  assert(parent.from <= scope.from, 'A scope starts inside its parent');
  assert(scope.to <= parent.to, 'A scope ends inside its parent');
}

function assertSpan(reading: Reading, node: SyntaxNode): void {
  assert(node.from <= node.to, 'A node starts before it ends');
  assert(node.to <= reading.source.length, 'A node ends inside its source');
}

function textOf(reading: Reading, node: SyntaxNode): string {
  assertSpan(reading, node);
  return reading.source.slice(node.from, node.to);
}

function define(reading: Reading, node: SyntaxNode, how: { readonly form: JsDefinitionForm; readonly scope: JsScope }): void {
  assert(reading.scopes.includes(how.scope), 'define: a name lands in a scope of this reading');
  const name = textOf(reading, node);
  how.scope.names.add(name);
  reading.definitions.push({ name, from: node.from, to: node.to, form: how.form, scope: how.scope });
  if (exportedDeclaration(node)) {
    reading.exported.add(name);
  }
}

function readVariableDefinition(node: SyntaxNode, reading: Reading): void {
  assert(node.name === 'VariableDefinition', 'readVariableDefinition: reads a definition');
  const parent = node.parent?.name ?? '';
  if (parent === 'ImportGroup') {
    // `{ a as b }` binds `b` under another name; `{ b }` binds the export's own.
    const aliased = node.prevSibling?.name === 'as';
    define(reading, node, { form: aliased ? 'plain' : 'import-member', scope: reading.scopes[0] ?? currentScope(reading) });
    return;
  }
  if (OUTER_NAMED_NODES.has(parent)) {
    define(reading, node, { form: 'plain', scope: currentScope(reading).parent ?? currentScope(reading) });
    return;
  }
  define(reading, node, { form: patternForm(node), scope: declaresVar(node) ? hoistScope(reading) : currentScope(reading) });
}

// Lezer 1.5.6 reads the `x` of `{ x }` as a definition where 1.5.4 read a key, and
// Studio installs the newer one: a new name must keep the key under either. `{ a: x }`
// and `{ ...x }` hold a definition under both, and have no key to keep.
function patternForm(node: SyntaxNode): JsDefinitionForm {
  assert(node.name === 'VariableDefinition', 'patternForm: classifies a definition');
  const property = node.parent;
  if (property?.name !== 'PatternProperty') {
    return 'plain';
  }
  if (property.getChild(':') !== null) {
    return 'plain';
  }
  return property.getChild('Spread') === null ? 'shorthand' : 'plain';
}

function readPatternKey(node: SyntaxNode, reading: Reading): void {
  assert(node.name === 'PropertyName', 'readPatternKey: reads a key');
  const parent = node.parent;
  // `{ x }` and `{ x = 1 }` bind the key's own name; `{ x: y }` binds `y`.
  if (parent?.name === 'PatternProperty') {
    if (parent.getChild(':') === null) {
      define(reading, node, { form: 'shorthand', scope: declaresVar(node) ? hoistScope(reading) : currentScope(reading) });
    }
  }
}

function readObjectKey(node: SyntaxNode, reading: Reading): void {
  assert(node.name === 'PropertyDefinition', 'readObjectKey: reads a key');
  const parent = node.parent;
  if (parent?.name !== 'Property') {
    return; // A class member's name, which is no variable.
  }
  // `{ x }` reads `x`; `{ x: 1 }` and `{ x() {} }` only name a key.
  if (parent.getChild(':') === null) {
    if (parent.getChild('ParamList') === null) {
      reading.references.push({ name: textOf(reading, node), from: node.from, to: node.to, shorthand: true, scope: currentScope(reading), written: false });
    }
  }
}

function readVariableName(node: SyntaxNode, reading: Reading): void {
  assert(node.name === 'VariableName', 'readVariableName: reads a name');
  assertSpan(reading, node);
  const parent = node.parent?.name;
  if (parent === 'ImportGroup') {
    return; // The export's own name, in `{ a as b }`.
  }
  if (parent === 'ExportGroup') {
    reading.exported.add(textOf(reading, node));
    return;
  }
  reading.references.push({
    name: textOf(reading, node),
    from: node.from,
    to: node.to,
    shorthand: false,
    scope: currentScope(reading),
    written: writtenAt(node, reading),
  });
}

// Climbs from a name through what it is the object of, to whatever finally
// decides: an assignment's left side, `++`, `delete`, or a mutating method.
function writtenAt(name: SyntaxNode, reading: Reading): boolean {
  assert(name.name === 'VariableName', 'writtenAt: climbs from a name');
  let at = name;
  let inLiteral = false;
  for (let count = 0; count < JS_SCOPE_LIMITS.ancestorsMax; count++) {
    const parent = parentOf(at);
    if (parent === undefined) {
      return false;
    }
    if (inLiteral) {
      if (parent.name !== 'AssignmentExpression') {
        if (!PATTERN_NODES.has(parent.name)) {
          return false;
        }
      }
    }
    switch (parent.name) {
      case 'AssignmentExpression':
        return parent.firstChild?.from === at.from;
      case 'PostfixExpression':
        return true;
      case 'UnaryExpression':
        return parent.getChild('delete') !== null || textOfOperator(parent, reading) === '++' || textOfOperator(parent, reading) === '--';
      case 'CallExpression':
        return calledMutator(parent, at, reading);
      case 'MemberExpression':
        if (parent.firstChild?.from !== at.from) {
          return false; // The index of `x[i]`, which is only read.
        }
        break;
      case 'ParenthesizedExpression':
        break;
      default:
        if (!PATTERN_NODES.has(parent.name)) {
          return false;
        }
        inLiteral = true;
    }
    at = parent;
  }
  return false;
}

function textOfOperator(unary: SyntaxNode, reading: Reading): string | undefined {
  assert(unary.name === 'UnaryExpression', 'textOfOperator: reads a unary expression');
  const operator = unary.getChild('ArithOp');
  return operator === null ? undefined : textOf(reading, operator);
}

// `x.push(1)` writes `x`; `f(x)` and `x.map(g)` do not.
function calledMutator(call: SyntaxNode, callee: SyntaxNode, reading: Reading): boolean {
  assert(call.name === 'CallExpression', 'calledMutator: reads a call');
  assert(call.from <= callee.from, 'calledMutator: what is climbed from lies inside the call');
  if (call.firstChild?.from !== callee.from) {
    return false;
  }
  if (call.firstChild?.to !== callee.to) {
    return false;
  }
  const method = callee.lastChild;
  return callee.name === 'MemberExpression' && method !== null && MUTATING_METHODS.has(textOf(reading, method));
}

function readTag(node: SyntaxNode, reading: Reading): void {
  assert(node.name === 'JSXIdentifier', 'readTag: reads a tag name');
  const parent = node.parent;
  const named = TAG_NODES.has(parent?.name ?? '');
  const member = parent?.name === 'JSXMemberExpression' && parent.firstChild?.from === node.from;
  if (named || member) {
    reading.tags.push({ name: textOf(reading, node), scope: currentScope(reading) });
  }
}

function sameLine(source: string, from: number, to: number): boolean {
  assert(from <= to, 'sameLine: statements are read in source order');
  return !source.slice(from, to).includes('\n');
}

// A comment belongs to the statement below it when no blank line parts them.
function directlyAbove(source: string, from: number, to: number): boolean {
  assert(from <= to, 'directlyAbove: a comment comes before what it is above');
  return source.slice(from, to).split('\n').length <= 2;
}

function readStatement(node: SyntaxNode, from: number, source: string): JsStatement {
  assert(from <= node.from, 'readStatement: a statement’s comments come before it');
  assert(node.to <= source.length, 'readStatement: a statement ends inside its source');
  const declared = node.name === 'ExportDeclaration' ? (firstDeclaration(node) ?? node) : node;
  const kind = statementKind(node, declared);
  const parts = new Set<StatementPart | undefined>();
  node.cursor().iterate((inner) => {
    parts.add(statementPart(inner, source));
  });
  const typeName = declared.getChild('TypeDefinition');
  return {
    from,
    to: node.to,
    kind,
    typeNames: kind === 'type' && typeName !== null ? [source.slice(typeName.from, typeName.to)] : [],
    callable: isCallable(declared),
    awaits: parts.has('awaits'),
    volatile: parts.has('volatile'),
    readsImportMeta: parts.has('import-meta'),
  };
}

function firstDeclaration(exported: SyntaxNode): SyntaxNode | undefined {
  return exported.getChild('InterfaceDeclaration') ?? exported.getChild('TypeAliasDeclaration') ?? undefined;
}

function statementKind(node: SyntaxNode, declared: SyntaxNode): JsStatementKind {
  switch (declared.name) {
    case 'ImportDeclaration':
      return 'import';
    case 'VariableDeclaration':
      return declared.getChild('const') !== null ? 'const' : declared.getChild('let') !== null ? 'let' : 'var';
    case 'FunctionDeclaration':
      return 'function';
    case 'ClassDeclaration':
    case 'EnumDeclaration':
      return 'class';
    case 'InterfaceDeclaration':
    case 'TypeAliasDeclaration':
      return 'type';
    default:
      return node.name === 'ExportDeclaration' ? 'export' : 'effect';
  }
}

function isCallable(declared: SyntaxNode): boolean {
  if (declared.name === 'FunctionDeclaration' || declared.name === 'ClassDeclaration') {
    return true;
  }
  if (declared.name !== 'VariableDeclaration') {
    return false;
  }
  return declared.getChild('ArrowFunction') !== null || declared.getChild('FunctionExpression') !== null || declared.getChild('ClassExpression') !== null;
}

type StatementPart = 'awaits' | 'volatile' | 'import-meta';

function statementPart(node: SyntaxNodeRef, source: string): StatementPart | undefined {
  switch (node.name) {
    case 'AwaitExpression':
      return 'awaits';
    case 'ImportMeta':
      return 'import-meta';
    case 'CallExpression': {
      const callee = node.node.firstChild;
      return callee !== null && VOLATILE_CALLS.has(source.slice(callee.from, callee.to)) ? 'volatile' : undefined;
    }
    case 'NewExpression':
      // `new Date()` is now; `new Date(value)` is that value.
      return source.slice(node.from, node.to).replace(/\s/g, '') === 'newDate()' ? 'volatile' : undefined;
    default:
      return undefined;
  }
}

// Whether the binding `node` sits in is a `var`, which ignores blocks.
function declaresVar(node: SyntaxNode): boolean {
  let at = parentOf(node);
  for (let count = 0; at !== undefined && count < JS_SCOPE_LIMITS.ancestorsMax; count++) {
    if (at.name === 'VariableDeclaration' || at.name === 'ForOfSpec' || at.name === 'ForInSpec' || at.name === 'ForSpec') {
      return at.getChild('var') !== null;
    }
    if (at.name === 'ParamList') {
      return false;
    }
    at = parentOf(at);
  }
  return false;
}

function hoistScope(reading: Reading): JsScope {
  for (let index = reading.stack.length - 1; index >= 0; index--) {
    const scope = reading.stack[index];
    if (scope?.hoists === true) {
      return scope;
    }
  }
  assert(false, 'The top level takes a hoisted name');
  return currentScope(reading);
}

// `export const x`, `export function x`: a binding the export statement declares.
function exportedDeclaration(node: SyntaxNode): boolean {
  let at = parentOf(node);
  for (let count = 0; at !== undefined && count < JS_SCOPE_LIMITS.ancestorsMax; count++) {
    if (at.name === 'ExportDeclaration') {
      return true;
    }
    if (at.name === 'Block' || at.name === 'ParamList') {
      return false;
    }
    at = parentOf(at);
  }
  return false;
}

// Lezer says null for the root; absence here is `undefined`.
function parentOf(node: SyntaxNode): SyntaxNode | undefined {
  return node.parent ?? undefined;
}
