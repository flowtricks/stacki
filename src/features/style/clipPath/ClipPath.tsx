import {
  type ClipPathProps,
  useShapeState,
  useHandleSelectionState,
  useShapeFitState,
  useStyleSourceState,
  useCanvasRefs,
  useWriteRefs,
  useSelectionRefs,
  useShapeRefs,
  useCodeHighlights,
  useSelectedCodeHighlights,
  useLatestMirrors,
  shapeSyncActions,
  shapeScaleSyncActions,
  pastedCacheActions,
  handleSelectionActions,
} from './clipPathEditorState';
import {
  pointerSelectionActions,
  polygonSelectionActions,
  dragSupportActions,
  dragFinishActions,
  transformDragActions,
  selectionLoadActions,
  historyActions,
  pointDeleteActions,
  pointDuplicateActions,
  presetChoiceActions,
  breakpointActions,
  codeEditActions,
} from './clipPathEditActions';
import {
  codeSelectionActions,
  type EditorAfterCodeSelectionActions,
  shapeFitActions,
  shapeScaleActions,
  guideActions,
  dragPointActions,
  presetTypeaheadActions,
  presetButtonActions,
  presetListActions,
  handleKeyboardActions,
  shapeKeyboardActions,
  keyboardLoopActions,
  keyboardKeyActions,
} from './clipPathShapeActions';
import {
  marqueeMoveActions,
  pointDuplicateDragActions,
  handleDragActions,
  pointerMoveActions,
  pointerEndActions,
  useWindowPointerListeners,
  useDismissListeners,
  useDeselectListener,
  useCanvasMeasure,
  useCodeSyncEffects,
  useShortcutListeners,
  windowKeyDownActions,
} from './clipPathPointerActions';
import { useWindowKeyListeners } from './clipPathSelectionRead';
import { useSelectionSync } from './useSelectionSync';
import {
  useClipPathWrite,
  useTimerCleanup,
  pointEditActions,
  type EditorAfterPointEditActions,
  marqueeStartActions,
  transformStartActions,
  dragStartActions,
  handleGeometry,
  renderGeometry,
} from './clipPathWriteActions';
import './ClipPath.css';
import { ClipPathView } from './ClipPathView';

function useClipPathEditorPart1(editor: ClipPathProps) {
  const stage1 = Object.assign(editor, useShapeState());
  const stage2 = Object.assign(stage1, useHandleSelectionState());
  const stage3 = Object.assign(stage2, useShapeFitState());
  const stage4 = Object.assign(stage3, useStyleSourceState());
  const stage5 = Object.assign(stage4, useCanvasRefs());
  const stage6 = Object.assign(stage5, useWriteRefs());
  const stage7 = Object.assign(stage6, useSelectionRefs());
  const stage8 = Object.assign(stage7, useShapeRefs(stage7));
  const stage9 = Object.assign(stage8, useCodeHighlights(stage8));
  const stage10 = Object.assign(stage9, useSelectedCodeHighlights(stage9));
  const stage11 = Object.assign(stage10, useLatestMirrors(stage10));
  const stage12 = Object.assign(stage11, shapeSyncActions(stage11));
  const stage13 = Object.assign(stage12, shapeScaleSyncActions(stage12));
  const stage14 = Object.assign(stage13, pastedCacheActions(stage13));
  const stage15 = Object.assign(stage14, handleSelectionActions(stage14));
  const stage16 = Object.assign(stage15, pointerSelectionActions(stage15));
  const stage17 = Object.assign(stage16, polygonSelectionActions(stage16));
  const stage18 = Object.assign(stage17, dragSupportActions(stage17));
  const stage19 = Object.assign(stage18, dragFinishActions(stage18));
  const stage20 = Object.assign(stage19, transformDragActions(stage19));
  const stage21 = Object.assign(stage20, selectionLoadActions(stage20));
  const stage22 = Object.assign(stage21, historyActions(stage21));
  const stage23 = Object.assign(stage22, pointDeleteActions(stage22));
  const stage24 = Object.assign(stage23, pointDuplicateActions(stage23));
  const stage25 = Object.assign(stage24, presetChoiceActions(stage24));
  const stage26 = Object.assign(stage25, breakpointActions(stage25));
  const stage27 = Object.assign(stage26, codeEditActions(stage26));
  const stage28 = Object.assign(stage27, codeSelectionActions(stage27));
  return stage28;
}

function useClipPathEditorPart2(editor: EditorAfterCodeSelectionActions) {
  const stage1 = Object.assign(editor, shapeFitActions(editor));
  const stage2 = Object.assign(stage1, shapeScaleActions(stage1));
  const stage3 = Object.assign(stage2, guideActions(stage2));
  const stage4 = Object.assign(stage3, dragPointActions(stage3));
  const stage5 = Object.assign(stage4, presetTypeaheadActions(stage4));
  const stage6 = Object.assign(stage5, presetButtonActions(stage5));
  const stage7 = Object.assign(stage6, presetListActions(stage6));
  const stage8 = Object.assign(stage7, handleKeyboardActions(stage7));
  const stage9 = Object.assign(stage8, shapeKeyboardActions(stage8));
  const stage10 = Object.assign(stage9, keyboardLoopActions(stage9));
  const stage11 = Object.assign(stage10, keyboardKeyActions(stage10));
  const stage12 = Object.assign(stage11, marqueeMoveActions(stage11));
  const stage13 = Object.assign(stage12, pointDuplicateDragActions(stage12));
  const stage14 = Object.assign(stage13, handleDragActions(stage13));
  const stage15 = Object.assign(stage14, pointerMoveActions(stage14));
  const stage16 = Object.assign(stage15, pointerEndActions(stage15));
  const stage17 = Object.assign(stage16, useWindowPointerListeners(stage16));
  useDismissListeners(stage17);
  const stage18 = Object.assign(stage17, useDeselectListener(stage17));
  useCanvasMeasure(stage18);
  const stage19 = Object.assign(stage18, useCodeSyncEffects(stage18));
  const stage20 = Object.assign(stage19, useShortcutListeners(stage19));
  const stage21 = Object.assign(stage20, windowKeyDownActions(stage20));
  const stage22 = Object.assign(stage21, useWindowKeyListeners(stage21));
  useSelectionSync(stage22);
  useClipPathWrite(stage22);
  const stage23 = Object.assign(stage22, useTimerCleanup(stage22));
  const stage24 = Object.assign(stage23, pointEditActions(stage23));
  return stage24;
}

function useClipPathEditorPart3(editor: EditorAfterPointEditActions) {
  const stage1 = Object.assign(editor, marqueeStartActions(editor));
  const stage2 = Object.assign(stage1, transformStartActions(stage1));
  const stage3 = Object.assign(stage2, dragStartActions(stage2));
  const stage4 = Object.assign(stage3, handleGeometry(stage3));
  const stage5 = Object.assign(stage4, renderGeometry(stage4));
  return stage5;
}

export default function ClipPath(props: ClipPathProps = {}) {
  // A copy: the composers widen the object they are given into the editor.
  const editor = useClipPathEditorPart3(useClipPathEditorPart2(useClipPathEditorPart1({ ...props })));
  return <ClipPathView editor={editor} />;
}
