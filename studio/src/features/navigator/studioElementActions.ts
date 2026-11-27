import type { ElementActionProps } from '../../../vendor/stacki/src/features/structure/ElementContextMenu';
import type { NavigatorProps } from './Navigator';
import { copyNode, pasteNode, hasCopiedNode } from './clipboard';
import { getStudioRole } from '../roles/roleStore';

type ActionOptions = Pick<NavigatorProps, 'document' | 'selected' | 'components' | 'action' | 'report' | 'editRootId' | 'setDefaults' | 'openComponent'>;

export function studioElementActions(props: ActionOptions, role: 'client' | 'admin'): Omit<ElementActionProps, 'nodes'> {
  const off = getStudioRole().editorOff;
  const fixed = off.has('elements');
  // Giving bare text a tag writes new markup, which a limited role may not (editorActions.ts).
  const wraps = role === 'admin' && !fixed && !off.has('sidePanel') && !off.has('text');
  return {
    clientMode: role === 'client',
    editRootId: props.editRootId,
    ...(role === 'admin' ? { onOpenComponent: props.openComponent } : {}),
    ...(role === 'admin' && props.setDefaults ? { onSetDefaults: props.setDefaults } : {}),
    ...(wraps ? { onConvertText: (id: string, name: 'div' | 'span') => props.action({ kind: 'wrap-text', node: id, name }) } : {}),
    ...(fixed ? { canChangeStructure: () => false } : {}),
    onRemoveNode: (id) => props.action({ kind: 'delete', node: id }),
    onDuplicateNode: (id) => props.action({ kind: 'duplicate', node: id }),
    onCopyNode: (id) => copyNode(props.document, id, props.report),
    onPasteNode: () => pasteNode(props.document, props.selected, props.report, props.components),
    hasClipboard: fixed ? false : hasCopiedNode,
  };
}
