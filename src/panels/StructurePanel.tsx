import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigatorNode, StructurePageState, DropLocation, DropTarget } from './structureModel';
import type { ContextAction, ContextPosition, StructureTreeContext } from './StructureTree';
import { CollapseVerticalIcon, CodeIcon, DragIcon, ExpandVerticalIcon } from '../ui/Icons';
import { hidesChildRows } from '../treeSelection';
import {
  collapseMap,
  defaultCollapsed,
  findNavigatorNode,
  findVisibleNode,
  navigatorAncestors,
  navigatorChildren,
} from './structureModel';
import { ContextMenu, NodeList } from './StructureTree';

interface StructurePanelProps {
  readonly pageState: StructurePageState | null;
  readonly currentPage?:
    | {
        readonly kind: string;
        readonly route?: string;
        readonly from?: string;
      }
    | null
    | undefined;
  readonly layouts: readonly unknown[];
  readonly currentLayoutName: string;
  readonly selectedId: string | null;
  readonly emptyNodeIds?: ReadonlySet<string>;
  readonly hiddenNodeIds?: ReadonlySet<string>;
  readonly inertNodeIds?: ReadonlySet<string>;
  readonly liveClassesById?: ReadonlyMap<string, readonly string[]>;
  readonly revealTick?: number;
  readonly onSelect: (id: string) => void;
  readonly onHoverNode?: (id: string | null) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  /** A row holding code (frontmatter, <style>, <script>) was double-clicked. */
  readonly onOpenCode?: (id: string) => void;
  readonly onChangeLayout: (name: string) => void;
  readonly onDropComponent: (name: string, target: DropLocation) => void;
  readonly onMoveNode: (id: string, target: DropLocation) => void;
  readonly onRemoveNode: (id: string) => void;
  readonly onCopyNode: (id: string) => void;
  readonly onDuplicateNode: (id: string) => void;
  readonly onPasteNode: () => void;
  readonly hasClipboard?: (() => boolean) | false;
  readonly onRawChange: (source: string) => void;
}

export default function StructurePanel(props: StructurePanelProps) {
  if (!props.pageState) {
    return <MissingPage currentPage={props.currentPage} />;
  }
  if (!props.pageState.editable) {
    return <CodePage pageState={props.pageState} onRawChange={props.onRawChange} />;
  }
  return <EditableStructurePanel {...props} pageState={props.pageState} />;
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
            <strong>{currentPage.route}</strong> comes from{' '}
            {currentPage.from ? <code>{currentPage.from}</code> : 'an integration'}, not from this
            project — it can be previewed here, but its markup lives in a dependency and isn’t
            editable.
          </>
        ) : (
          'Select a page to edit.'
        )}
      </div>
    </div>
  );
}

function CodePage({
  pageState,
  onRawChange,
}: {
  readonly pageState: Extract<StructurePageState, { readonly editable: false }>;
  readonly onRawChange: (source: string) => void;
}) {
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Code</h2>
      </div>
      <div className="code-editor">
        <div className="code-note">
          {pageState.reason ?? 'This page cannot be edited visually.'} You can still edit the source
          here — the preview updates live.
        </div>
        <textarea
          spellCheck={false}
          value={pageState.source}
          onChange={(event) => onRawChange(event.currentTarget.value)}
        />
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
        <ContextMenu
          position={state.contextMenu}
          canPaste={typeof props.hasClipboard === 'function' && props.hasClipboard()}
          onClose={() => state.setContextMenu(null)}
          onAction={(action) => runContextAction(action, props, state)}
        />
      )}
    </div>
  );
}

interface TreeState {
  readonly dropTarget: DropTarget | null;
  readonly setDropTarget: React.Dispatch<React.SetStateAction<DropTarget | null>>;
  readonly toggled: ReadonlyMap<string, boolean>;
  readonly setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>;
  readonly allExpanded: boolean;
  readonly setAllExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  readonly contextMenu: ContextPosition | null;
  readonly setContextMenu: React.Dispatch<React.SetStateAction<ContextPosition | null>>;
  readonly bodyRef: React.RefObject<HTMLDivElement>;
  readonly tooltip: { readonly left: number; readonly top: number } | null;
  readonly showTooltip: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly hideTooltip: () => void;
}

function useTreeState(props: EditableProps): TreeState {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [allExpanded, setAllExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextPosition | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tooltip = useHeaderTooltip();
  useArrowNavigation(props, toggled, setToggled);
  useSelectionExpansion(props, setToggled);
  useRevealRow(bodyRef, props.revealTick ?? 0, props.selectedId);
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
  const [tooltip, setTooltip] = useState<TreeState['tooltip']>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hideTooltip = useCallback((): void => {
    clearTimeout(timer.current);
    setTooltip(null);
  }, []);
  const showTooltip = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setTooltip({ left: bounds.left + bounds.width / 2, top: bounds.bottom + 8 }),
      500,
    );
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
      const next = arrowTarget(key, found, toggled, setToggled);
      if (next) {
        props.onSelect(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, setToggled, toggled]);
}

type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

function parseArrowKey(event: KeyboardEvent): ArrowKey | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return undefined;
  }
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  ) {
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

function arrowTarget(
  key: ArrowKey,
  found: ReturnType<typeof findVisibleNode> & {},
  toggled: ReadonlyMap<string, boolean>,
  setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>,
): NavigatorNode | null | undefined {
  if (key === 'ArrowLeft') {
    return found.siblings[found.index - 1];
  }
  if (key === 'ArrowRight') {
    return found.siblings[found.index + 1];
  }
  if (key === 'ArrowUp') {
    return found.parent;
  }
  const children = navigatorChildren(found.node);
  if (children.length === 0 || hidesChildRows(found.node, children)) {
    return undefined;
  }
  if (collapsedState(found.node, toggled)) {
    setToggled((previous) => new Map(previous).set(found.node.id, false));
  }
  return children[0];
}

function useSelectionExpansion(
  props: EditableProps,
  setToggled: React.Dispatch<React.SetStateAction<ReadonlyMap<string, boolean>>>,
): void {
  useEffect(() => {
    if (!props.selectedId || props.selectedId === 'frontmatter') {
      return;
    }
    const ancestors = navigatorAncestors(props.pageState.model.nodes, props.selectedId);
    if (ancestors.length === 0) {
      return;
    }
    setToggled((previous) => expandAncestors(previous, ancestors));
  }, [props.pageState.model.nodes, props.selectedId, setToggled]);
}

function expandAncestors(
  previous: ReadonlyMap<string, boolean>,
  ancestors: readonly NavigatorNode[],
): ReadonlyMap<string, boolean> {
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
  selectedId: string | null,
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
    const frame = requestAnimationFrame(() => revealRow(bodyRef.current, selectedId));
    return () => cancelAnimationFrame(frame);
  }, [bodyRef, revealTick, selectedId]);
}

function revealRow(body: HTMLDivElement | null, selectedId: string): void {
  const row = body?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedId)}"]`);
  if (!body || !row) {
    return;
  }
  const bodyBounds = body.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  if (rowBounds.top >= bodyBounds.top && rowBounds.bottom <= bodyBounds.bottom) {
    return;
  }
  body.scrollTop += rowBounds.top - bodyBounds.top - (bodyBounds.height - rowBounds.height) / 2;
}

function treeContextOf(props: EditableProps, state: TreeState): StructureTreeContext {
  const isCollapsed = (node: NavigatorNode): boolean => collapsedState(node, state.toggled);
  return {
    selectedId: props.selectedId,
    ...(props.emptyNodeIds === undefined ? {} : { emptyNodeIds: props.emptyNodeIds }),
    ...(props.hiddenNodeIds === undefined ? {} : { hiddenNodeIds: props.hiddenNodeIds }),
    ...(props.inertNodeIds === undefined ? {} : { inertNodeIds: props.inertNodeIds }),
    ...(props.liveClassesById === undefined ? {} : { liveClassesById: props.liveClassesById }),
    currentLayoutName: props.currentLayoutName,
    dropTarget: state.dropTarget,
    setDropTarget: state.setDropTarget,
    isCollapsed,
    isDndPayload,
    performDrop: (event, target) => performDrop(event, target, props, state),
    nodeById: (id) => findNavigatorNode(props.pageState.model.nodes, id),
    onSelect: props.onSelect,
    ...(props.onHoverNode === undefined ? {} : { onHoverNode: props.onHoverNode }),
    ...(props.onOpenComponent === undefined ? {} : { onOpenComponent: props.onOpenComponent }),
    ...(props.onOpenCode === undefined ? {} : { onOpenCode: props.onOpenCode }),
    toggleCollapse: (node) => {
      state.setToggled((previous) =>
        new Map(previous).set(node.id, !collapsedState(node, previous)),
      );
    },
    openContextMenu: (left, top, nodeId) => {
      props.onSelect(nodeId);
      state.setContextMenu({ left, top, nodeId });
    },
  };
}

function isDndPayload(event: React.DragEvent<HTMLElement>): boolean {
  return (
    event.dataTransfer.types.includes('avb/component') ||
    event.dataTransfer.types.includes('avb/node')
  );
}

function performDrop(
  event: React.DragEvent<HTMLElement>,
  target: DropLocation,
  props: EditableProps,
  state: TreeState,
): void {
  event.preventDefault();
  event.stopPropagation();
  state.setDropTarget(null);
  const componentName = event.dataTransfer.getData('avb/component');
  const nodeId = event.dataTransfer.getData('avb/node');
  if (componentName) {
    props.onDropComponent(componentName, target);
  } else if (nodeId) {
    props.onMoveNode(nodeId, target);
  }
}

function NavigatorHeader({
  state,
  nodes,
}: {
  readonly state: TreeState;
  readonly nodes: readonly NavigatorNode[];
}) {
  const toggleAll = (): void => {
    state.setToggled(collapseMap(nodes, state.allExpanded));
    state.setAllExpanded((expanded) => !expanded);
  };
  return (
    <>
      <div className="panel-header">
        <h2>Navigator</h2>
        <button
          className="ghost"
          onMouseEnter={state.showTooltip}
          onMouseLeave={state.hideTooltip}
          onClick={() => {
            state.hideTooltip();
            toggleAll();
          }}
        >
          {state.allExpanded ? (
            <CollapseVerticalIcon size={14} />
          ) : (
            <ExpandVerticalIcon size={14} />
          )}
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
    <div className="panel-body" ref={state.bodyRef} onDragLeave={() => state.setDropTarget(null)}>
      <FrontmatterRow props={props} />
      <NodeList nodes={nodes} parentId={null} depth={0} {...treeContext} />
      {nodes.length === 0 && <EmptyDropTarget props={props} state={state} />}
    </div>
  );
}

function FrontmatterRow({ props }: { readonly props: EditableProps }) {
  const importCount = props.pageState.model.imports.length;
  return (
    <div
      className={`structure-node frontmatter-node ${props.selectedId === 'frontmatter' ? 'selected' : ''}`}
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

function EmptyDropTarget({
  props,
  state,
}: {
  readonly props: EditableProps;
  readonly state: TreeState;
}) {
  const location = { parentId: null, index: 0 };
  const active =
    state.dropTarget?.kind === 'gap' &&
    state.dropTarget.parentId === null &&
    state.dropTarget.index === 0;
  return (
    <div
      className={`drop-zone-empty ${active ? 'over' : ''}`}
      onDragOver={(event) => {
        if (isDndPayload(event)) {
          event.preventDefault();
          state.setDropTarget({ kind: 'gap', ...location });
        }
      }}
      onDrop={(event) => performDrop(event, location, props, state)}
    >
      Drag components here
    </div>
  );
}

function runContextAction(action: ContextAction, props: EditableProps, state: TreeState): void {
  const menu = state.contextMenu;
  state.setContextMenu(null);
  if (!menu) {
    return;
  }
  if (action === 'copy') {
    props.onCopyNode(menu.nodeId);
  } else if (action === 'duplicate') {
    props.onDuplicateNode(menu.nodeId);
  } else if (action === 'paste') {
    props.onPasteNode();
  } else {
    props.onRemoveNode(menu.nodeId);
  }
}

function collapsedState(node: NavigatorNode, toggled: ReadonlyMap<string, boolean>): boolean {
  return toggled.get(node.id) ?? defaultCollapsed(node);
}
