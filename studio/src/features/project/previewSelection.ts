import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { flatten, type ParserNode } from '../source/source';
import type { usePreview } from '../preview/usePreview';
import type { ComponentFocus } from './editorNavigation';

export function previewSelection(preview: ReturnType<typeof usePreview>, file: string, nodes: readonly ParserNode[], focus?: ComponentFocus) {
  const labels = () =>
    preview.send({
      type: 'studio:labels',
      labels: flatten(nodes).map((node) => ({
        id: pathFor(node.id ?? ''),
        label: node.name ?? node.kind,
        component: node.kind === 'component',
        nodeKind: node.kind,
      })),
    });
  return {
    select(id: string, occurrence = 0) {
      preview.send({
        type: 'studio:scope',
        scope: isCanvasPage(file) ? '' : file + '|',
        focus: focus?.path ?? '',
        occurrence: focus?.occurrence ?? 0,
      });
      labels();
      preview.send({ type: 'studio:select', id: pathFor(id), occurrence });
    },
    hover(id: string | undefined) {
      labels();
      preview.send({ type: 'studio:hover', id: id ? pathFor(id) : '' });
    },
  };
}
export function pathFor(id: string) {
  return id === 'layout' ? '0' : id.replace(/^n/, '');
}
