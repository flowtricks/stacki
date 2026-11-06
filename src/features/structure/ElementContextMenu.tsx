import { ContextMenu, type ContextAction, type ContextPosition } from './StructureContextMenu';
import { findNavigatorNode, type NavigatorNode } from './structureModel';
import { canWrapNode, type WrapperTag } from '../../editor/wrapRules';
import { isFragmentNode } from '../../editor/liveClasses';

/** Shared by navigator and canvas so action availability cannot drift between them. */
export interface ElementActionProps {
  readonly nodes: readonly NavigatorNode[];
  readonly clientMode?: boolean;
  readonly editRootId?: string | undefined;
  readonly onSetDefaults?: (name: string, id: string) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  readonly onWrapNode?: (id: string, tag: WrapperTag) => void;
  /** Whether Delete and Cut may take this node. Left out, the protected nodes alone are refused. */
  readonly canDeleteNode?: (id: string) => boolean;
  readonly onRemoveNode: (id: string) => void;
  readonly onCopyNode: (id: string) => void;
  readonly onCutNode?: (id: string) => void;
  readonly onDuplicateNode: (id: string) => void;
  readonly onPasteNode: () => void;
  readonly hasClipboard?: (() => boolean) | false;
}

export function ElementContextMenu(
  props: ElementActionProps & {
    readonly position: ContextPosition;
    readonly onClose: () => void;
  },
) {
  const node = findNavigatorNode(props.nodes, props.position.nodeId);
  const root = props.editRootId ? findNavigatorNode(props.nodes, props.editRootId) : undefined;
  if (!node || (props.editRootId && (!root || !findNavigatorNode([root], node.id)))) {
    return undefined;
  }
  return (
    <ContextMenu
      position={props.position}
      {...contextCapabilities(props, props.position)}
      canPaste={typeof props.hasClipboard === 'function' && props.hasClipboard()}
      onClose={props.onClose}
      onAction={(action) => {
        props.onClose();
        runContextAction(action, props, props.position);
      }}
    />
  );
}

function runContextAction(action: ContextAction, props: ElementActionProps, menu: ContextPosition): void {
  const capabilities = contextCapabilities(props, menu);
  if (capabilities.protectedNode && action !== 'paste' && action !== 'open' && action !== 'defaults') {
    return;
  }
  switch (action) {
    case 'defaults':
    case 'open': {
      const node = findNavigatorNode(props.nodes, menu.nodeId);
      if (action === 'defaults') {
        if (capabilities.canSetDefaults && node?.kind === 'component') {
          props.onSetDefaults?.(node.name, node.id);
        }
        return;
      }
      if (capabilities.canOpen && node?.kind === 'component') {
        props.onOpenComponent?.(node.name, node.id);
      }
      return;
    }
    case 'cut':
      if (capabilities.canCut) {
        props.onCutNode?.(menu.nodeId);
      }
      return;
    case 'copy':
      props.onCopyNode(menu.nodeId);
      return;
    case 'duplicate':
      props.onDuplicateNode(menu.nodeId);
      return;
    case 'paste':
      props.onPasteNode();
      return;
    case 'delete':
      if (capabilities.canDelete) {
        props.onRemoveNode(menu.nodeId);
      }
      return;
    case 'div':
    case 'a':
      props.onWrapNode?.(menu.nodeId, action);
      return;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function contextCapabilities(props: ElementActionProps, position: ContextPosition) {
  const nodes = props.nodes;
  const node = findNavigatorNode(nodes, position.nodeId);
  const component = node?.kind === 'component' && !node.dynamicTag && !isFragmentNode(node);
  const protectedNode =
    node === undefined ||
    node.id === props.editRootId ||
    node.kind === 'chunk-group' ||
    node.kind === 'branch' ||
    (props.clientMode === true && node.id === 'layout');
  const wrap = props.onWrapNode !== undefined && !protectedNode;
  const canDelete = !protectedNode && props.canDeleteNode?.(position.nodeId) !== false;
  return {
    component,
    protectedNode,
    canDelete,
    canSetDefaults: component && !props.clientMode && props.onSetDefaults !== undefined,
    canCut: props.onCutNode !== undefined && canDelete,
    canOpen: component && !node.astroAsset && props.onOpenComponent !== undefined,
    canWrapBox: wrap && canWrapNode(nodes, position.nodeId, 'div'),
    canWrapLink: wrap && canWrapNode(nodes, position.nodeId, 'a'),
  };
}
