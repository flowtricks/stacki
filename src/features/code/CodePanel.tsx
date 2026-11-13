import { useMemo } from 'react';
import type { EditorModel } from '../../editor/pageView';
import { componentSourceRanges, sourceLineLabel, sourceNodeAtOffset, sourceRangeForSelection } from './codePanelModel';
import CodeEditor from '../../ui/CodeEditor';
import { CodeIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface CodePanelProps {
  readonly source: string;
  readonly relativePath: string;
  readonly model: EditorModel | undefined;
  readonly selectedId: string | undefined;
  readonly onChange: (source: string, position: number) => void;
  readonly onSelect: (id: string) => void;
  readonly onOpenComponent: (name: string, id: string) => void;
}

export default function CodePanel(props: CodePanelProps) {
  const translate = useTranslate();
  const { source, relativePath, model, selectedId, onChange, onSelect, onOpenComponent } = props;
  const activeRange = useMemo(() => sourceRangeForSelection(model, selectedId, source.length), [model, selectedId, source.length]);
  const components = useMemo(() => componentSourceRanges(model?.nodes ?? [], source), [model, source]);
  const lineLabel = sourceLineLabel(source, activeRange);
  return (
    <section className="code-panel">
      <header className="code-panel-header">
        <span className="code-panel-title">
          <CodeIcon size={14} />
          {translate('workspace.code.title')}
        </span>
        <span className="code-panel-path" title={relativePath}>
          {relativePath}
        </span>
        {lineLabel && <span className="code-panel-lines">{lineLabel}</span>}
      </header>
      <div className="code-panel-editor">
        <CodeEditor
          language="astro"
          value={source}
          activeRange={activeRange}
          componentRanges={components}
          onChange={onChange}
          onPositionChange={(position) => {
            if (model?.bodyStart !== undefined && position < model.bodyStart) {
              onSelect('frontmatter');
              return;
            }
            const node = sourceNodeAtOffset(model?.nodes ?? [], position);
            if (node !== undefined) {
              onSelect(node.id);
            }
          }}
          onOpenComponent={onOpenComponent}
        />
      </div>
    </section>
  );
}
