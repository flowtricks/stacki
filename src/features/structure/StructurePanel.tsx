import { TreeDragRow, useTreeDragCleanup } from '../../ui/TreeDragDrop';
import { ErrorToast } from '../../ui/ErrorToast';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanelSearch } from '../../ui/PanelSearch';
import { isSearching } from '../../lib/searchText';
import { buildNavigatorIndex, navigatorHighlightWords, searchNavigator } from './navigatorSearch';
import type { NavigatorNode, StructurePageState, StructureProjection, DropLocation, DropTarget } from './structureModel';
import type { PseudoKind, PseudoNodeIds, StructureTreeContext } from './StructureTree';
import type { ContextPosition } from './StructureContextMenu';
import { ElementContextMenu } from './ElementContextMenu';
import type { WrapperTag } from '../../editor/wrapRules';
import { CollapseVerticalIcon, CodeIcon, ExpandVerticalIcon } from '../../ui/Icons';
import { hidesChildRows } from '../../editor/treeSelection';
import { navigatorArrowTarget } from './navigatorArrows';
import {
  collapseMap,
  defaultCollapsed,
  findNavigatorNode,
  findVisibleNode,
  initialCollapseMap,
  navigatorAncestors,
  navigatorChildren,
  structureProjection,
} from './structureModel';
import CodeEditor from '../../ui/CodeEditor';
import { NodeList, scrollRowIntoScroller } from './StructureTree';
import {
  dropReasonText,
  selfRefusal,
  navigatorDragView,
  publishNavigatorDrop,
  subscribeCanvasDrag,
  type NavigatorDragView,
} from '../../editor/canvasDragSession';
import { clearDrag } from '../../editor/dragState';
import { navigatorDropOf, parseNavigatorDrop, type NavigatorDrop } from './navigatorDrop';
import { INSERT_DRAG_TYPE, type InsertDragChoice } from '../../editor/insertDragData';
import type { Drag } from '../../editor/dragState';
import { dropPlacement, type DropPlacement } from './dropPlacement';
import { documentOfPath, type PlacementEnvironment, type PlacementInsertable } from '../../editor/placementCheck';
import { getDrag } from '../../editor/dragState';
import type { PlacementMessage } from '../../../shared/page/placement';
import { type LiveValue } from '../../ui/liveValue';
import { assert } from '../../../shared/core/assert';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { reportActionToast } from '../../ui/errorNotices';
import { createPortal } from 'react-dom';
import { PanelHeader } from '../../ui/PanelHeader';
import { TOOLTIP_DELAY_MS } from '../../ui/delayedTooltip';

interface StructurePanelProps {
  readonly clientMode?: boolean;
  readonly editRootId?: string | undefined;
  readonly onSetDefaults?: (name: string, id: string) => void;
  readonly pageState: StructurePageState | undefined;
  readonly currentPage?:
    | {
        readonly kind: string;
        readonly route?: string;
        readonly from?: string;
        readonly path?: string;
      }
    | undefined;
  readonly layouts: readonly unknown[];
  /** The project's components, for the placement rule: a component is judged by the tag it renders. */
  readonly insertables?: readonly PlacementInsertable[];
  readonly currentLayoutName: string;
  readonly selectedId: string | undefined;
  readonly emptyNodeIds?: ReadonlySet<string>;
  readonly hiddenNodeIds?: ReadonlySet<string>;
  readonly inertNodeIds?: ReadonlySet<string>;
  readonly pseudoNodeIds?: PseudoNodeIds;
  readonly selectedPseudo?: PseudoKind | undefined;
  readonly onSelectPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly liveClassesById?: ReadonlyMap<string, readonly string[]>;
  /**
   * Labels that stand in for rows' own, by node id. Given, the tree is a list of named rows rather than a file (the
   * component canvas's frames), so the file's frontmatter row is left out.
   */
  readonly rowLabels?: ReadonlyMap<string, string>;
  readonly revealTick?: number;
  readonly onSelect: (id: string) => void;
  readonly onHoverNode?: (id: string | undefined) => void;
  readonly onHoverPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  /** A row holding code (frontmatter, <style>, <script>) was double-clicked. */
  readonly onOpenCode?: (id: string) => void;
  readonly onChangeLayout: (name: string) => void;
  readonly onDropComponent: (name: string, target: DropLocation) => void;
  /** Inserts a tile dropped from the Add elements panel; without it the Navigator takes no such drop. */
  readonly onDropInsert?: (choice: InsertDragChoice, target: DropLocation) => void;
  readonly onMoveNode: (id: string, target: DropLocation) => void;
  readonly onWrapNode?: (id: string, tag: WrapperTag) => void;
  readonly canChangeStructure?: (id: string) => boolean;
  readonly onRemoveNode: (id: string) => void;
  readonly onCopyNode: (id: string) => void;
  readonly onCutNode?: (id: string) => void;
  readonly onDuplicateNode: (id: string) => void;
  readonly onPasteNode: () => void;
  readonly hasClipboard?: (() => boolean) | false;
  /** Typed code (step 8): the same handler as the code panel's. */
  readonly onCodeChange: (source: string, position: number) => void;
  readonly onOpenCodePanel: () => void;
  /** The dev server's recent output: Astro's own account of the page. Live,
   * so a chunk of output re-renders the view that shows it, not the panel. */
  readonly devLog?: LiveValue<string> | undefined;
}

export default function StructurePanel(props: StructurePanelProps) {
  const translate = useTranslate();
  if (!props.pageState) {
    return <MissingPage currentPage={props.currentPage} />;
  }
  const projection = structureProjection(props.pageState);
  if (props.clientMode && projection.tag === 'parse-error') {
    return <ErrorToast message={translate('structure.error.needsDeveloper')} />;
  }
  switch (projection.tag) {
    case 'valid':
      return <EditableStructurePanel {...props} pageState={projection.state} />;
    case 'parse-error':
      return <ParseErrorPage projection={projection} {...props} />;
    default: {
      const exhaustive: never = projection;
      return exhaustive;
    }
  }
}

function MissingPage({ currentPage }: Pick<StructurePanelProps, 'currentPage'>) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const injected = currentPage?.kind === 'route';
  return (
    <div className="panel-section grow">
      <PanelHeader title={translate('rail.navigator')} />
      <div className="props-empty">
        {injected
          ? translateRich('structure.missing.injected', {
              route: <strong>{currentPage.route}</strong>,
              from: currentPage.from ? <code>{currentPage.from}</code> : translate('structure.missing.integration'),
            })
          : translate('structure.missing.select')}
      </div>
    </div>
  );
}

// Keep the source editable while syntax diagnostics use the shared notification surface.
function ParseErrorPage({
  projection,
  onCodeChange,
  onOpenCodePanel,
}: Pick<StructurePanelProps, 'devLog' | 'onCodeChange' | 'onOpenCodePanel'> & {
  readonly projection: Extract<StructureProjection, { readonly tag: 'parse-error' }>;
}) {
  const translate = useTranslate();
  const [diagnostic] = projection.diagnostics;
  return (
    <div className="panel-section grow">
      <PanelHeader title={translate('rail.code')} />
      <div className="code-editor">
        <ErrorToast
          message={
            diagnostic
              ? diagnostic.near
                ? translate('structure.error.syntaxNear', { message: diagnostic.message, near: diagnostic.near })
                : diagnostic.message
              : translate('structure.error.syntax')
          }
          recovery={[{ label: translate('structure.error.openCode'), run: onOpenCodePanel }]}
        />
        <div className="code-panel-editor">
          <CodeEditor language="astro" value={projection.state.source} onChange={onCodeChange} />
        </div>
      </div>
    </div>
  );
}

type EditableProps = StructurePanelProps & {
  readonly pageState: Extract<StructurePageState, { readonly editable: true }>;
};

function EditableStructurePanel(props: EditableProps) {
  const state = useTreeState(props);
  // A drag on the canvas is drawn here too, from the same decision, in the same commit (canvasDragSession.ts).
  const canvasDrag = useSyncExternalStore(subscribeCanvasDrag, navigatorDragView);
  useCanvasDragReveal(state.bodyRef, canvasDrag?.revealId);
  usePublishNavigatorDrop(props.pageState.model.nodes, canvasDrag === undefined ? state.dropTarget : undefined);
  const translate = useTranslate();
  const treeContext = treeContextOf(props, state, canvasDrag, translate);
  return (
    // A drag that starts in the tree ends the search first: the drop is a position in the page's own lists, which the filtered copy does not share.
    <div className="panel-section grow navigator" onDragStartCapture={() => state.setQuery('')}>
      <NavigatorHeader state={state} nodes={props.pageState.model.nodes} />
      <NavigatorBody props={props} state={state} treeContext={treeContext} canvasDrag={canvasDrag} />
      {state.contextMenu && (
        <ElementContextMenu {...props} nodes={props.pageState.model.nodes} position={state.contextMenu} onClose={() => state.setContextMenu(undefined)} />
      )}
    </div>
  );
}

/** What the Navigator says about the drop in flight (the placement rule): why a place refuses, where it lands instead, or a caution. */
interface DropNote {
  readonly tone: 'refused' | 'snapped' | 'warning';
  readonly reason: PlacementMessage;
}

interface TreeState {
  readonly dropNote: DropNote | undefined;
  readonly setDropNote: React.Dispatch<React.SetStateAction<DropNote | undefined>>;
  readonly dropTarget: DropTarget | undefined;
  readonly setDropTarget: React.Dispatch<React.SetStateAction<DropTarget | undefined>>;
  readonly toggled: ReadonlyMap<string, boolean>;
  readonly setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>;
  /** What the search box holds; never remembered. */
  readonly query: string;
  readonly setQuery: React.Dispatch<React.SetStateAction<string>>;
  /** Counts the searches a selection ended, so the selected row is scrolled into view in the tree that comes back. */
  readonly searchRevealTick: number;
  readonly setSearchRevealTick: React.Dispatch<React.SetStateAction<number>>;
  readonly allExpanded: boolean;
  readonly setAllExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  readonly contextMenu: ContextPosition | undefined;
  readonly setContextMenu: React.Dispatch<React.SetStateAction<ContextPosition | undefined>>;
  readonly bodyRef: React.RefObject<HTMLDivElement>;
  readonly tooltip: { readonly left: number; readonly top: number } | undefined;
  readonly showTooltip: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly hideTooltip: () => void;
}

function useTreeState(props: EditableProps): TreeState {
  const [dropTarget, setDropTarget] = useState<DropTarget | undefined>(undefined);
  const [dropNote, setDropNote] = useState<DropNote | undefined>(undefined);
  // The first frame already has the selected row's ancestors open: opening them in
  // an effect drew the tree folded for a frame, then pushed every row below the
  // selection down, on each open of the Navigator.
  const [toggled, setToggled] = useState(() =>
    selectionExpanded(initialCollapseMap(props.pageState.model.nodes), props.pageState.model.nodes, props.selectedId, props.selectedPseudo),
  );
  const [allExpanded, setAllExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [searchRevealTick, setSearchRevealTick] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextPosition | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tooltip = useHeaderTooltip();
  useTreeDragCleanup(() => {
    clearDrag();
    setDropTarget(undefined);
    setDropNote(undefined);
  });
  useArrowNavigation(props, toggled, setToggled, { searching: isSearching(query) });
  useSelectionExpansion(props, setToggled);
  useRevealRow(bodyRef, (props.revealTick ?? 0) + searchRevealTick, props.selectedId, props.selectedPseudo);
  return {
    dropNote,
    setDropNote,
    dropTarget,
    setDropTarget,
    toggled,
    setToggled,
    query,
    setQuery,
    searchRevealTick,
    setSearchRevealTick,
    allExpanded,
    setAllExpanded,
    contextMenu,
    setContextMenu,
    bodyRef,
    ...tooltip,
  };
}

function useHeaderTooltip(): Pick<TreeState, 'tooltip' | 'showTooltip' | 'hideTooltip'> {
  const [tooltip, setTooltip] = useState<TreeState['tooltip']>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hideTooltip = useCallback((): void => {
    clearTimeout(timer.current);
    setTooltip(undefined);
  }, []);
  const showTooltip = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTooltip({ left: bounds.left + bounds.width / 2, top: bounds.bottom + 8 }), TOOLTIP_DELAY_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { tooltip, showTooltip, hideTooltip };
}

function useArrowNavigation(
  props: EditableProps,
  toggled: ReadonlyMap<string, boolean>,
  setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>,
  { searching }: { readonly searching: boolean },
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = parseArrowKey(event);
      // The arrows walk the page's rows, which a search leaves out of sight.
      if (!key || !props.selectedId || searching) {
        return;
      }
      const found = findVisibleNode(props.pageState.model.nodes, props.selectedId);
      if (!found) {
        return;
      }
      event.preventDefault();
      // ::before and ::after are rows too (navigatorArrows.ts): ↓ enters them, ← → step past them.
      const next = navigatorArrowTarget(key, found, props.selectedPseudo, {
        childrenOf: shownChildren,
        pseudosOf: (id) => pseudoKindsFor(id, props.pseudoNodeIds),
      });
      if (next === undefined) {
        return;
      }
      if (key === 'ArrowDown' && collapsedState(found.node, toggled)) {
        setToggled((previous) => new Map(previous).set(found.node.id, false));
      }
      if (next.kind === 'node') {
        props.onSelect(next.node.id);
      } else {
        props.onSelectPseudo?.(next.nodeId, next.pseudo);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, searching, setToggled, toggled]);
}

// The children a node lists as rows: none where the tree folds them into it.
function shownChildren(node: NavigatorNode): readonly NavigatorNode[] {
  const children = navigatorChildren(node);
  return hidesChildRows(node, children) ? [] : children;
}

function pseudoKindsFor(id: string, pseudoNodeIds: PseudoNodeIds | undefined): readonly PseudoKind[] {
  const kinds: PseudoKind[] = [];
  if (pseudoNodeIds?.before.has(id) === true) {
    kinds.push('before');
  }
  if (pseudoNodeIds?.after.has(id) === true) {
    kinds.push('after');
  }
  return kinds;
}

type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

function parseArrowKey(event: KeyboardEvent): ArrowKey | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return undefined;
  }
  const target = event.target;
  if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) {
    return undefined;
  }
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      return event.key;
    default:
      return undefined;
  }
}

function useSelectionExpansion(props: EditableProps, setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>): void {
  // Before paint: a canvas drop ends the drag's opened rows and selects the moved node in one task, and with a
  // passive effect the tree was painted folded for a few frames between the two (seen in the running app).
  useLayoutEffect(() => {
    setToggled((previous) => selectionExpanded(previous, props.pageState.model.nodes, props.selectedId, props.selectedPseudo));
  }, [props.pageState.model.nodes, props.selectedId, props.selectedPseudo, setToggled]);
}

/** `toggled` with the selected row's ancestors open (and its element, for a picked ::before or ::after); `toggled` itself when nothing changes. */
export function selectionExpanded(
  toggled: ReadonlyMap<string, boolean>,
  nodes: readonly NavigatorNode[],
  selectedId: string | undefined,
  selectedPseudo: PseudoKind | undefined,
): ReadonlyMap<string, boolean> {
  if (selectedId === undefined || selectedId === 'frontmatter') {
    return toggled;
  }
  const ancestors = navigatorAncestors(nodes, selectedId);
  // A picked ::before or ::after is a row inside its element, so the element
  // opens too (a canvas click on one left it shut, the row out of sight).
  const own = selectedPseudo === undefined ? undefined : findVisibleNode(nodes, selectedId)?.node;
  const opened = own === undefined ? ancestors : [...ancestors, own];
  if (opened.length === 0) {
    return toggled;
  }
  const next = expandAncestors(toggled, opened);
  assert(
    opened.every((node) => !collapsedState(node, next)),
    'selectionExpanded: every opened row is open',
  );
  return next;
}

function expandAncestors(previous: ReadonlyMap<string, boolean>, ancestors: readonly NavigatorNode[]): ReadonlyMap<string, boolean> {
  const next = new Map(previous);
  let changed = false;
  for (const node of ancestors) {
    if (collapsedState(node, next)) {
      next.set(node.id, false);
      changed = true;
    }
  }
  return changed ? next : previous;
}

function useRevealRow(
  bodyRef: React.RefObject<HTMLDivElement>,
  revealTick: number,
  selectedId: string | undefined,
  selectedPseudo: PseudoKind | undefined,
): void {
  const lastReveal = useRef(revealTick);
  useEffect(() => {
    if (revealTick === lastReveal.current) {
      return;
    }
    lastReveal.current = revealTick;
    if (!selectedId) {
      return;
    }
    const frame = requestAnimationFrame(() => revealRow(bodyRef.current ?? undefined, selectedId, selectedPseudo));
    return () => cancelAnimationFrame(frame);
  }, [bodyRef, revealTick, selectedId, selectedPseudo]);
}

function revealRow(bodyElement: HTMLDivElement | undefined, selectedId: string, selectedPseudo: PseudoKind | undefined): void {
  const id = CSS.escape(selectedId);
  // The picked ::before / ::after row when there is one, else the element's own.
  const selector = selectedPseudo === undefined ? `[data-node-id="${id}"]` : `[data-pseudo-of="${id}"][data-pseudo="${selectedPseudo}"]`;
  // Its element's row when the pseudo row is not drawn yet (the element opens a frame later).
  const row = bodyElement?.querySelector<HTMLElement>(selector) ?? bodyElement?.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!bodyElement || !row) {
    return;
  }
  const bodyBounds = bodyElement.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  if (rowBounds.top >= bodyBounds.top && rowBounds.bottom <= bodyBounds.bottom) {
    return;
  }
  bodyElement.scrollTop += rowBounds.top - bodyBounds.top - (bodyBounds.height - rowBounds.height) / 2;
}

function treeContextOf(props: EditableProps, state: TreeState, canvasDrag: NavigatorDragView | undefined, translate: Translator): StructureTreeContext {
  // A canvas drag opens the rows its mark sits in for as long as it lasts, without touching what the person
  // opened or closed: when the drag ends the set is empty and every row is as it was.
  // A list of named rows (rowLabels) is open until the person closes a row: its rows are regenerated with new ids, and
  // a default that closed them would fold the list up each time.
  const isCollapsed = (node: NavigatorNode): boolean =>
    canvasDrag?.expand.has(node.id) === true
      ? false
      : props.rowLabels === undefined
        ? collapsedState(node, state.toggled)
        : (state.toggled.get(node.id) ?? false);
  return {
    clientMode: props.clientMode === true,
    selectedId: props.selectedId,
    editRootId: props.editRootId,
    canEdit: (id) => canEditNode(props, id),
    ...(props.emptyNodeIds === undefined ? {} : { emptyNodeIds: props.emptyNodeIds }),
    ...(props.hiddenNodeIds === undefined ? {} : { hiddenNodeIds: props.hiddenNodeIds }),
    ...(props.inertNodeIds === undefined ? {} : { inertNodeIds: props.inertNodeIds }),
    ...(props.pseudoNodeIds === undefined ? {} : { pseudoNodeIds: props.pseudoNodeIds }),
    selectedPseudo: props.selectedPseudo,
    ...(props.onSelectPseudo === undefined ? {} : { onSelectPseudo: props.onSelectPseudo }),
    ...(props.liveClassesById === undefined ? {} : { liveClassesById: props.liveClassesById }),
    ...(props.rowLabels === undefined ? {} : { rowLabels: props.rowLabels }),
    currentLayoutName: props.currentLayoutName,
    dropTarget: canvasDrag === undefined ? state.dropTarget : canvasDrag.navigator,
    setDropTarget: state.setDropTarget,
    movingId: canvasDrag === undefined || canvasDrag.subject.kind === 'new' ? undefined : canvasDrag.subject.id,
    isCollapsed,
    isDndPayload,
    performDrop: (event, target) => dropOnTree(event, target, props, state, translate),
    placementFor: (location) => dropPlacement(props.pageState.model.nodes, getDrag(), location, placementEnvironment(props)),
    noteDrop: (placement) => state.setDropNote((previous) => noteOf(placement, previous)),
    nodeById: (id) => findNavigatorNode(props.pageState.model.nodes, id) ?? undefined,
    onSelect: (id) => {
      if (canEditNode(props, id)) {
        props.onSelect(id);
        endSearch(props, state, id);
      }
    },
    ...(props.onHoverNode === undefined ? {} : { onHoverNode: props.onHoverNode }),
    ...(props.onHoverPseudo === undefined ? {} : { onHoverPseudo: props.onHoverPseudo }),
    ...(props.onOpenComponent === undefined ? {} : { onOpenComponent: props.onOpenComponent }),
    ...(props.onOpenCode === undefined ? {} : { onOpenCode: props.onOpenCode }),
    toggleCollapse: (node) => {
      state.setToggled((previous) =>
        new Map(previous).set(node.id, !(props.rowLabels === undefined ? collapsedState(node, previous) : (previous.get(node.id) ?? false))),
      );
    },
    openContextMenu: (left, top, nodeId) => {
      if (!canEditNode(props, nodeId)) {
        return;
      }
      props.onSelect(nodeId);
      state.setContextMenu({ left, top, nodeId });
    },
  };
}

// Choosing a row ends the search: the box empties, the whole page comes back with the chosen row's ancestors
// open (the opening stays; every other fold is the person's own, untouched), and the row is scrolled into view.
function endSearch(props: EditableProps, state: TreeState, selectedId: string): void {
  if (isSearching(state.query)) {
    state.setToggled((previous) => selectionExpanded(previous, props.pageState.model.nodes, selectedId, undefined));
    state.setQuery('');
    state.setSearchRevealTick((tick) => tick + 1);
  }
}

function isDndPayload(event: React.DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer.types;
  return types.includes('avb/component') || types.includes('avb/node') || types.includes(INSERT_DRAG_TYPE);
}

function dropOnTree(event: React.DragEvent<HTMLElement>, target: DropLocation, props: EditableProps, state: TreeState, translate: Translator): void {
  event.preventDefault();
  event.stopPropagation();
  state.setDropTarget(undefined);
  if (props.editRootId && !canEditNode(props, target.parentId)) {
    return;
  }
  const drop = parseNavigatorDrop((type) => event.dataTransfer.getData(type));
  if (drop === undefined) {
    return;
  }
  // The rule is asked again at the drop, not trusted from the last dragover: a refused place writes nothing,
  // and one with a valid neighbour lands there, as the indicator showed.
  const drag = dragOfDrop(drop);
  const placement = dropPlacement(props.pageState.model.nodes, drag, target, placementEnvironment(props));
  state.setDropNote(undefined);
  if (placement.kind === 'refused') {
    return;
  }
  const landing = placement.kind === 'snap' ? placement.to : target;
  if (placement.kind === 'snap') {
    // The drag's tooltip is gone with the drop, so what it said (why, and where it went instead) is a toast.
    reportActionToast(translate('structure.placement.snappedToast', { reason: translate(placement.reason.messageKey, placement.reason.params) }), 'info', []);
  }
  switch (drop.kind) {
    case 'component':
      props.onDropComponent(drop.path ?? drop.name, landing);
      return;
    case 'insert':
      props.onDropInsert?.(drop.choice, landing);
      return;
    case 'node':
      if (drop.id === props.editRootId || !canEditNode(props, drop.id)) {
        return;
      }
      props.onMoveNode(drop.id, landing);
      return;
    default: {
      const exhaustive: never = drop;
      return exhaustive;
    }
  }
}

// The drag a drop stands for, as the placement rule reads it: what was dropped, not the last dragover's record.
function dragOfDrop(drop: NavigatorDrop): Drag {
  switch (drop.kind) {
    case 'component':
      return { kind: 'component', name: drop.name };
    case 'insert':
      return { kind: 'insert', choice: drop.choice, label: '' };
    case 'node':
      return { kind: 'node', id: drop.id, nodeKind: 'node' };
    default: {
      const exhaustive: never = drop;
      return exhaustive;
    }
  }
}

function placementEnvironment(props: EditableProps): PlacementEnvironment {
  return { insertables: props.insertables, document: documentOfPath(props.currentPage?.path) };
}

// The note a place's placement leaves; the same note again is the same state, so a drag over one row does not re-render the tree on every move.
function noteOf(placement: DropPlacement, previous: DropNote | undefined): DropNote | undefined {
  let next: DropNote | undefined = undefined;
  switch (placement.kind) {
    case 'refused':
      // A row over itself or its own rows: no mark, the not-allowed cursor, and no words (they only state the obvious).
      next = placement.reason.reason === 'self-drop' ? undefined : { tone: 'refused', reason: placement.reason };
      break;
    case 'snap':
      next = { tone: 'snapped', reason: placement.reason };
      break;
    case 'valid':
      next = placement.warning === undefined ? undefined : { tone: 'warning', reason: placement.warning };
      break;
    case 'open':
      break;
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
  return previous?.tone === next?.tone && previous?.reason.reason === next?.reason.reason ? previous : next;
}

// The drag's words float at the pointer (position: fixed, in a portal on the body), so they never take room in the tree
// or the panel. The pointer is tracked straight into the element's style: a drag moves it on every event, and the
// tree must not re-render for that. Without a pointer yet (a drag that began on the canvas) it sits at the corner.
function DropNoteChip({ note }: { readonly note: DropNote | undefined }) {
  const translate = useTranslate();
  if (note === undefined) {
    return undefined;
  }
  const reason = translate(note.reason.messageKey, note.reason.params);
  return <FloatingDropNote tone={note.tone} text={note.tone === 'snapped' ? translate('structure.placement.snapped', { reason }) : reason} />;
}

const POINTER_OFFSET_PX = 16;
const lastPointer: { x: number | undefined; y: number | undefined } = { x: undefined, y: undefined };

function placeNote(element: HTMLElement | undefined): void {
  if (element === undefined || lastPointer.x === undefined || lastPointer.y === undefined) {
    return;
  }
  element.style.left = `${lastPointer.x + POINTER_OFFSET_PX}px`;
  element.style.top = `${lastPointer.y + POINTER_OFFSET_PX}px`;
  element.style.bottom = 'auto';
}

function FloatingDropNote({ tone, text }: { readonly tone: string; readonly text: string }) {
  const element = useRef<HTMLDivElement | undefined>(undefined);
  useLayoutEffect(() => {
    placeNote(element.current);
    const follow = (event: Event): void => {
      if ('clientX' in event && 'clientY' in event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
        if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
          lastPointer.x = event.clientX;
          lastPointer.y = event.clientY;
          placeNote(element.current);
        }
      }
    };
    document.addEventListener('dragover', follow, true);
    return () => document.removeEventListener('dragover', follow, true);
  }, []);
  return createPortal(
    <div
      ref={(node) => {
        element.current = node ?? undefined;
      }}
      className="navigator-drop-note"
      role="status"
      data-tone={tone}
    >
      {text}
    </div>,
    document.body,
  );
}

function NavigatorHeader({ state, nodes }: { readonly state: TreeState; readonly nodes: readonly NavigatorNode[] }) {
  const translate = useTranslate();
  const toggleAll = (): void => {
    state.setToggled(collapseMap(nodes, { collapsed: state.allExpanded }));
    state.setAllExpanded((expanded) => !expanded);
  };
  return (
    <>
      <PanelHeader
        title={translate('rail.navigator')}
        actions={
          <button
            className="ghost"
            aria-label={state.allExpanded ? translate('structure.collapseAll') : translate('structure.expandAll')}
            onMouseEnter={state.showTooltip}
            onMouseLeave={state.hideTooltip}
            onClick={() => {
              state.hideTooltip();
              toggleAll();
            }}
          >
            {state.allExpanded ? <CollapseVerticalIcon size={14} /> : <ExpandVerticalIcon size={14} />}
          </button>
        }
      />
      {state.tooltip && (
        <div className="rail-tooltip below" style={state.tooltip}>
          {state.allExpanded ? translate('structure.collapseAll') : translate('structure.expandAll')}
        </div>
      )}
      <PanelSearch
        value={state.query}
        placeholder={translate('structure.search.placeholder')}
        hint={translate('structure.search.hint')}
        onChange={state.setQuery}
      />
    </>
  );
}

function NavigatorBody({
  props,
  state,
  treeContext,
  canvasDrag,
}: {
  readonly props: EditableProps;
  readonly state: TreeState;
  readonly treeContext: StructureTreeContext;
  readonly canvasDrag: NavigatorDragView | undefined;
}) {
  const translate = useTranslate();
  const nodes = props.pageState.model.nodes;
  // Drop gaps overlap the row edges instead of taking room between rows, so
  // they catch the pointer only while a drag is over the navigator. Otherwise
  // a click on a row's edge would land on a gap and select nothing.
  const [bodyDrag, setBodyDrag] = useState<BodyDrag>('idle');
  const search = useNavigatorSearch(nodes, state.query, { idle: canvasDrag === undefined && bodyDrag === 'idle' });
  // Searched, the tree is a copy holding the matches, drawn open so no match hides in a folded row; the user's own folds are untouched.
  useClearWhenSelectionHidden(props.selectedId, search, state);
  const context = search.filtering ? { ...treeContext, isCollapsed: () => false, highlightWords: search.words, searchSnippets: search.snippets } : treeContext;
  return (
    <div
      className={bodyDrag === 'dragging' ? 'panel-body is-drag-over' : 'panel-body'}
      ref={state.bodyRef}
      onDragEnter={() => setBodyDrag('dragging')}
      onDragOver={() => state.setDropTarget(undefined)}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node) {
          if (event.currentTarget.contains(event.relatedTarget)) {
            return;
          }
        }
        setBodyDrag('idle');
        state.setDropTarget(undefined);
      }}
      onDropCapture={() => setBodyDrag('idle')}
      onDragEnd={() => setBodyDrag('idle')}
    >
      {/* One box as wide as the widest row: every row, and the tinted block under a selected one, fill it, so a
          selected row and its subtree share both edges however long a label runs (styles.css, .structure-tree). */}
      <div className="structure-tree">
        {!props.clientMode && !props.editRootId && props.rowLabels === undefined && !search.filtering && <FrontmatterRow props={props} />}
        <NodeList nodes={search.filtering ? search.nodes : nodes} parentId={undefined} depth={0} {...context} />
      </div>
      {!props.clientMode && nodes.length === 0 && <EmptyDropTarget props={props} state={state} />}
      {search.filtering && search.nodes.length === 0 && <div className="props-empty">{translate('structure.search.noMatch')}</div>}
      {search.filtering && search.capped && <div className="props-empty">{translate('structure.search.capped', { count: search.matchCount })}</div>}
      {canvasDrag === undefined ? <DropNoteChip note={state.dropNote} /> : <CanvasDropNote view={canvasDrag} />}
    </div>
  );
}

// A selection that arrives from elsewhere (the canvas) and lands on a row the filter hides ends the search, so the
// selected row is never out of sight. Only a change of selection counts: typing a query that leaves the current
// selection out of the results does not clear it.
function useClearWhenSelectionHidden(selectedId: string | undefined, search: NavigatorSearch, state: TreeState): void {
  const lastSelected = useRef(selectedId);
  useEffect(() => {
    if (lastSelected.current === selectedId) {
      return;
    }
    lastSelected.current = selectedId;
    if (search.filtering && selectedId !== undefined && selectedId !== 'frontmatter' && findNavigatorNode(search.nodes, selectedId) === undefined) {
      state.setQuery('');
      state.setSearchRevealTick((tick) => tick + 1);
    }
  }, [selectedId, search, state]);
}

interface NavigatorSearch {
  /** True when the tree drawn is the search's copy: a query is typed and nothing is being dragged. */
  readonly filtering: boolean;
  readonly nodes: readonly NavigatorNode[];
  readonly words: readonly string[];
  readonly matchCount: number;
  readonly capped: boolean;
  readonly snippets: ReadonlyMap<string, string>;
}

// The index is built once per tree and only once a query exists; each keystroke is then one walk of it.
const NO_SNIPPETS: ReadonlyMap<string, string> = new Map();

function useNavigatorSearch(nodes: readonly NavigatorNode[], query: string, { idle }: { readonly idle: boolean }): NavigatorSearch {
  const searching = isSearching(query);
  const index = useMemo(() => (searching ? buildNavigatorIndex(nodes) : undefined), [nodes, searching]);
  const filtering = searching && idle;
  const result = useMemo(() => (filtering && index !== undefined ? searchNavigator(nodes, index, query) : undefined), [filtering, index, nodes, query]);
  const words = useMemo(() => navigatorHighlightWords(query), [query]);
  return {
    filtering: filtering && result !== undefined,
    nodes: result?.nodes ?? [],
    words,
    matchCount: result?.matchCount ?? 0,
    capped: result?.capped ?? false,
    snippets: result?.snippets ?? NO_SNIPPETS,
  };
}

// The canvas drag's note, in the words the canvas shows beside the pointer.
function CanvasDropNote({ view }: { readonly view: NavigatorDragView }) {
  const translate = useTranslate();
  // Over itself the drop is obviously nowhere: the Navigator shows no mark and says nothing (the canvas chip still does).
  const text = selfRefusal(view.verdict) ? undefined : dropReasonText(view, translate);
  if (text === undefined) {
    return undefined;
  }
  return <FloatingDropNote tone={view.verdict.kind === 'refused' ? 'refused' : 'warning'} text={text} />;
}

// A drag over the Navigator tells the canvas where its mark is, so the canvas draws the same line
// (CanvasDropOverlay.tsx NavigatorDropLine). Published before paint, with the mark itself.
function usePublishNavigatorDrop(nodes: readonly NavigatorNode[], target: DropTarget | undefined): void {
  useLayoutEffect(() => {
    publishNavigatorDrop(target === undefined ? undefined : navigatorDropOf(nodes, target));
  }, [nodes, target]);
  useEffect(() => () => publishNavigatorDrop(undefined), []);
}

// Keeps the row a canvas drag points at in view, before the frame paints: the mark moves and the tree follows.
function useCanvasDragReveal(bodyRef: React.RefObject<HTMLDivElement>, revealId: string | undefined): void {
  useLayoutEffect(() => {
    if (revealId === undefined) {
      return;
    }
    const row = bodyRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(revealId)}"]`) ?? undefined;
    scrollRowIntoScroller(row);
  }, [bodyRef, revealId]);
}

type BodyDrag = 'idle' | 'dragging';

function FrontmatterRow({ props }: { readonly props: EditableProps }) {
  const translate = useTranslate();
  const importCount = props.pageState.model.imports.length;
  const selectedClass = props.selectedId === 'frontmatter' ? 'selected' : '';
  return (
    <div
      className={`structure-node frontmatter-node ${selectedClass}`}
      style={{ paddingInlineStart: 6 }}
      onClick={() => props.onSelect('frontmatter')}
      onDoubleClick={() => props.onOpenCode?.('frontmatter')}
    >
      <span className="icon">
        <CodeIcon size={12} />
      </span>
      <span className="label">{translate('structure.frontmatter')}</span>
      <span className="prop-preview">{translate('structure.imports', { count: importCount })}</span>
    </div>
  );
}

function EmptyDropTarget({ props, state }: { readonly props: EditableProps; readonly state: TreeState }) {
  const translate = useTranslate();
  const location = { parentId: undefined, index: 0 };
  const active = state.dropTarget?.kind === 'gap' && state.dropTarget.parentId === undefined && state.dropTarget.index === 0;
  return (
    <TreeDragRow
      className={`drop-zone-empty ${active ? 'over' : ''}`}
      dropBehavior={{
        active,
        accepts: isDndPayload,
        enter: () => state.setDropTarget({ kind: 'gap', ...location }),
        drop: (event) => dropOnTree(event, location, props, state, translate),
      }}
    >
      {translate('structure.dragHere')}
    </TreeDragRow>
  );
}

function collapsedState(node: NavigatorNode, toggled: ReadonlyMap<string, boolean>): boolean {
  return toggled.get(node.id) ?? defaultCollapsed(node);
}

function canEditNode(props: EditableProps, id: string | undefined): boolean {
  if (!props.editRootId) {
    return true;
  }
  const root = findNavigatorNode(props.pageState.model.nodes, props.editRootId);
  return root !== undefined && id !== undefined && findNavigatorNode([root], id) !== undefined;
}
