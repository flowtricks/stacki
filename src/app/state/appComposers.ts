// useAppScope: the app's whole state, composed in order — the core, each
// group of hooks on the ones before it, then the property edits and the view
// model (App.tsx).

import { useMemo } from 'react';
import { classNamesIn, classSourceKind } from '../../../shared/page/classNames';
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
import { useAppInsert } from './appInsert';
import { useLoopEdits } from './appLoopEdits';
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

// Every piece of the app's state and behaviour, in the order its hooks run.
export function useAppScope() {
  const coreState = useCoreState();
  const lifecycle = useLifecycle(coreState);
  const navigation = useNavigation(coreState, lifecycle);
  const history = useHistory(coreState, lifecycle, navigation);
  const nodeEdits = useNodeEdits(coreState, lifecycle, history);
  const shortcuts = useShortcuts(coreState, lifecycle, navigation, history, nodeEdits);
  const appInsert = useAppInsert(coreState, history);
  const propertyEdits = usePropertyEdits(coreState, lifecycle, history, nodeEdits);
  const pageOps = usePageOps(coreState, lifecycle, navigation, history, nodeEdits, shortcuts);
  const viewModel = useViewModel(coreState, lifecycle, shortcuts, pageOps);
  return {
    ...coreState,
    ...lifecycle,
    ...navigation,
    ...history,
    ...nodeEdits,
    ...shortcuts,
    ...appInsert,
    ...propertyEdits,
    ...pageOps,
    ...viewModel,
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
  const loopEdits = useLoopEdits(coreState, history);
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
    ...loopEdits,
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
  const projectClasses = usePageClasses(coreState);
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
    projectClasses,
  };
}

// The class field's suggestions: the project's classes as last scanned, and
// the open file's own as it reads now, so a class just written into the page
// is offered at once rather than after the next scan.
function usePageClasses(coreState: ReturnType<typeof useCoreState>): readonly string[] {
  const { projectClasses, pageState, currentPage } = coreState;
  const source = pageState?.source;
  const file = currentPage?.path;
  return useMemo(() => {
    const kind = file === undefined ? undefined : classSourceKind(file);
    if (source === undefined || kind === undefined) {
      return projectClasses;
    }
    const known = new Set(projectClasses);
    const own = classNamesIn(source, kind).filter((name) => !known.has(name));
    return own.length === 0 ? projectClasses : [...projectClasses, ...own].sort();
  }, [projectClasses, source, file]);
}
