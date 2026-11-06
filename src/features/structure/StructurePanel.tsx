import { TreeDragRow, useTreeDragCleanup } from '../../ui/TreeDragDrop';
import { ErrorToast } from '../../ui/ErrorToast';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigatorNode, StructurePageState, StructureProjection, DropLocation, DropTarget } from './structureModel';
import type { PseudoKind, PseudoNodeIds, StructureTreeContext } from './StructureTree';
import type { ContextPosition } from './StructureContextMenu';
import { ElementContextMenu } from './ElementContextMenu';
import type { WrapperTag } from '../../editor/wrapRules';
import { CollapseVerticalIcon, CodeIcon, DragIcon, ExpandVerticalIcon } from '../../ui/Icons';
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
import { NodeList } from './StructureTree';
import { clearDrag } from '../../editor/dragState';
import { parseNavigatorDrop } from './navigatorDrop';
import { type LiveValue } from '../../ui/liveValue';

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
      }
    | undefined;
  readonly layouts: readonly unknown[];
  readonly currentLayoutName: string;
  readonly selectedId: string | undefined;
  readonly emptyNodeIds?: ReadonlySet<string>;
  readonly hiddenNodeIds?: ReadonlySet<string>;
  readonly inertNodeIds?: ReadonlySet<string>;
  readonly pseudoNodeIds?: PseudoNodeIds;
  readonly selectedPseudo?: PseudoKind | undefined;
  readonly onSelectPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly liveClassesById?: ReadonlyMap<string, readonly string[]>;
  readonly revealTick?: number;
  readonly onSelect: (id: string) => void;
  readonly onHoverNode?: (id: string | undefined) => void;
  readonly onHoverPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  /** A row holding code (frontmatter, <style>, <script>) was double-clicked. */
  readonly onOpenCode?: (id: string) => void;
  readonly onChangeLayout: (name: string) => void;
  readonly onDropComponent: (name: string, target: DropLocation) => void;
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
  if (!props.pageState) {
    return <MissingPage currentPage={props.currentPage} />;
  }
  const projection = structureProjection(props.pageState);
  if (props.clientMode && projection.tag === 'parse-error') {
    return <ErrorToast message="This page needs a Developer to fix its source before editing." />;
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
  const injected = currentPage?.kind === 'route';
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Navigator</h2>
      </div>
      <div className="props-empty">
        {injected ? (
          <>
            <strong>{currentPage.route}</strong> comes from {currentPage.from ? <code>{currentPage.from}</code> : 'an integration'}, not from this project — it
            can be previewed here, but its markup lives in a dependency and isn’t editable.
          </>
        ) : (
          'Select a page to edit.'
        )}
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
  const [diagnostic] = projection.diagnostics;
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Code</h2>
      </div>
      <div className="code-editor">
        <ErrorToast
          message={diagnostic ? `${diagnostic.message}${diagnostic.near ? ` Near ${diagnostic.near}` : ''}` : 'This page contains a syntax error.'}
          recovery={[{ label: 'Open code panel', run: onOpenCodePanel }]}
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
  const treeContext = treeContextOf(props, state);
  return (
    <div className="panel-section grow">
      <NavigatorHeader state={state} nodes={props.pageState.model.nodes} />
      <NavigatorBody props={props} state={state} treeContext={treeContext} />
      {state.contextMenu && (
        <ElementContextMenu {...props} nodes={props.pageState.model.nodes} position={state.contextMenu} onClose={() => state.setContextMenu(undefined)} />
      )}
    </div>
  );
}

interface TreeState {
  readonly dropTarget: DropTarget | undefined;
  readonly setDropTarget: React.Dispatch<React.SetStateAction<DropTarget | undefined>>;
  readonly toggled: ReadonlyMap<string, boolean>;
  readonly setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>;
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
  const [toggled, setToggled] = useState(() => initialCollapseMap(props.pageState.model.nodes));
  const [allExpanded, setAllExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextPosition | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tooltip = useHeaderTooltip();
  useTreeDragCleanup(() => {
    clearDrag();
    setDropTarget(undefined);
  });
  useArrowNavigation(props, toggled, setToggled);
  useSelectionExpansion(props, setToggled);
  useRevealRow(bodyRef, props.revealTick ?? 0, props.selectedId, props.selectedPseudo);
  return {
    dropTarget,
    setDropTarget,
    toggled,
    setToggled,
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
    timer.current = setTimeout(() => setTooltip({ left: bounds.left + bounds.width / 2, top: bounds.bottom + 8 }), 500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { tooltip, showTooltip, hideTooltip };
}

function useArrowNavigation(
  props: EditableProps,
  toggled: ReadonlyMap<string, boolean>,
  setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = parseArrowKey(event);
      if (!key || !props.selectedId) {
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
  }, [props, setToggled, toggled]);
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
  useEffect(() => {
    if (!props.selectedId || props.selectedId === 'frontmatter') {
      return;
    }
    const ancestors = navigatorAncestors(props.pageState.model.nodes, props.selectedId);
    // A picked ::before or ::after is a row inside its element, so the element
    // opens too (a canvas click on one left it shut, the row out of sight).
    const own = props.selectedPseudo === undefined ? undefined : findVisibleNode(props.pageState.model.nodes, props.selectedId)?.node;
    const opened = own === undefined ? ancestors : [...ancestors, own];
    if (opened.length === 0) {
      return;
    }
    setToggled((previous) => expandAncestors(previous, opened));
  }, [props.pageState.model.nodes, props.selectedId, props.selectedPseudo, setToggled]);
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

function treeContextOf(props: EditableProps, state: TreeState): StructureTreeContext {
  const isCollapsed = (node: NavigatorNode): boolean => collapsedState(node, state.toggled);
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
    currentLayoutName: props.currentLayoutName,
    dropTarget: state.dropTarget,
    setDropTarget: state.setDropTarget,
    isCollapsed,
    isDndPayload,
    performDrop: (event, target) => dropOnTree(event, target, props, state),
    nodeById: (id) => findNavigatorNode(props.pageState.model.nodes, id) ?? undefined,
    onSelect: (id) => {
      if (canEditNode(props, id)) {
        props.onSelect(id);
      }
    },
    ...(props.onHoverNode === undefined ? {} : { onHoverNode: props.onHoverNode }),
    ...(props.onHoverPseudo === undefined ? {} : { onHoverPseudo: props.onHoverPseudo }),
    ...(props.onOpenComponent === undefined ? {} : { onOpenComponent: props.onOpenComponent }),
    ...(props.onOpenCode === undefined ? {} : { onOpenCode: props.onOpenCode }),
    toggleCollapse: (node) => {
      state.setToggled((previous) => new Map(previous).set(node.id, !collapsedState(node, previous)));
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

function isDndPayload(event: React.DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes('avb/component') || event.dataTransfer.types.includes('avb/node');
}

function dropOnTree(event: React.DragEvent<HTMLElement>, target: DropLocation, props: EditableProps, state: TreeState): void {
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
  switch (drop.kind) {
    case 'component':
      props.onDropComponent(drop.path ?? drop.name, target);
      return;
    case 'node':
      if (drop.id === props.editRootId || !canEditNode(props, drop.id)) {
        return;
      }
      props.onMoveNode(drop.id, target);
      return;
    default: {
      const exhaustive: never = drop;
      return exhaustive;
    }
  }
}

function NavigatorHeader({ state, nodes }: { readonly state: TreeState; readonly nodes: readonly NavigatorNode[] }) {
  const toggleAll = (): void => {
    state.setToggled(collapseMap(nodes, { collapsed: state.allExpanded }));
    state.setAllExpanded((expanded) => !expanded);
  };
  return (
    <>
      <div className="panel-header">
        <h2>Navigator</h2>
        <button
          className="ghost"
          aria-label={state.allExpanded ? 'Collapse all' : 'Expand all'}
          onMouseEnter={state.showTooltip}
          onMouseLeave={state.hideTooltip}
          onClick={() => {
            state.hideTooltip();
            toggleAll();
          }}
        >
          {state.allExpanded ? <CollapseVerticalIcon size={14} /> : <ExpandVerticalIcon size={14} />}
        </button>
      </div>
      {state.tooltip && (
        <div className="rail-tooltip below" style={state.tooltip}>
          {state.allExpanded ? 'Collapse all' : 'Expand all'}
        </div>
      )}
    </>
  );
}

function NavigatorBody({
  props,
  state,
  treeContext,
}: {
  readonly props: EditableProps;
  readonly state: TreeState;
  readonly treeContext: StructureTreeContext;
}) {
  const nodes = props.pageState.model.nodes;
  return (
    <div
      className="panel-body"
      ref={state.bodyRef}
      onDragOver={() => state.setDropTarget(undefined)}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node) {
          if (event.currentTarget.contains(event.relatedTarget)) {
            return;
          }
        }
        state.setDropTarget(undefined);
      }}
    >
      {!props.clientMode && !props.editRootId && <FrontmatterRow props={props} />}
      <NodeList nodes={nodes} parentId={undefined} depth={0} {...treeContext} />
      {!props.clientMode && nodes.length === 0 && <EmptyDropTarget props={props} state={state} />}
    </div>
  );
}

function FrontmatterRow({ props }: { readonly props: EditableProps }) {
  const importCount = props.pageState.model.imports.length;
  const selectedClass = props.selectedId === 'frontmatter' ? 'selected' : '';
  return (
    <div
      className={`structure-node frontmatter-node ${selectedClass}`}
      style={{ paddingLeft: 6 }}
      onClick={() => props.onSelect('frontmatter')}
      onDoubleClick={() => props.onOpenCode?.('frontmatter')}
    >
      <span className="drag-handle" style={{ visibility: 'hidden' }}>
        <DragIcon size={11} />
      </span>
      <span className="icon">
        <CodeIcon size={12} />
      </span>
      <span className="label">Frontmatter</span>
      <span className="prop-preview">
        {importCount} import{importCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function EmptyDropTarget({ props, state }: { readonly props: EditableProps; readonly state: TreeState }) {
  const location = { parentId: undefined, index: 0 };
  const active = state.dropTarget?.kind === 'gap' && state.dropTarget.parentId === undefined && state.dropTarget.index === 0;
  return (
    <TreeDragRow
      className={`drop-zone-empty ${active ? 'over' : ''}`}
      dropBehavior={{
        active,
        accepts: isDndPayload,
        enter: () => state.setDropTarget({ kind: 'gap', ...location }),
        drop: (event) => dropOnTree(event, location, props, state),
      }}
    >
      Drag components here
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
