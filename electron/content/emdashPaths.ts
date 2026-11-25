// The pages an EmDash dynamic route stands for. A route like `src/pages/posts/[slug].astro` reads its entry
// at request time (`getEmDashEntry('posts', slug)`), so it has no `getStaticPaths` for the dev server to run
// and the canvas would otherwise preview the bare pattern. The entries come from EmDash itself: the
// published ones in the project's local database, which is what the dev server renders from. Reading only:
// nothing here can change an entry.

import fs from 'node:fs';

import { assert } from '../../shared/core/assert';
import { isEmDashCollectionSlug } from '../../shared/properties/emdash';
import { emDashEntries } from './emdashProject';

export interface EmDashPageEntry {
  readonly params: Readonly<Record<string, string>>;
  readonly label: string;
}

const PAGE_BYTES_MAX = 1024 * 1024;
const PARAMS_MAX = 64;
// `getEmDashEntry('posts', slug)` and `getEmDashCollection("posts")`; an expression in place of the name is
// not followed, so a page that picks its collection at run time previews its pattern, as it did before.
const COLLECTION_CALL = /\bgetEmDash(?:Entry|Collection)\s*\(\s*(['"])([a-z][a-z0-9_]*)\1/;
const ROUTE_PARAM = /\[(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)\]/g;

/** The collection an EmDash page reads first, when its source names one outright. */
export function emDashCollectionOfPage(source: string): string | undefined {
  const name = COLLECTION_CALL.exec(source)?.[2];
  return name !== undefined && isEmDashCollectionSlug(name) ? name : undefined;
}

/** The one placeholder of a route (`/posts/[slug]`), or undefined for none or several: a second would have no entry field to fill it. */
export function emDashRouteParam(pattern: string): string | undefined {
  const names = [...pattern.matchAll(ROUTE_PARAM)].map((match) => match[1]).filter((name): name is string => name !== undefined);
  assert(names.length <= PARAMS_MAX, 'A route has a bounded number of placeholders');
  const [only] = names;
  return names.length === 1 ? only : undefined;
}

/** The entries a dynamic EmDash page can preview, newest first; empty when the page is not an EmDash page or has no local entries. */
export async function emDashPageEntries(root: string, pagePath: string, pattern: string): Promise<readonly EmDashPageEntry[]> {
  const param = emDashRouteParam(pattern);
  if (param === undefined) {
    return [];
  }
  let source: string;
  try {
    if (fs.statSync(pagePath).size > PAGE_BYTES_MAX) {
      return [];
    }
    source = fs.readFileSync(pagePath, 'utf8');
  } catch {
    return [];
  }
  const collection = emDashCollectionOfPage(source);
  if (collection === undefined) {
    return [];
  }
  const entries = await emDashEntries(root, collection);
  // A rest parameter's value may hold slashes in EmDash (`/docs/a/b`), which one entry slug never does.
  return entries.map((entry) => ({ params: { [param]: entry.slug }, label: entry.title }));
}
