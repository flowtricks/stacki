import { TreeDragRow, TreeDropGap, TreeDragHandle } from '../../ui/TreeDragDrop';
import React, { useEffect, useRef } from 'react';
import type { PairedNode } from '../../../shared/page/pageNode';
import type { NavigatorNode, DropLocation, DropTarget } from './structureModel';
import { canContainTag } from '../../editor/elementSchemas';
import { isDataBound } from '../../editor/bindings';
import { allowDragEffect, clearDrag, getDrag, setDrag } from '../../editor/dragState';
import { elementLabel } from '../../editor/classNames';
import { hidesChildRows, noteText } from '../../editor/treeSelection';
import {
  BranchIcon,
  CodeIcon,
  PseudoElementIcon,
  CornerIcon,
  CustomElementIcon,
  ElementComponentIcon,
  FileIcon,
  HideIcon,
  LayoutIcon,
  PointerEventsNoneIcon,
  RepeatIcon,
  TextIcon,
  CommentIcon,
  astroAssetIcon,
  elementIcon,
} from '../../ui/Icons';
import { defaultCollapsed, navigatorChildren, navigatorHost } from './structureModel';
import { navigatorHostsDrop } from './navigatorDrop';
import { isFragmentNode } from '../../editor/liveClasses';

export interface StructureTreeContext {
  readonly clientMode?: boolean;
  readonly editRootId?: string | undefined;
  readonly canEdit: (id: string) => boolean;
  readonly selectedId: string | undefined;
  readonly emptyNodeIds?: ReadonlySet<string>;
  readonly hiddenNodeIds?: ReadonlySet<string>;
  readonly inertNodeIds?: ReadonlySet<string>;
  /** Elements whose ::before, and whose ::after, the canvas draws: rows of their own. */
  readonly pseudoNodeIds?: PseudoNodeIds;
  /** The pseudo-element row picked, when its element is the selection. */
  readonly selectedPseudo?: PseudoKind | undefined;
  readonly onSelectPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly liveClassesById?: ReadonlyMap<string, readonly string[]>;
  readonly currentLayoutName: string;
  readonly dropTarget: DropTarget | undefined;
  readonly setDropTarget: React.Dispatch<React.SetStateAction<DropTarget | undefined>>;
  readonly isCollapsed: (node: NavigatorNode) => boolean;
  readonly isDndPayload: (event: React.DragEvent<HTMLElement>) => boolean;
  readonly performDrop: (event: React.DragEvent<HTMLElement>, target: DropLocation) => void;
  readonly nodeById: (id: string) => NavigatorNode | undefined;
  readonly onSelect: (id: string) => void;
  readonly onHoverNode?: (id: string | undefined) => void;
  readonly onHoverPseudo?: (id: string, pseudo: PseudoKind) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  readonly onOpenCode?: (id: string) => void;
  readonly toggleCollapse: (node: NavigatorNode) => void;
  readonly openContextMenu: (left: number, top: number, nodeId: string) => void;
}

export type PseudoKind = 'before' | 'after';

export interface PseudoNodeIds {
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

interface NodeListProps extends StructureTreeContext {
  readonly nodes: readonly NavigatorNode[];
  /** The list's parent; undefined for the page's root list. */
  readonly parentId: string | undefined;
  readonly depth: number;
}

const ANNOTATABLE = new Set(['element', 'component']);

export function NodeList({ nodes, parentId, depth, ...context }: NodeListProps) {
  const { noteFor, folded } = foldedNotes(nodes);
  return (
    <>
      {nodes.map((node, index) =>
        folded.has(index) ? undefined : (
          <React.Fragment key={node.id}>
            <Gap parentId={parentId} index={noteFor.has(index) ? index - 1 : index} depth={depth} {...context} />
            <TreeNode node={node} note={noteFor.get(index)} depth={depth} {...context} />
          </React.Fragment>
        ),
      )}
      {nodes.length > 0 && <Gap parentId={parentId} index={nodes.length} depth={depth} {...context} />}
    </>
  );
}

function foldedNotes(nodes: readonly NavigatorNode[]): {
  readonly noteFor: ReadonlyMap<number, NavigatorNode>;
  readonly folded: ReadonlySet<number>;
} {
  const noteFor = new Map<number, NavigatorNode>();
  const folded = new Set<number>();
  for (const [index, node] of nodes.entries()) {
    const next = nodes[index + 1];
    if (node.kind === 'comment' && next && ANNOTATABLE.has(next.kind)) {
      noteFor.set(index + 1, node);
      folded.add(index);
    }
  }
  return { noteFor, folded };
}

interface GapProps extends StructureTreeContext {
  readonly parentId: string | undefined;
  readonly index: number;
  readonly depth: number;
}

function Gap(props: GapProps) {
  const { parentId, index, depth, dropTarget, setDropTarget, isDndPayload, performDrop } = props;
  const active = dropTarget?.kind === 'gap' && dropTarget.parentId === parentId && dropTarget.index === index;
  const parent = parentId === undefined ? undefined : props.nodeById(parentId);
  // A gap is a drop inside its parent, so the parent's own rule decides it too.
  const accepted = (parent === undefined || navigatorHostsDrop(parent)) && acceptsDrag(parent);
  const location = { parentId, index };
  if (props.editRootId && (!parentId || !props.canEdit(parentId))) {
    return undefined;
  }
  if (props.clientMode && parentId === undefined) {
    return undefined;
  }
  return (
    <TreeDropGap
      depth={depth}
      parent={parentId}
      index={index}
      behavior={{
        active,
        accepts: (event) => accepted && isDndPayload(event),
        enter: () => setDropTarget({ kind: 'gap', ...location }),
        drop: (event) => performDrop(event, location),
      }}
    />
  );
}

function acceptsDrag(parent: NavigatorNode | undefined): boolean {
  const drag = getDrag();
  if (!drag || drag.kind !== 'node' || drag.nodeKind !== 'element' || !drag.tag) {
    return true;
  }
  if (!parent || parent.kind !== 'element') {
    return true;
  }
  return canContainTag(parent.name, drag.tag);
}

interface TreeNodeProps extends StructureTreeContext {
  readonly node: NavigatorNode;
  readonly note: NavigatorNode | undefined;
  readonly depth: number;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth } = props;
  const context = treeContextFromRow(props);
  const rowRef = useRef<HTMLDivElement>(null);
  const selected = props.selectedId === node.id;
  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);
  const children = navigatorChildren(node);
  const host = navigatorHost(node);
  const listsChildren = children.length > 0 && !hidesChildRows(node, children);
  // A ::before sits above an element's children and an ::after below them, as
  // the browser draws them: rows of their own, so an element with one opens.
  const pseudos = pseudoKindsOf(node.id, props.pseudoNodeIds);
  const showChildren = listsChildren || pseudos.length > 0;
  const view = nodeView(props, { children, host, showChildren, selected });
  const pseudoRow = (pseudo: PseudoKind): React.ReactNode =>
    pseudos.includes(pseudo) ? (
      <PseudoRow
        nodeId={node.id}
        pseudo={pseudo}
        depth={depth + 1}
        selected={selected && props.selectedPseudo === pseudo}
        onHover={(id, kind) => props.onHoverPseudo?.(id, kind)}
        onLeave={() => props.onHoverNode?.(undefined)}
        onSelect={props.onSelectPseudo ?? ((id) => props.onSelect(id))}
      />
    ) : undefined;
  return (
    <>
      <TreeRow {...props} {...view} selected={selected && props.selectedPseudo === undefined} rowRef={rowRef} />
      {showChildren && !view.collapsed && (
        <>
          {pseudoRow('before')}
          {listsChildren && <NodeList {...context} nodes={children} parentId={host.id} depth={depth + 1} />}
          {pseudoRow('after')}
        </>
      )}
    </>
  );
}

function pseudoKindsOf(id: string, pseudoNodeIds: PseudoNodeIds | undefined): readonly PseudoKind[] {
  if (pseudoNodeIds === undefined) {
    return [];
  }
  const kinds: PseudoKind[] = [];
  if (pseudoNodeIds.before.has(id)) {
    kinds.push('before');
  }
  if (pseudoNodeIds.after.has(id)) {
    kinds.push('after');
  }
  return kinds;
}

// A pseudo-element: drawn by CSS, so it is selected (its element, with its
// selector in the Style panel) and never dragged, renamed or deleted.
function PseudoRow(props: {
  readonly nodeId: string;
  readonly pseudo: PseudoKind;
  readonly depth: number;
  readonly selected: boolean;
  readonly onHover: (id: string, pseudo: PseudoKind) => void;
  readonly onLeave: () => void;
  readonly onSelect: (id: string, pseudo: PseudoKind) => void;
}) {
  return (
    <div
      className={`structure-node is-pseudo${props.selected ? ' selected' : ''}`}
      data-pseudo-of={props.nodeId}
      data-pseudo={props.pseudo}
      style={{ paddingLeft: 6 + props.depth * 16 }}
      onMouseEnter={() => props.onHover(props.nodeId, props.pseudo)}
      onMouseLeave={props.onLeave}
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect(props.nodeId, props.pseudo);
      }}
    >
      <span className="drag-handle" />
      <span className="icon">
        <PseudoElementIcon size={12} />
      </span>
      <span className="label">::{props.pseudo}</span>
    </div>
  );
}

function treeContextFromRow(props: TreeNodeProps): StructureTreeContext {
  return {
    clientMode: props.clientMode === true,
    selectedId: props.selectedId,
    editRootId: props.editRootId,
    canEdit: props.canEdit,
    ...(props.emptyNodeIds === undefined ? {} : { emptyNodeIds: props.emptyNodeIds }),
    ...(props.hiddenNodeIds === undefined ? {} : { hiddenNodeIds: props.hiddenNodeIds }),
    ...(props.inertNodeIds === undefined ? {} : { inertNodeIds: props.inertNodeIds }),
    ...(props.pseudoNodeIds === undefined ? {} : { pseudoNodeIds: props.pseudoNodeIds }),
    selectedPseudo: props.selectedPseudo,
    ...(props.onSelectPseudo === undefined ? {} : { onSelectPseudo: props.onSelectPseudo }),
    ...(props.liveClassesById === undefined ? {} : { liveClassesById: props.liveClassesById }),
    currentLayoutName: props.currentLayoutName,
    dropTarget: props.dropTarget,
    setDropTarget: props.setDropTarget,
    isCollapsed: props.isCollapsed,
    isDndPayload: props.isDndPayload,
    performDrop: props.performDrop,
    nodeById: props.nodeById,
    onSelect: props.onSelect,
    ...(props.onHoverNode === undefined ? {} : { onHoverNode: props.onHoverNode }),
    ...(props.onHoverPseudo === undefined ? {} : { onHoverPseudo: props.onHoverPseudo }),
    ...(props.onOpenComponent === undefined ? {} : { onOpenComponent: props.onOpenComponent }),
    ...(props.onOpenCode === undefined ? {} : { onOpenCode: props.onOpenCode }),
    toggleCollapse: props.toggleCollapse,
    openContextMenu: props.openContextMenu,
  };
}

interface NodeView {
  readonly children: readonly NavigatorNode[];
  readonly host: NavigatorNode;
  readonly showChildren: boolean;
  readonly canHostChildren: boolean;
  readonly collapsed: boolean;
  readonly component: boolean;
  readonly fragment: boolean;
  readonly layout: boolean;
  readonly selected: boolean;
  readonly dropInto: boolean;
  readonly description: { readonly icon: React.ReactNode; readonly label: string };
  readonly hint: string | undefined;
}

function nodeView(props: TreeNodeProps, shape: Pick<NodeView, 'children' | 'host' | 'showChildren' | 'selected'>): NodeView {
  const { children, host, showChildren, selected } = shape;
  const { node } = props;
  const fragment = isFragmentNode(node);
  const layout = node.id === 'layout';
  const component = node.kind === 'component' && !node.dynamicTag && !fragment;
  let description = describeNode(node, props.liveClassesById?.get(node.id));
  let hint: string | undefined;
  if (layout) {
    const label = node.kind === 'component' || node.kind === 'element' ? node.name : '';
    description = { icon: <LayoutIcon size={13} />, label: label || props.currentLayoutName };
    hint = props.currentLayoutName && props.currentLayoutName !== description.label ? props.currentLayoutName : undefined;
  }
  return {
    children,
    host,
    showChildren,
    canHostChildren: navigatorHostsDrop(node),
    collapsed: props.isCollapsed(node),
    component,
    fragment,
    layout,
    selected,
    dropInto: props.dropTarget?.kind === 'into' && props.dropTarget.intoId === node.id,
    description,
    hint,
  };
}

interface TreeRowProps extends TreeNodeProps, NodeView {
  readonly rowRef: React.RefObject<HTMLDivElement>;
}

function TreeRow(props: TreeRowProps) {
  const { node, description } = props;
  const handlers = treeRowHandlers(props);
  return (
    <TreeDragRow
      ref={props.rowRef}
      data-node-id={node.id}
      aria-disabled={!props.canEdit(node.id)}
      title={props.fragment ? fragmentTitle : undefined}
      className={rowClassName(props)}
      style={{ paddingLeft: 6 + props.depth * 16 }}
      dropBehavior={treeRowDropBehavior(props)}
      draggable={
        props.canEdit(node.id) &&
        node.id !== props.editRootId &&
        !(props.clientMode && node.id === 'layout') &&
        node.kind !== 'chunk-group' &&
        node.kind !== 'branch'
      }
      {...handlers}
    >
      <TreeDragHandle {...(props.showChildren ? { expansion: { collapsed: props.collapsed, toggle: () => props.toggleCollapse(node) } } : {})} />
      <span className="icon">{description.icon}</span>
      <RowLabel node={node} label={description.label} note={props.note} />
      {props.hint && (
        <span className="prop-preview" title={`Imported from ${props.hint}.astro`}>
          {props.hint}
        </span>
      )}
      <NodeStatus
        rendersNothing={props.emptyNodeIds?.has(node.id) ?? false}
        hidden={props.hiddenNodeIds?.has(node.id) ?? false}
        inert={props.inertNodeIds?.has(node.id) ?? false}
      />
    </TreeDragRow>
  );
}

function treeRowHandlers(props: TreeRowProps) {
  const { node } = props;
  return {
    onDragStart: (event: React.DragEvent<HTMLDivElement>): void => {
      if (!props.canEdit(node.id) || node.id === props.editRootId || (props.clientMode && node.id === 'layout')) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      event.dataTransfer.setData('avb/node', node.id);
      allowDragEffect(event.dataTransfer, 'move');
      const tag = 'name' in node ? node.name : undefined;
      setDrag({
        kind: 'node',
        id: node.id,
        nodeKind: node.kind,
        ...(tag === undefined ? {} : { tag }),
      });
    },
    onDragEnd: (): void => {
      clearDrag();
      props.setDropTarget(undefined);
    },
    onClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      event.stopPropagation();
      props.onSelect(node.id);
    },
    onDoubleClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!props.canEdit(node.id) || props.editRootId) {
        return;
      }
      // A <script> or <style> is code, not markup: it opens in the code editor.
      if (node.kind === 'raw') {
        openCode(event, props);
      } else {
        openComponent(event, props);
      }
    },
    onMouseEnter: (): void => props.onHoverNode?.(node.id),
    onMouseLeave: (): void => props.onHoverNode?.(undefined),
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      props.openContextMenu(event.clientX, event.clientY, node.id);
    },
  };
}

// The row's own id is passed on: its click has only just asked for the
// selection, which still names the previous row when the double-click lands.
function openCode(event: React.MouseEvent<HTMLDivElement>, props: TreeRowProps): void {
  if (!props.onOpenCode) {
    return;
  }
  event.stopPropagation();
  props.onOpenCode(props.node.id);
}

function openComponent(event: React.MouseEvent<HTMLDivElement>, props: TreeRowProps): void {
  const { node } = props;
  if (!props.component || (node.kind === 'component' && node.astroAsset)) {
    return;
  }
  if (!props.onOpenComponent || !('name' in node)) {
    return;
  }
  event.stopPropagation();
  props.onOpenComponent(node.name, node.id);
}

function treeRowDropBehavior(props: TreeRowProps) {
  return {
    active: props.dropInto,
    accepts: (event: React.DragEvent<HTMLDivElement>) =>
      props.canEdit(props.node.id) && props.canHostChildren && acceptsDrag(props.node) && props.isDndPayload(event),
    enter: () => props.setDropTarget({ kind: 'into', intoId: props.node.id }),
    drop: (event: React.DragEvent<HTMLDivElement>) => props.performDrop(event, { parentId: props.host.id, index: props.children.length }),
  };
}

function RowLabel({ node, label, note }: { readonly node: NavigatorNode; readonly label: string; readonly note: NavigatorNode | undefined }) {
  const noteValue = note?.kind === 'comment' ? note.value : undefined;
  return (
    <span className="label" style={node.kind === 'text' ? { fontWeight: 400, fontStyle: 'italic' } : {}}>
      {label}
      {noteValue !== undefined && (
        <span className="node-note" title={noteValue.trim()}>
          {' / '}
          {truncate(noteText(noteValue).replace(/\s+/g, ' '), 44)}
        </span>
      )}
    </span>
  );
}

function NodeStatus({ rendersNothing, hidden, inert }: { readonly rendersNothing: boolean; readonly hidden: boolean; readonly inert: boolean }) {
  if (!rendersNothing && !hidden && !inert) {
    return undefined;
  }
  return (
    <span className="node-empty">
      {rendersNothing && (
        <span title="Renders nothing on the page with its current props">
          <HideIcon size={13} />
        </span>
      )}
      {hidden && !rendersNothing && (
        <span title="display: none — on the page, not drawn">
          <HideIcon size={13} />
        </span>
      )}
      {inert && (
        <span title="pointer-events: none — drawn, but takes no clicks">
          <PointerEventsNoneIcon size={13} />
        </span>
      )}
    </span>
  );
}

function rowClassName(view: NodeView & { readonly node: NavigatorNode }): string {
  const { node } = view;
  const mapped = node.kind === 'map' || node.kind === 'cond' || node.kind === 'branch' || (nodeIsDataBound(node) && !view.component);
  return [
    'structure-node',
    view.component ? 'is-component' : '',
    mapped ? 'is-map' : '',
    view.layout ? 'layout-node' : '',
    view.selected ? 'selected' : '',
  ].join(' ');
}

function describeNode(node: NavigatorNode, live: readonly string[] | undefined): { readonly icon: React.ReactNode; readonly label: string } {
  if (isFragmentNode(node)) {
    return { icon: <CustomElementIcon size={12} />, label: 'Fragment' };
  }
  switch (node.kind) {
    case 'text':
      return { icon: <TextIcon size={12} />, label: truncate(node.value, 34) };
    case 'comment':
      return { icon: <CommentIcon size={12} />, label: truncate(node.value.trim(), 30) };
    case 'raw':
      return { icon: <CodeIcon size={12} />, label: node.name };
    case 'raw-line':
      return { icon: <CodeIcon size={12} />, label: truncate(node.value, 30) };
    case 'element':
      return describeElement(node, live);
    case 'chunk-group':
      return { icon: <FileIcon size={12} />, label: node.name };
    case 'expr':
      return { icon: <CodeIcon size={12} />, label: truncate(node.value.replace(/\s+/g, ' '), 34) };
    case 'map': {
      const at = node.head.indexOf('.map');
      return {
        icon: <RepeatIcon size={12} />,
        label: at > 0 ? node.head.slice(0, at + 4) : truncate(node.head, 24),
      };
    }
    case 'cond':
      return { icon: <BranchIcon size={12} />, label: truncate(`if ${node.test}`, 40) };
    case 'branch':
      return { icon: <CornerIcon size={12} />, label: node.name === 'else' ? 'else' : 'then' };
    case 'component':
      return describeComponent(node, live);
  }
}

function describeElement(node: PairedNode, live?: readonly string[]) {
  const source = elementLabel(node);
  const label = source === node.name ? (live?.[0] ?? source) : source;
  return { icon: elementIcon(node.name), label: truncate(label, 40) };
}

function describeComponent(node: PairedNode, live?: readonly string[]) {
  if (node.dynamicTag) {
    const source = elementLabel(node);
    const label = source === node.name ? (live?.[0] ?? source) : source;
    return { icon: <CustomElementIcon size={12} />, label: truncate(label, 40) };
  }
  if (node.astroAsset) {
    return { icon: astroAssetIcon(node.name, 14), label: node.name };
  }
  return { icon: <ElementComponentIcon size={14} />, label: node.name };
}

function nodeIsDataBound(node: NavigatorNode): boolean {
  const props = 'props' in node ? node.props : undefined;
  const children = 'children' in node ? node.children : undefined;
  return isDataBound({
    ...(props === undefined ? {} : { props }),
    ...(children === undefined ? {} : { children }),
  });
}

function truncate(value: string, lengthMax: number): string {
  return value.length > lengthMax ? `${value.slice(0, lengthMax - 1)}…` : value;
}

const fragmentTitle = 'Inline group in this file. Expand it to edit its children; there is no separate file to open.';

export { defaultCollapsed };
