import { editingOffFor } from '../../lib/editorGate';
import type { Translator } from '../../lib/i18n/localeContext';
import { isComponentCanvasPage } from '../../features/preview/componentCanvas/componentCanvasSession';
import { canvasContentEdits } from '../model/canvasTextContent';
import { canvasPropEdits, type ComponentSource } from '../model/canvasPropText';
import { readPage, readText, resolvePath, writeText } from '../../ipc/bridge';
import { boundPropReader, canvasBoundEdits, type BoundTextHost, type BoundTextWords } from '../model/canvasBoundText';
import type { ShellView } from '../App';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { canvasRichRootsOf, canvasTextBreaksOf, canvasTextFormatter, type CanvasTextBreaking } from '../model/canvasTextFormat';
import { componentReference } from '../model/componentReference';
import { DEFAULT_SLOT_FIELD } from '../../../shared/properties/componentDefaults';
import { projectRelativePath } from '../../lib/projectPath';
import { assetScopeOf, shownAssetNodes } from '../../editor/richAssetImports';

export function desktopCanvasText(app: ShellView, translate: Translator): CanvasTextDocument | undefined {
  const state = app.pageState;
  const file = app.openEditableFile?.path;
  if (!file || !state?.editable || state.parsedFrom !== state.source) {
    return undefined;
  }
  if (!file.endsWith('.astro') || editingOffFor('text') !== undefined) {
    return undefined;
  }
  // The component canvas's page is generated and never edited: a double click there opens a frame's instance, so its
  // words offer no typing (it would take the double click and then be refused).
  if (app.editStack.length <= 1 && isComponentCanvasPage(file)) {
    return undefined;
  }
  const host = boundTextHost(app);
  // Imported images read as their paths wherever the content is read as rich text (richAssetImports.ts).
  const relative = projectRelativePath(app.project.path, file, window.avb.platform);
  const shown = shownAssetNodes(state.model.nodes, assetScopeOf(relative, 'imports' in state.model ? state.model.imports : []));
  const words: BoundTextWords = {
    saved: (path, saved) => translate('preview.text.source.saved', { path, file: saved }),
    undo: translate('preview.text.source.undo'),
    sourceChanged: translate('preview.text.sourceChanged'),
  };
  return {
    file: projectRelativePath(app.project.path, file, window.avb.platform),
    projectPath: app.project.path,
    loadContent: async (document) => [
      ...(await canvasContentEdits(document, translate('shell.canvasText.sharedContent'))),
      ...(await canvasBoundEdits(document, host, words)),
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
        bound: boundPropReader(document, host, words),
      })),
    ],
    source: state.source,
    nodes: state.model.nodes,
    pathFor: app.pathFor,
    apply: app.changeCodeSource,
    report: app.showToast,
    // The canvas bar's presses, saved as the Content field saves them.
    format: canvasTextFormatter(shown, app.setNodeInline),
    ...desktopTextBreaks(app, state.model, shown),
    settings: app.componentEditing,
    focus: canvasFocus(app.selectedId, app.pathFor),
    components: app.insertables,
  };
}

// What Enter types in each text, from the editing settings of the component it sits in.
function desktopTextBreaks(
  app: ShellView,
  model: NonNullable<ShellView['model']>,
  shown: NonNullable<ShellView['model']>['nodes'],
): { readonly breaks: (path: string) => CanvasTextBreaking | undefined; readonly richBoxes: () => readonly string[] } {
  const imports = 'imports' in model ? model.imports : [];
  // Read when a catalog is published, not on every render of the shell.
  let breaks: ReadonlyMap<string, CanvasTextBreaking> | undefined;
  const settingsOf = (node: (typeof shown)[number]) =>
    app.componentEditing(
      componentReference({ name: node.name ?? '', project: app.project.path, file: app.currentPage?.path, imports, components: app.insertables })?.path,
      DEFAULT_SLOT_FIELD,
    );
  return {
    breaks: (path) => (breaks ??= canvasTextBreaksOf(shown, app.pathFor, settingsOf)).get(path),
    richBoxes: () => canvasRichRootsOf(shown, app.pathFor, settingsOf),
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

// The data modules a page's text comes from, read and written under the project
// root. A write is one undo step on the same history the page's edits use.
function boundTextHost(app: ShellView): BoundTextHost {
  const root = app.project.path;
  const separator = root.includes('\\') ? '\\' : '/';
  const absolute = (rel: string) => `${root}${separator}${rel.split('/').join(separator)}`;
  const write = async (file: string, expected: string, next: string) => {
    const current = await readText(root, file);
    if (current !== expected) {
      throw new Error(`${file} changed on disk`);
    }
    await writeText(root, file, next);
  };
  return {
    readModule: async (fromFile, spec) => {
      const resolved = await resolvePath(root, absolute(fromFile), spec);
      if (!resolved.ok) {
        return undefined;
      }
      return { file: resolved.rel, text: await readText(root, resolved.rel) };
    },
    readFile: (file) => readText(root, file).catch(() => undefined),
    writeModule: async ({ file, before, after }) => {
      await write(file, before, after);
      app.pushCommand({ label: file, undo: () => write(file, after, before), redo: () => write(file, before, after) });
    },
    undo: async () => {
      await app.undo();
    },
  };
}
