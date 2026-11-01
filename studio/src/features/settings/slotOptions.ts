import { componentAt } from '../project/componentEntry';
import type { Project } from '../project/projectClient';
import { flatten, parsePage } from '../source/source';

export function slotOptions(project: Project, file: string, source: string, selected: string) {
  const parsed = parsePage(source);
  if (!parsed.editable || selected === 'layout') {
    return undefined;
  }
  const parent = flatten(parsed.model.nodes).find((node) => node.children?.some((child) => child.id === selected));
  return parent?.id && (parent.id === 'layout' || parent.kind === 'component') ? componentAt(project, file, parsed, parent.id)?.slots : undefined;
}
