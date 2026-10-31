// Formatting words selected on the canvas, with the Settings Content field's
// own formatting (richFormat.ts) — not a second implementation of it.
//
// The Content field edits an element's inline content in an editable element
// and reads the result back as nodes. The canvas does the same with a hidden
// copy of that content: it selects the words the canvas selected, presses the
// same button, and hands the nodes to the same setNodeInline. So a word made
// bold on the canvas gets exactly the markup the panel would give it, and
// pressing a lit button turns the format off, as it does there.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import {
  INLINE_TAGS,
  isChippable,
  isInlineOnly,
  nodesToHtml,
  type InlineNode,
} from '../../features/props/richContentModel';
import {
  richApplyLink,
  richContentNodes,
  richExec,
  richWrapTag,
  type FormatState,
} from '../../features/props/richFormat';
import type { CanvasFormatAction } from '../../features/preview/canvasTextSelection';

/** A model node whose children are its own kind, as the page model's are. */
export interface CanvasFormatTree<Node> {
  readonly id?: string;
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly children?: readonly Node[] | undefined;
}

/** The element whose inline content holds a text node, and the way down to it. */
export interface InlineRoot<Node extends CanvasFormatTree<Node>> {
  readonly root: Node;
  readonly trail: readonly number[];
}

/**
 * The element the Content field would edit for this text node: its parent,
 * or, when the text sits inside inline markup (`<strong>`, `<a>` …), the
 * element around that markup — so a press can take a format off as well as
 * put one on. Undefined when the content is not plain inline content.
 */
export function inlineRootOf<Node extends CanvasFormatTree<Node>>(
  nodes: readonly Node[],
  textId: string,
): InlineRoot<Node> | undefined {
  const chain = ancestorsOf(nodes, textId);
  if (!chain) {
    return undefined;
  }
  let at = chain.ancestors.length - 1;
  while (at > 0) {
    const node = chain.ancestors[at];
    const parent = chain.ancestors[at - 1];
    assert(node !== undefined, 'An ancestor exists at each level');
    assert(parent !== undefined, 'An ancestor exists above each level');
    if (node.kind !== 'element' || !INLINE_TAGS.has(node.name ?? '')) {
      break;
    }
    if (!isInlineOnly(parent.children)) {
      break;
    }
    at -= 1;
  }
  const root = chain.ancestors[at];
  if (root === undefined || !isInlineOnly(root.children)) {
    return undefined;
  }
  return { root, trail: chain.indices.slice(at + 1) };
}

// Every ancestor of a node, outermost first, with the child index taken at
// each one. Iterative and bounded by the tree's node limit.
function ancestorsOf<Node extends CanvasFormatTree<Node>>(
  nodes: readonly Node[],
  id: string,
): { readonly ancestors: readonly Node[]; readonly indices: readonly number[] } | undefined {
  type Entry = { readonly node: Node; readonly ancestors: Node[]; readonly indices: number[] };
  const stack: Entry[] = nodes.map((node, index) => ({ node, ancestors: [], indices: [index] }));
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited += 1) {
    const entry = stack.pop();
    if (!entry) {
      return undefined;
    }
    if (entry.node.id === id) {
      assert(entry.indices.length === entry.ancestors.length + 1, 'One index per level');
      return entry.ancestors.length
        ? { ancestors: entry.ancestors, indices: entry.indices }
        : undefined;
    }
    const children: readonly Node[] = entry.node.children ?? [];
    children.forEach((child, index) =>
      stack.push({
        node: child,
        ancestors: [...entry.ancestors, entry.node],
        indices: [...entry.indices, index],
      }),
    );
  }
  return undefined;
}

/** Which buttons are lit: the inline markup the selected text already sits in. */
export function inlineStatesAt(
  children: readonly InlineNode[],
  trail: readonly number[],
): FormatState {
  assert(trail.length > 0, 'A trail reaches a text node');
  const names = new Set<string>();
  let level: readonly InlineNode[] = children;
  for (const index of trail.slice(0, -1)) {
    const node = level[index];
    if (node?.kind !== 'element') {
      return {};
    }
    names.add(node.name);
    level = node.children ?? [];
  }
  const has = (...tags: readonly string[]) => tags.some((tag) => names.has(tag));
  return {
    bold: has('strong', 'b'),
    italic: has('em', 'i'),
    superscript: has('sup'),
    subscript: has('sub'),
    code: has('code'),
    span: has('span'),
    link: has('a'),
  };
}

/** The content with the text at `trail` holding `value` — what is typed but not saved yet. */
export function inlineWithValue(
  children: readonly InlineNode[],
  trail: readonly number[],
  value: string,
  depth = 0,
): readonly InlineNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'Inline content depth limit exceeded');
  const [index, ...rest] = trail;
  assert(index !== undefined, 'A trail reaches a text node');
  return children.map((node, at) => {
    if (at !== index) {
      return node;
    }
    if (rest.length === 0) {
      return node.kind === 'text' ? { ...node, value } : node;
    }
    if (node.kind !== 'element') {
      return node;
    }
    return { ...node, children: inlineWithValue(node.children ?? [], rest, value, depth + 1) };
  });
}

/**
 * The content after one press over the words [start, end) of the text at
 * `trail`, which must read `value`. Undefined when the content cannot be laid
 * out as the panel would lay it out, or the press changes nothing.
 */
export function formatInlineSelection(
  children: readonly InlineNode[],
  selection: {
    readonly trail: readonly number[];
    readonly start: number;
    readonly end: number;
    readonly value: string;
  },
  action: CanvasFormatAction,
): InlineNode[] | undefined {
  assert(selection.start < selection.end, 'A format acts on selected words');
  assert(selection.end <= selection.value.length, 'The selection lies inside its text');
  const host = document.createElement('div');
  host.contentEditable = 'true';
  host.setAttribute('aria-hidden', 'true');
  // Off screen, not display:none: the browser only edits what it lays out.
  host.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;white-space:pre';
  document.body.append(host);
  try {
    host.innerHTML = nodesToHtml(children, isChippable);
    const text = nodeAtTrail(host, selection.trail);
    if (!text || text.nodeType !== Node.TEXT_NODE || text.textContent !== selection.value) {
      return undefined;
    }
    const range = document.createRange();
    range.setStart(text, selection.start);
    range.setEnd(text, selection.end);
    const target = { host, savedRange: { current: range } };
    return pressFormat(target, action) ? richContentNodes(host) : undefined;
  } finally {
    host.remove();
  }
}

function pressFormat(target: Parameters<typeof richExec>[0], action: CanvasFormatAction): boolean {
  switch (action.kind) {
    case 'exec':
      richExec(target, action.command);
      return true;
    case 'wrap':
      return richWrapTag(target, action.tag);
    case 'link':
      return richApplyLink(target, action.url);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function nodeAtTrail(host: HTMLElement, trail: readonly number[]): ChildNode | undefined {
  let node: ChildNode | undefined = undefined;
  let level: NodeListOf<ChildNode> = host.childNodes;
  for (const index of trail) {
    node = level[index];
    if (!node) {
      return undefined;
    }
    level = node.childNodes;
  }
  return node;
}
