// Taking a loop away: the Source menu's "None" removes the loop and keeps one
// copy of its body, with everything bound to the loop's item turned into what
// it shows now, so nothing is left reading a variable that no longer exists.
//
//   {item.data.Number}            becomes  the text the first item shows
//   label={item.data.Label}       becomes  label="the text the first item shows"
//   {item.data.price * 2}         becomes  {"12" * 2}  (each reference by its value)
//
// A value is the one the canvas shows for the first item, found in the data
// tree the pickers read (`samples`, by item path). A binding with no known
// value becomes empty, and is counted, so the person is told. A loop whose body
// has code this cannot read (raw script, an unreadable head) is not removed:
// nothing is guessed and nothing is lost.
//
// Pure: it builds new nodes and never touches the old ones.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { encodeText } from '../../shared/page/htmlText';
import type { Attr } from '../../shared/page/pageNode';
import { splitMapHead } from './loopBindings';
import type { TreeNode } from './dataSample';
import type { EditorNode } from './pageView';

/** The values the first item shows, by path from the item (`item.data.Number`). */
export type ItemSamples = Readonly<Record<string, string>>;

export interface RemovedLoopBody {
  readonly nodes: readonly EditorNode[];
  /** Bindings turned into the value the item shows. */
  readonly replaced: number;
  /** Bindings with no known value, left empty. */
  readonly emptied: number;
}

export type LoopRemoval = ({ readonly ok: true } & RemovedLoopBody) | { readonly ok: false; readonly reason: 'unreadableCode' | 'unreadableHead' };

const SAMPLES_MAX = 4_000;

/**
 * The loop body without the loop: `item` and `index` are the names its head
 * gives the item and its position, and `samples` what the first item shows.
 */
export function removedLoopBody(children: readonly EditorNode[], names: { readonly item: string; readonly index: string }, samples: ItemSamples): LoopRemoval {
  assert(/^[A-Za-z_$][\w$]*$/.test(names.item), 'A loop item is named by an identifier');
  assert(Object.keys(samples).length <= SAMPLES_MAX, 'The samples of one item are bounded');
  const tally = new Tally();
  const nodes = children.map((child) => flattened(child, { ...names, depth: 0 }, samples, tally));
  if (tally.refusedCode) {
    return { ok: false, reason: 'unreadableCode' };
  }
  return { ok: true, nodes, replaced: tally.replacedCount, emptied: tally.emptiedCount };
}

/** Whether `code` reads the loop's item (or its position) by name. */
export function readsLoopItem(code: string, names: { readonly item: string; readonly index: string }): boolean {
  return referencePattern(names).test(code);
}

// The count is the one piece of state, owned here; the walk reports to it.
class Tally {
  replacedCount = 0;
  emptiedCount = 0;
  refusedCode = false;
  replace(): void {
    this.replacedCount++;
  }
  empty(): void {
    this.emptiedCount++;
  }
  refuse(): void {
    this.refusedCode = true;
  }
}

interface Scope {
  readonly item: string;
  readonly index: string;
  readonly depth: number;
}

// `item`, `item.data.x`, `item?.data`, and the position name when there is one.
function referencePattern(names: { readonly item: string; readonly index: string }): RegExp {
  const item = names.item.replace(/\$/g, '\\$');
  const index = names.index === '' ? undefined : names.index.replace(/\$/g, '\\$');
  const alternatives = [`${item}((?:\\??\\.[A-Za-z_$][\\w$]*)*)`, ...(index === undefined ? [] : [`(${index})(?![\\w$])`])];
  return new RegExp(`(?<![.\\w$])(?:${alternatives.join('|')})`, 'g');
}

function flattened(node: EditorNode, scope: Scope, samples: ItemSamples, tally: Tally): EditorNode {
  assert(scope.depth <= LIMITS.treeDepthMax, `removedLoopBody: depth ${scope.depth} exceeds the tree cap`);
  const own = ownFlattened(withFlattenedProps(node, scope, samples, tally), scope, samples, tally);
  if (own.shadowed) {
    return own.node;
  }
  const children = own.node.children;
  if (children === undefined) {
    return own.node;
  }
  const next = children.map((child) => flattened(child, { ...scope, depth: scope.depth + 1 }, samples, tally));
  assert(next.length === children.length, 'Removing a loop keeps every child');
  return Object.assign({}, own.node, { children: next });
}

function withFlattenedProps(node: EditorNode, scope: Scope, samples: ItemSamples, tally: Tally): EditorNode {
  const props = node.props;
  if (props === undefined) {
    return node;
  }
  const kept: [string, Attr][] = [];
  let changed = false;
  for (const [key, value] of Object.entries(props)) {
    if (value.type === 'expr') {
      const next = attributeOf(value.value, scope, samples, tally);
      changed ||= next !== value;
      kept.push([key, next]);
    } else if (value.type === 'spread') {
      if (referencePattern(scope).test(value.value)) {
        // A spread of the item cannot become one value: the attributes it carried are not known.
        tally.empty();
        changed = true;
      } else {
        kept.push([key, value]);
      }
    } else {
      kept.push([key, value]);
    }
  }
  if (!changed) {
    return node;
  }
  // The source spans describe the attributes as they were; a node whose
  // attributes changed is written from its props, so the spans go.
  const names = new Set(kept.map(([key]) => key));
  const { attrSpans: staleSpans, ...rest } = node;
  void staleSpans;
  const order = rest.attrOrder?.filter((name) => names.has(name));
  return { ...rest, props: Object.fromEntries(kept), ...(order === undefined ? {} : { attrOrder: order }) };
}

// An attribute's expression: a bare reference is its value as text; any other code keeps running, over values.
function attributeOf(code: string, scope: Scope, samples: ItemSamples, tally: Tally): Attr {
  const whole = wholeReference(code, scope);
  if (whole !== undefined) {
    return { type: 'string', value: valueOf(whole, scope, samples, tally) ?? '' };
  }
  return { type: 'expr', value: substituted(code, scope, samples, tally) };
}

// `item.data.x` and nothing else: the reference's path, normalized to dots.
function wholeReference(code: string, scope: Scope): string | undefined {
  const trimmed = code.trim();
  const pattern = referencePattern(scope);
  const found = [...trimmed.matchAll(pattern)];
  const only = found[0];
  return found.length === 1 && only !== undefined && only[0] === trimmed ? normalized(trimmed) : undefined;
}

function normalized(reference: string): string {
  return reference.replace(/\?\./g, '.');
}

// The first item is item 0, so its position is `0`; any other reference is looked up in the samples.
function valueOf(reference: string, scope: Scope, samples: ItemSamples, tally: Tally): string | undefined {
  if (scope.index !== '' && reference === scope.index) {
    tally.replace();
    return '0';
  }
  const value = Object.hasOwn(samples, reference) ? samples[reference] : undefined;
  if (value === undefined) {
    tally.empty();
    return undefined;
  }
  tally.replace();
  return value;
}

// Every reference in code that goes on running is replaced by its value as a literal.
function substituted(code: string, scope: Scope, samples: ItemSamples, tally: Tally): string {
  return code.replace(referencePattern(scope), (whole: string) => {
    if (scope.index !== '' && whole === scope.index) {
      // A position inside code is a number.
      tally.replace();
      return '0';
    }
    const value = valueOf(normalized(whole), scope, samples, tally);
    return value === undefined ? 'undefined' : JSON.stringify(value);
  });
}

function ownFlattened(node: EditorNode, scope: Scope, samples: ItemSamples, tally: Tally): { readonly node: EditorNode; readonly shadowed: boolean } {
  switch (node.kind) {
    case 'expr': {
      // The node's code is written in its braces: `{item.data.Number}`.
      const braced = /^\{([\s\S]*)\}$/.exec(node.value.trim());
      const whole = wholeReference(braced?.[1] ?? node.value, scope);
      if (whole !== undefined) {
        const value = valueOf(whole, scope, samples, tally);
        return { node: { ...node, kind: 'text', value: encodeText(value ?? '') }, shadowed: false };
      }
      return { node: { ...node, value: substituted(node.value, scope, samples, tally) }, shadowed: false };
    }
    case 'text': {
      if (!node.value.includes('{')) {
        return { node, shadowed: false };
      }
      const value = node.value.replace(/\{([^{}]*)\}/g, (segment: string, inner: string) => {
        if (!referencePattern(scope).test(inner)) {
          return segment;
        }
        const whole = wholeReference(inner, scope);
        if (whole !== undefined) {
          return encodeText(valueOf(whole, scope, samples, tally) ?? '');
        }
        return `{${substituted(inner, scope, samples, tally)}}`;
      });
      return { node: { ...node, value }, shadowed: false };
    }
    case 'cond':
      return { node: { ...node, test: substituted(node.test, scope, samples, tally) }, shadowed: false };
    case 'map':
      return flattenedLoop(node, scope, tally);
    case 'raw':
    case 'raw-line':
      if (referencePattern(scope).test(node.kind === 'raw' ? node.inner : node.value)) {
        tally.refuse();
      }
      return { node, shadowed: false };
    case 'element':
    case 'component':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return { node, shadowed: false };
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// A loop inside the body: one over the item's own list cannot be flattened (its items are not one
// value), so it is emptied; one that names the item itself shadows it below.
function flattenedLoop(
  node: Extract<EditorNode, { readonly kind: 'map' }>,
  scope: Scope,
  tally: Tally,
): { readonly node: EditorNode; readonly shadowed: boolean } {
  const head = splitMapHead(node.head);
  if (head === undefined) {
    if (referencePattern(scope).test(node.head)) {
      tally.refuse();
    }
    return { node, shadowed: false };
  }
  const reads = referencePattern(scope).test(head.data);
  if (reads) {
    tally.empty();
  }
  const parameters = head.item + (head.index ? `, ${head.index}` : '');
  const rewritten = reads ? { ...node, head: `[].map((${parameters}) => (` } : node;
  return { node: rewritten, shadowed: head.item === scope.item || head.index === scope.item };
}

/**
 * What the first item of a list shows, by path from the loop's item: the first
 * entry of the first of `lists` the data tree holds (the loop's own source, as
 * the pickers sample it), each leaf by its value as the picker shows it.
 */
export function itemSamples(tree: readonly TreeNode[] | undefined, lists: readonly string[], item: string): ItemSamples {
  for (const list of lists) {
    const node = treeNodeAt(tree, list);
    const first = node?.children?.[0];
    if (first !== undefined) {
      return leavesOf(first, item);
    }
  }
  return {};
}

// The node at a path, looking only down branches the path continues.
function treeNodeAt(tree: readonly TreeNode[] | undefined, path: string): TreeNode | undefined {
  const pending: TreeNode[] = [...(tree ?? [])];
  for (let visited = 0; pending.length > 0 && visited < LIMITS.treeNodesMax; visited++) {
    const node = pending.shift();
    if (node?.path === path) {
      return node;
    }
    if (node?.children !== undefined && path.startsWith(node.path)) {
      pending.push(...node.children);
    }
  }
  return undefined;
}

// Every leaf under the entry, its path from the entry's own replaced by the item's name.
function leavesOf(entry: TreeNode, item: string): ItemSamples {
  const samples: Record<string, string> = {};
  const pending: TreeNode[] = [entry];
  for (let visited = 0; pending.length > 0 && visited < LIMITS.treeNodesMax && Object.keys(samples).length < SAMPLES_MAX; visited++) {
    const node = pending.shift();
    if (node === undefined) {
      break;
    }
    if (node.children === undefined || node.children.length === 0) {
      if (node.path.startsWith(entry.path) && node.preview !== '') {
        samples[`${item}${node.path.slice(entry.path.length)}`] = node.preview;
      }
    } else {
      pending.push(...node.children);
    }
  }
  return samples;
}
