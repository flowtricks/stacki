import React, { useEffect, useRef } from 'react';
import type { PairedNode } from '../../shared/page-node';
import type { NavigatorNode, DropLocation, DropTarget } from './structureModel';
import { canContainTag } from '../elementSchemas';
import { isDataBound } from '../bindings';
import { clearDrag, getDrag, setDrag } from '../dragState';
import { elementLabel } from '../classNames';
import { hidesChildRows, noteText } from '../treeSelection';
import { thenBranch } from '../branches';
import {
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CornerIcon,
  CustomElementIcon,
  DragIcon,
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
} from '../ui/Icons';
import {
  defaultCollapsed,
  isFragmentNode,
  navigatorChildren,
  navigatorHost,
} from './structureModel';
import { currentDesktopPlatform, shortcutLabel } from '../shortcutLabel';

export interface StructureTreeContext {
  readonly selectedId: string | null;
  readonly emptyNodeIds?: ReadonlySet<string>;
  readonly hiddenNodeIds?: ReadonlySet<string>;
  readonly inertNodeIds?: ReadonlySet<string>;
  readonly liveClassesById?: ReadonlyMap<string, readonly string[]>;
  readonly currentLayoutName: string;
  readonly dropTarget: DropTarget | null;
  readonly setDropTarget: React.Dispatch<React.SetStateAction<DropTarget | null>>;
  readonly isCollapsed: (node: NavigatorNode) => boolean;
  readonly isDndPayload: (event: React.DragEvent<HTMLElement>) => boolean;
  readonly performDrop: (event: React.DragEvent<HTMLElement>, target: DropLocation) => void;
  readonly nodeById: (id: string) => NavigatorNode | null;
  readonly onSelect: (id: string) => void;
  readonly onHoverNode?: (id: string | null) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  readonly onOpenCode?: (id: string) => void;
  readonly toggleCollapse: (node: NavigatorNode) => void;
  readonly openContextMenu: (left: number, top: number, nodeId: string) => void;
}

interface NodeListProps extends StructureTreeContext {
  readonly nodes: readonly NavigatorNode[];
  readonly parentId: string | null;
  readonly depth: number;
}

const ANNOTATABLE = new Set(['element', 'component']);

export function NodeList({ nodes, parentId, depth, ...context }: NodeListProps) {
  const { noteFor, folded } = foldedNotes(nodes);
  return (
    <>
      {nodes.map((node, index) =>
        folded.has(index) ? null : (
          <React.Fragment key={node.id}>
            <Gap
              parentId={parentId}
              index={noteFor.has(index) ? index - 1 : index}
              depth={depth}
              {...context}
            />
            <TreeNode node={node} note={noteFor.get(index) ?? null} depth={depth} {...context} />
          </React.Fragment>
        ),
      )}
      {nodes.length > 0 && (
        <Gap parentId={parentId} index={nodes.length} depth={depth} {...context} />
      )}
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
  readonly parentId: string | null;
  readonly index: number;
  readonly depth: number;
}

function Gap(props: GapProps) {
  const { parentId, index, depth, dropTarget, setDropTarget, isDndPayload, performDrop } = props;
  const active =
    dropTarget?.kind === 'gap' && dropTarget.parentId === parentId && dropTarget.index === index;
  const accepted = acceptsDrag(parentId === null ? null : props.nodeById(parentId));
  const location = { parentId, index };
  return (
    <div
      className="nav-gap"
      style={{ marginLeft: depth * 16 }}
      onDragOver={(event) => {
        if (accepted && isDndPayload(event)) {
          event.preventDefault();
          event.stopPropagation();
          setDropTarget({ kind: 'gap', ...location });
        }
      }}
      onDrop={(event) => {
        if (accepted) {
          performDrop(event, location);
        }
      }}
    >
      {active && <div className="drop-indicator" />}
    </div>
  );
}

function acceptsDrag(parent: NavigatorNode | null): boolean {
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
  readonly note: NavigatorNode | null;
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
  const showChildren = children.length > 0 && !hidesChildRows(node, children);
  const view = nodeView(props, children, host, showChildren, selected);
  return (
    <>
      <TreeRow {...props} {...view} rowRef={rowRef} />
      {showChildren && !view.collapsed && (
        <NodeList {...context} nodes={children} parentId={host.id} depth={depth + 1} />
      )}
    </>
  );
}

function treeContextFromRow(props: TreeNodeProps): StructureTreeContext {
  return {
    selectedId: props.selectedId,
    ...(props.emptyNodeIds === undefined ? {} : { emptyNodeIds: props.emptyNodeIds }),
    ...(props.hiddenNodeIds === undefined ? {} : { hiddenNodeIds: props.hiddenNodeIds }),
    ...(props.inertNodeIds === undefined ? {} : { inertNodeIds: props.inertNodeIds }),
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
  readonly hint: string | null;
}

function nodeView(
  props: TreeNodeProps,
  children: readonly NavigatorNode[],
  host: NavigatorNode,
  showChildren: boolean,
  selected: boolean,
): NodeView {
  const { node } = props;
  const fragment = isFragmentNode(node);
  const layout = node.id === 'layout';
  const component = node.kind === 'component' && !node.dynamicTag && !fragment;
  let description = describeNode(node, props.liveClassesById?.get(node.id));
  let hint: string | null = null;
  if (layout) {
    const label = node.kind === 'component' || node.kind === 'element' ? node.name : '';
    description = { icon: <LayoutIcon size={13} />, label: label || props.currentLayoutName };
    hint =
      props.currentLayoutName && props.currentLayoutName !== description.label
        ? props.currentLayoutName
        : null;
  }
  return {
    children,
    host,
    showChildren,
    canHostChildren: canHostChildren(node),
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
    <div
      ref={props.rowRef}
      data-node-id={node.id}
      title={props.fragment ? fragmentTitle : undefined}
      className={rowClassName(props)}
      style={rowStyle(props.depth, props.dropInto)}
      draggable={node.kind !== 'chunk-group' && node.kind !== 'branch'}
      {...handlers}
    >
      <RowHandle
        node={node}
        showChildren={props.showChildren}
        collapsed={props.collapsed}
        toggleCollapse={props.toggleCollapse}
      />
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
    </div>
  );
}

function treeRowHandlers(props: TreeRowProps) {
  const { node } = props;
  return {
    onDragStart: (event: React.DragEvent<HTMLDivElement>): void => {
      event.stopPropagation();
      event.dataTransfer.setData('avb/node', node.id);
      event.dataTransfer.effectAllowed = 'move';
      const tag = 'name' in node ? node.name : undefined;
      setDrag({
        kind: 'node',
        id: node.id,
        nodeKind: node.kind,
        ...(tag === undefined ? {} : { tag }),
      });
    },
    onDragEnd: clearDrag,
    onDragOver: (event: React.DragEvent<HTMLDivElement>): void => {
      if (props.canHostChildren && acceptsDrag(node) && props.isDndPayload(event)) {
        event.preventDefault();
        event.stopPropagation();
        props.setDropTarget({ kind: 'into', intoId: node.id });
      }
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>): void => {
      if (props.canHostChildren && acceptsDrag(node)) {
        props.performDrop(event, { parentId: props.host.id, index: props.children.length });
      }
    },
    onClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      event.stopPropagation();
      props.onSelect(node.id);
    },
    onDoubleClick: (event: React.MouseEvent<HTMLDivElement>): void => {
      // A <script> or <style> is code, not markup: it opens in the code editor.
      if (node.kind === 'raw') {
        openCode(event, props);
      } else {
        openComponent(event, props);
      }
    },
    onMouseEnter: (): void => props.onHoverNode?.(node.id),
    onMouseLeave: (): void => props.onHoverNode?.(null),
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

function RowHandle({
  node,
  showChildren,
  collapsed,
  toggleCollapse,
}: {
  readonly node: NavigatorNode;
  readonly showChildren: boolean;
  readonly collapsed: boolean;
  readonly toggleCollapse: (node: NavigatorNode) => void;
}) {
  if (!showChildren) {
    return (
      <span className="drag-handle">
        <DragIcon size={11} />
      </span>
    );
  }
  return (
    <span
      className="drag-handle"
      style={{ cursor: 'pointer', opacity: 1 }}
      onClick={(event) => {
        event.stopPropagation();
        toggleCollapse(node);
      }}
    >
      {collapsed ? <ChevronRightIcon size={10} /> : <ChevronDownIcon size={10} />}
    </span>
  );
}

function RowLabel({
  node,
  label,
  note,
}: {
  readonly node: NavigatorNode;
  readonly label: string;
  readonly note: NavigatorNode | null;
}) {
  const noteValue = note?.kind === 'comment' ? note.value : undefined;
  return (
    <span
      className="label"
      style={node.kind === 'text' ? { fontWeight: 400, fontStyle: 'italic' } : {}}
    >
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

function NodeStatus({
  rendersNothing,
  hidden,
  inert,
}: {
  readonly rendersNothing: boolean;
  readonly hidden: boolean;
  readonly inert: boolean;
}) {
  if (!rendersNothing && !hidden && !inert) {
    return null;
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

function canHostChildren(node: NavigatorNode): boolean {
  return (
    node.kind === 'component' ||
    node.kind === 'element' ||
    node.kind === 'chunk-group' ||
    node.kind === 'map' ||
    node.kind === 'branch' ||
    thenBranch(node) !== null
  );
}

function rowClassName(view: NodeView & { readonly node: NavigatorNode }): string {
  const { node } = view;
  const mapped =
    node.kind === 'map' ||
    node.kind === 'cond' ||
    node.kind === 'branch' ||
    (nodeIsDataBound(node) && !view.component);
  return [
    'structure-node',
    view.component ? 'is-component' : '',
    mapped ? 'is-map' : '',
    view.layout ? 'layout-node' : '',
    view.selected ? 'selected' : '',
  ].join(' ');
}

function rowStyle(depth: number, dropInto: boolean): React.CSSProperties {
  return {
    paddingLeft: 6 + depth * 16,
    ...(dropInto ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}),
  };
}

function describeNode(
  node: NavigatorNode,
  live: readonly string[] | undefined,
): { readonly icon: React.ReactNode; readonly label: string } {
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

function ContextMenuItem({
  action,
  label,
  shortcut,
  disabled = false,
  onAction,
}: {
  readonly action: ContextAction;
  readonly label: string;
  readonly shortcut: string;
  readonly disabled?: boolean;
  readonly onAction: (action: ContextAction) => void;
}) {
  return (
    <div
      className={`ctx-menu-item ${disabled ? 'disabled' : ''}`}
      onClick={() => {
        if (!disabled) {
          onAction(action);
        }
      }}
    >
      <span>{label}</span>
      <span className="ctx-shortcut">{shortcut}</span>
    </div>
  );
}

export type ContextAction = 'copy' | 'paste' | 'duplicate' | 'delete';
export interface ContextPosition {
  readonly left: number;
  readonly top: number;
  readonly nodeId: string;
}

export function ContextMenu({
  position,
  canPaste,
  onClose,
  onAction,
}: {
  readonly position: ContextPosition;
  readonly canPaste: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: ContextAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useContextDismiss(ref, onClose);
  const left = Math.min(position.left, window.innerWidth - 208);
  const top = Math.min(position.top, window.innerHeight - 130);
  const shortcut = (key: string): string =>
    shortcutLabel(key, 'primary', currentDesktopPlatform());
  return (
    <div ref={ref} className="ctx-menu" style={{ left, top, width: 200 }}>
      <ContextMenuItem action="copy" label="Copy" shortcut={shortcut('C')} onAction={onAction} />
      <ContextMenuItem
        action="paste"
        label="Paste"
        shortcut={shortcut('V')}
        disabled={!canPaste}
        onAction={onAction}
      />
      <ContextMenuItem
        action="duplicate"
        label="Duplicate"
        shortcut={shortcut('D')}
        onAction={onAction}
      />
      <div className="ctx-divider" />
      <ContextMenuItem action="delete" label="Delete" shortcut="⌫" onAction={onAction} />
    </div>
  );
}

function useContextDismiss(ref: React.RefObject<HTMLDivElement>, onClose: () => void): void {
  useEffect(() => {
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Node && ref.current !== null && !ref.current.contains(target);
    const onDown = (event: MouseEvent): void => {
      if (outside(event.target)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const onScroll = (event: Event): void => {
      if (outside(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, ref]);
}

const fragmentTitle =
  'Inline group in this file. Expand it to edit its children; there is no separate file to open.';

export { defaultCollapsed };
