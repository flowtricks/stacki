// Where an arrow key moves the Navigator's selection. An element's rows are
// its ::before, then its children, then its ::after, as the tree draws them:
// ↓ goes to the first of them, ← and → step between them as siblings (a
// ::before is the first child's left-hand sibling), and ↑ goes to the parent,
// from a ::before or ::after to its own element. Pure: the panel owns the
// selection and the expanded rows.

import { assert } from '../../../shared/core/assert';
import type { FoundNavigatorNode, NavigatorNode } from './structureModel';

export type NavigatorArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
export type NavigatorPseudo = 'before' | 'after';

/** A row the Navigator can select: an element, or one of its pseudo-elements. */
export type NavigatorRow =
  { readonly kind: 'node'; readonly node: NavigatorNode } | { readonly kind: 'pseudo'; readonly nodeId: string; readonly pseudo: NavigatorPseudo };

export interface NavigatorTree {
  /** The child rows a node lists (none when its children are not shown as rows). */
  readonly childrenOf: (node: NavigatorNode) => readonly NavigatorNode[];
  /** The pseudo-elements a node draws, ::before first. */
  readonly pseudosOf: (id: string) => readonly NavigatorPseudo[];
}

/** The rows under `node`, in tree order: ::before, its children, ::after. */
export function rowsUnder(node: NavigatorNode, children: readonly NavigatorNode[], pseudos: readonly NavigatorPseudo[]): readonly NavigatorRow[] {
  const rows: NavigatorRow[] = [];
  if (pseudos.includes('before')) {
    rows.push({ kind: 'pseudo', nodeId: node.id, pseudo: 'before' });
  }
  for (const child of children) {
    rows.push({ kind: 'node', node: child });
  }
  if (pseudos.includes('after')) {
    rows.push({ kind: 'pseudo', nodeId: node.id, pseudo: 'after' });
  }
  assert(rows.length === children.length + pseudos.length, 'rowsUnder: one row per child and pseudo-element');
  return rows;
}

/**
 * The row an arrow key moves to from the selection: `found` is the selected
 * element, and `pseudo` its ::before or ::after when that row is the one
 * selected. Undefined where the key leads nowhere (no sibling, no child).
 */
export function navigatorArrowTarget(
  key: NavigatorArrowKey,
  found: FoundNavigatorNode,
  pseudo: NavigatorPseudo | undefined,
  tree: NavigatorTree,
): NavigatorRow | undefined {
  const own = (): readonly NavigatorRow[] => rowsUnder(found.node, tree.childrenOf(found.node), tree.pseudosOf(found.node.id));
  if (pseudo !== undefined) {
    // A pseudo-element row: its siblings are its element's other rows.
    if (key === 'ArrowUp') {
      return { kind: 'node', node: found.node };
    }
    if (key === 'ArrowDown') {
      return undefined;
    }
    const rows = own();
    const index = rows.findIndex((row) => row.kind === 'pseudo' && row.pseudo === pseudo);
    assert(index >= 0, 'navigatorArrowTarget: a selected pseudo-element is one of its element rows');
    return rows[key === 'ArrowLeft' ? index - 1 : index + 1];
  }
  if (key === 'ArrowUp') {
    return found.parent === undefined ? undefined : { kind: 'node', node: found.parent };
  }
  if (key === 'ArrowDown') {
    return own()[0];
  }
  // An element: its siblings, with its parent's ::before and ::after either side.
  const parentPseudos = found.parent === undefined ? [] : tree.pseudosOf(found.parent.id);
  const rows =
    found.parent === undefined ? found.siblings.map((node): NavigatorRow => ({ kind: 'node', node })) : rowsUnder(found.parent, found.siblings, parentPseudos);
  const index = found.index + (parentPseudos.includes('before') ? 1 : 0);
  assert(rows[index]?.kind === 'node', 'navigatorArrowTarget: the selection sits at its own row');
  return rows[key === 'ArrowLeft' ? index - 1 : index + 1];
}
