import { canvasContentEdits } from '../model/canvasTextContent';
import { canvasPropEdits, type ComponentSource } from '../model/canvasPropText';
import { readPage } from '../../ipc/bridge';
import type { ShellView } from '../App';
import type { CanvasTextDocument, CanvasTextFormatter } from '../../features/preview/useCanvasText';
import {
  formatInlineSelection,
  inlineRootOf,
  inlineStatesAt,
  inlineWithValue,
} from '../model/canvasTextFormat';
import { isInlineOnly } from '../../features/props/richContentModel';
import type { PageNode } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { projectRelativePath } from '../../lib/projectPath';

export function desktopCanvasText(app: ShellView): CanvasTextDocument | undefined {
  const state = app.pageState;
  const file = app.openEditableFile?.path;
  if (!file || !state?.editable || state.parsedFrom !== state.source) {
    return undefined;
  }
  if (!file.endsWith('.astro')) {
    return undefined;
  }
  return {
    file: projectRelativePath(app.project.path, file, window.avb.platform),
    projectPath: app.project.path,
    loadContent: async (document) => [
      ...(await canvasContentEdits(document)),
      ...(await canvasPropEdits(document, {
        projectPath: app.project.path,
        file,
        nodes: state.model.nodes,
        imports: 'imports' in state.model ? state.model.imports : [],
        components: app.insertables,
        relative: (path) => projectRelativePath(app.project.path, path, window.avb.platform),
        read: readComponent,
        setProp: (nodeId, prop, value) => app.setProp(nodeId, prop, value, true),
      })),
    ],
    source: state.source,
    nodes: state.model.nodes,
    pathFor: app.pathFor,
    apply: app.changeCodeSource,
    report: app.showToast,
    format: desktopCanvasFormat(state.model.nodes, app.setNodeInline),
    focus: canvasFocus(app.selectedId, app.pathFor),
    components: app.insertables,
  };
}

// The selected node's page path: the text of the selected component instance
// is marked as editable. Selecting something inside it (a `strong` in its
// content) is working on that thing, so the instance's text is not marked.
function canvasFocus(
  selectedId: string | undefined,
  pathFor: (id: string) => string | undefined,
): readonly string[] {
  const path = selectedId ? pathFor(selectedId) : undefined;
  return path ? [path] : [];
}

// A component's parsed template, for the prop text it prints. A component
// Stacki cannot edit visually prints nothing it can find.
async function readComponent(path: string): Promise<ComponentSource | undefined> {
  const read = await readPage(path);
  if (!read.editable || !('imports' in read.model)) {
    return undefined;
  }
  return { nodes: read.model.nodes, imports: read.model.imports };
}

// The canvas bar's presses, saved the way the Content field saves: the whole
// inline content of the element, through setNodeInline.
function desktopCanvasFormat(
  nodes: readonly PageNode[],
  setNodeInline: ShellView['setNodeInline'],
): CanvasTextFormatter {
  const contentOf = (textId: string) => {
    const found = inlineRootOf(nodes, textId);
    if (!found?.root.id) {
      return undefined;
    }
    const children = 'children' in found.root ? found.root.children : undefined;
    if (!isInlineOnly(children)) {
      return undefined;
    }
    return { rootId: found.root.id, children, trail: found.trail };
  };
  return {
    states: (textId) => {
      const content = contentOf(textId);
      return content ? inlineStatesAt(content.children, content.trail) : undefined;
    },
    apply: (textId, selection, action) => {
      const content = contentOf(textId);
      if (!content) {
        return false;
      }
      assert(content.trail.length > 0, 'Formatted text sits inside its element');
      const typed = inlineWithValue(content.children, content.trail, selection.value);
      const next = formatInlineSelection(typed, { ...selection, trail: content.trail }, action);
      if (!next) {
        return false;
      }
      setNodeInline(content.rootId, next);
      return true;
    },
  };
}
