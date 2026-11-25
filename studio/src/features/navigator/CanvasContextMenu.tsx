import { useEffect, useMemo } from 'react';
import { ElementContextMenu } from '../../../vendor/stacki/src/features/structure/ElementContextMenu';
import { parsePageTree } from '../../../vendor/stacki/shared/page/pageNode';
import { studioElementActions } from './studioElementActions';
import type { EditorProps } from '../../app/Editor';
import type { useEditor } from '../project/useEditor';
import type { useStudioDefaultsCanvas } from '../settings/useStudioDefaultsCanvas';

export function CanvasContextMenu({
  props,
  model,
  defaultsCanvas,
}: {
  readonly props: EditorProps;
  readonly model: ReturnType<typeof useEditor>;
  readonly defaultsCanvas: ReturnType<typeof useStudioDefaultsCanvas>;
}) {
  const { position, close } = model.preview.contextMenu;
  const source = model.document?.text.toString();
  useEffect(() => close(), [close, props.file, source, props.view.device]);
  const nodes = useMemo(() => parsePageTree(model.nodes), [model.nodes]);
  if (!position || !model.editable) {
    return undefined;
  }
  const nodeId = position.path === '0' && nodes[0]?.id === 'layout' ? 'layout' : 'n' + position.path;
  if (model.selected !== nodeId) {
    return undefined;
  }
  return (
    <ElementContextMenu
      key={position.generation}
      {...studioElementActions(
        {
          ...model,
          components: props.project.components,
          report: props.report,
          editRootId: defaultsCanvas.rootId,
          ...(defaultsCanvas.state.kind === 'idle'
            ? {
                setDefaults: (name: string, id: string) => {
                  void defaultsCanvas.startForNode(name, id).catch(props.report);
                },
              }
            : {}),
        },
        props.view.role === 'client' ? 'client' : 'admin',
      )}
      nodes={nodes}
      position={{ ...position, nodeId }}
      onClose={close}
    />
  );
}
