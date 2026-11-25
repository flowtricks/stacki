// What a quick-insert pick does: the structural action the server applies, and the stand-in the
// canvas shows the moment it is picked (shared/page/canvasInsert.ts, electron/preload/framePendingInsert.ts),
// as Desktop's palette shows one (src/editor/canvasInsertShow.ts). Measured before the stand-in (Studio,
// a 700 ms render and 200 ms round trip): a picked <div> appeared after about 1.1 s; with it, in about 15 ms.
// Pure: it reads the page as it is before the insert and changes nothing.
import { insertTargetFor } from '../../../vendor/stacki/src/editor/insertTarget';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { planCanvasInsert, type CanvasInsert, type CanvasInsertSource } from '../../../vendor/stacki/shared/page/canvasInsert';
import type { InsertChoice } from '../../../vendor/stacki/src/features/palette/insertItem';
import type { Project } from '../project/projectClient';
import { pathFor } from '../project/previewSelection';
import { dropTarget } from '../navigator/dropTarget';
import { componentImport } from '../source/imports';
import { parseInsertContent } from '../source/insertContentContract';
import { insertedContentPreview } from '../source/insertedContent';
import { parsePage, type TreeAction } from '../source/source';

export interface QuickInsertPlan {
  readonly action: TreeAction;
  /** Undefined when the canvas cannot predict the node; the rendered page shows it then. */
  readonly standIn: CanvasInsert | undefined;
}

export function planQuickInsert(input: {
  readonly source: string;
  readonly file: string;
  readonly selected: string;
  readonly components: Project['components'];
  readonly item: InsertChoice;
}): QuickInsertPlan | undefined {
  const parsed = parsePage(input.source, { locs: true });
  if (!parsed.editable) {
    return undefined;
  }
  const { item } = input;
  const location = insertTargetFor(parsePageModel(parsed.model), input.selected, item, input.components);
  const target = dropTarget(parsed.model.nodes, location);
  let action: TreeAction;
  let shown: CanvasInsertSource;
  if (item.type === 'component') {
    const component = input.components.find((candidate) => candidate.file === item.path) ?? input.components.find((candidate) => candidate.name === item.name);
    if (!component) {
      return undefined;
    }
    action = {
      kind: 'insert',
      ...target,
      name: component.name,
      importPath: componentImport(input.file, component),
      paired: component.slots.includes('default') && component.slotText === true,
    };
    shown = { kind: 'component', name: component.name, props: {} };
  } else {
    const content = parseInsertContent(item);
    action = { kind: 'insert-content', ...target, content };
    shown = insertedContentPreview(content);
  }
  return { action, standIn: planCanvasInsert(parsed.model.nodes, location, shown, pathFor) };
}
