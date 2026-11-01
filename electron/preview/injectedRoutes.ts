// Pages that are not files in this project.
//
// A site's routes usually are its files: `src/pages/about.astro` is `/about`,
// and the editor opens the one to change the other. They don't have to be. An
// Astro integration can call injectRoute() for every page it ships, and then a
// site consists of a config file and nothing else — the pages live inside a
// dependency (github.com/flowtricks/stacki/issues/7).
//
// Nothing on disk names those routes, so the dev server is asked instead: as
// Astro resolves its routes it hands the list to integrations, and the preview
// config writes it beside the other things it reports. This reads that list.
//
// Preview only, deliberately. Their source is in node_modules, where an edit
// is undone by the next install and renaming or deleting is not the editor's
// business — so these never join the page list the editor writes through.

import fs from 'fs';
import path from 'path';

import { toRecord, toArray } from '../../shared/core/record';
import { packageOf } from '../lib/installedPackages';

export interface InjectedRoute {
  readonly route: string;
  readonly entrypoint: string | undefined;
  readonly from: string | undefined;
  readonly params: readonly unknown[];
}

/**
 * Routes this project serves that it has no file for.
 *
 * `origin` is Astro's: 'project' is a file under src/pages (the editor already
 * knows those), 'internal' is Astro's own (a 404 page and friends), and what's
 * left came from an integration. An unreadable or missing list means none —
 * no server has run yet, or this Astro is too old to report them, and either
 * way the app carries on with the pages it can see.
 */
function readInjectedRoutes(projectPath: string): InjectedRoute[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(projectPath, 'node_modules', '.avb', 'routes.json'), 'utf8'));
  } catch {
    return [];
  }
  const routes = toArray(raw);
  if (!routes) {
    return [];
  }
  const injected: InjectedRoute[] = [];
  for (const route of routes) {
    const record = toRecord(route);
    const pattern = record?.['pattern'];
    if (typeof pattern !== 'string' || pattern.startsWith('/__avb')) {
      continue;
    }
    const origin = record?.['origin'];
    if (!origin || origin === 'project' || origin === 'internal') {
      continue;
    }
    const entrypoint = record?.['entrypoint'];
    const params = record?.['params'];
    injected.push({
      route: pattern,
      // Astro writes a string here or omits it; anything else is not a route
      // entrypoint this editor can open, so the boundary drops it.
      entrypoint: typeof entrypoint === 'string' ? entrypoint : undefined,
      from: packageOf(entrypoint),
      params: toArray(params) ?? [],
    });
  }
  return injected;
}

export { readInjectedRoutes };
