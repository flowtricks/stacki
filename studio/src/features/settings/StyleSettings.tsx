import { spacingHover } from '../preview/spacingHover';
import { LockedSettings } from './LockedSettings';
import { useEffect, useMemo } from 'react';
import StylePanel from '../../../vendor/stacki/src/features/style/StylePanel';
import { parsePageTree } from '../../../vendor/stacki/shared/page/pageNode';
import type { SharedDocument } from '../collaboration/useDocument';
import { nodeTextEdit } from './settingsEdits';
import { addStyleClass } from './styleClassEdit';
import type { ParserNode } from '../source/source';
import type { OutlineState } from '../preview/outlineState';
import { pathFor } from '../project/previewSelection';

export function StyleSettings({
  document,
  nodes,
  selected,
  classes,
  select,
  device,
  report,
  preview,
}: {
  readonly document: SharedDocument;
  readonly nodes: readonly ParserNode[];
  readonly selected: string;
  readonly classes: readonly string[];
  readonly select: (id: string) => void;
  readonly device: string;
  readonly report: (error: unknown) => void;
  readonly preview: OutlineState;
}) {
  useEffect(() => () => spacingHover.set(undefined), []);
  const model = useMemo(() => ({ nodes: parsePageTree(nodes) }), [nodes]);
  const prefix = document.file.startsWith('src/pages/') ? '' : document.file + '|';
  const path = prefix + pathFor(selected);
  const notice = document.selectionNotice;
  return notice ? (
    <LockedSettings notice={notice} report={report} />
  ) : (
    <StylePanel
      project={{ path: 'studio' }}
      model={model}
      node={{ id: selected }}
      device={device}
      openFilePath={document.file}
      openFileKind={document.file.startsWith('src/pages/') ? 'page' : 'component'}
      projectClasses={classes}
      renderedClasses={preview.selected?.id === path ? preview.classes[path]?.[preview.selected.occurrence ?? 0] : []}
      historyTick={document.revision}
      onSelectNode={select}
      pathOf={(id) => prefix + pathFor(id)}
      onWriteStyleNode={(target, css) => {
        if (target.filePath && target.filePath !== document.file) {
          return false;
        }
        try {
          document.edit(nodeTextEdit(document.text.toString(), target.nodeId, css));
          return true;
        } catch (error) {
          report(error);
          return false;
        }
      }}
      onAddClass={async (name) => {
        try {
          const source = document.text.toString();
          document.replaceSource(addStyleClass(source, selected, name));
          await document.whenSaved();
          return { tag: 'applied' };
        } catch (error) {
          return { tag: 'refused', message: String(error) };
        }
      }}
      onSpacingHover={spacingHover.set}
      onRecordUndo={(command) => document.recordCommand(command)}
    />
  );
}
