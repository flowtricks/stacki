import { isCanvasPage, isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import type { SharedDocument } from '../collaboration/useDocument';
import { getStudioRole } from '../roles/roleStore';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { flatten, type parsePage } from '../source/source';
import { resolveImport } from '../source/imports';
import type { Project } from './projectClient';
import type { ComponentFocus, OpenFile } from './editorNavigation';
import { pathFor } from './previewSelection';

type Parsed = ReturnType<typeof parsePage> | undefined;
export function componentAt(project: Project, file: string, parsed: Parsed, id: string, name?: string) {
  if (!parsed?.editable) {
    return undefined;
  }
  const node = flatten(parsed.model.nodes).find((node) => node.id === id);
  const spec = parsed.model.imports.find((item) => item.name === (node?.name ?? name))?.path;
  return project.components.find((item) => item.file === resolveImport(file, spec, project.components));
}
interface Context {
  readonly project: Project;
  readonly file: string;
  readonly parsed: Parsed;
  readonly document: SharedDocument | undefined;
  readonly open: OpenFile | undefined;
  readonly focus: ComponentFocus | undefined;
  readonly report: (error: unknown) => void;
}
export function componentEntry(context: Context) {
  return (name: string, id: string, occurrence = 0) => {
    if (isDefaultsCanvas(context.file)) {
      return;
    }
    if (!can(getStudioRole(), 'component:edit')) {
      return;
    }
    const component = componentAt(context.project, context.file, context.parsed, id, name);
    if (!component || !context.document?.ready) {
      return;
    }
    if (component.origin?.kind === 'package') {
      context.report(new Error('Package components are read-only. Edit instance properties on the page.'));
      return;
    }
    const focus =
      context.focus ??
      (id === 'layout'
        ? undefined
        : {
            path: (isCanvasPage(context.file) ? '' : context.file + '|') + pathFor(id),
            occurrence,
          });
    // Finish the source save before closing its collaboration connection.
    void context.document
      .whenSaved()
      .then(() => context.open?.(component.file, focus))
      .catch(context.report);
  };
}
