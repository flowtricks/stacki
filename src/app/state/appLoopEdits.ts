// A loop's list settings, written to the page: the query, the loop head, the
// children re-pointed at the new item, and whatever the old source leaves
// unused, planned in one pass (loopQueryPlan.ts) and committed as one undo step.

import { useCallback, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { childrenFingerprint, planLoop, targetKey, type LoopTarget } from '../../editor/loopQueryPlan';
import { frontmatterGesture, nodeGesture, sequence } from '../../editor/editGestures';
import { findEditorNodeById as findNodeById } from '../../editor/pageState';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import type { LoopApplyResult } from '../../features/props/LoopSettings';
import { frontmatterOf } from '../model/nodeFactory';
import type { useCoreState } from './appLifecycle';
import type { useHistory } from './appNodeEdits';

type LoopMemory = Map<string, { readonly produced: string; readonly snapshots: Map<string, readonly EditorNode[]> }>;

export function useLoopEdits(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Each loop's children as they were for each source it read, kept for
  // switching back: bindings a collection could not fill were unlinked, and
  // the source they came from links them again. Valid only while the children
  // are exactly what the last switch made (`produced`) — after an edit there,
  // the snapshot would undo it, so the loop is re-pointed instead.
  const loopMemoryRef = useRef<LoopMemory>(new Map());
  const setLoopSource = useCallback(
    (nodeId: string, target: LoopTarget, sanityClient: 'available' | 'unavailable'): LoopApplyResult => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return { ok: false, message: 'This page can’t be edited right now.' };
      }
      const loop = findNodeById(state.model.nodes, nodeId);
      if (loop?.kind !== 'map') {
        return { ok: false, message: 'That loop is no longer on the page.' };
      }
      const children = loop.children ?? [];
      const memory = loopMemoryRef.current.get(nodeId);
      const fresh = memory !== undefined && memory.produced === childrenFingerprint(children);
      const restore = fresh ? memory.snapshots.get(targetKey(target)) : undefined;
      const planned = planLoop({ model: state.model, loop, target, sanityClient, restore });
      if (!planned.ok) {
        return planned;
      }
      const plan = planned.plan;
      rememberLoop(loopMemoryRef.current, nodeId, {
        snapshots: fresh ? memory.snapshots : new Map<string, readonly EditorNode[]>(),
        previous: plan.previous,
        children,
        after: plan.loop.children,
      });
      assert(plan.loop.id === nodeId, 'A loop plan restates the loop it was made for');
      const options = { coalesceKey: undefined, urgency: true };
      const written = (model: EditorModel): EditorModel => ({ ...model, extraFrontmatter: plan.extraFrontmatter, imports: plan.imports });
      // Only what changed is sent: the document engine refuses an edit that
      // changes nothing (a sort dropped back where it was, a setting set to
      // what it already says), and that refusal read as an editor error.
      const loopChanged = plan.loop.head !== loop.head || plan.loop.children !== loop.children;
      const loopEdit = loopChanged ? nodeGesture(nodeId, plan.loop, options) : undefined;
      const after = loopEdit === undefined ? state.model : loopEdit.apply(state.model);
      const frontmatterChanged = frontmatterOf(written(after)) !== frontmatterOf(after);
      const frontmatterEdit = frontmatterChanged ? frontmatterGesture(after, options, written) : undefined;
      if (loopEdit !== undefined && frontmatterEdit !== undefined) {
        commitEdit(sequence(loopEdit, frontmatterEdit));
      } else if (loopEdit !== undefined || frontmatterEdit !== undefined) {
        const only = loopEdit ?? frontmatterEdit;
        assert(only !== undefined, 'One of the two edits is there');
        commitEdit(only);
      }
      return { ok: true, unbound: plan.unbound, lost: plan.lost, restored: plan.restored };
    },
    [commitEdit, pageStateRef],
  );
  return { setLoopSource };
}

// A page holds a few dozen loops at most, and a loop switches between a few
// sources; past these the oldest are forgotten, which only means a switch back
// re-points bindings instead of restoring them.
const LOOP_MEMORY_LOOPS_MAX = 64;
const LOOP_MEMORY_SOURCES_MAX = 16;

function rememberLoop(
  memory: LoopMemory,
  nodeId: string,
  change: {
    readonly snapshots: Map<string, readonly EditorNode[]>;
    readonly previous: string | undefined;
    readonly children: readonly EditorNode[];
    readonly after: readonly EditorNode[];
  },
): void {
  const snapshots = change.snapshots;
  if (change.previous !== undefined) {
    snapshots.delete(change.previous);
    snapshots.set(change.previous, change.children);
  }
  while (snapshots.size > LOOP_MEMORY_SOURCES_MAX) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    snapshots.delete(oldest);
  }
  memory.delete(nodeId);
  memory.set(nodeId, { produced: childrenFingerprint(change.after), snapshots });
  while (memory.size > LOOP_MEMORY_LOOPS_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    memory.delete(oldest);
  }
  assert(memory.size <= LOOP_MEMORY_LOOPS_MAX, 'Loop memory is bounded');
}
