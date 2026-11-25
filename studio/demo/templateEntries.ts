// `/studio/api/page-entries` without a server: a template page's entries are the ones the
// bake rendered through it (bakeTemplates.ts), in the order the build wrote them, which
// is getStaticPaths' order. Studio's server runs getStaticPaths instead
// (src/features/pages/templateEntriesServer.ts); the answer has the same shape.
import { assert } from '../vendor/stacki/shared/core/assert';
import type { BakePage } from '../src/features/bake/bakeSnapshot';
import { BAKE_LIMITS } from '../src/features/bake/bakeSnapshot';
import { isTemplateRoute, type TemplateEntries } from '../src/features/pages/templateRoutes';
import { routeFor } from '../src/features/project/projectClient';

export function bakedTemplateEntries(pages: readonly BakePage[], file: string): TemplateEntries {
  if (!file.startsWith('src/pages/') || !isTemplateRoute(routeFor(file))) {
    return { entries: [], error: undefined };
  }
  const entries = pages.flatMap((page) => {
    if (page.file !== file || page.entry === undefined) {
      return [];
    }
    // The props the entry rendered with, sampled at bake time: the picker's values.
    return [page.entryProps === undefined ? { route: page.route, label: page.entry } : { route: page.route, label: page.entry, props: page.entryProps }];
  });
  assert(entries.length <= BAKE_LIMITS.pagesMax, 'A template has no more entries than the bake has pages');
  return { entries, error: entries.length === 0 ? 'The demo has no entries of this template.' : undefined };
}
