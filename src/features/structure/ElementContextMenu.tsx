import { ContextMenu, type ContextAction, type ContextPosition } from './StructureContextMenu';
import { findNavigatorNode, type NavigatorNode } from './structureModel';
import { canConvertText, canWrapNode, type TextTag, type WrapperTag } from '../../editor/wrapRules';
import { isFragmentNode } from '../../editor/liveClasses';
import { currentUnlinkMenu } from './unlinkMenu';
import type { EditorPart } from '../../../shared/properties/projectRoles';

/** Shared by navigator and canvas so action availability cannot drift between them. */
export interface ElementActionProps {
  readonly nodes: readonly NavigatorNode[];
  readonly clientMode?: boolean;
  /** The canvas controls the person's role has off (shared/properties/projectRoles.ts): their menu rows are disabled. */
  readonly roleOff?: ReadonlySet<EditorPart>;
  readonly editRootId?: string | undefined;
  readonly onSetDefaults?: (name: string, id: string) => void;
  readonly onOpenComponent?: (name: string, id: string) => void;
  /** Opens the component canvas for the instance's component; left out where there is no canvas (Studio). */
  readonly onOpenCanvas?: (name: string, id: string) => void;
  /** Puts the element's code in the AI panel's message box; left out where there is no AI panel (Studio). */
  readonly onAddToChat?: (id: string) => void;
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
  // Adding to the chat changes nothing, so a protected node allows it.
  if (action === 'add-to-chat') {
    props.onAddToChat?.(menu.nodeId);
    return;
  }
  if (capabilities.protectedNode && action !== 'paste' && action !== 'open' && action !== 'canvas' && action !== 'defaults') {
    return;
  }
  switch (action) {
    case 'canvas': {
      const node = findNavigatorNode(props.nodes, menu.nodeId);
      if (capabilities.openCanvas === 'enabled' && node?.kind === 'component') {
        props.onOpenCanvas?.(node.name, node.id);
      }
      return;
    }
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
    case 'unlink': {
      const offer = currentUnlinkMenu();
      if (capabilities.component && capabilities.canUnlink && offer !== undefined) {
        offer.unlink(menu.nodeId);
      }
      return;
    }
    case 'cut':
      if (capabilities.canCut) {
        props.onCutNode?.(menu.nodeId);
      }
      return;
    case 'copy':
      if (capabilities.canCopy) {
        props.onCopyNode(menu.nodeId);
      }
      return;
    case 'duplicate':
      if (capabilities.canDuplicate) {
        props.onDuplicateNode(menu.nodeId);
      }
      return;
    case 'paste':
      if (capabilities.canPaste) {
        props.onPasteNode();
      }
      return;
    case 'delete':
      if (capabilities.canDelete) {
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
  // Each action answers to its own canvas control; cutting is a copy and a delete.
  const allows = (part: EditorPart): boolean => props.roleOff?.has(part) !== true;
  const canCopy = canChange && allows('copy');
  const canDelete = canChange && allows('delete');
  const wrap = props.onWrapNode !== undefined && canChange && allows('insert');
  const convert = props.onConvertText !== undefined && canChange && allows('insert');
  return {
    canCopy,
    canDelete,
    canDuplicate: canChange && allows('duplicate'),
    canPaste: allows('paste') && typeof props.hasClipboard === 'function' && props.hasClipboard(),
    // Unlinking replaces the instance with its markup: elements go and others arrive.
    canUnlink: canChange && allows('insert') && allows('delete'),
    component,
    addToChat: addToChatState({ offered: props.onAddToChat !== undefined, hasCode: node !== undefined && node.kind !== 'chunk-group' }),
    plainText: node?.kind === 'text' && props.onConvertText !== undefined,
    protectedNode,
    canChange,
    canSetDefaults: component && !props.clientMode && props.onSetDefaults !== undefined,
    canCut: props.onCutNode !== undefined && canCopy && canDelete,
    canOpen: component && !node.astroAsset && props.onOpenComponent !== undefined,
    // The same rule as Open component: an Astro component of the project, not an asset or a dynamic tag.
    openCanvas: openCanvasState({ offered: props.onOpenCanvas !== undefined, opens: component && !node.astroAsset }),
    canWrapBox: wrap && canWrapNode(nodes, position.nodeId, 'div'),
    canWrapLink: wrap && canWrapNode(nodes, position.nodeId, 'a'),
    canConvertDiv: convert && canConvertText(nodes, position.nodeId, 'div'),
    canConvertSpan: convert && canConvertText(nodes, position.nodeId, 'span'),
  };
}

function addToChatState(state: { readonly offered: boolean; readonly hasCode: boolean }): 'enabled' | 'disabled' | 'absent' {
  if (!state.offered) {
    return 'absent';
  }
  return state.hasCode ? 'enabled' : 'disabled';
}

function openCanvasState(state: { readonly offered: boolean; readonly opens: boolean }): 'enabled' | 'disabled' | 'absent' {
  if (!state.offered) {
    return 'absent';
  }
  return state.opens ? 'enabled' : 'disabled';
}
