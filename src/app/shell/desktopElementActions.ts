import type { ShellView } from '../App';
import { canvasInstanceOpener } from '../../features/preview/componentCanvas/componentCanvasSession';
import type { ElementActionProps } from '../../features/structure/ElementContextMenu';
import { structuralSelection } from '../model/selectionStructure';
import { addNodeToChatOffer } from './aiAddToChat';
import { currentRole } from '../../lib/currentRole';

export function desktopElementActions(app: ShellView): Omit<ElementActionProps, 'nodes'> {
  return {
    editRootId: app.defaultsCanvas.rootId,
    // The canvas controls "View as" previews as off.
    roleOff: currentRole().editorOff,
    onOpenComponent: (name, id) => {
      void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
    },
    // Open in canvas, the Components panel's Open in canvas for this instance's component (useDesktopComponentCanvas.ts).
    ...(canvasInstanceOpener() === undefined ? {} : { onOpenCanvas: (name: string, id: string) => canvasInstanceOpener()?.(name, id) }),
    ...(app.defaultsCanvas.state.kind === 'idle'
      ? {
          onSetDefaults: (name: string, id: string) => {
            void app.defaultsCanvas.startForNode(name, id).catch(app.reportFailure);
          },
        }
      : {}),
    ...(addNodeToChatOffer() === undefined ? {} : { onAddToChat: (id: string) => addNodeToChatOffer()?.(id) }),
    onWrapNode: app.wrapNode,
    // Markdown writes no tag around its words, so its text has nothing to convert to.
    ...(app.openEditableFile?.path.endsWith('.astro') ? { onConvertText: app.convertText } : {}),
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
