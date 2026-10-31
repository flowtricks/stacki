import { canvasContentEdits } from '../../../vendor/stacki/src/app/model/canvasTextContent';
import {
  canvasPropEdits,
  type ComponentSource,
} from '../../../vendor/stacki/src/app/model/canvasPropText';
import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import type { ScanComponent } from '../../../vendor/stacki/shared/properties/projectScan';
import type { Attr } from '../../../vendor/stacki/shared/page/pageNode';
import type { CanvasTextDocument } from '../../../vendor/stacki/src/features/preview/useCanvasText';
import { reportErrorToast } from '../../../vendor/stacki/src/ui/errorNotices';
import type { SharedDocument } from '../collaboration/useDocument';
import { parsePage, type ParserNode } from '../source/source';
import { pathFor } from '../project/previewSelection';
import { request, type Component } from '../project/projectClient';
import { record, string } from '../../shared/validation';
import { setAttributes } from '../settings/settingsEdits';

// Studio's files are project-relative; the prop finder resolves imports against
// a project root, so both are read under this one stand-in.
const ROOT = 'studio';

export function studioCanvasText(
  file: string,
  document: SharedDocument | undefined,
  nodes: readonly ParserNode[],
  context: { readonly components: readonly Component[]; readonly selected: string },
): CanvasTextDocument | undefined {
  if (!document?.ready || !file.endsWith('.astro')) {
    return undefined;
  }
  const source = document.text.toString();
  const replace = (next: string) => {
    if (document.text.toString() !== source) {
      throw new Error('The shared source changed. Select the text again.');
    }
    document.replaceSource(next);
    if (document.text.toString() !== next) {
      throw new Error('Text was not changed. Check your editing access or selection lock.');
    }
  };
  const pathOf = (id: string) => (isCanvasPage(file) ? '' : file + '|') + pathFor(id);
  return {
    file,
    source,
    nodes,
    projectPath: ROOT,
    loadContent: async (canvas) => [
      ...(await canvasContentEdits(canvas)),
      ...(await canvasPropEdits(canvas, {
        projectPath: ROOT,
        file: `${ROOT}/${file}`,
        nodes,
        imports: importsOf(source),
        components: context.components.map(scanComponent),
        relative: (path) => path.slice(ROOT.length + 1),
        read: readComponent,
        // A prop typed on the canvas is written as the props panel writes it.
        setProp: (id: string, prop: string, value: Attr) =>
          replace(setAttributes(source, id, { [prop]: value })),
      })),
    ],
    pathFor: pathOf,
    apply: async (next) => replace(next),
    report: reportErrorToast,
    components: context.components,
    // The selected node's page path: its text from a prop or a slot is marked.
    focus: context.selected ? [pathOf(context.selected)] : [],
  };
}

function importsOf(source: string) {
  const parsed = parsePage(source);
  return parsed.editable && 'imports' in parsed.model ? parsed.model.imports : [];
}

function scanComponent(component: Component): ScanComponent {
  return {
    name: component.name,
    path: `${ROOT}/${component.file}`,
    folder: component.file.slice(0, component.file.lastIndexOf('/')),
    schema: component.fields,
    ...(component.origin === undefined ? {} : { origin: component.origin }),
  };
}

// A component's template, read from the project, for the props it shows.
async function readComponent(path: string): Promise<ComponentSource | undefined> {
  const file = path.slice(ROOT.length + 1);
  const answer = record(await request(`/studio/api/file?file=${encodeURIComponent(file)}`));
  const parsed = parsePage(string(answer['source'], 2_000_000));
  if (!parsed.editable || !('imports' in parsed.model)) {
    return undefined;
  }
  return { nodes: parsed.model.nodes, imports: parsed.model.imports };
}
