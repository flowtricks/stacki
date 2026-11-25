// Which selected node the Style panel has something to style.
//
// Logic and structure put no element of their own on the page: a `<Fragment>` and
// a `<slot>` render what they hold, an if/else, a loop and an expression render
// per the data. The canvas still answers a question about their path, with the first
// element it finds between their markers, and the panel would draw that element's
// chips, CSS code and layout under the logic node's name. So such a node is no
// selection for the panel: it shows its empty state, at once, with nothing held over.
import { rendersOwnElement } from '../../../editor/liveClasses';
import { findNode, type HostNode } from './host';

const LOGIC_KINDS: readonly string[] = ['cond', 'branch', 'map', 'expr'];

/** `selection`, or undefined when it is nothing or puts no element on the page. */
export function styleableSelection<T extends { readonly id: string }>(
  model: { readonly nodes: readonly HostNode[] } | undefined,
  selection: T | undefined,
): T | undefined {
  if (selection === undefined) {
    return undefined;
  }
  const node = findNode(model?.nodes, selection.id);
  if (node === undefined) {
    // Not in the model (the layout, a frontmatter subject): the panel decides, as before.
    return selection;
  }
  if (LOGIC_KINDS.includes(node.kind)) {
    return undefined;
  }
  return rendersOwnElement(node) ? selection : undefined;
}
