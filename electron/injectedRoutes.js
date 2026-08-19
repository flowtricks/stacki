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

const fs = require('fs');
const path = require('path');

/** The package an entrypoint belongs to, when it is inside one. */
function packageOf(entrypoint) {
  const m = String(entrypoint || '').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return m ? m[1] : null;
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
function readInjectedRoutes(projectPath) {
  let routes;
  try {
    routes = JSON.parse(
      fs.readFileSync(path.join(projectPath, 'node_modules', '.avb', 'routes.json'), 'utf8')
    );
  } catch {
    return [];
  }
  if (!Array.isArray(routes)) return [];
  return routes
    .filter((r) => r && typeof r.pattern === 'string' && !r.pattern.startsWith('/__avb'))
    .filter((r) => r.origin && r.origin !== 'project' && r.origin !== 'internal')
    .map((r) => ({
      route: r.pattern,
      entrypoint: r.entrypoint || null,
      from: packageOf(r.entrypoint),
      params: Array.isArray(r.params) ? r.params : [],
    }));
}

module.exports = { readInjectedRoutes, packageOf };
