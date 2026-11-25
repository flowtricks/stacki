import { layoutPageTitle } from '../../../vendor/stacki/shared/page/pageTitle';
import { pageDisplayLabel } from '../../../vendor/stacki/src/lib/pageName';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import type { ParserNode } from '../source/source';
import { routeFor, type Project } from './projectClient';

export function projectPages(project: Project) {
  const metadata = new Map(project.pageMetadata?.map((page) => [page.path, page]));
  return project.pages.map((path) => ({
    ...metadata.get(path),
    path,
    name: path.replace(/^src\/pages\//, ''),
    route: routeFor(path),
  }));
}

export function projectPageLabel(project: Project, file: string, translate: Translator): string | undefined {
  const page = projectPages(project).find((entry) => entry.path === file);
  return page ? pageDisplayLabel(page, translate) : undefined;
}

export function livePageTitles(project: Project, file: string, model: { readonly editable: boolean; readonly nodes: readonly ParserNode[] }): Project {
  if (!model.editable || !project.pages.includes(file)) {
    return project;
  }
  return {
    ...project,
    pageMetadata: projectPages(project).map((page) => (page.path === file ? { ...page, title: layoutPageTitle(model.nodes, page.inheritedTitle) } : page)),
  };
}
