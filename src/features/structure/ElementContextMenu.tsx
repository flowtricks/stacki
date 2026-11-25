import { ContextMenu, type ContextAction, type ContextPosition } from './StructureContextMenu';
import { findNavigatorNode, type NavigatorNode } from './structureModel';
import { canConvertText, canWrapNode, type TextTag, type WrapperTag } from '../../editor/wrapRules';
import { isFragmentNode } from '../../editor/liveClasses';

/** Shared by navigator and canvas so action availability cannot drift between them. */
export interface ElementActionProps {
  readonly nodes: readonly NavigatorNode[];
  readonly clientMode?: boolean;
  readonly editRootId?: string | undefined;
  readonly onSetDefaults?: (name: string, id: string) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  readonly onWrapNode?: (id: string, tag: WrapperTag) => void;
  /** Gives bare text a tag. Left out where a page cannot write one, and the menu then offers none. */
  readonly onConvertText?: (id: string, tag: TextTag) => void;
  /** Whether Delete, Cut, Copy, Duplicate and Wrap may act on this node. Left out, the protected nodes alone are refused. */
  readonly canChangeStructure?: (id: string) => boolean;
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
      if (capabilities.canChange) {
        props.onCopyNode(menu.nodeId);
      }
      return;
    case 'duplicate':
      if (capabilities.canChange) {
        props.onDuplicateNode(menu.nodeId);
      }
      return;
    case 'paste':
      props.onPasteNode();
      return;
    case 'delete':
      if (capabilities.canChange) {
        props.onRemoveNode(menu.nodeId);
      }
      return;
    case 'div':
      if (capabilities.canWrapBox) {
        props.onWrapNode?.(menu.nodeId, action);
      }
      return;
    case 'a':
      if (capabilities.canWrapLink) {
        props.onWrapNode?.(menu.nodeId, action);
      }
      return;
    case 'convert-div':
      if (capabilities.canConvertDiv) {
        props.onConvertText?.(menu.nodeId, 'div');
      }
      return;
    case 'convert-span':
      if (capabilities.canConvertSpan) {
        props.onConvertText?.(menu.nodeId, 'span');
      }
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
  const canChange = !protectedNode && props.canChangeStructure?.(position.nodeId) !== false;
  const wrap = props.onWrapNode !== undefined && canChange;
  const convert = props.onConvertText !== undefined && canChange;
  return {
    component,
    plainText: node?.kind === 'text' && props.onConvertText !== undefined,
    protectedNode,
    canChange,
    canSetDefaults: component && !props.clientMode && props.onSetDefaults !== undefined,
    canCut: props.onCutNode !== undefined && canChange,
    canOpen: component && !node.astroAsset && props.onOpenComponent !== undefined,
    canWrapBox: wrap && canWrapNode(nodes, position.nodeId, 'div'),
    canWrapLink: wrap && canWrapNode(nodes, position.nodeId, 'a'),
    canConvertDiv: convert && canConvertText(nodes, position.nodeId, 'div'),
    canConvertSpan: convert && canConvertText(nodes, position.nodeId, 'span'),
  };
}
