// ---------------------------------------------------------------------------
// Renaming a loop variable
//
// `services.map((service) => …)` — renaming `service` has to follow every
// reference below it, or the loop's own children stop compiling. Text-level
// rewriting, since the children hold code as strings.
//
// Every function here takes nodes and returns new ones: they build a gesture's
// prediction (src/editor/editGestures.ts) and never touch the model the page shows.
// The bytes are rewritten by the engine's form of the same rules
// (shared/engine/loopScope.ts).
// ---------------------------------------------------------------------------

import { LIMITS } from '../../shared/core/limits';
import { assert } from '../../shared/core/assert';
import type { EditorNode } from './pageView';
import type { Attr } from '../../shared/page/pageNode';

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*=>\s*\($/;

export interface LoopHead {
  readonly data: string;
  readonly item: string;
  readonly index: string;
}

export function splitMapHead(head: unknown): LoopHead | undefined {
  const match = String(head).trim().match(MAP_HEAD_RE);
  const data = match?.[1];
  const item = match?.[2];
  if (!match || data === undefined || item === undefined) {
    return undefined;
  }
  return { data: data.trim(), item, index: match[3] || '' };
}

// Whole identifier only: `service` but never the `service` in `x.service`
// (a property of something else) or in `services`.
const escapeIdentifier = (name: string): string => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const identifierPattern = (name: string, flags?: string): RegExp => new RegExp(`(?<![.\\w$])${escapeIdentifier(name)}(?![\\w$])`, flags);
const renameIdent = (code: unknown, from: string, to: string): string => String(code ?? '').replace(identifierPattern(from, 'g'), () => to);

// Text nodes are prose with {expressions} in it — rewrite only the braces,
// so a loop variable named `title` doesn't rewrite the word in a sentence.
const renameInBraces = (text: unknown, from: string, to: string): string =>
  String(text ?? '').replace(/\{([^{}]*)\}/g, (_, inner) => `{${renameIdent(inner, from, to)}}`);

const loopHeadOf = (data: string, head: LoopHead): string => `${data}.map((${head.item}${head.index ? `, ${head.index}` : ''}) => (`;

// The children a node has, when it has a list of them (a void element and a
// text have none).
function childrenOf(node: EditorNode): readonly EditorNode[] | undefined {
  return node.children;
}

// The node with new children, only when it has a list to replace.
function withChildren(node: EditorNode, change: (children: readonly EditorNode[]) => readonly EditorNode[]): EditorNode {
  const children = childrenOf(node);
  if (children === undefined) {
    return node;
  }
  const next = change(children);
  assert(next.length === children.length, 'Loop rewrites keep every child');
  // Object.assign keeps the node's own variant, where a spread would widen
  // it: a condition's children stay its branches, rewritten in place.
  return Object.assign({}, node, { children: next });
}

// Attributes whose expression values are rewritten by `rename`.
function withExpressions(node: EditorNode, rename: (code: string) => string): EditorNode {
  const props = node.props;
  if (props === undefined) {
    return node;
  }
  const next = Object.fromEntries(
    Object.entries(props).map(([key, value]): [string, Attr] => (value.type === 'expr' ? [key, { ...value, value: rename(value.value) }] : [key, value])),
  );
  return { ...node, props: next };
}

/** The nodes with the loop variable `from` renamed to `to` wherever it is
 * read, stopping below a loop that declares the name again (it shadows it). */
export function renamedLoopVar(nodes: readonly EditorNode[], from: string, to: string): readonly EditorNode[] {
  assert(from.length > 0, 'A rename names the variable it renames');
  assert(from !== to, 'A rename changes the name');
  return renamedList(nodes, from, to, 0);
}

function renamedList(nodes: readonly EditorNode[], from: string, to: string, depth: number): readonly EditorNode[] {
  // The parser caps nesting; a tree built from parses is never deeper.
  assert(depth <= LIMITS.treeDepthMax, `renamedLoopVar: depth ${depth} exceeds the tree cap`);
  return nodes.map((node) => renamedNode(node, from, to, depth));
}

function renamedNode(node: EditorNode, from: string, to: string, depth: number): EditorNode {
  const rename = (code: string): string => renameIdent(code, from, to);
  const below = (next: EditorNode): EditorNode => withChildren(withExpressions(next, rename), (children) => renamedList(children, from, to, depth + 1));
  switch (node.kind) {
    case 'map': {
      const head = splitMapHead(node.head);
      if (head === undefined) {
        return below({ ...node, head: rename(node.head) }); // Custom head: best effort.
      }
      // Only the data expression is a reference; the parameters are this
      // loop's own declarations.
      const data = rename(head.data);
      const renamed = data === head.data ? node : { ...node, head: loopHeadOf(data, head) };
      if (head.item === from || head.index === from) {
        // The loop re-declares the name: everything below means its own.
        return renamed;
      }
      // Declarations in a statement-body loop read the outer item as freely
      // as the markup does.
      const body = node.body?.map(rename);
      return below(body === undefined ? renamed : { ...renamed, body });
    }
    case 'expr':
      return below({ ...node, value: rename(node.value) });
    case 'cond':
      return below({ ...node, test: rename(node.test) });
    case 'text':
      return below({ ...node, value: renameInBraces(node.value, from, to) });
    case 'raw-line':
    case 'element':
    case 'component':
    case 'raw':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return below(node);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// `data.map((item[, index]) => (` → its pieces, or undefined when the head is
// hand-written code the loop editor can't model.
export const parseLoopHead = splitMapHead;

// Whether `expr` reads from the variable `name` (`service`, `service.tags`) —
// not merely contains its letters (`services`, `x.service`).
const readsVar = (expr: unknown, name: string): boolean => identifierPattern(name).test(String(expr || ''));

/** The nodes with every loop that reads one of `vars` pointed at an empty
 * array. Switching a loop's data source orphans any loop beneath it that reads
 * from the item — `service.tags.map(...)` under `services.map((service) => …)`
 * would call .map on undefined once the parent points somewhere else. An empty
 * array is still valid code, renders nothing, and keeps the child markup for
 * re-pointing by hand. */
export function disconnectedLoops(nodes: readonly EditorNode[], vars: readonly string[]): readonly EditorNode[] {
  assert(vars.length > 0, 'Loops are disconnected from named variables');
  return disconnectedList(nodes, vars, 0);
}

function disconnectedList(nodes: readonly EditorNode[], vars: readonly string[], depth: number): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, `disconnectedLoops: depth ${depth} exceeds the tree cap`);
  return nodes.map((node) => disconnectedNode(node, vars, depth));
}

function disconnectedNode(node: EditorNode, vars: readonly string[], depth: number): EditorNode {
  const below = (next: EditorNode, active: readonly string[]): EditorNode => withChildren(next, (children) => disconnectedList(children, active, depth + 1));
  if (node.kind === 'map') {
    const head = parseLoopHead(node.head);
    const reads = head !== undefined && vars.some((name) => readsVar(head.data, name));
    const next = reads ? { ...node, head: loopHeadOf('[]', head) } : node;
    // The declarations are left alone: an empty list never calls the
    // callback, so nothing in there can run, and the code is still what the
    // user wrote for when they point it at data again. A nested loop that
    // reuses the name shadows it, so anything deeper refers to the inner one.
    const shadowed = new Set([head?.item, head?.index].filter(Boolean));
    const rest = vars.filter((name) => !shadowed.has(name));
    return rest.length > 0 ? below(next, rest) : next;
  }
  if (node.kind === 'cond') {
    // A condition reading the item: false renders the else branch instead of
    // throwing.
    const reads = vars.some((name) => readsVar(node.test, name));
    return below(reads ? { ...node, test: 'false' } : node, vars);
  }
  return below(node, vars);
}

// The path from the roots to `id`, inclusive.
function findPath(nodes: readonly EditorNode[], id: string, trail: readonly EditorNode[], depth: number): readonly EditorNode[] | undefined {
  assert(depth <= LIMITS.treeDepthMax, `findPath: depth ${depth} exceeds parser cap`);
  for (const node of nodes) {
    const next = [...trail, node];
    if (node.id === id) {
      return next;
    }
    const children = childrenOf(node);
    const hit = children === undefined ? undefined : findPath(children, id, next, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

// The loop variables in scope at a node: every enclosing map's item/index.
export function loopVarsAt(nodes: readonly EditorNode[], id: string): string[] {
  const path = findPath(nodes, id, [], 0) ?? [];
  const vars = path.slice(0, -1).flatMap((node) => {
    const head = node.kind === 'map' ? parseLoopHead(node.head) : undefined;
    return [head?.item, head?.index].filter((name): name is string => Boolean(name));
  });
  return [...new Set(vars)];
}

// What a dropped binding is replaced with, so the element keeps rendering
// something you can select and retype.
const UNBOUND_TEXT = 'content';

/** A node with its bindings to `vars` dropped, and how many were. */
export interface Stripped {
  readonly node: EditorNode;
  readonly removed: number;
}

/** The node as it can stand outside the loops that declared `vars`. Moving or
 * pasting a node out of its loop leaves its bindings pointing at a variable
 * that no longer exists — `{service.text}` becomes a hard ReferenceError that
 * blanks the whole page. Exactly those bindings are replaced: `{…}` children
 * and interpolations become placeholder text, expression props are dropped (a
 * stale `href="content"` would just be a broken link), and nested loops that
 * read from the departed item are pointed at an empty array. */
export function strippedBindings(node: EditorNode, vars: readonly string[]): Stripped {
  if (vars.length === 0) {
    return { node, removed: 0 };
  }
  const stripped = strippedNode(node, vars, 0);
  assert(stripped.removed >= 0, 'A count of removed bindings is never negative');
  assert(stripped.node.id === node.id, 'Stripping keeps the node');
  return stripped;
}

function strippedNode(node: EditorNode, active: readonly string[], depth: number): Stripped {
  assert(depth <= LIMITS.treeDepthMax, `strippedBindings: depth ${depth} exceeds the tree cap`);
  const reads = (code: string): boolean => active.some((x) => readsVar(code, x));
  const props = strippedProps(node, reads);
  const own = strippedOwn(props.node, active, reads);
  const removed = props.removed + own.removed;
  if (own.below.length === 0) {
    return { node: own.node, removed };
  }
  const children = childrenOf(own.node);
  if (children === undefined) {
    return { node: own.node, removed };
  }
  const walked = children.map((child) => strippedNode(child, own.below, depth + 1));
  const count = walked.reduce((sum, child) => sum + child.removed, removed);
  const next = withChildren(own.node, () => walked.map((child) => child.node));
  return { node: next, removed: count };
}

// Expression props reading a lost variable are dropped.
function strippedProps(node: EditorNode, reads: (code: string) => boolean): Stripped {
  const props = node.props;
  if (props === undefined) {
    return { node, removed: 0 };
  }
  const kept = Object.entries(props).filter(([, value]) => !(value.type === 'expr' && reads(value.value)));
  const removed = Object.keys(props).length - kept.length;
  assert(removed >= 0, 'Dropping attributes never adds one');
  if (removed === 0) {
    return { node, removed };
  }
  return { node: { ...node, props: Object.fromEntries(kept) }, removed };
}

// The node's own code, rewritten; `below` is the variables still lost for its
// children (a loop re-declaring one shadows it; an expression has none).
interface StrippedOwn extends Stripped {
  readonly below: readonly string[];
}

function strippedOwn(node: EditorNode, active: readonly string[], reads: (code: string) => boolean): StrippedOwn {
  switch (node.kind) {
    case 'expr':
      // A dropped binding leaves placeholder text rather than a hole, so the
      // element stays visible and editable on the canvas.
      return reads(node.value) ? { node: { ...node, kind: 'text', value: UNBOUND_TEXT }, removed: 1, below: [] } : { node, removed: 0, below: active };
    case 'text': {
      if (!node.value.includes('{')) {
        return { node, removed: 0, below: active };
      }
      const value = node.value.replace(/\{([^{}]*)\}/g, (whole, inner: string) => (reads(inner) ? UNBOUND_TEXT : whole));
      const removed = value === node.value ? 0 : 1;
      return { node: removed === 0 ? node : { ...node, value }, removed, below: active };
    }
    case 'map':
      return strippedLoop(node, active, reads);
    case 'cond':
      // A condition on a variable that's gone would throw; false keeps the
      // markup and renders the else branch.
      return reads(node.test) ? { node: { ...node, test: 'false' }, removed: 1, below: active } : { node, removed: 0, below: active };
    case 'raw-line':
    case 'element':
    case 'component':
    case 'raw':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return { node, removed: 0, below: active };
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function strippedLoop(node: Extract<EditorNode, { readonly kind: 'map' }>, active: readonly string[], reads: (code: string) => boolean): StrippedOwn {
  const head = parseLoopHead(node.head);
  const repoint = head !== undefined && reads(head.data);
  const pointed = repoint ? { ...node, head: loopHeadOf('[]', head) } : node;
  const below = active.filter((name) => name !== head?.item && name !== head?.index);
  if (below.length === 0 || node.body === undefined) {
    return { node: pointed, removed: repoint ? 1 : 0, below };
  }
  // This loop can still run (its own data may be fine), so a declaration
  // reading a lost variable would throw. Dropping the line would orphan
  // whatever reads the name it declares — so keep the binding and swap what
  // it's assigned, the same placeholder a lost text binding gets.
  const stillReads = (code: string): boolean => below.some((x) => readsVar(code, x));
  const body = node.body.map((line) => {
    const declaration = stillReads(line) ? line.match(/^((?:const|let)\s+[^=]+=\s*)/) : undefined;
    return declaration ? `${declaration[1] ?? ''}'${UNBOUND_TEXT}';` : line;
  });
  const swapped = body.filter((line, index) => line !== node.body?.[index]).length;
  return { node: { ...pointed, body }, removed: (repoint ? 1 : 0) + swapped, below };
}
