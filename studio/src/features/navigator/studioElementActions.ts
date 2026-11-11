import type { ElementActionProps } from '../../../vendor/stacki/src/features/structure/ElementContextMenu';
import type { NavigatorProps } from './Navigator';
import { copyNode, pasteNode, hasCopiedNode } from './clipboard';

type ActionOptions = Pick<NavigatorProps, 'document' | 'selected' | 'components' | 'action' | 'report' | 'editRootId' | 'setDefaults' | 'openComponent'>;

export function studioElementActions(props: ActionOptions, role: 'client' | 'admin'): Omit<ElementActionProps, 'nodes'> {
  return {
    clientMode: role === 'client',
    editRootId: props.editRootId,
    ...(role === 'admin' ? { onOpenComponent: props.openComponent } : {}),
    ...(role === 'admin' && props.setDefaults ? { onSetDefaults: props.setDefaults } : {}),
    ...(role === 'admin' ? { onConvertText: (id: string, name: 'div' | 'span') => props.action({ kind: 'wrap-text', node: id, name }) } : {}),
    onRemoveNode: (id) => props.action({ kind: 'delete', node: id }),
    onDuplicateNode: (id) => props.action({ kind: 'duplicate', node: id }),
    onCopyNode: (id) => copyNode(props.document, id, props.report),
    onPasteNode: () => pasteNode(props.document, props.selected, props.report, props.components),
    hasClipboard: hasCopiedNode,
  };
}
