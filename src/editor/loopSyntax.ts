// JavaScript as the loop reader sees it: a small expression tree built from a
// real parse, so `posts.filter(p => p.data.on)` and the same thing written with
// a block body, a destructured parameter, extra parentheses or a TypeScript
// `as` read the same. Lezer parses (it is already in the bundle for the code
// editors, it parses TypeScript, and it never throws); this module keeps only
// the shapes a query can be made of and calls everything else `other`, with
// its source text, so nothing it does not understand is lost.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

const typescript = parser.configure({ dialect: 'ts' });

// Frontmatter is a page's setup code: far smaller than this in practice, and
// past it the reader reports the loop as custom rather than parsing for long.
export const LOOP_SYNTAX_LIMITS = {
  sourceCharsMax: 200_000,
  argumentsMax: 16,
  parametersMax: 8,
  declarationsMax: 2_000,
  entriesMax: 500,
} as const;

interface Span {
  readonly from: number;
  readonly to: number;
}

export type JsParameter =
  { readonly kind: 'name'; readonly name: string } | { readonly kind: 'object'; readonly names: readonly string[] } | { readonly kind: 'other' };

export type Js = Span &
  (
    | { readonly kind: 'name'; readonly name: string }
    | { readonly kind: 'member'; readonly object: Js; readonly property: string; readonly optional: boolean }
    | { readonly kind: 'index'; readonly object: Js; readonly index: Js }
    | { readonly kind: 'call'; readonly callee: Js; readonly args: readonly Js[] }
    | { readonly kind: 'new'; readonly callee: Js; readonly args: readonly Js[] }
    | { readonly kind: 'await'; readonly value: Js }
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'boolean'; readonly value: boolean }
    | { readonly kind: 'null' }
    | { readonly kind: 'unary'; readonly operator: string; readonly value: Js }
    | { readonly kind: 'binary'; readonly operator: string; readonly left: Js; readonly right: Js }
    | { readonly kind: 'conditional'; readonly test: Js; readonly consequent: Js; readonly alternate: Js }
    | {
        readonly kind: 'function';
        readonly parameters: readonly JsParameter[];
        readonly body: Js | undefined;
        /**
         * Whether the body was read through local constants (`const v = …;
         * return v === e`): its clauses then name things only that block
         * declares, so none can be kept as code on its own.
         */
        readonly substituted: boolean;
      }
    | { readonly kind: 'object'; readonly entries: readonly JsEntry[] }
    | { readonly kind: 'array'; readonly items: readonly Js[] }
    | { readonly kind: 'other' }
  );

/** One `key: value` of an object literal; a computed key or a spread is `other`. */
export interface JsEntry {
  readonly key: string | undefined;
  readonly value: Js;
}

/** A parsed piece of code: its tree, and the text its spans index. */
export interface ParsedExpression {
  readonly source: string;
  readonly expression: Js;
}

/** A top-level `const`/`let`/`var` binding one name. */
export interface Declaration {
  readonly name: string;
  readonly init: Js | undefined;
  /** The whole statement, with a comment on its last line and its line break. */
  readonly statement: Span;
  /** Whether the statement binds only this name (so it can be replaced whole). */
  readonly alone: boolean;
}

export interface ParsedFrontmatter {
  readonly source: string;
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** Every name the code reads, with how many times, by position. */
  readonly uses: readonly { readonly name: string; readonly from: number }[];
  /** Names bound by anything: declarations, destructuring, functions, classes. */
  readonly bound: ReadonlySet<string>;
}

/** One expression, or undefined when the text is not exactly one. */
export function parseExpression(text: string): ParsedExpression | undefined {
  if (text.length > LOOP_SYNTAX_LIMITS.sourceCharsMax) {
    return undefined;
  }
  const source = `(${text}\n);`;
  const tree = typescript.parse(source);
  const statement = tree.topNode.firstChild;
  if (statement?.name !== 'ExpressionStatement' || statement.nextSibling !== null) {
    return undefined;
  }
  if (hasError(tree.topNode)) {
    return undefined;
  }
  const outer = statement.firstChild;
  if (!outer) {
    return undefined;
  }
  const expression = toJs(outer, source, 0);
  assert(expression.from >= 0, 'An expression starts inside its source');
  return { source, expression };
}

/** The frontmatter's top-level declarations and the names it reads. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const source = text.length > LOOP_SYNTAX_LIMITS.sourceCharsMax ? '' : text;
  const tree = typescript.parse(source);
  const declarations = new Map<string, Declaration>();
  const bound = new Set<string>();
  let statement = tree.topNode.firstChild;
  for (let count = 0; statement && count < LOOP_SYNTAX_LIMITS.declarationsMax; count++) {
    const declaration = statement.name === 'ExportDeclaration' ? statement.getChild('VariableDeclaration') : statement;
    if (declaration?.name === 'VariableDeclaration') {
      readDeclaration(declaration, statement, source, declarations, bound);
    }
    statement = statement.nextSibling;
  }
  const uses: { name: string; from: number }[] = [];
  tree.topNode.cursor().iterate((node) => {
    if (node.name === 'VariableDefinition') {
      bound.add(source.slice(node.from, node.to));
    }
    if (node.name === 'VariableName') {
      uses.push({ name: source.slice(node.from, node.to), from: node.from });
    }
    return uses.length < LIMITS.treeNodesMax;
  });
  assert(declarations.size <= LOOP_SYNTAX_LIMITS.declarationsMax, 'Declarations are bounded');
  return { source, declarations, uses, bound };
}

function readDeclaration(node: SyntaxNode, statement: SyntaxNode, source: string, out: Map<string, Declaration>, bound: Set<string>): void {
  const span = statementSpan(statement, source);
  const children = significant(node);
  const names = children.filter((child) => child.name === 'VariableDefinition');
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child?.name !== 'VariableDefinition') {
      if (child?.name === 'ObjectPattern' || child?.name === 'ArrayPattern') {
        child.cursor().iterate((inner) => {
          if (inner.name === 'VariableDefinition' || inner.name === 'PropertyName') {
            bound.add(source.slice(inner.from, inner.to));
          }
        });
      }
      continue;
    }
    const name = source.slice(child.from, child.to);
    bound.add(name);
    // `const x: T = value`: the value follows the `=`, after any annotation.
    let at = index + 1;
    while (children[at] && children[at]?.name !== 'Equals' && children[at]?.name !== ',') {
      at++;
    }
    const value = children[at]?.name === 'Equals' ? children[at + 1] : undefined;
    out.set(name, { name, init: value ? toJs(value, source, 0) : undefined, statement: span, alone: names.length === 1 });
  }
}

// The statement, its comment on the same line, and the line break after it —
// what removing it should take so no blank line is left behind.
function statementSpan(statement: SyntaxNode, source: string): Span {
  const rest = /^[ \t]*(?:\/\/[^\n]*)?\r?\n?/.exec(source.slice(statement.to));
  const to = statement.to + (rest?.[0].length ?? 0);
  assert(to <= source.length, 'A statement ends inside its source');
  return { from: statement.from, to };
}

function hasError(node: SyntaxNode): boolean {
  let found = false;
  node.cursor().iterate((inner) => {
    if (inner.type.isError) {
      found = true;
    }
    return !found;
  });
  return found;
}

const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ',', ';', '.', '?.', 'LineComment', 'BlockComment']);

function significant(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!PUNCTUATION.has(child.name)) {
      out.push(child);
    }
    if (out.length > LIMITS.treeNodesMax) {
      break;
    }
  }
  return out;
}

function other(node: SyntaxNode): Js {
  return { kind: 'other', from: node.from, to: node.to };
}

/** The Lezer node as a Js tree, unwrapping parentheses, `as`, `satisfies` and `!`. */
function toJs(node: SyntaxNode, source: string, depth: number): Js {
  if (depth > LIMITS.treeDepthMax) {
    return other(node);
  }
  const span = { from: node.from, to: node.to };
  const text = source.slice(node.from, node.to);
  const parts = significant(node);
  const below = (child: SyntaxNode | undefined): Js => (child ? toJs(child, source, depth + 1) : other(node));
  switch (node.name) {
    case 'ParenthesizedExpression':
      return parts.length === 1 ? below(parts[0]) : other(node);
    case 'VariableName':
      return { ...span, kind: 'name', name: text };
    case 'String':
      return stringValue(text, span) ?? other(node);
    case 'TemplateString':
      return node.getChild('Interpolation') ? other(node) : (stringValue(text, span) ?? other(node));
    case 'Number': {
      const value = Number(text.replace(/_/g, ''));
      return Number.isFinite(value) ? { ...span, kind: 'number', value } : other(node);
    }
    case 'BooleanLiteral':
      return { ...span, kind: 'boolean', value: text === 'true' };
    case 'null':
      return { ...span, kind: 'null' };
    case 'AwaitExpression':
      return { ...span, kind: 'await', value: below(parts[1]) };
    case 'MemberExpression':
      return memberJs(node, parts, source, depth, span);
    case 'CallExpression':
    case 'NewExpression':
      return callJs(node, parts, source, depth, span);
    case 'UnaryExpression':
      return unaryJs(node, parts, source, depth, span);
    case 'PostfixExpression':
      // `value!` asserts to the compiler only; at runtime it is the value.
      return parts.length === 2 && parts[1] && source.slice(parts[1].from, parts[1].to) === '!' ? below(parts[0]) : other(node);
    case 'BinaryExpression':
      return binaryJs(node, parts, source, depth, span);
    case 'ConditionalExpression':
      return parts.length === 5
        ? { ...span, kind: 'conditional', test: below(parts[0]), consequent: below(parts[2]), alternate: below(parts[4]) }
        : other(node);
    case 'ArrowFunction':
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      return functionJs(node, source, depth, span);
    case 'ObjectExpression':
    case 'ArrayExpression':
      return literalJs(node, parts, source, depth, span);
    default:
      return other(node);
  }
}

// `"a": 1`, `a: 1` or `a` alone; `[k]: 1` and `...r` have no key.
function entryOf(node: SyntaxNode, source: string, depth: number): JsEntry {
  const parts = significant(node).filter((part) => part.name !== ':');
  const [key, value] = parts;
  if (node.name !== 'Property' || key === undefined) {
    return { key: undefined, value: other(node) };
  }
  const name =
    key.name === 'PropertyDefinition' ? source.slice(key.from, key.to) : key.name === 'String' ? decodeString(source.slice(key.from, key.to)) : undefined;
  if (value === undefined) {
    // Shorthand `{ a }`: the value is the variable of that name.
    return name === undefined ? { key: undefined, value: other(node) } : { key: name, value: { from: key.from, to: key.to, kind: 'name', name } };
  }
  return { key: name, value: toJs(value, source, depth + 1) };
}

function unaryJs(node: SyntaxNode, parts: readonly SyntaxNode[], source: string, depth: number, span: Span): Js {
  const symbol = parts[0];
  const operand = parts[1];
  if (parts.length !== 2 || !symbol || !operand) {
    return other(node);
  }
  const operator = source.slice(symbol.from, symbol.to);
  const value = toJs(operand, source, depth + 1);
  // `-2.5` is a number, as the writer writes one; not an operation on one.
  return operator === '-' && value.kind === 'number' ? { ...span, kind: 'number', value: -value.value } : { ...span, kind: 'unary', operator, value };
}

// An object or array literal, bounded; `[...list]` copies a list, so it reads
// as the list itself.
function literalJs(node: SyntaxNode, parts: readonly SyntaxNode[], source: string, depth: number, span: Span): Js {
  const kept = parts.slice(0, LOOP_SYNTAX_LIMITS.entriesMax);
  if (node.name === 'ObjectExpression') {
    return { ...span, kind: 'object', entries: kept.map((part) => entryOf(part, source, depth)) };
  }
  const copied = parts[1];
  if (parts.length === 2 && parts[0]?.name === 'Spread' && copied) {
    return toJs(copied, source, depth + 1);
  }
  return parts.some((part) => part.name === 'Spread') ? other(node) : { ...span, kind: 'array', items: kept.map((part) => toJs(part, source, depth + 1)) };
}

function memberJs(node: SyntaxNode, parts: readonly SyntaxNode[], source: string, depth: number, span: Span): Js {
  const object = parts[0];
  const property = parts[1];
  if (!object || !property || parts.length !== 2) {
    return other(node);
  }
  const optional = node.getChild('?.') !== null;
  const base = toJs(object, source, depth + 1);
  if (property.name === 'PropertyName') {
    return { ...span, kind: 'member', object: base, property: source.slice(property.from, property.to), optional };
  }
  const index = toJs(property, source, depth + 1);
  // `data["campus-name"]` is the field `campus-name`, the way `.` names one.
  if (index.kind === 'string') {
    return { ...span, kind: 'member', object: base, property: index.value, optional };
  }
  return { ...span, kind: 'index', object: base, index };
}

function callJs(node: SyntaxNode, parts: readonly SyntaxNode[], source: string, depth: number, span: Span): Js {
  const isNew = node.name === 'NewExpression';
  const callee = isNew ? parts[1] : parts[0];
  const argumentList = node.getChild('ArgList');
  if (!callee) {
    return other(node);
  }
  const args = argumentList ? significant(argumentList) : [];
  if (args.length > LOOP_SYNTAX_LIMITS.argumentsMax || args.some((argument) => argument.name === 'Spread')) {
    return other(node);
  }
  const converted = args.map((argument) => toJs(argument, source, depth + 1));
  const calleeJs = toJs(callee, source, depth + 1);
  return isNew ? { ...span, kind: 'new', callee: calleeJs, args: converted } : { ...span, kind: 'call', callee: calleeJs, args: converted };
}

function binaryJs(node: SyntaxNode, parts: readonly SyntaxNode[], source: string, depth: number, span: Span): Js {
  const [left, operator, right] = parts;
  if (parts.length !== 3 || !left || !operator || !right) {
    return other(node);
  }
  const symbol = source.slice(operator.from, operator.to);
  if (symbol === 'as' || symbol === 'satisfies') {
    return toJs(left, source, depth + 1);
  }
  return { ...span, kind: 'binary', operator: symbol, left: toJs(left, source, depth + 1), right: toJs(right, source, depth + 1) };
}

function functionJs(node: SyntaxNode, source: string, depth: number, span: Span): Js {
  const list = node.getChild('ParamList');
  const parameters: JsParameter[] = [];
  if (list) {
    for (const parameter of significant(list)) {
      parameters.push(parameterOf(parameter, source));
    }
  } else {
    // `entry => …`: one bare parameter, which Lezer gives as a definition.
    const bare = node.getChild('VariableDefinition');
    if (bare) {
      parameters.push({ kind: 'name', name: source.slice(bare.from, bare.to) });
    }
  }
  if (parameters.length > LOOP_SYNTAX_LIMITS.parametersMax) {
    return other(node);
  }
  const body = functionBody(node, source, depth);
  return { ...span, kind: 'function', parameters, body: body?.value, substituted: body?.substituted ?? false };
}

function parameterOf(node: SyntaxNode, source: string): JsParameter {
  if (node.name === 'VariableDefinition') {
    return { kind: 'name', name: source.slice(node.from, node.to) };
  }
  if (node.name === 'ObjectPattern') {
    const names: string[] = [];
    for (const property of significant(node)) {
      // `{ data }` only: a renamed or defaulted property is not a plain field read.
      const inner = significant(property);
      if (property.name !== 'PatternProperty' || inner.length !== 1 || inner[0]?.name !== 'PropertyName') {
        return { kind: 'other' };
      }
      names.push(source.slice(inner[0].from, inner[0].to));
    }
    return { kind: 'object', names };
  }
  return { kind: 'other' };
}

// An arrow's expression body, or a block's `return` with the block's own
// constants put in place of their names. Generated code writes a condition as
// `const value0 = entry.fields?.["category"]; let expected0 = "Care";
// if (…) expected0 = …; return (value0 === expected0);` — the `if`s only
// coerce a value's type, so the return, substituted, says what is compared.
function functionBody(node: SyntaxNode, source: string, depth: number): { readonly value: Js; readonly substituted: boolean } | undefined {
  const block = node.getChild('Block');
  if (!block) {
    const parts = significant(node);
    const last = parts[parts.length - 1];
    const value = last && last.name !== 'ParamList' && last.name !== 'Arrow' && last.name !== 'VariableDefinition' ? toJs(last, source, depth + 1) : undefined;
    return value === undefined ? undefined : { value, substituted: false };
  }
  const statements = significant(block);
  const last = statements[statements.length - 1];
  if (last?.name !== 'ReturnStatement') {
    return undefined;
  }
  const locals = new Map<string, Js>();
  for (const statement of statements.slice(0, -1)) {
    if (statement.name === 'VariableDeclaration') {
      const declared = new Map<string, Declaration>();
      readDeclaration(statement, statement, source, declared, new Set());
      for (const [name, declaration] of declared) {
        if (declaration.init !== undefined) {
          locals.set(name, declaration.init);
        }
      }
    } else if (statement.name !== 'IfStatement') {
      return undefined;
    }
  }
  const value = significant(last)[1];
  if (!value) {
    return undefined;
  }
  const returned = toJs(value, source, depth + 1);
  return locals.size === 0 ? { value: returned, substituted: false } : { value: substitutedJs(returned, locals, 0), substituted: true };
}

// The tree with each local name replaced by what it was declared as.
function substitutedJs(node: Js, locals: ReadonlyMap<string, Js>, depth: number): Js {
  if (depth > LIMITS.treeDepthMax) {
    return node;
  }
  const next = (child: Js): Js => substitutedJs(child, locals, depth + 1);
  switch (node.kind) {
    case 'name':
      return locals.get(node.name) ?? node;
    case 'member':
      return { ...node, object: next(node.object) };
    case 'index':
      return { ...node, object: next(node.object), index: next(node.index) };
    case 'call':
    case 'new':
      return { ...node, callee: next(node.callee), args: node.args.map(next) };
    case 'await':
    case 'unary':
      return { ...node, value: next(node.value) };
    case 'binary':
      return { ...node, left: next(node.left), right: next(node.right) };
    case 'conditional':
      return { ...node, test: next(node.test), consequent: next(node.consequent), alternate: next(node.alternate) };
    case 'array':
      return { ...node, items: node.items.map(next) };
    case 'object':
      return { ...node, entries: node.entries.map((entry) => ({ ...entry, value: next(entry.value) })) };
    case 'function':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'other':
      return node;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function stringValue(text: string, span: Span): Js | undefined {
  const value = decodeString(text);
  return value === undefined ? undefined : { ...span, kind: 'string', value };
}

/** The value a JavaScript string or plain template literal holds. */
export function decodeString(literal: string): string | undefined {
  const quote = literal.charAt(0);
  if (literal.length < 2 || literal.charAt(literal.length - 1) !== quote) {
    return undefined;
  }
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return undefined;
  }
  const body = literal.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index++) {
    const character = body.charAt(index);
    if (character !== '\\') {
      out += character;
      continue;
    }
    const escaped = decodeEscape(body, index + 1);
    if (escaped === undefined) {
      return undefined;
    }
    out += escaped.text;
    index = escaped.end - 1;
  }
  assert(out.length <= body.length, 'A decoded string is never longer than its source');
  return out;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

function decodeEscape(body: string, at: number): { readonly text: string; readonly end: number } | undefined {
  const character = body.charAt(at);
  const simple = SIMPLE_ESCAPES[character];
  if (simple !== undefined) {
    return { text: simple, end: at + 1 };
  }
  if (character === 'x') {
    const hex = body.slice(at + 1, at + 3);
    return /^[0-9a-fA-F]{2}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), end: at + 3 } : undefined;
  }
  if (character === 'u') {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(body.slice(at + 1));
    if (braced?.[1]) {
      const point = parseInt(braced[1], 16);
      return point <= 0x10ffff ? { text: String.fromCodePoint(point), end: at + 1 + braced[0].length } : undefined;
    }
    const hex = body.slice(at + 1, at + 5);
    return /^[0-9a-fA-F]{4}$/.test(hex) ? { text: String.fromCharCode(parseInt(hex, 16)), end: at + 5 } : undefined;
  }
  if (character === '\n') {
    return { text: '', end: at + 1 }; // A line continuation.
  }
  return character === '' ? undefined : { text: character, end: at + 1 };
}

/** The source text a node spans. */
export function textOf(parsed: { readonly source: string }, node: Span): string {
  assert(node.to <= parsed.source.length, 'A span ends inside its source');
  return parsed.source.slice(node.from, node.to);
}

/** `a.b.c` as its names, or undefined when it is anything else. */
export function namePath(node: Js): readonly string[] | undefined {
  const path: string[] = [];
  let current: Js = node;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth++) {
    if (current.kind === 'name') {
      path.unshift(current.name);
      return path;
    }
    if (current.kind !== 'member') {
      return undefined;
    }
    path.unshift(current.property);
    current = current.object;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A whole module: what a loop's list passes through in another file.
// ---------------------------------------------------------------------------

export interface ModuleImport {
  /** The name this module uses. */
  readonly name: string;
  /** The name the other module exports (`default` for a default import). */
  readonly imported: string;
  readonly path: string;
}

export interface ModuleFunction {
  readonly name: string;
  /** Every call in its body, in source order: where its data comes from. */
  readonly calls: readonly Js[];
  /** Where it starts, for the line a link opens at. */
  readonly from: number;
}

export interface ParsedModule {
  readonly source: string;
  readonly declarations: ReadonlyMap<string, Declaration>;
  readonly imports: readonly ModuleImport[];
  readonly functions: ReadonlyMap<string, ModuleFunction>;
}

// A module's functions call a handful of things each; past this the rest is
// not where its data comes from.
const MODULE_CALLS_MAX = 200;

/** A module's imports, top-level constants and functions (declared, or arrows held by a const). */
export function parseModule(text: string): ParsedModule {
  const source = text.length > LOOP_SYNTAX_LIMITS.sourceCharsMax ? '' : text;
  const tree = typescript.parse(source);
  const declarations = new Map<string, Declaration>();
  const functions = new Map<string, ModuleFunction>();
  const imports: ModuleImport[] = [];
  const bound = new Set<string>();
  let statement = tree.topNode.firstChild;
  for (let count = 0; statement && count < LOOP_SYNTAX_LIMITS.declarationsMax; count++) {
    const inner = statement.name === 'ExportDeclaration' ? (statement.getChild('FunctionDeclaration') ?? statement.getChild('VariableDeclaration')) : statement;
    if (inner?.name === 'ImportDeclaration') {
      imports.push(...importsOf(inner, source));
    } else if (inner?.name === 'FunctionDeclaration') {
      const name = inner.getChild('VariableDefinition');
      if (name) {
        functions.set(source.slice(name.from, name.to), { name: source.slice(name.from, name.to), calls: callsIn(inner, source), from: inner.from });
      }
    } else if (inner?.name === 'VariableDeclaration') {
      readDeclaration(inner, statement, source, declarations, bound);
      const name = inner.getChild('VariableDefinition');
      const value = inner.getChild('ArrowFunction') ?? inner.getChild('FunctionExpression');
      if (name && value) {
        functions.set(source.slice(name.from, name.to), { name: source.slice(name.from, name.to), calls: callsIn(value, source), from: inner.from });
      }
    }
    statement = statement.nextSibling;
  }
  assert(functions.size <= LOOP_SYNTAX_LIMITS.declarationsMax, 'Module functions are bounded');
  return { source, declarations, imports, functions };
}

function importsOf(node: SyntaxNode, source: string): ModuleImport[] {
  const spec = node.getChild('String');
  const path = spec ? decodeString(source.slice(spec.from, spec.to)) : undefined;
  if (path === undefined) {
    return [];
  }
  const out: ModuleImport[] = [];
  const named = node.getChild('ImportGroup');
  for (const child of significant(node)) {
    // `import x from …`: the default export under a local name.
    if (child.name === 'VariableDefinition' && node.getChild('Star') === null) {
      out.push({ name: source.slice(child.from, child.to), imported: 'default', path });
    }
  }
  if (named) {
    let exported: string | undefined;
    for (const child of significant(named)) {
      const text = source.slice(child.from, child.to);
      if (child.name === 'VariableName') {
        exported = text; // `a as b`: the exported name comes first.
      } else if (child.name === 'VariableDefinition') {
        out.push({ name: text, imported: exported ?? text, path });
        exported = undefined;
      }
    }
  }
  return out;
}

function callsIn(node: SyntaxNode, source: string): readonly Js[] {
  const calls: Js[] = [];
  node.cursor().iterate((inner) => {
    if (calls.length >= MODULE_CALLS_MAX) {
      return false;
    }
    if (inner.name === 'CallExpression') {
      calls.push(toJs(inner.node, source, 0));
    }
    return true;
  });
  return calls;
}

/**
 * The default a destructuring gives `local`: `{ filters: propFilters = {…} }`
 * from `Astro.props`, as a tree whose spans index the frontmatter.
 */
export function destructuredDefault(frontmatter: string, local: string): Js | undefined {
  const source = frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax ? '' : frontmatter;
  const tree = typescript.parse(source);
  let found: Js | undefined;
  tree.topNode.cursor().iterate((node) => {
    if (found !== undefined) {
      return false;
    }
    if (node.name !== 'PatternProperty') {
      return true;
    }
    const parts = significant(node.node).filter((part) => part.name !== ':');
    const name = parts.find((part) => part.name === 'VariableDefinition');
    const equals = parts.findIndex((part) => part.name === 'Equals');
    const value = equals < 0 ? undefined : parts[equals + 1];
    if (name !== undefined && value !== undefined && source.slice(name.from, name.to) === local) {
      found = toJs(value, source, 0);
    }
    return true;
  });
  return found;
}
