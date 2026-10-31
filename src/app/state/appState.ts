// The app's state, held at its root: the project, the canvas's reports, the
// dev server, data, panels, the window, and the session's refs. The hooks in
// this folder build on it in order; useAppScope (appComposers.ts) composes
// them (App.tsx).

import { usePropertySaveGuard } from '../usePropertySaveGuard';
import type { RemoteCmsSelection } from '../../features/cms/remoteCmsShared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScanResult } from '../../../shared/properties/projectScan';
import { nodeAtPath, pathOfNode } from '../../editor/editorTree';
import type { DevDiagnosis } from '../../features/preview/DevOffline';
import type { PreviewDevice } from '../../features/preview/PreviewToolbar';
import type { VariableSelection } from '../../features/variables/variablesBridge';
import { type CodeWindowState } from '../../features/code/codeWindowTarget';
import {
  type AssetPick,
  type CollectionSamples,
  type DevStatus,
  type DynamicEntry,
  type GitInfo,
  type InjectedRoute,
  type ItemIndexes,
  type LeftTab,
  type NodeStates,
  type PreviewCommitInfo,
  type ProjectIdentity,
  type RightTab,
  type RightTabIndicator,
} from '../appTypes';
import {
  findEditorNodeById as findNodeById,
  type CurrentPage,
  type EditorPageState,
  type OpenFile,
  type PageStateSnapshot,
  type TrailingSlash,
} from '../../editor/pageState';
import { type EditorModel } from '../../editor/pageView';
import { type AppCollection } from '../../ipc/appBridge';
import { createLiveValue } from '../../ui/liveValue';

// The open project, its scan, and the page and selection being edited.
export function useProjectState() {
  const propertySave = usePropertySaveGuard();
  const [project, setProject] = useState<ProjectIdentity | undefined>(undefined);

  // ----------------------------------------------------------------
  // Model operations
  // ----------------------------------------------------------------

  const projectRef = useRef<ProjectIdentity | undefined>(undefined);
  projectRef.current = project;
  const [scan, setScan] = useState<ScanResult>({
    pages: [],
    pageFolders: [],
    layouts: [],
    components: [],
  });
  const [projectClasses, setProjectClasses] = useState<readonly string[]>([]);
  const [currentPage, setCurrentPage] = useState<CurrentPage | undefined>(undefined);
  // Drill-down trail: [page, component, nested component, …]. The last entry
  // is what's on screen; anything before it is what Back/Escape returns to.
  const [editStack, setEditStack] = useState<readonly OpenFile[]>([]);
  const [pageState, setPageState] = useState<EditorPageState | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  return {
    currentPage,
    editStack,
    pageState,
    project,
    projectClasses,
    projectRef,
    propertySave,
    scan,
    selectedId,
    setCurrentPage,
    setEditStack,
    setPageState,
    setProject,
    setProjectClasses,
    setScan,
    setSelectedId,
  };
}

// What the canvas reports about the selection and the rendered page.
export function useCanvasReportState() {
  // Classes the selected element actually carries on the page, reported by the
  // preview. An expression-valued class attribute (`class:list={[…]}`,
  // `class={x}`) has no readable text in the source, so this is what lets the
  // style panel show the classes this instance resolved to.
  const [selectedClasses, setSelectedClasses] = useState<readonly string[]>([]);
  // Navigator selection is an action even when the row is already selected:
  // it resets a canvas-picked loop occurrence to the first rendered copy.
  const [navigatorSelectionTick, setNavigatorSelectionTick] = useState(0);
  // Which selection the classes above describe, and a counter that lets the
  // effect below re-check the moment a report lands rather than on a timer.
  const classesForRef = useRef<string | undefined>(undefined);
  const [classesTick, setClassesTick] = useState(0);
  // The navigator row under the pointer: a live value, read by the canvas pane
  // alone, so crossing rows does not re-render the app (src/ui/liveValue.ts).
  const [hoverNode] = useState(() => createLiveValue<string | undefined>(undefined));
  // Paths the page reports as having actually rendered something. Null until
  // the page has said anything, which is not the same as "nothing rendered".
  const [renderedPaths, setRenderedPathsState] = useState<readonly string[] | undefined>(undefined);
  // Nodes the page says are there but taking no part: display:none, and
  // pointer-events:none. Marked in the navigator (see StructurePanel).
  const [nodeStates, setNodeStatesState] = useState<NodeStates | undefined>(undefined);
  // Path to the classes that node rendered with, for labelling rows whose
  // class is an expression the source can't resolve.
  const [nodeClasses, setNodeClassesState] = useState<
    Readonly<Record<string, readonly string[]>> | undefined
  >(undefined);
  // The canvas re-reports after every walk of the page, mostly with what it
  // said last time. A report equal to the one held keeps the held one, and
  // React skips the render a new array or object would have cost the app.
  const setRenderedPaths = useCallback(
    (next: readonly string[] | undefined) =>
      setRenderedPathsState((held) => (sameReport(held, next) ? held : next)),
    [],
  );
  const setNodeStates = useCallback(
    (next: NodeStates | undefined) =>
      setNodeStatesState((held) => (sameReport(held, next) ? held : next)),
    [],
  );
  const setNodeClasses = useCallback(
    (next: Readonly<Record<string, readonly string[]>> | undefined) =>
      setNodeClassesState((held) => (sameReport(held, next) ? held : next)),
    [],
  );
  return {
    classesForRef,
    classesTick,
    hoverNode,
    navigatorSelectionTick,
    nodeClasses,
    nodeStates,
    renderedPaths,
    selectedClasses,
    setClassesTick,
    setHoverNodeId: hoverNode.set,
    setNodeClasses,
    setNodeStates,
    setNavigatorSelectionTick,
    setRenderedPaths,
    setSelectedClasses,
  };
}

// Two canvas reports say the same thing: the same object, or the same content.
// Reports are built in a fixed order, so equal content serializes equally; a
// report that differs only in order reads as changed and costs one render,
// never a wrong one.
export function sameReport(held: unknown, next: unknown): boolean {
  if (held === next) {
    return true;
  }
  if (held === undefined || next === undefined) {
    return false;
  }
  return JSON.stringify(held) === JSON.stringify(next);
}

// The dev server, the busy overlay and the toast.
export function useDevState() {
  const [devUrl, setDevUrl] = useState<string | undefined>(undefined);
  const [trailingSlash, setTrailingSlash] = useState<TrailingSlash>('ignore');
  const [devStatus, setDevStatus] = useState<DevStatus>('off');
  // Dev-server output arrives a chunk at a time and is shown in two corners
  // (DevOffline, the parse-error view): a live value they read, so a chunk
  // re-renders them rather than the app (src/ui/liveValue.ts).
  const [devLog] = useState(() => createLiveValue(''));
  const setDevLog = devLog.set;
  const [devDiag, setDevDiag] = useState<DevDiagnosis | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  return {
    busy,
    devDiag,
    devLog,
    devStatus,
    devUrl,
    refreshKey,
    setBusy,
    setDevDiag,
    setDevLog,
    setDevStatus,
    setDevUrl,
    setRefreshKey,
    setTrailingSlash,
    trailingSlash,
  };
}

// Dynamic routes, injected routes and the data the binding picker samples.
export function useDataState() {
  // Concrete paths behind a dynamic route, and which one the canvas is showing.
  const [dynamicPaths, setDynamicPaths] = useState<readonly DynamicEntry[]>([]);
  // Routes the dev server serves that aren't files here — pages an integration
  // injected. A project can consist entirely of these (a site whose pages ship
  // in a package), in which case they are the only pages there are to show.
  const [injectedRoutes, setInjectedRoutes] = useState<readonly InjectedRoute[]>([]);
  // One sampled entry per collection the open file reads by name, for the
  // binding picker. Keyed by collection; a name present with no value has
  // been asked for and has no answer, which stops it being asked again.
  const [collectionSamples, setCollectionSamples] = useState<CollectionSamples>({});
  // Every collection the project has, so data anywhere in the site is
  // reachable from the picker — not only what this page already reads.
  const [collections, setCollections] = useState<readonly AppCollection[]>([]);
  const sampleAskedRef = useRef(new Set<string>());
  const [dynamicIndex, setDynamicIndex] = useState(0);
  // Which item of each loop's list the data picker reads as `service`, `post`,
  // … — keyed by the item's own name. See bindContext below.
  const [itemIndex, setItemIndex] = useState<ItemIndexes>({});
  const [dynamicError, setDynamicError] = useState<string | undefined>(undefined);
  return {
    collectionSamples,
    collections,
    dynamicError,
    dynamicIndex,
    dynamicPaths,
    injectedRoutes,
    itemIndex,
    sampleAskedRef,
    setCollectionSamples,
    setCollections,
    setDynamicError,
    setDynamicIndex,
    setDynamicPaths,
    setInjectedRoutes,
    setItemIndex,
  };
}

// The left panel, the CMS views and the interactive preview.
export function usePanelState(
  canvasReportState: ReturnType<typeof useCanvasReportState>,
  projectState: ReturnType<typeof useProjectState>,
) {
  const { setHoverNodeId } = canvasReportState;
  const { currentPage } = projectState;

  const [leftTab, setLeftTab] = useState<LeftTab>('navigator');
  useEffect(() => {
    if (leftTab !== 'navigator') {
      setHoverNodeId(undefined);
    }
  }, [leftTab, setHoverNodeId]);
  const componentPropertiesOpen = currentPage?.kind === 'component';
  useEffect(() => {
    if (!componentPropertiesOpen) {
      setLeftTab((tab) => (tab === 'properties' ? 'navigator' : tab));
    }
  }, [componentPropertiesOpen]);
  const [cmsRel, setCmsRel] = useState<string | undefined>(undefined);
  // Content collection open in the schema-driven editor. Only one of the two
  // is ever open: they edit the same kind of thing in two different ways.
  const [contentName, setContentName] = useState<string | undefined>(undefined);
  // A connected CMS's document open in the main view; never open beside the two above.
  const [cmsRemote, setCmsRemote] = useState<RemoteCmsSelection | undefined>(undefined);
  // Which stylesheet group the variables sheet is showing: { file, index }.
  const [varsGroup, setVarsGroup] = useState<VariableSelection | undefined>(undefined);
  const [cmsTick, setCmsTick] = useState(0); // bumped on save, refreshes counts
  const [cmsSettings, setCmsSettings] = useState(false); // editing that collection's fields
  const [inPreview, setInPreview] = useState(false); // interactive full-site preview
  const [previewSource, setPreviewSource] = useState<string | undefined>(undefined);
  return {
    cmsRemote,
    setCmsRemote,
    cmsRel,
    cmsSettings,
    cmsTick,
    componentPropertiesOpen,
    contentName,
    inPreview,
    leftTab,
    previewSource,
    setCmsRel,
    setCmsSettings,
    setCmsTick,
    setContentName,
    setInPreview,
    setLeftTab,
    setPreviewSource,
    setVarsGroup,
    varsGroup,
  };
}

// The canvas route, the code window, the breakpoint and the right panel.
export function useWindowState() {
  // The path the canvas is on, kept where the preview toggle can read it: it's
  // derived at the bottom of this component (a dynamic page's entry is picked
  // there), long after the callbacks up here are defined.
  const livePathRef = useRef<string | undefined>(undefined);
  // A node's path on the canvas, for the edits that show themselves there
  // before the source rebuilds. Set where the page tree is (appCanvasModel.ts),
  // which is built after the edit callbacks that read it.
  const canvasPathForRef = useRef<(id: string) => string | undefined>(() => undefined);
  const [termOpen, setTermOpen] = useState(false); // bottom terminal dock
  const [codeWin, setCodeWin] = useState<CodeWindowState | undefined>(undefined);
  const openCodeWindowRef = useRef<(() => boolean) | undefined>(undefined);
  const selectionKeysRef = useRef<readonly string[]>([]);
  const [fileText, setFileText] = useState(''); // loaded text for kind:'file'
  // Breakpoint lives here, not in PreviewPane: a re-mount of that pane must
  // not silently drop the user out of the view they picked (which would
  // reload every preview iframe and flash the canvas white).
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  // Bumped every time the page itself makes the selection, so the navigator
  // scrolls the row into view — a counter, not the id, so clicking the same
  // element twice still reveals it.
  const [revealTick, setRevealTick] = useState(0);
  const [rightTab, setRightTab] = useState<RightTab>('style');
  // ⌘Enter asks the props panel to open Settings and take the caret into the
  // class field — a counter, so pressing it again re-focuses.
  // Git state, read here so the History panel and the title-bar chip cannot
  // disagree about which branch is checked out. The chip still refreshes it on
  // its own schedule; this is the copy the panel reads.
  const [gitInfo, setGitInfo] = useState<GitInfo | undefined>(undefined);
  // The commit being previewed, or undefined for the working tree. See phase 4:
  // while this is set the canvas points at a separate server and the editor is
  // read-only.
  const [previewRef, setPreviewRef] = useState<string | undefined>(undefined);
  const [previewInfo, setPreviewInfo] = useState<PreviewCommitInfo | undefined>(undefined);
  const [classFocus, setClassFocus] = useState(0);
  const [contentFocus, setContentFocus] = useState(0);
  // Sliding highlight behind the active Style/Settings tab, measured from the
  // buttons so it tracks their real geometry (and any panel resize).
  const rightTabRefs = useRef<Record<string, HTMLButtonElement | undefined>>({});
  const [rightTabInd, setRightTabInd] = useState<RightTabIndicator | undefined>(undefined);
  // The asset request a field is waiting on, and the tab to go back to once
  // it's answered — "Choose Image…" borrows the left panel rather than
  // opening a window over the canvas.
  const [assetPick, setAssetPick] = useState<AssetPick | undefined>(undefined);
  const tabBeforePick = useRef<LeftTab>(undefined);
  // Bumped by ⌘⇧A: the Components panel opens its naming dialog when it changes.
  const [createRequest, setCreateRequest] = useState(0);
  return {
    assetPick,
    classFocus,
    codeWin,
    contentFocus,
    createRequest,
    device,
    fileText,
    gitInfo,
    livePathRef,
    canvasPathForRef,
    openCodeWindowRef,
    previewInfo,
    previewRef,
    revealTick,
    rightTab,
    rightTabInd,
    rightTabRefs,
    selectionKeysRef,
    setAssetPick,
    setClassFocus,
    setCodeWin,
    setContentFocus,
    setCreateRequest,
    setDevice,
    setFileText,
    setGitInfo,
    setPreviewInfo,
    setPreviewRef,
    setRevealTick,
    setRightTab,
    setRightTabInd,
    setTermOpen,
    tabBeforePick,
    termOpen,
  };
}

// Components, the page snapshot refs, and the selection that follows its node.
export function useSessionRefs(projectState: ReturnType<typeof useProjectState>) {
  const { currentPage, pageState, scan, setSelectedId } = projectState;

  // A layout is just a component that lives in src/layouts — it can be
  // placed on a page like any other. Every lookup that answers "what do we
  // know about the component named X" has to search both lists, or a placed
  // layout would come back with no props, no slots and no rest support.
  // Components win a name collision: they're the more likely intent.
  const insertables = useMemo(
    () => [...scan.components, ...scan.layouts],
    [scan.components, scan.layouts],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const devLogRef = useRef('');
  const pageStateRef = useRef<PageStateSnapshot>({ currentPage: undefined, pageState: undefined });
  pageStateRef.current = { currentPage, pageState };

  // The selection follows the node it names across every model the page
  // shows: by its handle, which parses carry by span mapping (plan §4). A
  // selected node whose own bytes changed has no handle left to carry, and the
  // selection moves to the node at the same place, of the same kind. Selection
  // is interaction state, and never names a node to main.
  const shownModelRef = useRef<EditorModel | undefined>(undefined);
  useEffect(() => {
    const model = pageState?.editable ? pageState.model : undefined;
    const before = shownModelRef.current;
    shownModelRef.current = model;
    if (!model || !before || before === model) {
      return;
    }
    setSelectedId((id) => {
      if (!id || id === 'layout' || id === 'frontmatter' || findNodeById(model.nodes, id)) {
        return id;
      }
      const was = findNodeById(before.nodes, id);
      const trail = pathOfNode(before.nodes, id);
      const now = trail ? nodeAtPath(model.nodes, trail) : undefined;
      return now && was && now.kind === was.kind ? now.id : undefined;
    });
  }, [pageState, setSelectedId]);
  return { devLogRef, insertables, pageStateRef, saveTimer };
}

// Typed code awaiting its parse, and the refs event handlers read.
export function useTypedCodeRefs(
  sessionRefs: ReturnType<typeof useSessionRefs>,
  projectState: ReturnType<typeof useProjectState>,
  canvasReportState: ReturnType<typeof useCanvasReportState>,
  panelState: ReturnType<typeof usePanelState>,
) {
  const { pageStateRef } = sessionRefs;
  const { editStack, selectedId } = projectState;
  const { classesForRef, setClassesTick, setSelectedClasses } = canvasReportState;
  const { inPreview } = panelState;

  // Typed code waiting for its parse (step 8). While the page shows that text,
  // its model is the parse of older text, and a gesture on it would save that
  // model over the typing: gestures wait until the parse lands.
  const typedSourceRef = useRef<string | undefined>(undefined);
  const typedCodeUnparsed = useCallback((): boolean => {
    const typed = typedSourceRef.current;
    return typed !== undefined && typed === pageStateRef.current.pageState?.source;
  }, [pageStateRef]);
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedId;

  // A report from the canvas about what the selected element's classes really
  // are. It is always about whatever is selected right now — the canvas is
  // asked for the tracked path — so this records which element it answered
  // for, which is what lets the panel tell a fresh answer from a stale one.
  const receiveClasses = useCallback(
    (list: readonly string[]) => {
      classesForRef.current = selectedIdRef.current;
      setSelectedClasses(list);
      setClassesTick((count) => count + 1);
    },
    [classesForRef, setClassesTick, setSelectedClasses],
  );
  const editStackRef = useRef<readonly OpenFile[]>([]);
  editStackRef.current = editStack;
  const inPreviewRef = useRef(false);
  inPreviewRef.current = inPreview;
  const previewPathRef = useRef<string | undefined>(undefined);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  return {
    editStackRef,
    inPreviewRef,
    previewIframeRef,
    previewPathRef,
    receiveClasses,
    selectedIdRef,
    typedCodeUnparsed,
    typedSourceRef,
  };
}
