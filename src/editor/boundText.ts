// Text a page prints from data: `{aiCallout1.body}`, found at the string it comes
// from, so the canvas can write the words back to the source that holds them.
//
// The page's expression is followed the way the language reads it, and never
// run: a name is looked up among the file's top-level `const`s and its imports,
// a module is read as text and its export followed to a declaration, and a path
// (`.body`, `[2]`, `["key"]`) walks object and array literals. The walk ends at
// one string literal, whose exact span is the only thing an edit may replace.
// Anything else (a call, a concatenation, a template with holes, a `let`, a
// value a prop or the runtime supplies) ends in a refusal that names the file
// the person has to go to: a binding that cannot be traced is never guessed.
//
// Everything here is pure: the host reads modules (`readModule`) and writes
// files, so Desktop (IPC) and Studio (its dev server) share this one reading.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { parseLoopHead, loopSourcePath } from '../../shared/page/loopSource';

export const BOUND_TEXT_LIMITS = {
  /** Names followed on the way to a literal (a const that names a const, a re-export). */
  hopsMax: 12,
  /** Steps in one path (`a.b[0].c`). */
  stepsMax: 16,
  /** Modules read for one expression. */
  modulesMax: 8,
  /** Items one loop is resolved for: one target each. */
  itemsMax: 200,
  /** Characters of an expression that is read at all. */
  expressionCharsMax: 400,
} as const;

/** How a string literal is spelled, so a rewrite keeps the file's own style. `json` is a data file: always double quotes and JSON escapes. */
export type StringQuote = '"' | "'" | '`' | 'json';

/** One string literal in one file, quotes included. `file` is project relative, and `''` stands for the page being edited. */
export interface BoundTextSite {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly quote: StringQuote;
  readonly value: string;
  /** The literal as written, kept to prove the file still holds it before a write. */
  readonly raw: string;
}

export const BOUND_TEXT_BLOCKS = [
  'call',
  'computed',
  'concatenation',
  'duplicate',
  'ambiguous',
  'missing',
  'mutable',
  'not-text',
  'prop',
  'runtime',
  'template',
  'unreadable',
  'unsupported',
] as const;
export type BoundTextBlockReason = (typeof BOUND_TEXT_BLOCKS)[number];

/** Why a binding cannot be written back, and the file the person edits instead. */
export interface BoundTextBlock {
  readonly reason: BoundTextBlockReason;
  /** Project-relative file where the value stops being a plain string; `''` is the page itself. */
  readonly file: string;
  readonly detail: string;
}

export type BoundTextOutcome = { readonly ok: true; readonly site: BoundTextSite } | { readonly ok: false; readonly block: BoundTextBlock };

export type BoundListOutcome = { readonly ok: true; readonly count: number } | { readonly ok: false; readonly block: BoundTextBlock };

/** A module as the host read it. */
export interface BoundTextModule {
  readonly file: string;
  readonly text: string;
}

export interface BoundTextEnvironment {
  /** The page being edited, by its project-relative file. */
  readonly page: BoundTextModule;
  /** The module `spec` names from `fromFile`, or undefined (a package, a missing file). */
  readonly readModule: (fromFile: string, spec: string) => Promise<BoundTextModule | undefined>;
}

/** A loop the expression sits in: `cards.map((card) => …)` at item `index` of `cards`. */
export interface BoundTextLoop {
  readonly item: string;
  /** The list the loop reads, as a path: `cards`, `data.cards`. */
  readonly list: string;
  readonly index: number;
}

const typescript = parser.configure({ dialect: 'ts' });

// A unit is one file read as script: its tree, and where its code starts in the file's text.
interface Unit {
  readonly file: string;
  readonly code: string;
  readonly offset: number;
  readonly root: SyntaxNode;
  readonly json: boolean;
}

interface Context {
  readonly environment: BoundTextEnvironment;
  readonly units: Map<string, Unit | undefined>;
  hops: number;
}

type Step = { readonly kind: 'key'; readonly name: string } | { readonly kind: 'index'; readonly at: number };
type Want = 'string' | 'list';
type Found =
  | { readonly kind: 'site'; readonly site: BoundTextSite }
  | { readonly kind: 'list'; readonly count: number }
  | { readonly kind: 'block'; readonly block: BoundTextBlock };

const PATH_TOKEN = /^(?:\??\.([A-Za-z_$][\w$]*)|\[(\d{1,6})\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\])/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

/** The path an expression names (`a.b[0]["c"]`) as a root and steps, or undefined when it is code. */
export function parseBoundPath(expression: string): { readonly root: string; readonly steps: readonly Step[] } | undefined {
  const text = expression.trim();
  if (text.length === 0 || text.length > BOUND_TEXT_LIMITS.expressionCharsMax) {
    return undefined;
  }
  const root = IDENTIFIER.exec(text)?.[0];
  if (root === undefined) {
    return undefined;
  }
  const steps: Step[] = [];
  let rest = text.slice(root.length);
  while (rest.length > 0) {
    const token = PATH_TOKEN.exec(rest);
    if (token === null || steps.length >= BOUND_TEXT_LIMITS.stepsMax) {
      return undefined;
    }
    const [whole, name, digits, doubled, singled] = token;
    if (name !== undefined) {
      steps.push({ kind: 'key', name });
    } else if (digits !== undefined) {
      steps.push({ kind: 'index', at: Number(digits) });
    } else {
      const quoted = doubled ?? singled;
      const decoded = quoted === undefined ? undefined : decodeStringLiteral(`"${quoted.replaceAll('"', '\\"').replaceAll("\\'", "'")}"`);
      if (decoded === undefined) {
        return undefined;
      }
      steps.push({ kind: 'key', name: decoded });
    }
    rest = rest.slice(whole.length);
  }
  assert(steps.length <= BOUND_TEXT_LIMITS.stepsMax, 'A bound path stays within its step bound');
  return { root, steps };
}

/** The expression as one path text, after `loops` are replaced by the list items they stand on: `card.title` in item 2 of `cards` reads `cards[2].title`. */
export function expressionInLoops(expression: string, loops: readonly BoundTextLoop[]): string {
  assert(loops.length <= BOUND_TEXT_LIMITS.stepsMax, 'Loops nest within their bound');
  let text = expression.trim();
  for (let depth = loops.length - 1; depth >= 0; depth--) {
    const loop = loops[depth];
    assert(loop !== undefined, 'Each nesting depth has a loop');
    const parsed = parseBoundPath(text);
    if (parsed !== undefined && parsed.root === loop.item) {
      text = `${loop.list}[${loop.index}]${text.slice(loop.item.length)}`;
    }
  }
  return text;
}

/** The loop a `map` node's head names: its item, and the list as a path. Undefined when the head is code the walk cannot follow. */
export function boundLoopOf(head: string): { readonly item: string; readonly list: string } | undefined {
  const parsed = parseLoopHead(head);
  if (parsed === undefined) {
    return undefined;
  }
  const source = loopSourcePath(parsed.source);
  if (source === undefined || source.kind !== 'list') {
    return undefined;
  }
  return { item: parsed.item, list: source.path };
}

/** The string literal `expression` reads, or why it cannot be written back. */
export async function resolveBoundText(environment: BoundTextEnvironment, expression: string): Promise<BoundTextOutcome> {
  const found = await resolveBound(environment, expression, 'string');
  if (found.kind === 'site') {
    return { ok: true, site: found.site };
  }
  return found.kind === 'block' ? { ok: false, block: found.block } : { ok: false, block: notText(environment.page.file, expression) };
}

/** How many items the list literal `expression` names holds, for a loop's per-item targets. */
export async function resolveBoundList(environment: BoundTextEnvironment, expression: string): Promise<BoundListOutcome> {
  const found = await resolveBound(environment, expression, 'list');
  if (found.kind === 'list') {
    return { ok: true, count: found.count };
  }
  return found.kind === 'block' ? { ok: false, block: found.block } : { ok: false, block: notText(environment.page.file, expression) };
}

async function resolveBound(environment: BoundTextEnvironment, expression: string, want: Want): Promise<Found> {
  const path = parseBoundPath(expression);
  const pageFile = environment.page.file;
  if (path === undefined) {
    return { kind: 'block', block: classifyCode(expression, pageFile) };
  }
  const context: Context = { environment, units: new Map(), hops: 0 };
  const page = pageUnit(environment.page);
  if (page === undefined) {
    return blocked('unreadable', pageFile, 'The page has no frontmatter to read.');
  }
  return lookup(context, page, path.root, path.steps, want);
}

function notText(file: string, expression: string): BoundTextBlock {
  return { reason: 'not-text', file, detail: `${expression.trim()} is not a string.` };
}

function blocked(reason: BoundTextBlockReason, file: string, detail: string): Found {
  return { kind: 'block', block: { reason, file, detail } };
}

// What an expression that is not a path is: said by its shape, never evaluated.
function classifyCode(expression: string, file: string): BoundTextBlock {
  const text = expression.trim();
  if (text.startsWith('`')) {
    return { reason: 'template', file, detail: 'A template with expressions builds this text.' };
  }
  if (/[+]/.test(text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''))) {
    return { reason: 'concatenation', file, detail: 'Pieces are joined to build this text.' };
  }
  if (text.includes('(')) {
    return { reason: 'call', file, detail: 'A function call produces this text.' };
  }
  return { reason: 'computed', file, detail: 'An expression computes this text.' };
}

function pageUnit(page: BoundTextModule): Unit | undefined {
  const head = /^---\r?\n/.exec(page.text);
  if (head === null) {
    return undefined;
  }
  const close = /\r?\n---/.exec(page.text.slice(head[0].length));
  if (close === null) {
    return undefined;
  }
  const code = page.text.slice(head[0].length, head[0].length + close.index);
  return { file: page.file, code, offset: head[0].length, root: typescript.parse(code).topNode, json: false };
}

function moduleUnit(read: BoundTextModule): Unit | undefined {
  if (/\.json$/i.test(read.file)) {
    const code = `(${read.text})`;
    return { file: read.file, code, offset: -1, root: typescript.parse(code).topNode, json: true };
  }
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(read.file)) {
    return undefined;
  }
  return { file: read.file, code: read.text, offset: 0, root: typescript.parse(read.text).topNode, json: false };
}

const text = (unit: Unit, node: SyntaxNode): string => unit.code.slice(node.from, node.to);

function children(node: SyntaxNode): SyntaxNode[] {
  const list: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (!child.name.endsWith('Comment')) {
      list.push(child);
    }
  }
  return list;
}

// `value as const`, `value satisfies T` and `(value)` read as `value`.
function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  for (let depth = 0; depth < BOUND_TEXT_LIMITS.hopsMax; depth++) {
    const parts = children(current);
    const [first, second] = parts;
    if (current.name === 'ParenthesizedExpression' && parts.length === 3 && parts[1] !== undefined) {
      current = parts[1];
    } else if (current.name === 'BinaryExpression' && first !== undefined && (second?.name === 'as' || second?.name === 'satisfies')) {
      current = first;
    } else {
      return current;
    }
  }
  return current;
}

// A top-level declaration of `name`: its initialiser, or why there is none.
function declaredValue(
  unit: Unit,
  name: string,
): { readonly kind: 'value'; readonly node: SyntaxNode } | { readonly kind: 'block'; readonly found: Found } | undefined {
  let definitions = 0;
  unit.root.cursor().iterate((entry) => {
    if (entry.name === 'VariableDefinition' && unit.code.slice(entry.from, entry.to) === name && entry.node.parent?.name !== 'ImportGroup') {
      definitions++;
    }
  });
  const top: SyntaxNode[] = [];
  for (const child of children(unit.root)) {
    const declaration = child.name === 'ExportDeclaration' ? child.getChild('VariableDeclaration') : child;
    if (declaration?.name === 'VariableDeclaration') {
      top.push(declaration);
    }
  }
  for (const declaration of top) {
    const parts = children(declaration);
    const definition = parts.find((part) => part.name === 'VariableDefinition');
    if (definition === undefined || text(unit, definition) !== name) {
      continue;
    }
    if (definitions !== 1) {
      return { kind: 'block', found: blocked('ambiguous', unit.file, `${name} is declared more than once.`) };
    }
    if (parts[0]?.name !== 'const') {
      return { kind: 'block', found: blocked('mutable', unit.file, `${name} can change while the page runs.`) };
    }
    const equals = parts.findIndex((part) => part.name === 'Equals');
    const value = equals === -1 ? undefined : parts[equals + 1];
    return value === undefined ? { kind: 'block', found: blocked('computed', unit.file, `${name} has no value written out.`) } : { kind: 'value', node: value };
  }
  return undefined;
}

interface ImportEntry {
  readonly spec: string;
  readonly imported: string;
}

// The names a unit imports: local name to the export it reads. A namespace import has no entry.
function importOf(unit: Unit, name: string): ImportEntry | undefined {
  for (const declaration of children(unit.root)) {
    if (declaration.name !== 'ImportDeclaration') {
      continue;
    }
    const parts = children(declaration);
    const specifier = parts.find((part) => part.name === 'String');
    // `import * as ns` names the module, not an export of it (namespaceOf).
    if (specifier === undefined || parts[1]?.name === 'type' || parts.some((part) => part.name === 'Star')) {
      continue;
    }
    const spec = decodeStringLiteral(text(unit, specifier));
    if (spec === undefined) {
      continue;
    }
    const direct = parts.find((part) => part.name === 'VariableDefinition');
    if (direct !== undefined && text(unit, direct) === name) {
      return { spec, imported: 'default' };
    }
    const group = parts.find((part) => part.name === 'ImportGroup');
    const names = group === undefined ? [] : children(group).filter((part) => part.name === 'VariableName' || part.name === 'VariableDefinition');
    for (let index = 0; index < names.length; index++) {
      const entry = names[index];
      const next = names[index + 1];
      if (entry === undefined) {
        continue;
      }
      const aliased = entry.name === 'VariableName' && next?.name === 'VariableDefinition' && text(unit, declaration).includes(' as ');
      if (aliased && next !== undefined && text(unit, next) === name) {
        return { spec, imported: text(unit, entry) };
      }
      if (
        entry.name === 'VariableDefinition' &&
        text(unit, entry) === name &&
        !(names[index - 1]?.name === 'VariableName' && text(unit, declaration).includes(' as '))
      ) {
        return { spec, imported: name };
      }
    }
  }
  return undefined;
}

async function lookup(context: Context, unit: Unit, name: string, steps: readonly Step[], want: Want): Promise<Found> {
  context.hops++;
  if (context.hops > BOUND_TEXT_LIMITS.hopsMax) {
    return blocked('computed', unit.file, 'Too many names stand between the text and its value.');
  }
  const declared = declaredValue(unit, name);
  if (declared?.kind === 'block') {
    return declared.found;
  }
  if (declared?.kind === 'value') {
    return evaluate(context, unit, declared.node, steps, want);
  }
  const imported = importOf(unit, name);
  if (imported !== undefined) {
    return exported(context, unit, imported, steps, want);
  }
  const namespace = namespaceOf(unit, name);
  const first = steps[0];
  if (namespace !== undefined && first?.kind === 'key') {
    return exported(context, unit, { spec: namespace, imported: first.name }, steps.slice(1), want);
  }
  const destructured = destructuredFrom(unit, name);
  if (destructured?.kind === 'block') {
    return destructured.found;
  }
  if (destructured?.kind === 'value') {
    return evaluateFrom(context, unit, destructured.init, [{ kind: 'key', name: destructured.key }, ...steps], want);
  }
  if (new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*Astro\\.props`).test(unit.code) || name === 'Astro') {
    return blocked('prop', unit.file, `${name} is a prop this file receives.`);
  }
  return blocked('runtime', unit.file, `${name} is not a constant this file writes out.`);
}

// A module by its specifier from `from`, read once per expression and bounded: the unit, or why there is none.
async function loadUnit(context: Context, from: Unit, spec: string): Promise<Unit | Found> {
  const key = `${from.file}\u0000${spec}`;
  if (!context.units.has(key)) {
    if (context.units.size >= BOUND_TEXT_LIMITS.modulesMax) {
      return blocked('unsupported', spec, 'More modules than one binding is followed through.');
    }
    const read = await context.environment.readModule(from.file, spec).catch(() => undefined);
    context.units.set(key, read === undefined ? undefined : moduleUnit(read));
  }
  return context.units.get(key) ?? blocked('unsupported', from.file, `${spec} is not a project script or JSON file.`);
}

const isFound = (value: Unit | Found): value is Found => 'kind' in value && typeof value.kind === 'string' && !('root' in value);

async function exported(context: Context, from: Unit, entry: ImportEntry, steps: readonly Step[], want: Want): Promise<Found> {
  const unit = await loadUnit(context, from, entry.spec);
  return isFound(unit) ? unit : exportedFrom(context, unit, entry.imported, steps, want);
}

async function exportedFrom(context: Context, unit: Unit, name: string, steps: readonly Step[], want: Want): Promise<Found> {
  context.hops++;
  if (context.hops > BOUND_TEXT_LIMITS.hopsMax) {
    return blocked('computed', unit.file, 'Too many names stand between the text and its value.');
  }
  if (unit.json) {
    return jsonExport(context, unit, name, steps, want);
  }
  const body = children(unit.root);
  for (const statement of body) {
    if (statement.name !== 'ExportDeclaration') {
      continue;
    }
    const parts = children(statement);
    if (name === 'default' && parts.some((part) => part.name === 'default')) {
      const value = parts[parts.findIndex((part) => part.name === 'default') + 1];
      if (value === undefined) {
        continue;
      }
      return value.name === 'VariableName' ? lookup(context, unit, text(unit, value), steps, want) : evaluate(context, unit, value, steps, want);
    }
    const declaration = parts.find((part) => part.name === 'VariableDeclaration');
    const definition = declaration === undefined ? undefined : children(declaration).find((part) => part.name === 'VariableDefinition');
    if (name !== 'default' && definition !== undefined && text(unit, definition) === name) {
      return lookup(context, unit, name, steps, want);
    }
    const listed = await exportList(context, unit, parts, name, steps, want);
    if (listed !== undefined) {
      return listed;
    }
  }
  return blocked('missing', unit.file, `${unit.file} does not export ${name}.`);
}

// `export { a as b }` and `export { a } from './other'`: the entry that exports `name`.
async function exportList(
  context: Context,
  unit: Unit,
  parts: readonly SyntaxNode[],
  name: string,
  steps: readonly Step[],
  want: Want,
): Promise<Found | undefined> {
  const group = parts.find((part) => part.name === 'ExportGroup');
  if (group === undefined) {
    return undefined;
  }
  const from = parts.find((part) => part.name === 'String');
  const names = children(group).filter((part) => part.name === 'VariableName' || part.name === 'VariableDefinition');
  const spelled = text(unit, group);
  for (let index = 0; index < names.length; index++) {
    const local = names[index];
    const after = names[index + 1];
    if (local === undefined) {
      continue;
    }
    const aliased = after !== undefined && new RegExp(`\\b${text(unit, local)}\\s+as\\s+${text(unit, after)}\\b`).test(spelled);
    const exportedName = aliased && after !== undefined ? text(unit, after) : text(unit, local);
    if (exportedName !== name) {
      continue;
    }
    if (from === undefined) {
      return lookup(context, unit, text(unit, local), steps, want);
    }
    const spec = decodeStringLiteral(text(unit, from));
    return spec === undefined ? undefined : exported(context, unit, { spec, imported: text(unit, local) }, steps, want);
  }
  return undefined;
}

async function jsonExport(context: Context, unit: Unit, name: string, steps: readonly Step[], want: Want): Promise<Found> {
  const statement = children(unit.root)[0];
  const parenthesized = statement === undefined ? undefined : children(statement)[0];
  const document = parenthesized === undefined ? undefined : children(parenthesized)[1];
  if (document === undefined) {
    return blocked('unreadable', unit.file, 'The JSON file has no value.');
  }
  if (name === 'default') {
    return evaluate(context, unit, document, steps, want);
  }
  return evaluate(context, unit, document, [{ kind: 'key', name }, ...steps], want);
}

async function evaluate(context: Context, unit: Unit, node: SyntaxNode, steps: readonly Step[], want: Want): Promise<Found> {
  const inner = unwrap(node);
  const step = steps[0];
  switch (inner.name) {
    case 'String':
    case 'TemplateString':
      return step === undefined && want === 'string'
        ? literalSite(unit, inner)
        : blocked('not-text', unit.file, 'This value is a string, not a list or an object.');
    case 'ObjectExpression':
      return step === undefined
        ? blocked('not-text', unit.file, 'This value is an object, not text.')
        : evaluateMember(context, unit, inner, step, steps.slice(1), want);
    case 'ArrayExpression':
      return evaluateItem(context, unit, inner, step, steps.slice(1), want);
    case 'VariableName':
      return lookup(context, unit, text(unit, inner), steps, want);
    case 'MemberExpression':
      return evaluateMemberChain(context, unit, inner, steps, want);
    case 'BinaryExpression':
      return blocked('concatenation', unit.file, 'Pieces are joined to build this text.');
    case 'CallExpression':
    case 'AwaitExpression':
      return blocked('call', unit.file, 'A function call produces this value.');
    default:
      return blocked('computed', unit.file, 'An expression computes this value.');
  }
}

// `other.field.deeper` as a value: the same walk, from `other`.
async function evaluateMemberChain(context: Context, unit: Unit, node: SyntaxNode, steps: readonly Step[], want: Want): Promise<Found> {
  const path = parseBoundPath(text(unit, node));
  if (path === undefined) {
    return blocked('computed', unit.file, 'An expression computes this value.');
  }
  return lookup(context, unit, path.root, [...path.steps, ...steps], want);
}

async function evaluateItem(context: Context, unit: Unit, node: SyntaxNode, step: Step | undefined, rest: readonly Step[], want: Want): Promise<Found> {
  const items = children(node).filter((part) => part.name !== '[' && part.name !== ']' && part.name !== ',');
  if (items.some((item) => item.name === 'Spread')) {
    return blocked('computed', unit.file, 'A spread in this list builds some of its items.');
  }
  if (step === undefined) {
    return want === 'list' ? { kind: 'list', count: items.length } : blocked('not-text', unit.file, 'This value is a list, not text.');
  }
  const item = step.kind === 'index' ? items[step.at] : undefined;
  if (item === undefined) {
    return blocked('missing', unit.file, step.kind === 'index' ? `The list has no item ${step.at}.` : 'A list has items by number, not by name.');
  }
  return evaluate(context, unit, item, rest, want);
}

async function evaluateMember(context: Context, unit: Unit, node: SyntaxNode, step: Step, rest: readonly Step[], want: Want): Promise<Found> {
  const wanted = step.kind === 'key' ? step.name : String(step.at);
  const properties = children(node).filter((part) => part.name === 'Property');
  const named = properties.filter((property) => {
    const key = children(property)[0];
    return (
      (key?.name === 'PropertyDefinition' && text(unit, key) === wanted) ||
      (key?.name === 'String' && decodeStringLiteral(text(unit, key)) === wanted) ||
      (key?.name === 'Number' && text(unit, key) === wanted)
    );
  });
  if (named.length > 1) {
    return blocked('ambiguous', unit.file, `${wanted} is written more than once.`);
  }
  // Later entries win over earlier ones, as the language reads them: the last spread or key that has the name decides.
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index];
    const parts = property === undefined ? [] : children(property);
    if (property !== undefined && property === named[0]) {
      return evaluateProperty(context, unit, parts, wanted, rest, want);
    }
    const spread = parts[0]?.name === 'Spread' ? parts[1] : undefined;
    if (spread === undefined) {
      continue;
    }
    const found = await evaluateFrom(context, unit, spread, [{ kind: 'key', name: wanted }, ...rest], want);
    if (found.kind !== 'block' || found.block.reason !== 'missing') {
      return found.kind === 'block' && found.block.reason === 'runtime' ? blocked('computed', unit.file, `A spread may supply ${wanted}.`) : found;
    }
  }
  return blocked('missing', unit.file, `${wanted} is not written in this object.`);
}

async function evaluateProperty(context: Context, unit: Unit, parts: readonly SyntaxNode[], wanted: string, rest: readonly Step[], want: Want): Promise<Found> {
  const colon = parts.findIndex((part) => part.name === ':');
  if (colon === -1) {
    // `{ title }`: the value is the name.
    return parts.length === 1 ? lookup(context, unit, wanted, rest, want) : blocked('computed', unit.file, `${wanted} is a method.`);
  }
  const value = parts[colon + 1];
  return value === undefined ? blocked('computed', unit.file, `${wanted} has no value.`) : evaluate(context, unit, value, rest, want);
}

function literalSite(unit: Unit, node: SyntaxNode): Found {
  const raw = text(unit, node);
  if (node.name === 'TemplateString' && children(node).some((part) => part.name === 'Interpolation')) {
    return blocked('template', unit.file, 'A template with expressions builds this text.');
  }
  const value = decodeStringLiteral(raw);
  if (value === undefined) {
    return blocked('computed', unit.file, 'This string uses an escape that is not read.');
  }
  const first = raw.charAt(0);
  const quote: StringQuote = unit.json ? 'json' : first === "'" ? "'" : first === '`' ? '`' : '"';
  const start = node.from + unit.offset;
  const end = node.to + unit.offset;
  assert(end - start === raw.length, 'A site spans exactly its literal');
  assert(start >= 0, 'A site starts inside its file');
  return { kind: 'site', site: { file: unit.file === '' ? '' : unit.file, start, end, quote, value, raw } };
}

// `import * as homeContent from "@lib/homepage/content"`: lezer reports the star as an error, so the line is read as text.
function namespaceOf(unit: Unit, name: string): string | undefined {
  for (const statement of children(unit.root)) {
    if (statement.name !== 'ImportDeclaration') {
      continue;
    }
    const match = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/.exec(text(unit, statement));
    if (match?.[1] === name && match[3] !== undefined) {
      return match[3];
    }
  }
  return undefined;
}

type Destructured = { readonly kind: 'value'; readonly init: SyntaxNode; readonly key: string } | { readonly kind: 'block'; readonly found: Found };

// `const { a, b: c } = await getPage("home")`: the initialiser, and the property `name` is read from it.
function destructuredFrom(unit: Unit, name: string): Destructured | undefined {
  for (const statement of children(unit.root)) {
    const declaration = statement.name === 'ExportDeclaration' ? statement.getChild('VariableDeclaration') : statement;
    const parts = declaration?.name === 'VariableDeclaration' ? children(declaration) : [];
    const pattern = parts.find((part) => part.name === 'ObjectPattern');
    const equals = parts.findIndex((part) => part.name === 'Equals');
    const init = equals === -1 ? undefined : parts[equals + 1];
    if (pattern === undefined || init === undefined) {
      continue;
    }
    for (const entry of children(pattern).filter((part) => part.name === 'PatternProperty')) {
      const bits = children(entry);
      const key = bits[0]?.name === 'PropertyName' ? text(unit, bits[0]) : undefined;
      const local = bits[1]?.name === ':' && bits[2]?.name === 'VariableDefinition' ? text(unit, bits[2]) : key;
      if (key === undefined || local !== name) {
        continue;
      }
      return parts[0]?.name === 'const'
        ? { kind: 'value', init, key }
        : { kind: 'block', found: blocked('mutable', unit.file, `${name} can change while the page runs.`) };
    }
  }
  return undefined;
}

// A value in the place `node` stands: a call is followed into the function it names, anything else is read as the value it is.
async function evaluateFrom(context: Context, unit: Unit, node: SyntaxNode, steps: readonly Step[], want: Want): Promise<Found> {
  let inner = unwrap(node);
  if (inner.name === 'AwaitExpression') {
    const awaited = children(inner)[1];
    inner = awaited === undefined ? inner : unwrap(awaited);
  }
  if (inner.name !== 'CallExpression') {
    return evaluate(context, unit, inner, steps, want);
  }
  const [callee, args] = children(inner);
  if (callee?.name !== 'VariableName' || args?.name !== 'ArgList') {
    return blocked('call', unit.file, 'A function call produces this value.');
  }
  const found = await functionNamed(context, unit, text(unit, callee), 0);
  if (!('node' in found)) {
    return found;
  }
  const literals = children(args)
    .filter((part) => part.name !== '(' && part.name !== ')' && part.name !== ',')
    .map((part) => (part.name === 'String' ? decodeStringLiteral(text(unit, part)) : undefined));
  return returnedValue(context, found, literals, steps, want);
}

interface FunctionAt {
  readonly unit: Unit;
  readonly node: SyntaxNode;
}

// The top-level function `name` has in `unit` (a declaration with a body, or a const arrow), or in the module it imports or re-exports it from.
async function functionNamed(context: Context, unit: Unit, name: string, depth: number): Promise<FunctionAt | Found> {
  assert(depth <= LIMITS.treeDepthMax, 'A function is looked up through a bounded chain of re-exports');
  context.hops++;
  if (context.hops > BOUND_TEXT_LIMITS.hopsMax) {
    return blocked('computed', unit.file, 'Too many names stand between the text and its value.');
  }
  for (const statement of children(unit.root)) {
    const inner = statement.name === 'ExportDeclaration' ? (statement.getChild('FunctionDeclaration') ?? statement.getChild('VariableDeclaration')) : statement;
    const parts = inner === null ? [] : children(inner);
    if (
      inner?.name === 'FunctionDeclaration' &&
      parts.some((part) => part.name === 'Block') &&
      parts.find((part) => part.name === 'VariableDefinition') !== undefined
    ) {
      if (text(unit, parts.find((part) => part.name === 'VariableDefinition') ?? inner) === name) {
        return { unit, node: inner };
      }
    }
    if (inner?.name === 'VariableDeclaration' && parts.find((part) => part.name === 'VariableDefinition') !== undefined) {
      const arrow = parts.find((part) => part.name === 'ArrowFunction');
      if (arrow !== undefined && text(unit, parts.find((part) => part.name === 'VariableDefinition') ?? inner) === name) {
        return { unit, node: arrow };
      }
    }
  }
  const imported = importOf(unit, name);
  const viaList = imported === undefined ? reexportOf(unit, name) : undefined;
  const entry = imported ?? viaList;
  if (entry === undefined) {
    return blocked('runtime', unit.file, `${name} is not a function this file writes out.`);
  }
  const target = await loadUnit(context, unit, entry.spec);
  return isFound(target) ? target : functionNamed(context, target, entry.imported, depth + 1);
}

// `export { a as b } from './x'` or `export * from './x'`: where `name` is exported from, when a module's own list does.
function reexportOf(unit: Unit, name: string): ImportEntry | undefined {
  for (const statement of children(unit.root)) {
    if (statement.name !== 'ExportDeclaration') {
      continue;
    }
    const source = /\bfrom\s+(['"])([^'"]+)\1/.exec(text(unit, statement))?.[2];
    const list = /^export\s*\{([^}]*)\}/.exec(text(unit, statement))?.[1];
    if (source === undefined || list === undefined) {
      continue;
    }
    for (const part of list.split(',')) {
      const [local, exportedName] = part.trim().split(/\s+as\s+/);
      if ((exportedName ?? local) === name && local !== undefined) {
        return { spec: source, imported: local.trim() };
      }
    }
  }
  return undefined;
}

// What the function returns for these literal arguments: the returns its own guards leave possible, each read for the property, and one answer or none.
async function returnedValue(
  context: Context,
  called: FunctionAt,
  literals: readonly (string | undefined)[],
  steps: readonly Step[],
  want: Want,
): Promise<Found> {
  const body = children(called.node).find((part) => part.name === 'Block');
  const params = children(children(called.node).find((part) => part.name === 'ParamList') ?? called.node)
    .filter((part) => part.name === 'VariableDefinition')
    .map((part) => text(called.unit, part));
  if (body === undefined) {
    return blocked('computed', called.unit.file, 'This function has no body to read.');
  }
  const scope = new Map<string, string>();
  params.forEach((param, index) => {
    const literal = literals[index];
    if (literal !== undefined) {
      scope.set(param, literal);
    }
  });
  const returns: SyntaxNode[] = [];
  collectReturns(called.unit, body, scope, returns, 0);
  if (returns.length === 0) {
    return blocked('computed', called.unit.file, 'No return of this function can be read.');
  }
  const answers: Found[] = [];
  for (const value of returns.slice(0, BOUND_TEXT_LIMITS.hopsMax)) {
    answers.push(await evaluateFrom(context, called.unit, value, steps, want));
  }
  return oneAnswer(answers, called.unit.file);
}

// Answers that agree are one answer; a missing key in one return is no answer; the rest cannot be told apart, so none is chosen.
function oneAnswer(answers: readonly Found[], file: string): Found {
  const present = answers.filter((answer) => !(answer.kind === 'block' && answer.block.reason === 'missing'));
  const [first] = present;
  if (first === undefined) {
    return answers[0] ?? blocked('missing', file, 'Nothing is returned for this.');
  }
  const same = (answer: Found) =>
    answer.kind === 'site' && first.kind === 'site'
      ? answer.site.file === first.site.file && answer.site.start === first.site.start
      : answer.kind === 'list' && first.kind === 'list' && answer.count === first.count;
  return present.every(same) ? first : present.length === 1 ? first : blocked('ambiguous', file, 'More than one return of this function can supply it.');
}

type Verdict = 'yes' | 'no' | 'unknown';

// The returns a function can make for known literal arguments, in the order they read, stopping at the first that must happen.
function collectReturns(unit: Unit, block: SyntaxNode, scope: ReadonlyMap<string, string>, into: SyntaxNode[], depth: number): boolean {
  assert(depth <= LIMITS.treeDepthMax, 'Function bodies nest within the tree depth bound');
  for (const statement of children(block).filter((part) => part.name !== '{' && part.name !== '}')) {
    if (statement.name === 'ReturnStatement') {
      const value = children(statement).find((part) => part.name !== 'return' && part.name !== ';');
      if (value !== undefined) {
        into.push(value);
      }
      return true;
    }
    if (statement.name !== 'IfStatement') {
      continue;
    }
    const parts = children(statement);
    const condition = parts.find((part) => part.name === 'ParenthesizedExpression');
    const branches = parts.filter((part) => part.name === 'Block');
    const verdict = condition === undefined ? 'unknown' : guard(unit, condition, scope, 0);
    const [then, otherwise] = branches;
    if (verdict !== 'no' && then !== undefined && collectReturns(unit, then, scope, into, depth + 1) && verdict === 'yes') {
      return true;
    }
    if (verdict !== 'yes' && otherwise !== undefined) {
      collectReturns(unit, otherwise, scope, into, depth + 1);
    }
  }
  return false;
}

// `id === "home"`, `a || b`, `a && b`, `!==`: decided only from arguments the call wrote as literals.
function guard(unit: Unit, node: SyntaxNode, scope: ReadonlyMap<string, string>, depth: number): Verdict {
  assert(depth <= LIMITS.treeDepthMax, 'A condition nests within the tree depth bound');
  const inner = node.name === 'ParenthesizedExpression' ? children(node)[1] : node;
  const parts = inner === undefined ? [] : children(inner);
  const [left, operator, right] = parts;
  if (inner?.name !== 'BinaryExpression' || left === undefined || operator === undefined || right === undefined) {
    return 'unknown';
  }
  const word = text(unit, operator);
  if (word === '||' || word === '&&') {
    const verdicts = [guard(unit, left, scope, depth + 1), guard(unit, right, scope, depth + 1)];
    if (word === '||') {
      return verdicts.includes('yes') ? 'yes' : verdicts.every((verdict) => verdict === 'no') ? 'no' : 'unknown';
    }
    return verdicts.includes('no') ? 'no' : verdicts.every((verdict) => verdict === 'yes') ? 'yes' : 'unknown';
  }
  if (!['===', '==', '!==', '!='].includes(word)) {
    return 'unknown';
  }
  const name = left.name === 'VariableName' ? text(unit, left) : right.name === 'VariableName' ? text(unit, right) : undefined;
  const literal = left.name === 'String' ? decodeStringLiteral(text(unit, left)) : right.name === 'String' ? decodeStringLiteral(text(unit, right)) : undefined;
  const known = name === undefined ? undefined : scope.get(name);
  if (known === undefined || literal === undefined) {
    return 'unknown';
  }
  const equal = known === literal;
  return word.startsWith('!') ? (equal ? 'no' : 'yes') : equal ? 'yes' : 'no';
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
  $: '$',
};

/** The characters a quoted or backtick string literal spells, or undefined for a literal that needs evaluating (a template hole, a legacy octal escape). */
export function decodeStringLiteral(raw: string): string | undefined {
  const quote = raw.charAt(0);
  if (raw.length < 2 || raw.charAt(raw.length - 1) !== quote || (quote !== '"' && quote !== "'" && quote !== '`')) {
    return undefined;
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let at = 0; at < body.length; at++) {
    const character = body.charAt(at);
    if (character === quote && quote !== '`') {
      return undefined;
    }
    if (quote === '`' && character === '$' && body.charAt(at + 1) === '{') {
      return undefined;
    }
    if (character !== '\\') {
      if (quote !== '`' && (character === '\n' || character === '\r')) {
        return undefined;
      }
      out += character === '\r' && body.charAt(at + 1) === '\n' ? '' : character === '\r' ? '\n' : character;
      continue;
    }
    const decoded = decodeEscape(body, at + 1);
    if (decoded === undefined) {
      return undefined;
    }
    out += decoded.text;
    at = decoded.next - 1;
  }
  return out;
}

function decodeEscape(body: string, at: number): { readonly text: string; readonly next: number } | undefined {
  const character = body.charAt(at);
  const simple = SIMPLE_ESCAPES[character];
  if (simple !== undefined) {
    return { text: simple, next: at + 1 };
  }
  if (character === '\n') {
    return { text: '', next: at + 1 };
  }
  if (character === '\r') {
    return { text: '', next: body.charAt(at + 1) === '\n' ? at + 2 : at + 1 };
  }
  if (character === '0' && !/\d/.test(body.charAt(at + 1))) {
    return { text: '\0', next: at + 1 };
  }
  if (/\d/.test(character)) {
    return undefined;
  }
  if (character === 'x') {
    const digits = /^[0-9a-fA-F]{2}/.exec(body.slice(at + 1))?.[0];
    return digits === undefined ? undefined : { text: String.fromCharCode(parseInt(digits, 16)), next: at + 3 };
  }
  if (character === 'u') {
    return decodeUnicodeEscape(body, at + 1);
  }
  return { text: character, next: at + 1 };
}

function decodeUnicodeEscape(body: string, at: number): { readonly text: string; readonly next: number } | undefined {
  if (body.charAt(at) === '{') {
    const close = body.indexOf('}', at);
    const digits = close === -1 ? '' : body.slice(at + 1, close);
    const code = /^[0-9a-fA-F]{1,6}$/.test(digits) ? parseInt(digits, 16) : Number.NaN;
    return Number.isSafeInteger(code) && code <= 0x10ffff ? { text: String.fromCodePoint(code), next: close + 1 } : undefined;
  }
  const digits = /^[0-9a-fA-F]{4}/.exec(body.slice(at))?.[0];
  return digits === undefined ? undefined : { text: String.fromCharCode(parseInt(digits, 16)), next: at + 4 };
}

/** The literal that spells `value` in `quote`'s style: escaped as that quote needs, never evaluated. */
export function encodeStringLiteral(value: string, quote: StringQuote): string {
  if (quote === 'json') {
    return JSON.stringify(value);
  }
  let out = '';
  for (const character of value) {
    out += encodeCharacter(character, quote, value);
  }
  // Backtick templates spell `${` with an escaped dollar.
  const body = quote === '`' ? out.replaceAll('${', '\\${') : out;
  const literal = `${quote}${body}${quote}`;
  assert(decodeStringLiteral(literal) === value, 'An encoded literal reads back as its value');
  return literal;
}

function encodeCharacter(character: string, quote: '"' | "'" | '`', whole: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (character === '\\') {
    return '\\\\';
  }
  if (character === quote) {
    return `\\${quote}`;
  }
  if (character === '\n') {
    return quote === '`' ? '\n' : '\\n';
  }
  if (character === '\r') {
    return '\\r';
  }
  if (character === '\t') {
    return '\\t';
  }
  if (code < 0x20 || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) {
    return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  assert(whole.length > 0, 'An encoded character belongs to some text');
  return character;
}

/** The file text with the site's literal replaced by `value`, or undefined when the file no longer holds the literal the site read. */
export function rewriteBoundText(fileText: string, site: BoundTextSite, value: string): string | undefined {
  if (fileText.slice(site.start, site.end) !== site.raw) {
    return undefined;
  }
  return fileText.slice(0, site.start) + encodeStringLiteral(value, site.quote) + fileText.slice(site.end);
}
