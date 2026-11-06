import type { ShellView } from '../App';
import type { ElementActionProps } from '../../features/structure/ElementContextMenu';
import { structuralSelection } from '../model/selectionStructure';

export function desktopElementActions(app: ShellView): Omit<ElementActionProps, 'nodes'> {
  return {
    editRootId: app.defaultsCanvas.rootId,
    onOpenComponent: (name, id) => {
      void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
    },
    ...(app.defaultsCanvas.state.kind === 'idle'
      ? {
          onSetDefaults: (name: string, id: string) => {
            void app.defaultsCanvas.startForNode(name, id).catch(app.reportFailure);
          },
        }
      : {}),
    onWrapNode: app.wrapNode,
    canChangeStructure: (id) => structuralSelection(app.selectedId, app.pseudoPick) === id,
    onRemoveNode: app.removeNode,
    onCopyNode: app.copyNode,
    onCutNode: (id) => {
      app.copyNode(id);
      app.removeNode(id);
    },
    onDuplicateNode: app.duplicateNode,
    onPasteNode: app.onPasteNode,
    hasClipboard: () => !!app.nodeClipboardRef.current,
  };
}
