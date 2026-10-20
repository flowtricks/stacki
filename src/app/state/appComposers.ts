// useAppScope: the app's whole state, composed in order — the core, each
// group of hooks on the ones before it, then the property edits and the view
// model (App.tsx).

import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useNavigation } from './appHistory';
import { useHistory } from './appNodeEdits';
import { useNodeEdits } from './appShortcuts';
import {
  useComment,
  useClassEdits,
  useAssetProp,
  useRenameProp,
  useNodeKind,
  useElementTag,
  useNodeText,
  useBranchEdits,
  useContentEdits,
} from './appPropertyEdits';
import { useShortcuts } from './appPageOps';
import {
  usePageOps,
  useScopeContext,
  useInstanceProps,
  useTagOptions,
  useCodeWindow,
  useSymbolFile,
  useCanvasGate,
  useCanvasNotices,
  useCrumbLabels,
  useCanvasMarks,
  useSelectionPaths,
  useOverlayInfo,
} from './appViewModel';
import { useFeedback } from '../../features/feedback/feedbackState';

// Every piece of the app's state and behaviour, in the order its hooks run.
export function useAppScope() {
  const coreState = useCoreState();
  const lifecycle = useLifecycle(coreState);
  const navigation = useNavigation(coreState, lifecycle);
  const history = useHistory(coreState, lifecycle, navigation);
  const nodeEdits = useNodeEdits(coreState, lifecycle, history);
  const shortcuts = useShortcuts(coreState, lifecycle, navigation, history, nodeEdits);
  const propertyEdits = usePropertyEdits(coreState, lifecycle, history, nodeEdits);
  const pageOps = usePageOps(coreState, lifecycle, navigation, history, nodeEdits, shortcuts);
  const viewModel = useViewModel(coreState, lifecycle, shortcuts, pageOps);
  // After the view model: it sets the selection keys this render pins notes to.
  const feedback = useFeedback({
    projectPath: coreState.project?.path,
    selectionKeys: coreState.selectionKeysRef.current,
    editedRel: viewModel.editedRel,
    label: viewModel.overlayInfo(viewModel.pathFor(coreState.selectedId) ?? '')?.label,
    showToast: lifecycle.showToast,
  });
  return {
    ...coreState,
    ...lifecycle,
    ...navigation,
    ...history,
    ...nodeEdits,
    ...shortcuts,
    ...propertyEdits,
    ...pageOps,
    ...viewModel,
    ...feedback,
  };
}

// Editing a node’s properties.
export function usePropertyEdits(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const comment = useComment(coreState, history);
  const classEdits = useClassEdits(coreState, lifecycle, history);
  const assetProp = useAssetProp(coreState, classEdits, history);
  const renamePropScope = useRenameProp(coreState, history);
  const nodeKind = useNodeKind(coreState, nodeEdits, history);
  const elementTag = useElementTag(coreState, history);
  const nodeText = useNodeText(coreState, history);
  const branchEdits = useBranchEdits(coreState, history);
  const contentEdits = useContentEdits(coreState, history);
  return {
    ...comment,
    ...classEdits,
    ...assetProp,
    ...renamePropScope,
    ...nodeKind,
    ...elementTag,
    ...nodeText,
    ...branchEdits,
    ...contentEdits,
  };
}

// What the panels and the canvas show.
export function useViewModel(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
) {
  const scopeContext = useScopeContext(shortcuts, pageOps, coreState);
  useInstanceProps(scopeContext, coreState);
  const tagOptionsScope = useTagOptions(coreState, pageOps, shortcuts);
  const codeWindow = useCodeWindow(coreState, shortcuts, pageOps, lifecycle);
  const symbolFile = useSymbolFile(coreState, pageOps, lifecycle);
  const canvasGate = useCanvasGate(coreState, lifecycle, codeWindow);
  const canvasNotices = useCanvasNotices(lifecycle, coreState, shortcuts);
  const crumbLabels = useCrumbLabels(pageOps, canvasNotices, coreState, shortcuts);
  const canvasMarks = useCanvasMarks(coreState, shortcuts, pageOps, crumbLabels, canvasNotices);
  const selectionPaths = useSelectionPaths(shortcuts, pageOps, canvasNotices, coreState);
  const overlayInfoScope = useOverlayInfo(shortcuts, pageOps, crumbLabels);
  return {
    ...scopeContext,
    ...tagOptionsScope,
    ...codeWindow,
    ...symbolFile,
    ...canvasGate,
    ...canvasNotices,
    ...crumbLabels,
    ...canvasMarks,
    ...selectionPaths,
    ...overlayInfoScope,
  };
}
