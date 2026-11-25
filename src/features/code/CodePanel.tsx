import { useMemo, type ReactNode } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorModel } from '../../editor/pageView';
import { componentSourceRanges, sourceLineLabel, sourceNodeAtOffset, sourceRangeForSelection, type SourceRange } from './codePanelModel';
import CodeEditor from '../../ui/CodeEditor';
import { PanelHeader } from '../../ui/PanelHeader';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface CodePanelProps {
  readonly source: string;
  readonly relativePath: string;
  readonly model: EditorModel | undefined;
  readonly selectedId: string | undefined;
  /** Code to show instead of the whole selected element: what a refusal's 'Show in code' points at. */
  readonly revealRange?: SourceRange | undefined;
  readonly onChange: (source: string, position: number) => void;
  readonly onSelect: (id: string) => void;
  readonly onOpenComponent: (name: string, id: string) => void;
  /** More editor behaviour from the caller, read when the editor is made (the CSS chips of the page's `<style>` blocks). */
  readonly extensions?: Extension | undefined;
  /** What the editor draws beside its code with those extensions (the chips' popups). */
  readonly overlay?: ReactNode;
}

export default function CodePanel(props: CodePanelProps) {
  const translate = useTranslate();
  const { source, relativePath, model, selectedId, revealRange, onChange, onSelect, onOpenComponent, extensions, overlay } = props;
  const selectionRange = useMemo(() => sourceRangeForSelection(model, selectedId, source.length), [model, selectedId, source.length]);
  const activeRange = revealRange ?? selectionRange;
  const components = useMemo(() => componentSourceRanges(model?.nodes ?? [], source), [model, source]);
  const lineLabel = sourceLineLabel(source, activeRange);
  return (
    <section className="code-panel">
      <PanelHeader
        title={translate('workspace.code.title')}
        actions={
          <>
            <span className="code-panel-path" title={relativePath}>
              {/* Cut from the start so the file name stays visible; styles.css says how. */}
              <bdi dir="ltr">{relativePath}</bdi>
            </span>
            {lineLabel && <span className="code-panel-lines">{lineLabel}</span>}
          </>
        }
      />
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
          extensions={extensions}
        />
        {overlay}
      </div>
    </section>
  );
}
