// The link field's Page tab lists a template's entries (`/posts/[slug]` becomes one row per post).
// Studio answers with the same page-entries read the title bar's entry picker makes, so both lists
// come from one source. The read is a GET: it never writes the project.
import { linkEntriesFromAnswer, type LinkEntryLoader } from '../../../vendor/stacki/src/features/props/linkEntries';
import { request } from '../project/projectClient';
import { parseTemplateEntries } from '../pages/templateRoutes';
import type { Project } from '../project/projectClient';
import { projectPages } from '../project/pageLabels';

export function linkEntryLoader(project: Project): LinkEntryLoader {
  return async (route) => {
    const page = projectPages(project).find((candidate) => candidate.route === route);
    if (page === undefined) {
      return { kind: 'unavailable' };
    }
    try {
      const entries = parseTemplateEntries(await request('/studio/api/page-entries?page=' + encodeURIComponent(page.path)));
      return linkEntriesFromAnswer(route, entries);
    } catch {
      // A template that cannot answer stays one row of its own.
      return { kind: 'unavailable' };
    }
  };
}
