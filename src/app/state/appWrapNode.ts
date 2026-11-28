import { useCallback } from 'react';
import { canConvertText, canWrapNode, textWrapGesture, wrapNodeGesture, type TextTag, type WrapperTag } from '../../editor/wrapNode';
import { showWrapOnCanvas } from '../../editor/canvasInsertShow';
import { newId } from '../model/nodeFactory';
import { editingOffFor } from '../../lib/editorGate';
import type { useCoreState } from './appLifecycle';
import type { useHistory } from './appNodeEdits';

export function useWrapNode(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { canvasPathForRef, pageStateRef, setSelectedId } = coreState;
  const { commitEdit } = history;
  const wrapNode = useCallback(
    (nodeId: string, name: WrapperTag): void => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable || editingOffFor('elements') !== undefined) {
        return;
      }
      if (!canWrapNode(state.model.nodes, nodeId, name)) {
        return;
      }
      const wrapper = { id: newId(), name };
      if (commitEdit(wrapNodeGesture(state.model, nodeId, wrapper))) {
        // The wrapper stands around the node on the canvas at once (framePendingInsert.ts).
        showWrapOnCanvas(state.model, nodeId, name, (id) => canvasPathForRef.current(id));
      }
      setSelectedId(wrapper.id);
    },
    [canvasPathForRef, commitEdit, pageStateRef, setSelectedId],
  );
  const convertText = useCallback(
    (nodeId: string, name: TextTag): void => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable || editingOffFor('elements') !== undefined) {
        return;
      }
      if (!canConvertText(state.model.nodes, nodeId, name)) {
        return;
      }
      const wrapper = { id: newId(), name };
      commitEdit(textWrapGesture(state.model, nodeId, wrapper));
      setSelectedId(wrapper.id);
    },
    [commitEdit, pageStateRef, setSelectedId],
  );
  return { convertText, wrapNode };
}
