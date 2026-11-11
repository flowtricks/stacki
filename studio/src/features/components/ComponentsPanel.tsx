import PalettePanel from '../../../vendor/stacki/src/features/palette/PalettePanel';
import { request, type Project } from '../project/projectClient';
import { parsePreviewTarget } from '../preview/usePreview';
import { useComponentCounts } from './useComponentCounts';
import { flatten, type ParserNode } from '../source/source';

/** A dev-server address as the preview origin serves it; the palette's hover cards and the insert grid share it. */
export async function resolvePreviewURL(url: string): Promise<string> {
  const parsed = new URL(url);
  const page = parsed.pathname + parsed.search;
  return parsePreviewTarget(await request('/studio/api/preview-url?page=' + encodeURIComponent(page))).url;
}
export function ComponentsPanel({
  project,
  insert,
  onDragBegin,
  nodes,
  select,
  open,
  report,
}: {
  readonly project: Project;
  readonly insert: (file: string) => void;
  readonly onDragBegin: () => void;
  readonly nodes: readonly ParserNode[];
  readonly select: (id: string) => void;
  readonly open: (file: string) => void;
  readonly report: (error: unknown) => void;
}) {
  const counts = useComponentCounts(project, report);
  return (
    <PalettePanel
      components={project.components
        .filter((component) => component.isLayout !== true)
        .map((component) => {
          const instances = counts.get(component.file);
          return {
            name: component.name,
            path: component.file,
            ...(component.origin === undefined ? {} : { origin: component.origin }),
            folder:
              component.folder ??
              component.file
                .replace(/^src\/components\//, '')
                .split('/')
                .slice(0, -1)
                .join('/'),
            schema: component.fields,
            slots: component.slots,
            ...(instances === undefined ? {} : { instances }),
          };
        })}
      devUrl={location.origin}
      resolvePreviewURL={resolvePreviewURL}
      trailingSlash="ignore"
      onInsert={insert}
      onDragBegin={onDragBegin}
      onUsage={(component) => request('/studio/api/component-usage?file=' + encodeURIComponent(component.path))}
      pageInstances={(name) => flatten(nodes).flatMap((node) => (node.kind === 'component' && node.name === name && node.id ? [{ id: node.id }] : []))}
      onSelectInstance={select}
      onOpenUsage={(file) => open(file.path)}
      createFrom={{
        kind: 'unavailable',
        reason: 'Create component templates in the project source.',
      }}
      onCreateComponent={() => {}}
    />
  );
}
