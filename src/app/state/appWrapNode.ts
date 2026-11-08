import { useCallback } from 'react';
import { canConvertText, canWrapNode, textWrapGesture, wrapNodeGesture, type TextTag, type WrapperTag } from '../../editor/wrapNode';
import { newId } from '../model/nodeFactory';
import type { useCoreState } from './appLifecycle';
import type { useHistory } from './appNodeEdits';

export function useWrapNode(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { pageStateRef, setSelectedId } = coreState;
  const { commitEdit } = history;
  const wrapNode = useCallback(
    (nodeId: string, name: WrapperTag): void => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      if (!canWrapNode(state.model.nodes, nodeId, name)) {
        return;
      }
      const wrapper = { id: newId(), name };
      commitEdit(wrapNodeGesture(state.model, nodeId, wrapper));
      setSelectedId(wrapper.id);
    },
    [commitEdit, pageStateRef, setSelectedId],
  );
  const convertText = useCallback(
    (nodeId: string, name: TextTag): void => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
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
