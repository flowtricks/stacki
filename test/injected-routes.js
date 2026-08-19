// Pages that aren't files here.
//
//   node test/injected-routes.js
//
// A site can get all of its routes from an integration: a shared library calls
// injectRoute() for every page, and the consuming project has no src/pages at
// all (github.com/flowtricks/stacki/issues/7). Page discovery globs the
// filesystem, so such a project reads as empty — and, with nothing selected,
// the canvas used to report the dev server as offline while it was serving
// those very pages.
//
// Astro hands its resolved route list to integrations, and the preview config
// writes it out; these check the reading end: which routes are the project's
// own, which came from a package, and that a list the app cannot get (no
// server yet, or an Astro without the hook) is an empty list rather than an
// error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// What Astro reports for the shape in the issue: a site with no pages of its
// own, every route injected by @fivedogs/presencia-core, plus Astro's own
// internals and Stacki's preview endpoints.
const ASTRO_ROUTES = [
  { pattern: '/', origin: 'external', entrypoint: 'node_modules/@fivedogs/presencia-core/src/paginas/index.astro', params: [] },
  { pattern: '/contacto', origin: 'external', entrypoint: 'node_modules/@fivedogs/presencia-core/src/paginas/contacto.astro', params: [] },
  { pattern: '/blog/[...id]', origin: 'external', entrypoint: 'node_modules/@fivedogs/presencia-core/src/paginas/blog/[...id].astro', params: ['id'] },
  { pattern: '/404', origin: 'internal', entrypoint: 'astro/404', params: [] },
  { pattern: '/__avb/paths', origin: 'external', entrypoint: '/tmp/.avb/paths.js', params: [] },
];

const { readInjectedRoutes, packageOf } = require('../electron/injectedRoutes.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-routes-'));
  const avbDir = path.join(dir, 'node_modules', '.avb');
  fs.mkdirSync(avbDir, { recursive: true });

  // Everything Astro reported, Stacki's own preview endpoints included — the
  // reader drops those, so the fixture keeps them to prove it.
  fs.writeFileSync(path.join(avbDir, 'routes.json'), JSON.stringify(ASTRO_ROUTES));

  const read = readInjectedRoutes;

  {
    const routes = read(dir);
    check('the injected pages are found', routes.length === 3, `${routes.length} routes`);
    check('and are the ones the library ships', routes.map((r) => r.route).join(',') === '/,/contacto,/blog/[...id]', routes.map((r) => r.route).join(','));
    check("Astro's own internals are left out", !routes.some((r) => r.route === '/404'), JSON.stringify(routes.map((r) => r.route)));
    check("and so are Stacki's own endpoints", !routes.some((r) => r.route.startsWith('/__avb')));
    check(
      'each says which package it came from',
      routes.every((r) => r.from === '@fivedogs/presencia-core'),
      JSON.stringify(routes.map((r) => r.from))
    );
    check('a dynamic one keeps its params', routes[2].params.join(',') === 'id', JSON.stringify(routes[2].params));
  }

  {
    // A project's own pages are files the editor already knows about, and must
    // not be listed twice.
    fs.writeFileSync(
      path.join(avbDir, 'routes.json'),
      JSON.stringify([
        { pattern: '/', origin: 'project', entrypoint: 'src/pages/index.astro', params: [] },
        { pattern: '/from-a-package', origin: 'external', entrypoint: 'node_modules/thing/src/p.astro', params: [] },
      ])
    );
    const routes = read(dir);
    check('a page of your own is not listed as injected', routes.length === 1 && routes[0].route === '/from-a-package', JSON.stringify(routes));
    check('and the package name survives a scoped-less path', routes[0].from === 'thing', routes[0].from);
  }

  {
    // No server has run yet, or an Astro too old for the hook: no list, and the
    // app carries on with whatever it can see on disk.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-routes-none-'));
    check('a project with no list reads as none', read(empty).length === 0);
    fs.writeFileSync(path.join(avbDir, 'routes.json'), 'not json');
    check('and so does an unreadable one', read(dir).length === 0);
  }

  {
    // The package name is what the panel groups these under.
    check('a scoped package is named in full', packageOf('node_modules/@fivedogs/presencia-core/src/paginas/x.astro') === '@fivedogs/presencia-core');
    check('an unscoped one too', packageOf('node_modules/presencia/src/x.astro') === 'presencia');
    check('and a path outside a package names none', packageOf('/tmp/.avb/paths.js') === null);
  }

  if (failures.length) {
    console.error(`injected-routes: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`injected-routes: ${checked} passed  [issue #7 shape]`);
})();
