import { useEffect, useState } from 'react';
import { onCanvasReady, queryCanvas } from '../../editor/canvasQuery';
import type { ElementPropsPanelProps } from './propsPanelTypes';

interface LayoutMetadata {
  readonly project: string | undefined;
  readonly file: string | undefined;
  readonly image: string | undefined;
  readonly type: string | undefined;
}

export function useLayoutMetadata(props: ElementPropsPanelProps): LayoutMetadata | undefined {
  const { isLayout, projectPath, filePath, valuePolicy } = props;
  const [rendered, setRendered] = useState<LayoutMetadata>();
  const enabled = isLayout === true && valuePolicy !== 'defaults';
  useEffect(() => {
    setRendered(undefined);
    if (!enabled) {
      return undefined;
    }
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void queryCanvas('', [], [], [], { pageMetadata: true }).then((answer) => {
        if (active && request === generation) {
          setRendered({
            project: projectPath,
            file: filePath,
            image: answer?.pageImage,
            type: answer?.pageType,
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
  }, [enabled, projectPath, filePath]);
  // A project/page switch must not display the previous page's resolved image.
  if (!enabled) {
    return undefined;
  }
  if (rendered?.project !== projectPath) {
    return undefined;
  }
  return rendered?.file === filePath ? rendered : undefined;
}
