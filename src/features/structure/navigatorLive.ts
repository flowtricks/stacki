// The Navigator's tree while content is being typed and is not yet in the file (ui/liveContent.ts, and the words a
// canvas editor of plain text drafts, ui/canvasTextDraft.ts): the same tree with the typed node's children, or the
// typed text's value, read from the editor. A row whose place and tag are unchanged keeps its id, so it stays open and
// its row is not rebuilt on each key; a block the file does not have yet gets an id of its own that selects nothing.
// Pure, apart from parsing the HTML in the given document.

import type { Attr, BranchNode, PageNode } from '../../../shared/page/pageNode';
import { toNodeId, type NodeId } from '../../../shared/core/brand';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { canvasDraftValue, type CanvasTextDraft } from '../../ui/canvasTextDraft';
import type { LiveContent } from '../../ui/liveContent';

// A row's own id for something the file does not have: a gesture id's shape (shared/core/brand.ts) with sixteen zeros,
// which no random one starts with. Numbered in the tree's order, so the same typed shape gets the same ids.
const LIVE_ID_PREFIX = `g${'0'.repeat(16)}`;

/** Whether a row stands for something typed that the file does not have yet: there is nothing to select or change. */
export function isLiveRowId(id: string): boolean {
  return id.startsWith(LIVE_ID_PREFIX);
}

export interface LiveTree {
  readonly nodes: readonly PageNode[];
  /** The row of the block holding the caret, while the editor reports one. */
  readonly caretId: string | undefined;
}

export function navigatorLiveTree(
  nodes: readonly PageNode[],
  typed: { readonly content: LiveContent | undefined; readonly draft: CanvasTextDraft | undefined },
  document: Document,
): LiveTree {
  const drafted = typed.draft?.kind === 'text' ? withDraft(nodes, typed.draft) : nodes;
  const content = typed.content;
  if (content === undefined) {
    return { nodes: drafted, caretId: undefined };
  }
  let typedNode: PageNode | undefined;
  const next = replaceNode(drafted, content.nodeID, (node) => {
    if (node.kind !== 'element' && node.kind !== 'component') {
      return node;
    }
    let minted = 0;
    const mint = () => toNodeId(`${LIVE_ID_PREFIX}${(minted++).toString(16).padStart(16, '0')}`);
    typedNode = { ...node, children: adopt(typedNodes(content.html, document), node.children ?? [], { mint, depth: 0 }) };
    return typedNode;
  });
  return { nodes: next, caretId: typedNode === undefined ? undefined : caretRow(typedNode, content.caret) };
}

function withDraft(nodes: readonly PageNode[], draft: CanvasTextDraft): readonly PageNode[] {
  return replaceNode(nodes, draft.nodeID, (node) => {
    if (node.kind !== 'text') {
      return node;
    }
    const value = canvasDraftValue(node, draft);
    return value === node.value ? node : { ...node, value };
  });
}

// The tree with one node replaced: every list on the way down is new, everything else is the same object, and an
// absent id (or an unchanged node) gives the same list back. A walk with a stack, bounded by the tree's limit.
function replaceNode(nodes: readonly PageNode[], id: string, change: (node: PageNode) => PageNode): readonly PageNode[] {
  const trail = pathTo(nodes, id);
  if (trail === undefined) {
    return nodes;
  }
  const rebuild = (list: readonly PageNode[], depth: number): readonly PageNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'The live tree is rebuilt to a bounded depth');
    const index = trail[depth];
    assert(index !== undefined, 'The trail names a child at each level');
    const node = list[index];
    assert(node !== undefined, 'The trail leads to a node');
    const next = depth === trail.length - 1 ? change(node) : withChildren(node, rebuild(childrenOf(node), depth + 1));
    return next === node ? list : list.map((child, at) => (at === index ? next : child));
  };
  return rebuild(nodes, 0);
}

function pathTo(nodes: readonly PageNode[], id: string): readonly number[] | undefined {
  const stack: { readonly node: PageNode; readonly trail: readonly number[] }[] = nodes.map((node, index) => ({ node, trail: [index] }));
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited += 1) {
    const entry = stack.pop();
    if (entry === undefined) {
      return undefined;
    }
    if (entry.node.id === id) {
      return entry.trail;
    }
    childrenOf(entry.node).forEach((node, index) => stack.push({ node, trail: [...entry.trail, index] }));
  }
  return undefined;
}

function childrenOf(node: PageNode): readonly PageNode[] {
  return 'children' in node ? (node.children ?? []) : [];
}

function withChildren(node: PageNode, children: readonly PageNode[]): PageNode {
  if (children === childrenOf(node)) {
    return node;
  }
  switch (node.kind) {
    case 'element':
    case 'component':
    case 'map':
    case 'chunk-group':
    case 'branch':
      return { ...node, children };
    case 'cond':
      // A conditional's children are its branches, and the rebuild replaces a branch only with a branch.
      return { ...node, children: children.filter(isBranch) };
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw':
      return node;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function isBranch(node: PageNode): node is BranchNode {
  return node.kind === 'branch';
}

// The editor's HTML, read in an inert document: nothing in it loads or runs.
function typedNodes(html: string, document: Document): readonly Node[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.childNodes);
}

// The typed content as page nodes, as the page's parser would read it (no text that is only space; the space runs a
// browser folds, and a template's indentation around the words, folded), each keeping the id and, for a tag, the
// written node it still is: the one at its place with its kind and tag.
function adopt(typed: readonly Node[], written: readonly PageNode[], walk: { readonly mint: () => NodeId; readonly depth: number }): readonly PageNode[] {
  assert(walk.depth <= LIMITS.treeDepthMax, 'Typed content nests to a bounded depth');
  assert(typed.length <= LIMITS.treeNodesMax, 'Typed content holds a bounded number of nodes');
  // Comments are not part of what an editor reads back, so they take no place.
  const places = written.filter((node) => node.kind !== 'comment');
  const shown = typed.filter((node) => isTag(node) || (node.nodeType === TEXT_NODE && folded(node) !== ''));
  return shown.map((node, index): PageNode => {
    const before = places[index];
    if (!isTag(node)) {
      return { kind: 'text', id: before?.kind === 'text' ? before.id : walk.mint(), value: folded(node) };
    }
    const name = node.localName;
    const same = before !== undefined && (before.kind === 'element' || before.kind === 'component') && before.name === name ? before : undefined;
    // A new tag is numbered before the words inside it, in the tree's order.
    const id = same?.id ?? walk.mint();
    const children = VOID_TAGS.has(name) ? undefined : adopt(Array.from(node.childNodes), same?.children ?? [], { mint: walk.mint, depth: walk.depth + 1 });
    return same === undefined ? { kind: 'element', id, name, props: attributesOf(node), children } : { ...same, children };
  });
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** The tags an editor writes that never hold children. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'source']);

function isTag(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function folded(node: Node): string {
  return (node.textContent ?? '').replace(/[ \t\n\r\f]+/g, ' ').trim();
}

function attributesOf(element: Element): Record<string, Attr> {
  return Object.fromEntries(
    Array.from(element.attributes).map((attribute): [string, Attr] => [
      attribute.name,
      attribute.value === '' ? { type: 'bare' } : { type: 'string', value: attribute.value },
    ]),
  );
}

// The caret's positions count elements only (the frame counts the same): a block, then an item of a list.
function caretRow(typed: PageNode, caret: readonly number[] | undefined): string | undefined {
  if (caret === undefined) {
    return undefined;
  }
  let node = typed;
  for (const index of caret.slice(0, LIMITS.treeDepthMax)) {
    const next = childrenOf(node).filter((child) => child.kind === 'element' || child.kind === 'component')[index];
    if (next === undefined) {
      break;
    }
    node = next;
  }
  return node.id;
}
