import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { useLayoutEffect, useRef } from 'react';
import { flatten, type ParserNode } from '../source/source';
import { componentAt } from '../project/componentEntry';
import { pathFor } from '../project/previewSelection';
import type { Project } from '../project/projectClient';
import type { usePreview } from './usePreview';
import type { parsePage } from '../source/source';

type Parsed = ReturnType<typeof parsePage> | undefined;
export function useLiveNumericStyles(file: string, parsed: Parsed, project: Project, preview: ReturnType<typeof usePreview>) {
  const previous = useRef<{ file: string; nodes: readonly ParserNode[] }>({ file, nodes: [] });
  const send = useRef(preview.send);
  send.current = preview.send;
  useLayoutEffect(() => {
    const after = parsed?.editable ? flatten(parsed.model.nodes) : [];
    const before = previous.current.nodes;
    const sameFile = previous.current.file === file;
    previous.current = { file, nodes: after };
    if (!sameFile || before.length !== after.length || after.some((node, index) => node.id !== before[index]?.id || node.name !== before[index]?.name)) {
      send.current({ type: 'studio:live-styles', reset: true, changes: [] });
      return;
    }
    let reset = false;
    const changes = after
      .flatMap((node, index) => {
        if (!node.id) {
          return [];
        }
        const component = componentAt(project, file, parsed, node.id);
        return (component?.numericStyles ?? []).flatMap((binding) => {
          const value = node.props?.[binding.prop];
          if (JSON.stringify(value) === JSON.stringify(before[index]?.props?.[binding.prop])) {
            return [];
          }
          if (node.props?.['style'] || (value && (value.type !== 'expr' || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.value)))) {
            reset = true;
            return [];
          }
          const number = value?.type === 'expr' ? Number(value.value) : 0;
          if (!Number.isFinite(number)) {
            return [];
          }
          return [
            {
              path: (isCanvasPage(file) ? '' : file + '|') + pathFor(node.id ?? ''),
              marker: `${component?.file}|${binding.marker}`,
              variable: binding.variable,
              value: number ? `${number}${binding.unit}` : '',
            },
          ];
        });
      })
      .slice(0, 500);
    if (reset || changes.length) {
      send.current({ type: 'studio:live-styles', reset, changes });
    }
  }, [file, parsed, project]);
}
