import { useMemo } from 'react';
import StackiCodePanel from '../../../vendor/stacki/src/features/code/CodePanel';
import CodeEditor from '../../../vendor/stacki/src/ui/CodeEditor';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { parsePage } from '../source/source';
import type { SharedDocument } from '../collaboration/useDocument';

interface Props {
  readonly document: SharedDocument | undefined;
  readonly selected: string;
  readonly select: (id: string) => void;
  readonly openComponent: (name: string, id: string) => void;
}
export function CodePanel({ document, selected, select, openComponent }: Props) {
  const source = document?.text.toString() ?? '';
  const astro = document?.file.endsWith('.astro') ?? false;
  const model = useMemo(() => {
    if (!astro) {
      return undefined;
    }
    const parsed = parsePage(source, { locs: true });
    return parsed.editable ? parsePageModel(parsed.model) : undefined;
  }, [source, astro]);
  if (!document) {
    return null;
  }
  return (
    <div className="studio-code-panel code-panel">
      {astro ? (
        <StackiCodePanel
          source={source}
          relativePath={document.file}
          model={model}
          selectedId={selected}
          onSelect={select}
          onOpenComponent={openComponent}
          onChange={(source) => document.replaceSource(source)}
        />
      ) : (
        <>
          <div className="panel-header">
            <h2>Code</h2>
            <span className="muted">{document.file.split('/').at(-1)}</span>
          </div>
          <div className="code-panel-editor">
            <CodeEditor
              language={document.file.endsWith('.css') ? 'css' : /\.mdx?$/.test(document.file) ? 'markdown' : 'javascript'}
              value={source}
              onChange={(source) => document.replaceSource(source)}
            />
          </div>
        </>
      )}
    </div>
  );
}
