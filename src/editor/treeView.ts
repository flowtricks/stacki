import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

// Read-only projections accept both parsed pages and the live editing tree.
// They keep source metadata opaque while the existing editor still owns mutation.
export interface TreeView {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly head?: string;
  readonly test?: string;
  readonly body?: readonly string[];
  readonly bodyParts?: readonly string[];
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string }>>;
  readonly children?: readonly TreeView[] | undefined;
}

// Each traversal owns its counter. Depth and work are bounded independently so
// cyclic live edits fail loudly instead of hanging the renderer.
export function treeBudget(): (depth: number) => void {
  let visited = 0;
  return (depth) => {
    assert(depth <= LIMITS.treeDepthMax, 'Tree traversal exceeds depth limit');
    assert(++visited <= LIMITS.treeNodesMax, 'Tree traversal exceeds node limit');
  };
}
