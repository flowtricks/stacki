import type { Translator } from '../../lib/i18n/localeContext';
import { canvasContentEdits } from '../model/canvasTextContent';
import { canvasPropEdits, type ComponentSource } from '../model/canvasPropText';
import { readPage } from '../../ipc/bridge';
import type { ShellView } from '../App';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { canvasTextFormatter } from '../model/canvasTextFormat';
import { projectRelativePath } from '../../lib/projectPath';

export function desktopCanvasText(app: ShellView, translate: Translator): CanvasTextDocument | undefined {
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
      ...(await canvasContentEdits(document, translate('shell.canvasText.sharedContent'))),
      ...(await canvasPropEdits(document, {
        label: translate('shell.canvasText.componentText'),
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
    // The canvas bar's presses, saved as the Content field saves them.
    format: canvasTextFormatter(state.model.nodes, app.setNodeInline),
    focus: canvasFocus(app.selectedId, app.pathFor),
    components: app.insertables,
  };
}

// The selected node's page path: the text of the selected component instance
// is marked as editable. Selecting something inside it (a `strong` in its
// content) is working on that thing, so the instance's text is not marked.
function canvasFocus(selectedId: string | undefined, pathFor: (id: string) => string | undefined): readonly string[] {
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
  return { nodes: read.model.nodes, imports: read.model.imports, extraFrontmatter: read.model.extraFrontmatter };
}
