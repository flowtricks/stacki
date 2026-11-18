// Goal: a link followed in the canvas's interact mode opens the page the frame landed
// on, at the entry it landed on when that page is dynamic. Before, a card linking to
// its project (`/projects/p1` of `/projects/[slug]`) matched no page by its exact
// route, so the editor reloaded the page it had open: the project showed for a moment
// under "Loading page…" and the grid came back.
// Method: canvasLandingFor and dynamicEntryIndexOf are the pure rules followCanvasRoute
// (src/app/shell/AppPanes.tsx) applies; each is checked on literal page lists for the
// cases a site has (an exact page, a template, a rest template, nothing), on the
// trailing-slash and query forms a frame reports, and on the inputs they refuse.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { canvasLandingFor, dynamicEntryIndexOf } = load('src/app/model/previewPage.ts');

const HOME = { route: '/', path: 'src/pages/index.astro' };
const ABOUT = { route: '/about', path: 'src/pages/about.astro' };
const PROJECT = { route: '/projects/[slug]', path: 'src/pages/projects/[slug].astro' };
const PROJECTS_INDEX = { route: '/projects', path: 'src/pages/projects/index.astro' };
const DOCS = { route: '/docs/[...rest]', path: 'src/pages/docs/[...rest].astro' };
const GUIDE_ENTRY = { route: '/docs/[slug]', path: 'src/pages/docs/[slug].astro' };
const PAGES = [HOME, ABOUT, PROJECT, PROJECTS_INDEX, DOCS, GUIDE_ENTRY];

// A page with a route of its own is opened as it is.
assert.equal(canvasLandingFor(PAGES, '/about/').page, ABOUT, 'an exact page is found with a trailing slash');
assert.equal(canvasLandingFor(PAGES, '/about/').entry, undefined, 'an exact page has no entry');
assert.equal(canvasLandingFor(PAGES, '/projects').page, PROJECTS_INDEX, 'an exact page wins over a template');
assert.equal(canvasLandingFor(PAGES, '/').page, HOME, 'the home page is found');

// A template is opened at the entry the frame landed on.
const landed = canvasLandingFor(PAGES, '/projects/p1/?from=grid');
assert.equal(landed.page, PROJECT, 'a project entry opens its template');
assert.equal(landed.entry, '/projects/p1', 'the entry is the path, without its slash or query');
assert.equal(canvasLandingFor(PAGES, '/docs/intro').page, GUIDE_ENTRY, 'a template without a rest parameter wins');
assert.equal(canvasLandingFor(PAGES, '/docs/guide/install').page, DOCS, 'a rest template takes deeper paths');
assert.equal(canvasLandingFor(PAGES, '/docs/guide/install').entry, '/docs/guide/install', 'a rest entry keeps every segment');

// Nothing the site has: the canvas goes back to the page the editor has open.
assert.equal(canvasLandingFor(PAGES, '/projects/p1/photos'), undefined, 'a deeper path fits no single-segment template');
assert.equal(canvasLandingFor(PAGES, '/api/feed.json'), undefined, 'an unknown path has no page');
assert.equal(canvasLandingFor([], '/projects/p1'), undefined, 'no pages, no landing');

// The entry the canvas shows, found among the template's entries by its route.
const ENTRIES = [{ route: '/projects/p0' }, { route: '/projects/p1/' }, { route: '/projects/p2' }];
assert.equal(dynamicEntryIndexOf(ENTRIES, '/projects/p1'), 1, 'an entry is found whatever its trailing slash');
assert.equal(dynamicEntryIndexOf(ENTRIES, '/projects/p2/'), 2, 'a landing with a slash finds its entry');
assert.equal(dynamicEntryIndexOf(ENTRIES, '/projects/p9'), undefined, 'an entry the list lacks is not guessed');
assert.equal(dynamicEntryIndexOf([], '/projects/p1'), undefined, 'no entries, no index');
assert.equal(dynamicEntryIndexOf([{ route: 'projects/p1' }], '/projects/p1'), undefined, 'an entry without a leading slash is no site path');
assert.throws(() => dynamicEntryIndexOf(ENTRIES, 'projects/p1'), /An entry is found by its site path/);
assert.throws(() => canvasLandingFor(PAGES, 'projects/p1'), /A preview frame reports a site path/);
