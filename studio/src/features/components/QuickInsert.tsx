import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { useEffect, useState } from 'react';
import InsertSearch, { type InsertItem } from '../../../vendor/stacki/src/features/palette/InsertSearch';
import { insertTargetFor } from '../../../vendor/stacki/src/editor/insertTarget';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { useEditor } from '../project/useEditor';
import type { Project } from '../project/projectClient';
import { parsePage, type TreeAction } from '../source/source';
import { componentImport } from '../source/imports';
import { parseInsertContent } from '../source/insertContentContract';
import { dropTarget } from '../navigator/dropTarget';

export function QuickInsert({
  model,
  project,
  enabled,
  report,
}: {
  readonly model: ReturnType<typeof useEditor>;
  readonly project: Project;
  readonly enabled: boolean;
  readonly report: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const document = model.document;
  const editable = !!document?.ready && model.editable;
  useInsertShortcut(enabled && editable, () => setOpen(true));
  if (!open || !enabled || !editable || !document) {
    return null;
  }
  return (
    <InsertSearch
      components={project.components.map((component) => ({
        name: component.name,
        path: component.file,
        folder: component.file
          .replace(/^src\/(components|layouts)\//, '')
          .split('/')
          .slice(0, -1)
          .join('/'),
        isLayout: component.file.startsWith('src/layouts/'),
      }))}
      allowSlot={!isCanvasPage(document.file)}
      onInsert={(item) => {
        setOpen(false);
        void insertChoice(model, project, item).catch(report);
      }}
      onClose={() => setOpen(false)}
    />
  );
}

async function insertChoice(model: ReturnType<typeof useEditor>, project: Project, item: InsertItem) {
  const document = model.document;
  if (!document?.ready) {
    return;
  }
  const parsed = parsePage(document.text.toString(), { locs: true });
  if (!parsed.editable) {
    return;
  }
  const location = insertTargetFor(parsePageModel(parsed.model), model.selected, item, project.components);
  const target = dropTarget(parsed.model.nodes, location);
  let action: TreeAction;
  if (item.type === 'component') {
    const component =
      project.components.find((component) => component.file === item.path) ?? project.components.find((component) => component.name === item.name);
    if (!component) {
      return;
    }
    action = {
      kind: 'insert',
      ...target,
      name: component.name,
      importPath: componentImport(document.file, component),
      paired: component.slots.includes('default') && component.slotText === true,
    };
  } else {
    action = { kind: 'insert-content', ...target, content: parseInsertContent(item) };
  }
  await document.action(action);
}

function useInsertShortcut(enabled: boolean, open: () => void) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        !['f', 'e'].includes(event.key.toLowerCase()) ||
        (event.target instanceof Element && event.target.closest('.cm-editor'))
      ) {
        return;
      }
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled, open]);
}
