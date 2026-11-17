// The canvas's node states (hidden, inert, drawing a ::before or ::after) as
// node ids, so the navigator can mark rows without knowing index paths.
//
// The canvas reports paths, and answers for a path with the first element
// between its markers: a loop's path reads its first `<li>`, a component
// instance's its root. Hidden and inert are true of what the node puts on the
// page either way, but a ::before or ::after is a box of ONE element, so it is
// kept only for a node that is that element (shared/page/pseudoElements.ts).
// This is the boundary where reported paths meet the tree, so the filter is here.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { pseudoLayerAllowed, type PseudoHostNode } from '../../../shared/page/pseudoElements';
import type { PseudoLayer } from '../../../shared/page/pseudoPath';

/** The paths one canvas report lists per state. */
export interface ReportedNodeStates {
  readonly hidden: readonly string[];
  readonly inert: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** The same states as node ids. */
export interface NodeStateIds {
  readonly hidden: ReadonlySet<string>;
  readonly inert: ReadonlySet<string>;
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

/**
 * `states` as ids of the nodes `byPath` holds. `prefix` is the open component's
 * namespace (`src/components/Card.astro|`), or '' on a page.
 */
export function nodeStateIds<Node extends PseudoHostNode & { readonly id: string }>(
  states: ReportedNodeStates,
  byPath: ReadonlyMap<string, Node>,
  prefix: string,
): NodeStateIds {
  const local = (path: string): string => (prefix.length > 0 && path.startsWith(prefix) ? path.slice(prefix.length) : path);
  const nodesOf = (paths: readonly string[]): Node[] => {
    assert(paths.length <= LIMITS.treeNodesMax, 'nodeStateIds: a report names at most every node');
    const found: Node[] = [];
    for (const path of paths) {
      const node = byPath.get(local(path));
      if (node !== undefined) {
        found.push(node);
      }
    }
    return found;
  };
  const ids = (nodes: readonly Node[]): ReadonlySet<string> => new Set(nodes.map((node) => node.id));
  const pseudoIds = (paths: readonly string[], pseudo: PseudoLayer): ReadonlySet<string> => {
    const owners = nodesOf(paths).filter((node) => pseudoLayerAllowed(node, pseudo));
    assert(owners.length <= paths.length, 'nodeStateIds: a filter never adds');
    return ids(owners);
  };
  const result = {
    hidden: ids(nodesOf(states.hidden)),
    inert: ids(nodesOf(states.inert)),
    before: pseudoIds(states.before, 'before'),
    after: pseudoIds(states.after, 'after'),
  };
  assert(result.before.size <= states.before.length, 'nodeStateIds: one ::before row per reported path at most');
  return result;
}
