import { spacingHover } from '../preview/spacingHover';
import { LockedSettings } from './LockedSettings';
import { useEffect, useMemo } from 'react';
import StylePanel from '../../../vendor/stacki/src/features/style/StylePanel';
import PanelBoundary from '../../../vendor/stacki/src/ui/PanelBoundary';
import { parsePageTree } from '../../../vendor/stacki/shared/page/pageNode';
import type { SharedDocument } from '../collaboration/useDocument';
import { nodeTextEdit } from './settingsEdits';
import { attributeEdit } from '../source/source';
import { addStyleClass } from './styleClassEdit';
import { addStyleBlockSource } from './styleBlockEdit';
import type { ParserNode } from '../source/source';
import type { OutlineState } from '../preview/outlineState';
import { pathFor } from '../project/previewSelection';
import type { LengthUnit } from '../../../vendor/stacki/shared/properties/lengthUnit';

export function StyleSettings({
  document,
  nodes,
  selected,
  classes,
  lengthUnit,
  select,
  device,
  report,
  preview,
}: {
  readonly document: SharedDocument;
  readonly nodes: readonly ParserNode[];
  readonly selected: string;
  readonly classes: readonly string[];
  /** What the panel writes lengths in, from the project scan: rem in a Lumos project. */
  readonly lengthUnit: LengthUnit | undefined;
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
    <PanelBoundary name="The Style panel" resetKey={selected}>
      <StylePanel
        project={{ path: 'studio' }}
        model={model}
        node={{ id: selected }}
        device={device}
        openFilePath={document.file}
        openFileKind={document.file.startsWith('src/pages/') ? 'page' : 'component'}
        projectClasses={classes}
        lengthUnit={lengthUnit}
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
        onAddStyleBlock={async (request) => {
          try {
            document.replaceSource(addStyleBlockSource(document.text.toString(), document.file, selected, request));
            await document.whenSaved();
            return { tag: 'applied' };
          } catch (error) {
            return { tag: 'refused', message: error instanceof Error ? error.message : String(error) };
          }
        }}
        onSetInlineStyle={(nodeId, style) => {
          // Desktop's own write: the attribute's whole next text, or removed (inlineTarget.ts).
          try {
            document.edit(attributeEdit(document.text.toString(), nodeId, 'style', style?.value, style?.type === 'expr'));
          } catch (error) {
            report(error);
          }
        }}
        onSpacingHover={spacingHover.set}
        onRecordUndo={(command) => document.recordCommand(command)}
      />
    </PanelBoundary>
  );
}
