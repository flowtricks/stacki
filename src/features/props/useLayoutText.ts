import { useEffect, useState } from 'react';
import { definedFields } from '../../../shared/core/boundary';
import type { PageText } from '../../../shared/properties/pageText';
import { onCanvasReady, queryCanvas } from '../../editor/canvasQuery';
import type { ElementPropsPanelProps } from './propsPanelTypes';

interface LayoutText {
  readonly project: string | undefined;
  readonly file: string | undefined;
  readonly node: string;
  readonly text: PageText | undefined;
}

export function useLayoutText(props: ElementPropsPanelProps): PageText | undefined {
  const { isLayout, projectPath, filePath, valuePolicy, node } = props;
  const title = node.props?.['title'];
  const description = node.props?.['description'];
  const [rendered, setRendered] = useState<LayoutText>();
  const hasOmission = title === undefined || description === undefined;
  const enabled = isLayout === true && hasOmission && valuePolicy !== 'defaults';
  useEffect(() => {
    setRendered(undefined);
    if (!enabled) {
      return undefined;
    }
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void queryCanvas('', [], [], [], { pageText: true }).then((answer) => {
        if (active && request === generation) {
          setRendered({
            project: projectPath,
            file: filePath,
            node: node.id,
            text: answer?.pageText,
          });
        }
      });
    };
    refresh();
    const stop = onCanvasReady(refresh);
    return () => {
      active = false;
      stop();
    };
  }, [enabled, projectPath, filePath, node.id, title, description]);
  // Metadata belongs to this layout on this page; late replies cannot cross selections.
  if (!enabled || rendered === undefined) {
    return undefined;
  }
  if (rendered.project !== projectPath || rendered.file !== filePath || rendered.node !== node.id) {
    return undefined;
  }
  return definedFields({
    title: title === undefined ? rendered.text?.title : undefined,
    description: description === undefined ? rendered.text?.description : undefined,
  });
}
