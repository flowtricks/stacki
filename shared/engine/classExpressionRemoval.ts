// Taking one class out of a class expression: the value of `class:list={…}`, or
// of `class={…}` when it is an expression, edited in place so the class is no
// longer applied and nothing else changes.
//
// The Style panel's selector field lists the classes an element carries, and a
// chip selected then Delete takes its class off the element. A literal
// `class="a b"` is a word list; a class expression is code, so the class is
// found in the syntax tree (Lezer, the parser the renderer and Studio already
// load: jsScope.ts says why it and not the TypeScript compiler) and only the
// text that names it is spliced out. Everything else keeps its bytes: quotes,
// indentation, line breaks, trailing commas, comments.
//
// What counts as naming the class, and what removing it means, follows how
// Astro's class:list (clsx) reads each shape:
//
//   'a b'                  a word of the string: the word goes, the rest stay
//   `btn ${size}`          a whole word of the template's text; `btn-${x}` is
//                          part of a computed word and is left alone
//   [ … ]                  each entry is read the same way; an entry left with
//                          no class at all is removed, comma and line included
//   { b: on, 'c d': x }    a word of a key: the key loses the word, or the whole
//                          property goes when it was the only one (`{ active }`
//                          too: the key is the class, the value its condition)
//   cond && 'x'            the class is the right operand: the whole entry goes,
//                          since a condition guarding nothing applies nothing
//   cond ? 'a' : 'b'       an arm left with nothing becomes '', so the other arm
//                          still applies when its branch is taken; both arms
//                          empty (or one empty already) and the whole entry goes
//   a || 'y', a ?? 'y'     both operands are values; one left with nothing
//                          becomes '', both and the entry goes
//
// A name, a member, a call or a spread is a value computed when the page runs.
// It may well produce the class, but Stacki can't rewrite it safely, so those
// are reported (`computed`) for the person to change in code, with where they
// are written. Nothing is ever guessed: the edited code is parsed again and read
// again, and an edit that does not parse, or still names the class, is refused
// (`unreadable`), so a file is never written in a state Stacki did not check.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';

export const CLASS_EXPRESSION_LIMITS = {
  /** An attribute's value is bounded where it is parsed; past that it is refused, not walked. */
  codeCharsMax: LIMITS.attrCharsMax,
  /** Nesting of arrays, conditions and templates; a real class list nests two or three deep. */
  depthMax: 32,
  /** Computed entries reported back; the message shows the first, the rest is for tests and logs. */
  snippetsMax: 16,
} as const satisfies Record<string, number>;

/** How the expression's value is read: a class:list value (arrays, objects) or a string (`class={…}`). */
export type ClassExpressionContext = 'list' | 'string';

/** A computed piece of the expression, by offsets into the code that was read. */
export interface ClassExpressionSnippet {
  readonly code: string;
  readonly from: number;
  readonly to: number;
}

export type ClassExpressionRemoval =
  /** The class is gone from the code. `code` undefined: nothing is left, so the attribute goes. */
  | { readonly tag: 'edited'; readonly code: string | undefined; readonly occurrences: number }
  /** The code names no such class and computes nothing that could. */
  | { readonly tag: 'absent' }
  /** Only computed values could hold the class: they are where to look. */
  | { readonly tag: 'computed'; readonly snippets: readonly ClassExpressionSnippet[] }
  /** The code does not parse, is past a bound, or the edit could not be checked. Nothing to write. */
  | { readonly tag: 'unreadable'; readonly reason: ClassExpressionUnreadable };

export type ClassExpressionUnreadable = 'syntax' | 'limit' | 'verify';

/** `code` with every literal occurrence of the class `name` taken out, or why not. Never throws on input. */
export function removeClassFromExpression(code: string, name: string, context: ClassExpressionContext): ClassExpressionRemoval {
  assert(name.length > 0, 'removeClassFromExpression: a class has a name');
  assert(!/\s/.test(name), 'removeClassFromExpression: one class, no whitespace');
  if (code.length > CLASS_EXPRESSION_LIMITS.codeCharsMax) {
    return { tag: 'unreadable', reason: 'limit' };
  }
  const parsed = parseExpression(code);
  if (parsed === undefined) {
    return { tag: 'unreadable', reason: 'syntax' };
  }
  const plan = newPlan(parsed.text, name, quoteOf(parsed));
  const fate = visitValue(plan, parsed.root, context, 0);
  if (plan.limited) {
    return { tag: 'unreadable', reason: 'limit' };
  }
  if (plan.occurrences === 0) {
    assert(plan.edits.length === 0, 'removeClassFromExpression: nothing found, nothing edited');
    return plan.snippets.length === 0 ? { tag: 'absent' } : { tag: 'computed', snippets: snippetsOf(plan) };
  }
  if (fate === 'emptied') {
    return { tag: 'edited', code: undefined, occurrences: plan.occurrences };
  }
  const edited = applyReplacements(parsed.text, plan.edits);
  assert(edited.startsWith(WRAP_OPEN), 'removeClassFromExpression: the wrapper opens the edited text');
  assert(edited.endsWith(WRAP_CLOSE), 'removeClassFromExpression: the wrapper closes the edited text');
  const next = edited.slice(WRAP_OPEN.length, edited.length - WRAP_CLOSE.length);
  // Fail closed: the edit is only as good as a fresh read of what it wrote.
  if (classExpressionOccurrences(next, name, context) !== 0) {
    return { tag: 'unreadable', reason: 'verify' };
  }
  return { tag: 'edited', code: next, occurrences: plan.occurrences };
}

/**
 * How many times `code` names the class `name` literally, the way removal reads
 * it; undefined when the code does not parse or is past a bound.
 */
export function classExpressionOccurrences(code: string, name: string, context: ClassExpressionContext): number | undefined {
  assert(name.length > 0, 'classExpressionOccurrences: a class has a name');
  if (code.length > CLASS_EXPRESSION_LIMITS.codeCharsMax) {
    return undefined;
  }
  const parsed = parseExpression(code);
  if (parsed === undefined) {
    return undefined;
  }
  const plan = newPlan(parsed.text, name, quoteOf(parsed));
  visitValue(plan, parsed.root, context, 0);
  if (plan.limited) {
    return undefined;
  }
  assert(plan.occurrences >= 0, 'classExpressionOccurrences: a count is never negative');
  return plan.occurrences;
}

// ---------------------------------------------------------------------------
// Parsing. The code is read as `(code\n)`: the parentheses make `{ a: x }` an
// object rather than a block, and the newline keeps a trailing `// comment` from
// swallowing the closing parenthesis.
// ---------------------------------------------------------------------------

const WRAP_OPEN = '(';
const WRAP_CLOSE = '\n)';
const expressionParser = parser.configure({ dialect: 'ts' });
const COMMENTS: ReadonlySet<string> = new Set(['LineComment', 'BlockComment']);

interface ParsedExpression {
  readonly text: string;
  readonly root: SyntaxNode;
}

function parseExpression(code: string): ParsedExpression | undefined {
  const text = `${WRAP_OPEN}${code}${WRAP_CLOSE}`;
  const tree = expressionParser.parse(text);
  let broken = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) {
        broken = true;
      }
      return !broken;
    },
  });
  if (broken) {
    return undefined;
  }
  const statements = childrenOf(tree.topNode);
  const statement = statements[0];
  if (statements.length !== 1 || statement === undefined || statement.name !== 'ExpressionStatement') {
    return undefined;
  }
  const parenthesized = childrenOf(statement)[0];
  if (parenthesized === undefined || parenthesized.name !== 'ParenthesizedExpression') {
    return undefined;
  }
  // The wrapper's own parentheses, end to end: `(a)(b)` would be a call instead.
  if (parenthesized.from !== 0 || parenthesized.to !== text.length) {
    return undefined;
  }
  const inner = childrenOf(parenthesized).filter((child) => child.name !== '(' && child.name !== ')');
  const root = inner[0];
  if (inner.length !== 1 || root === undefined) {
    return undefined;
  }
  assert(root.from >= WRAP_OPEN.length, 'parseExpression: the expression starts inside the wrapper');
  assert(root.to <= text.length - WRAP_CLOSE.length + 1, 'parseExpression: the expression ends inside the wrapper');
  return { text, root };
}

// A node's children without comments. A node has fewer children than its text
// has characters, and the text is bounded (codeCharsMax), so the walk is too.
function childrenOf(node: SyntaxNode): readonly SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const childrenMax = node.to - node.from + 1;
  let child = node.firstChild;
  for (let index = 0; child !== null; index += 1) {
    assert(index < childrenMax, 'childrenOf: a node has fewer children than characters');
    if (!COMMENTS.has(child.name)) {
      out.push(child);
    }
    child = child.nextSibling;
  }
  return out;
}

// The quote the code already writes strings with, for the '' an emptied arm becomes.
function quoteOf(parsed: ParsedExpression): string {
  let quote: string | undefined = undefined;
  parsed.root.toTree().iterate({
    enter: (node) => {
      if (quote === undefined && node.name === 'String') {
        quote = parsed.text.charAt(parsed.root.from + node.from);
      }
      return quote === undefined;
    },
  });
  return quote ?? "'";
}

// ---------------------------------------------------------------------------
// The walk. Every value node answers whether it still gives classes ('kept',
// possibly with edits inside it) or gives none now ('emptied', with no edits
// inside it: the parent removes or replaces it whole). The plan is the one
// piece of mutable state, owned by the top-level call.
// ---------------------------------------------------------------------------

type Fate = 'kept' | 'emptied';

interface Replacement {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

// The walk's one piece of mutable state, owned by the top-level call: what was
// found, the edits that take it out, and the computed values seen on the way.
class Plan {
  readonly edits: Replacement[] = [];
  readonly snippets: Range[] = [];
  private found = 0;
  private overLimit = false;

  constructor(
    readonly text: string,
    readonly name: string,
    readonly quote: string,
  ) {}

  get occurrences(): number {
    return this.found;
  }

  get limited(): boolean {
    return this.overLimit;
  }

  count(removed: number): void {
    assert(removed > 0, 'Plan.count: something was found');
    this.found += removed;
  }

  markLimited(): void {
    this.overLimit = true;
  }
}

function newPlan(text: string, name: string, quote: string): Plan {
  return new Plan(text, name, quote);
}

function visitValue(plan: Plan, node: SyntaxNode, context: ClassExpressionContext, depth: number): Fate {
  if (depth > CLASS_EXPRESSION_LIMITS.depthMax) {
    plan.markLimited();
    return 'kept';
  }
  switch (node.name) {
    case 'String':
      return visitString(plan, node);
    case 'TemplateString':
      return visitTemplate(plan, node, depth);
    case 'ArrayExpression':
      // A string context would print an array with commas: not a class list there.
      return context === 'list' ? visitArray(plan, node, depth) : computed(plan, node);
    case 'ObjectExpression':
      return context === 'list' ? visitObject(plan, node) : computed(plan, node);
    case 'ConditionalExpression':
      return visitConditional(plan, node, context, depth);
    case 'BinaryExpression':
      return visitBinary(plan, node, context, depth);
    case 'ParenthesizedExpression': {
      const inner = childrenOf(node).filter((child) => child.name !== '(' && child.name !== ')');
      const only = inner[0];
      if (inner.length !== 1 || only === undefined) {
        return computed(plan, node);
      }
      return visitValue(plan, only, context, depth + 1);
    }
    case 'BooleanLiteral':
    case 'null':
    case 'Number':
      // No class: clsx skips booleans and nullish values, and a number is no class name.
      return 'kept';
    case 'VariableName':
      return textOf(plan, node) === 'undefined' ? 'kept' : computed(plan, node);
    default:
      return computed(plan, node);
  }
}

function computed(plan: Plan, range: Range): Fate {
  if (plan.snippets.length < CLASS_EXPRESSION_LIMITS.snippetsMax) {
    plan.snippets.push({ from: range.from, to: range.to });
  }
  return 'kept';
}

function visitString(plan: Plan, node: SyntaxNode): Fate {
  assert(node.to - node.from >= 2, 'visitString: a string has its quotes');
  const raw = plan.text.slice(node.from + 1, node.to - 1);
  const words = withoutWord(raw, plan.name, NOT_GLUED);
  if (words.removed === 0) {
    return 'kept';
  }
  plan.count(words.removed);
  if (words.keptCount === 0) {
    return 'emptied';
  }
  plan.edits.push({ from: node.from + 1, to: node.to - 1, text: words.text });
  return 'kept';
}

// A template's text between its holes. A word touching a hole (`btn-${size}`) is
// part of a word computed at run time, never the class itself. A hole standing
// alone between spaces is a value of its own (`${open ? 'is-open' : ''}`) and is
// read like one; a hole left with nothing is taken out, `${}` and all.
function visitTemplate(plan: Plan, node: SyntaxNode, depth: number): Fate {
  const holes = childrenOf(node).filter((child) => child.name === 'Interpolation');
  const segments: Range[] = [];
  let start = node.from + 1;
  for (const hole of holes) {
    segments.push({ from: start, to: hole.from });
    start = hole.to;
  }
  segments.push({ from: start, to: node.to - 1 });
  assert(segments.length === holes.length + 1, 'visitTemplate: text sits around every hole');
  let keptWords = 0;
  for (const [index, segment] of segments.entries()) {
    const raw = plan.text.slice(segment.from, segment.to);
    const glue = { start: index > 0, end: index < holes.length };
    const words = withoutWord(raw, plan.name, glue);
    keptWords += words.keptCount;
    if (words.removed === 0) {
      continue;
    }
    plan.count(words.removed);
    // Two holes still need a space between them, or their words would run together.
    const text = words.keptCount > 0 ? words.text : glue.start && glue.end ? ' ' : '';
    plan.edits.push({ from: segment.from, to: segment.to, text });
  }
  let keptHoles = 0;
  for (const hole of holes) {
    const inner = childrenOf(hole).filter((child) => child.name !== 'InterpolationStart' && child.name !== 'InterpolationEnd');
    const value = inner[0];
    const before = plan.text.charAt(hole.from - 1);
    const after = plan.text.charAt(hole.to);
    const alone = (hole.from - 1 === node.from || /\s/.test(before)) && (hole.to + 1 === node.to || /\s/.test(after));
    if (inner.length !== 1 || value === undefined || !alone) {
      computed(plan, hole);
      keptHoles += 1;
      continue;
    }
    if (visitValue(plan, value, 'string', depth + 1) === 'emptied') {
      plan.edits.push({ from: hole.from, to: hole.to, text: '' });
    } else {
      keptHoles += 1;
    }
  }
  // Nothing left to give: no word and no hole. A template of spaces is no class.
  if (keptWords === 0 && keptHoles === 0 && plan.occurrences > 0) {
    dropEditsWithin(plan, node);
    return 'emptied';
  }
  return 'kept';
}

function visitArray(plan: Plan, node: SyntaxNode, depth: number): Fate {
  const elements = listItems(childrenOf(node), '[', ']');
  const emptied = new Set<number>();
  for (const [index, element] of elements.entries()) {
    const first = element.nodes[0];
    assert(first !== undefined, 'visitArray: an element has a node');
    if (first.name === 'Spread' || element.nodes.length !== 1) {
      computed(plan, element);
      continue;
    }
    if (visitValue(plan, first, 'list', depth + 1) === 'emptied') {
      emptied.add(index);
    }
  }
  return removeItems(plan, node, elements, emptied);
}

function visitObject(plan: Plan, node: SyntaxNode): Fate {
  const properties = listItems(childrenOf(node), '{', '}');
  const emptied = new Set<number>();
  for (const [index, property] of properties.entries()) {
    const only = property.nodes[0];
    if (property.nodes.length !== 1 || only === undefined || only.name !== 'Property') {
      computed(plan, property);
      continue;
    }
    if (visitProperty(plan, only) === 'emptied') {
      emptied.add(index);
    }
  }
  return removeItems(plan, node, properties, emptied);
}

// A key names classes; its value is only their condition, so it is never read
// for classes. `{ active }` is the shorthand for `{ active: active }`.
function visitProperty(plan: Plan, property: SyntaxNode): Fate {
  const parts = childrenOf(property);
  const key = parts[0];
  if (key === undefined || parts.some((part) => part.name === 'ParamList')) {
    return computed(plan, property);
  }
  if (key.name === 'PropertyDefinition') {
    if (textOf(plan, key) !== plan.name) {
      return 'kept';
    }
    plan.count(1);
    return 'emptied';
  }
  if (key.name !== 'String') {
    // `[name]: on`, `...rest`, a numeric key or an accessor: computed, or no class.
    return computed(plan, property);
  }
  const raw = plan.text.slice(key.from + 1, key.to - 1);
  const words = withoutWord(raw, plan.name, NOT_GLUED);
  if (words.removed === 0) {
    return 'kept';
  }
  plan.count(words.removed);
  if (words.keptCount === 0) {
    return 'emptied';
  }
  plan.edits.push({ from: key.from + 1, to: key.to - 1, text: words.text });
  return 'kept';
}

function visitConditional(plan: Plan, node: SyntaxNode, context: ClassExpressionContext, depth: number): Fate {
  const operands = childrenOf(node).filter((child) => child.name !== 'LogicOp');
  const consequent = operands[1];
  const alternate = operands[2];
  if (operands.length !== 3 || consequent === undefined || alternate === undefined) {
    return computed(plan, node);
  }
  // The test is a condition, not a class: never read.
  const consequentFate = visitValue(plan, consequent, context, depth + 1);
  const alternateFate = visitValue(plan, alternate, context, depth + 1);
  return emptiedOperands(plan, [
    { node: consequent, fate: consequentFate },
    { node: alternate, fate: alternateFate },
  ]);
}

function visitBinary(plan: Plan, node: SyntaxNode, context: ClassExpressionContext, depth: number): Fate {
  const parts = childrenOf(node);
  const left = parts[0];
  const operator = parts[1];
  const right = parts[2];
  if (parts.length !== 3 || left === undefined || operator === undefined || right === undefined || operator.name !== 'LogicOp') {
    // `'btn-' + size`, a comparison: computed.
    return computed(plan, node);
  }
  const symbol = textOf(plan, operator);
  if (symbol === '&&') {
    // The left side only decides; a condition that guards no class applies nothing.
    return visitValue(plan, right, context, depth + 1);
  }
  if (symbol === '||' || symbol === '??') {
    const leftFate = visitValue(plan, left, context, depth + 1);
    const rightFate = visitValue(plan, right, context, depth + 1);
    return emptiedOperands(plan, [
      { node: left, fate: leftFate },
      { node: right, fate: rightFate },
    ]);
  }
  return computed(plan, node);
}

// Operands either of which may be the value: an emptied one becomes '' so the
// others still apply as written; when nothing is left the whole expression is
// emptied and the parent takes it out.
function emptiedOperands(plan: Plan, operands: readonly { readonly node: SyntaxNode; readonly fate: Fate }[]): Fate {
  assert(operands.length === 2, 'emptiedOperands: two operands');
  const gone = operands.filter((operand) => operand.fate === 'emptied');
  if (gone.length === 0) {
    return 'kept';
  }
  const nothingLeft = operands.every((operand) => operand.fate === 'emptied' || isNoClass(plan, operand.node));
  if (nothingLeft) {
    for (const operand of operands) {
      dropEditsWithin(plan, operand.node);
    }
    return 'emptied';
  }
  for (const operand of gone) {
    plan.edits.push({ from: operand.node.from, to: operand.node.to, text: `${plan.quote}${plan.quote}` });
  }
  return 'kept';
}

// A value that gives no class as written: '', false, null, undefined.
function isNoClass(plan: Plan, node: SyntaxNode): boolean {
  if (node.name === 'String') {
    return plan.text.slice(node.from + 1, node.to - 1).trim() === '';
  }
  if (node.name === 'null') {
    return true;
  }
  if (node.name === 'BooleanLiteral') {
    return textOf(plan, node) === 'false';
  }
  if (node.name === 'VariableName') {
    return textOf(plan, node) === 'undefined';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lists: an array's elements and an object's properties, split on their commas.
// ---------------------------------------------------------------------------

interface ListItem extends Range {
  readonly nodes: readonly SyntaxNode[];
}

function listItems(children: readonly SyntaxNode[], open: string, close: string): readonly ListItem[] {
  const items: ListItem[] = [];
  let current: SyntaxNode[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first !== undefined && last !== undefined) {
      items.push({ from: first.from, to: last.to, nodes: current });
    }
    current = [];
  };
  for (const child of children) {
    if (child.name === open) {
      continue;
    }
    if (child.name === ',' || child.name === close) {
      flush();
      continue;
    }
    current.push(child);
  }
  flush();
  assert(items.length <= children.length, 'listItems: no more items than nodes');
  return items;
}

// Takes the emptied items out of a list. A list written one item per line loses
// the item's whole line; a list on one line loses the item and the comma before
// it (after it, for the first). A trailing comma stays as it was written: a list
// that had none gets none from the item that is now last.
function removeItems(plan: Plan, container: SyntaxNode, items: readonly ListItem[], emptied: ReadonlySet<number>): Fate {
  if (emptied.size === 0) {
    return 'kept';
  }
  if (emptied.size === items.length) {
    dropEditsWithin(plan, container);
    return 'emptied';
  }
  const kept = items.map((_, index) => index).filter((index) => !emptied.has(index));
  const lastKept = kept.at(-1);
  assert(lastKept !== undefined, 'removeItems: an item is kept');
  const containerText = plan.text.slice(container.from, container.to);
  const lines = containerText.includes('\n') ? items.map((item) => ownLine(plan.text, item)) : [];
  const lineMode = lines.length === items.length && lines.every((line) => line !== undefined);
  if (lineMode) {
    for (const index of emptied) {
      const line = lines[index];
      assert(line !== undefined, 'removeItems: a line-mode item has its line');
      plan.edits.push({ from: line.from, to: line.to, text: '' });
    }
    const last = items.at(-1);
    const keptItem = items[lastKept];
    assert(last !== undefined, 'removeItems: a list has a last item');
    assert(keptItem !== undefined, 'removeItems: the last kept item exists');
    if (emptied.has(items.length - 1) && !/^[ \t]*,/.test(plan.text.slice(last.to))) {
      const comma = /^[ \t]*,/.exec(plan.text.slice(keptItem.to));
      if (comma !== null) {
        plan.edits.push({ from: keptItem.to, to: keptItem.to + comma[0].length, text: '' });
      }
    }
    return 'kept';
  }
  const firstKept = kept[0];
  assert(firstKept !== undefined, 'removeItems: a first item is kept');
  const firstKeptItem = items[firstKept];
  const firstItem = items[0];
  assert(firstKeptItem !== undefined, 'removeItems: the first kept item exists');
  assert(firstItem !== undefined, 'removeItems: the list has a first item');
  if (firstKept > 0) {
    plan.edits.push({ from: firstItem.from, to: firstKeptItem.from, text: '' });
  }
  for (const index of emptied) {
    if (index < firstKept) {
      continue;
    }
    const previous = items[index - 1];
    const item = items[index];
    assert(previous !== undefined, 'removeItems: a later item has one before it');
    assert(item !== undefined, 'removeItems: the item exists');
    plan.edits.push({ from: previous.to, to: item.to, text: '' });
  }
  return 'kept';
}

// The item's whole line, newline included, when the item stands on a line of its
// own (indentation before it; a comma and a line comment at most after it).
function ownLine(text: string, item: Range): Range | undefined {
  const lineStart = text.lastIndexOf('\n', item.from - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, item.from))) {
    return undefined;
  }
  const tail = /^[ \t]*,?[ \t]*(?:\/\/[^\n]*)?\n/.exec(text.slice(item.to));
  if (tail === null) {
    return undefined;
  }
  return { from: lineStart, to: item.to + tail[0].length };
}

// ---------------------------------------------------------------------------
// Words and splicing.
// ---------------------------------------------------------------------------

interface Glue {
  /** The text's first character touches a hole before it. */
  readonly start: boolean;
  /** The text's last character touches a hole after it. */
  readonly end: boolean;
}

const NOT_GLUED: Glue = { start: false, end: false };

interface Words {
  readonly text: string;
  readonly removed: number;
  readonly keptCount: number;
}

// The whitespace-separated words of `raw` without `name`. Each kept word keeps the
// whitespace written before it, so `a\n  b` stays on its lines; the text's own
// leading and trailing whitespace stay too. A word glued to a hole is kept.
function withoutWord(raw: string, name: string, glue: Glue): Words {
  const matches = [...raw.matchAll(/\S+/g)];
  assert(matches.length <= raw.length, 'withoutWord: fewer words than characters');
  const kept: string[] = [];
  let removed = 0;
  let previousEnd = 0;
  for (const [index, match] of matches.entries()) {
    const word = match[0];
    const at = match.index;
    const before = raw.slice(previousEnd, at);
    previousEnd = at + word.length;
    const gluedStart = index === 0 && glue.start && at === 0;
    const gluedEnd = index === matches.length - 1 && glue.end && previousEnd === raw.length;
    if (word === name && !gluedStart && !gluedEnd) {
      removed += 1;
      continue;
    }
    kept.push(kept.length === 0 ? word : `${before}${word}`);
  }
  if (removed === 0) {
    return { text: raw, removed, keptCount: kept.length };
  }
  const leading = /^\s*/.exec(raw)?.[0] ?? '';
  const trailing = /\s*$/.exec(raw)?.[0] ?? '';
  const text = kept.length === 0 ? '' : `${leading}${kept.join('')}${trailing}`;
  assert(kept.length + removed === matches.length, 'withoutWord: every word is kept or removed');
  return { text, removed, keptCount: kept.length };
}

function textOf(plan: Plan, range: Range): string {
  return plan.text.slice(range.from, range.to);
}

// An emptied node is replaced or removed whole by its parent, so no edit inside it may stay.
function dropEditsWithin(plan: Plan, range: Range): void {
  const outside = plan.edits.filter((edit) => edit.to <= range.from || edit.from >= range.to);
  plan.edits.splice(0, plan.edits.length, ...outside);
}

function applyReplacements(text: string, edits: readonly Replacement[]): string {
  const sorted = [...edits].sort((first, second) => first.from - second.from);
  let out = '';
  let cursor = 0;
  for (const edit of sorted) {
    assert(edit.from >= cursor, 'applyReplacements: edits do not overlap');
    assert(edit.to >= edit.from, 'applyReplacements: an edit has a forward range');
    out += text.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  out += text.slice(cursor);
  assert(out.length <= text.length + edits.length * 2, 'applyReplacements: removal never grows the text past its quotes');
  return out;
}

function snippetsOf(plan: Plan): readonly ClassExpressionSnippet[] {
  return plan.snippets.map((range) => {
    // Offsets into the code as given: the wrapper's `(` is not part of it.
    const from = range.from - WRAP_OPEN.length;
    const to = range.to - WRAP_OPEN.length;
    assert(from >= 0, 'snippetsOf: a snippet starts inside the code');
    return { code: plan.text.slice(range.from, range.to), from, to };
  });
}
