// Read-only tree queries. Mutation code uses the live readers; rendering builds
// one index per immutable model so hovering and selecting never rescan it.

import type { Attr, PageNode } from '../../shared/page/pageNode';

interface TreeNodeLike<Node> {
  readonly id: string;
  readonly kind: string;
  readonly children?: readonly Node[] | undefined;
  readonly props?: Readonly<Record<string, Attr>>;
}

interface TreeEntry<Node extends TreeNodeLike<Node> = PageNode> {
  node: Node;
  list: readonly Node[];
  index: number;
  parent: TreeEntry<Node> | undefined;
  path?: string;
}

interface Frame<Node extends TreeNodeLike<Node> = PageNode> {
  list: readonly Node[];
  index: number;
  parent: TreeEntry<Node> | undefined;
}

function* entries<Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined): Generator<TreeEntry<Node>> {
  const stack: Frame<Node>[] = [{ list: nodes ?? [], index: 0, parent: undefined }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      break;
    }
    if (frame.index >= frame.list.length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    const node = frame.list[index];
    if (node === undefined) {
      continue;
    }
    const entry: TreeEntry<Node> = { node, list: frame.list, index, parent: frame.parent };
    yield entry;
    if ('children' in node && Array.isArray(node.children) && node.children.length) {
      stack.push({ list: node.children, index: 0, parent: entry });
    }
  }
}

function findEntry<Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, id: string): TreeEntry<Node> | undefined {
  for (const entry of entries(nodes)) {
    if (entry.node.id === id) {
      return entry;
    }
  }
  return undefined;
}

function trailOf<Node extends TreeNodeLike<Node>, Value>(entry: TreeEntry<Node> | undefined, pick: (entry: TreeEntry<Node>) => Value): Value[] | undefined {
  if (!entry) {
    return undefined;
  }
  const trail: Value[] = [];
  for (let current: TreeEntry<Node> | undefined = entry; current; current = current.parent) {
    trail.push(pick(current));
  }
  return trail.reverse();
}

export const findNodeById = <Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, id: string): Node | undefined =>
  findEntry(nodes, id)?.node || undefined;
export const findParentNode = <Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, id: string): Node | undefined =>
  findEntry(nodes, id)?.parent?.node || undefined;
export const pathOfNode = <Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, id: string): number[] | undefined =>
  trailOf(findEntry(nodes, id), (entry) => entry.index);
export const ancestorChain = <Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, id: string): Node[] | undefined =>
  trailOf(findEntry(nodes, id), (entry) => entry.node);

export function findParentList(model: { readonly nodes: readonly PageNode[] }, id: string): { list: readonly PageNode[]; index: number } | undefined {
  const found = findEntry(model.nodes, id);
  return found ? { list: found.list, index: found.index } : undefined;
}

export function isDescendantOf(candidateParent: PageNode, id: string): boolean {
  const children = 'children' in candidateParent ? candidateParent.children : undefined;
  return candidateParent.id === id || !!findNodeById(children, id);
}

export function nodeAtPath<Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined, trail: readonly number[]): Node | undefined {
  let list = nodes;
  let node: Node | undefined;
  for (const i of trail) {
    node = list?.[i];
    if (!node) {
      return undefined;
    }
    list = 'children' in node ? node.children : undefined;
  }
  return node;
}

interface TreeIndex<Node extends TreeNodeLike<Node> = PageNode> {
  readonly byId: Map<string, TreeEntry<Node>>;
  readonly byPath: Map<string, Node>;
  readonly sectionIds: string[];
  node(id: string): Node | undefined;
  parent(id: string): Node | undefined;
  path(id: string): string | undefined;
  ancestors(id: string): Node[] | undefined;
}

export function createTreeIndex<Node extends TreeNodeLike<Node>>(nodes: readonly Node[] | undefined): TreeIndex<Node> {
  const byId = new Map<string, TreeEntry<Node>>();
  const byPath = new Map<string, Node>();
  const sectionIds: string[] = [];
  for (const entry of entries(nodes)) {
    entry.path = entry.parent ? `${entry.parent.path}.${entry.index}` : String(entry.index);
    byId.set(entry.node.id, entry);
    byPath.set(entry.path, entry.node);
    // Presence, not kind: the tree query layer reads props from any node
    // that carries them, kind-tagged or not.
    if ('props' in entry.node) {
      const id = entry.node.props?.['id'];
      if (id?.type === 'string' && id.value) {
        sectionIds.push(id.value);
      }
    }
  }
  return {
    byId,
    byPath,
    sectionIds,
    node: (id) => byId.get(id)?.node || undefined,
    parent: (id) => byId.get(id)?.parent?.node || undefined,
    path: (id) => byId.get(id)?.path,
    ancestors: (id) => trailOf(byId.get(id), (entry) => entry.node),
  };
}

export type { TreeEntry, TreeIndex };
