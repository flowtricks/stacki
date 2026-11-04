// What a drop on the Navigator carries: a component from the palette or a node
// moved within the tree (PalettePanel and StructureTree set these types). Drag
// data can come from any window, so it is parsed like any other input: a name
// or id past the page-tree bound is no drop at all.
import { LIMITS } from '../../../shared/core/limits';
import { thenBranch } from '../../editor/branches';
import type { NavigatorNode } from './structureModel';

export type NavigatorDrop = { readonly kind: 'component'; readonly name: string; readonly path?: string } | { readonly kind: 'node'; readonly id: string };

/** `read` is `DataTransfer.getData`: an absent type reads as the empty string. */
export function parseNavigatorDrop(read: (type: string) => string): NavigatorDrop | undefined {
  const name = read('avb/component');
  if (name !== '') {
    const path = read('avb/component-path');
    if (name.length > LIMITS.tagNameCharsMax || path.length > LIMITS.ipcPathCharsMax || path.includes('\0')) {
      return undefined;
    }
    return { kind: 'component', name, ...(path === '' ? {} : { path }) };
  }
  const id = read('avb/node');
  if (id !== '') {
    return id.length <= LIMITS.tagNameCharsMax ? { kind: 'node', id } : undefined;
  }
  return undefined;
}

/** Whether the Navigator offers drops inside `node`: onto its row, which
 * appends, and into the gaps between its children. The answer has to be the
 * planner's (shared/engine/planTree.ts), or the Navigator offers a drop that
 * ends in an editor error. A loop whose callback is code (`bodyParts`: a
 * block body, a `flatMap`, statements around its markup) returns each root
 * from its own JavaScript site, so neither its edges nor the places between
 * its roots are one markup list; drops go inside its elements instead, as
 * insertTarget.ts does for inserts. A loop written as markup, `=> (<a />)`,
 * `=> (<a /> <b />)` or the empty `=> (null)`, takes them. */
export function navigatorHostsDrop(node: NavigatorNode): boolean {
  switch (node.kind) {
    case 'component':
    case 'element':
    case 'chunk-group':
    case 'branch':
      return true;
    case 'map':
      return node.bodyParts === undefined;
    case 'cond':
      // The row of an `if` stands for its then branch (src/editor/branches.ts).
      return thenBranch(node) !== undefined;
    case 'text':
    case 'expr':
    case 'raw':
    case 'raw-line':
    case 'comment':
      return false;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
