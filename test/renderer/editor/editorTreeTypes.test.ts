// Goal: the tree queries in src/editor/editorTree.ts accept every list a PageNode can hold, whatever order the compiler gives a union.
// A cond's children are BranchNode[], every other parent's are PageNode[]. Narrowing a PageNode by `children` yields the union of the
// two list types, and inferring the tree node from that union picked BranchNode or PageNode depending on the compiler's union order,
// so an incremental build once reported a false TS2345 in isDescendantOf while a clean build passed. BranchNode alone is not a tree
// node (its children are PageNodes, not BranchNodes), so callers widen such a union to PageNode[] before querying it.
// Method: tsc checks this file in the root project. The functions below are never called; each `@ts-expect-error` line must fail to
// compile, so if a change made it compile tsc reports the directive as unused and the gate fails. The runtime test only keeps the file
// in the suite and asserts the queries exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNodeById, isDescendantOf, nodeAtPath } from '../../../src/editor/editorTree.ts';
import type { BranchNode, CondNode, PageNode } from '../../../shared/page/pageNodeTypes.ts';

export function branchListTypeChecks(cond: CondNode, branches: readonly BranchNode[], id: string): void {
  // Widened to PageNode[], a cond's branch list is searchable like any other list.
  const widened: readonly PageNode[] = cond.children;
  const found: PageNode | undefined = findNodeById(widened, id);
  void found;
  void nodeAtPath(widened, [0]);
  // @ts-expect-error BranchNode is not a tree node on its own: its children are PageNodes, so the list must be widened first.
  void findNodeById(branches, id);
}

export function childrenUnionTypeChecks(parent: PageNode, id: string): boolean {
  // The narrowed union is exactly the shape isDescendantOf reads; widening it fixes the inferred node to PageNode.
  const children: readonly PageNode[] | undefined = 'children' in parent ? parent.children : undefined;
  const found: PageNode | undefined = findNodeById<PageNode>(children, id);
  return found !== undefined;
}

test('the tree queries the type checks cover exist', () => {
  assert.equal(typeof findNodeById, 'function');
  assert.equal(typeof isDescendantOf, 'function');
  assert.equal(typeof nodeAtPath, 'function');
});
