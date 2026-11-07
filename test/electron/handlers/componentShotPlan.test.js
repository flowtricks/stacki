// Goal: the plan for the component photographs picks the right pages, the right call sites and the right
// first instance, and reads the anchors out of a real DOM.
// Methodology: page order from route lists; call sites from real page sources (a layout, a nested element,
// a condition); region assignment with first-instance, taken, thin and unwanted cases; the page script run in
// jsdom against a fixture whose boxes are stubbed (jsdom has no layout), including a `Section` wrapper and a
// component nested in another component's file; and each bad shape of what the page script might answer.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const {
  COLLECT_ANCHOR_REGIONS,
  assignShots,
  callSitesOf,
  COLLECT_EMPTY_ANCHORS,
  hiddenComponents,
  hideOutsideScript,
  parseAnchorPaths,
  parseLinks,
  pickDynamicPages,
  planShotPages,
  routeMatchesPattern,
  sameOriginPaths,
  orderShotPages,
  parseAnchorRegions,
  SHOW_FIXED,
  shotHeight,
  splitAnchorPath,
} = require('#dist/electron/handlers/componentShotPlan.js');
const { COMPONENT_SHOT_LIMITS } = require('#dist/shared/properties/componentShots.js');

const jsonNull = JSON.parse('null');
const resolve = (specifier) => (specifier.startsWith('../') ? '/p/src/' + specifier.slice(3) : undefined);

test('pages load home first, then by route; dynamic and non-astro pages are left out; the list is bounded', () => {
  const page = (route, extension = 'astro') => ({ route, path: `/p/src/pages${route === '/' ? '/index' : route}.${extension}` });
  const ordered = orderShotPages([page('/pricing'), page('/blog/[slug]'), page('/about'), page('/'), page('/feed', 'md'), page('/blog')]);
  assert.deepEqual(
    ordered.map((entry) => entry.route),
    ['/', '/about', '/blog', '/pricing'],
  );
  // Translations come after the site's own language, so `/en/` does not win the alphabet.
  const translated = orderShotPages([page('/en/about'), page('/pt-br'), page('/zoo'), page('/'), page('/en'), page('/engineering')]);
  assert.deepEqual(
    translated.map((entry) => entry.route),
    ['/', '/engineering', '/zoo', '/en', '/en/about', '/pt-br'],
  );
  const many = Array.from({ length: COMPONENT_SHOT_LIMITS.pagesMax + 10 }, (_, at) => page(`/p${String(at).padStart(3, '0')}`));
  const limited = orderShotPages([...many, page('/')]);
  assert.equal(limited.length, COMPONENT_SHOT_LIMITS.pagesMax);
  assert.equal(limited[0]?.route, '/', 'the home page survives the cut');
  assert.deepEqual(orderShotPages([]), []);
});

const pageSource = [
  '---',
  'import Layout from "../layouts/Layout.astro";',
  'import Hero from "../components/Hero.astro";',
  'import Faq from "../components/Faq.astro";',
  'import { thing } from "../lib/thing.ts";',
  '---',
  '<Layout title="x">',
  '  <Hero />',
  '  <div><Faq /></div>',
  '  {ok && (<Hero />)}',
  '</Layout>',
].join('\n');

test('call sites map each trail to the file its import names, through elements and conditions', () => {
  const sites = callSitesOf(pageSource, resolve);
  assert.deepEqual(
    [...sites.entries()],
    [
      ['0', '/p/src/layouts/Layout.astro'],
      ['0.0', '/p/src/components/Hero.astro'],
      ['0.1.0', '/p/src/components/Faq.astro'],
      ['0.2.0.0', '/p/src/components/Hero.astro'],
    ],
  );
});

test('call sites: an import that does not resolve, a plain element and an unparseable file give nothing', () => {
  assert.equal(callSitesOf('---\nimport Hero from "@/nowhere";\n---\n<Hero />', resolve).size, 0);
  assert.equal(callSitesOf('<div><span /></div>', resolve).size, 0);
  assert.equal(callSitesOf('', resolve).size, 0);
  assert.equal(callSitesOf('---\nimport A from "../a.astro";\n---\n<A><div></A>', resolve).size >= 0, true, 'a broken template does not throw');
});

test('anchor paths belong to the page for a bare trail and to a file for a namespaced one', () => {
  assert.deepEqual(splitAnchorPath('0.2.1', 'src/pages/index.astro'), { file: 'src/pages/index.astro', trail: '0.2.1' });
  assert.deepEqual(splitAnchorPath('src/components/Hero.astro|0.1', 'src/pages/index.astro'), { file: 'src/components/Hero.astro', trail: '0.1' });
});

const region = (path, top, height = 400) => ({ path, left: 0, top, width: 1440, height });
const sitesByFile = new Map([
  ['src/pages/index.astro', callSitesOf(pageSource, resolve)],
  ['src/components/Hero.astro', new Map([['0', '/p/src/components/Section.astro']])],
]);
const known = (file) => sitesByFile.get(file);
const everything = () => true;

test('the first instance in document order is the one photographed, and a wrapper inside a component is found by its namespaced anchor', () => {
  const regions = [region('0', 0, 3000), region('0.0', 0, 600), region('src/components/Hero.astro|0', 0, 600), region('0.1.0', 700), region('0.2.0.0', 1200)];
  const found = assignShots(regions, 'src/pages/index.astro', new Set(), known, (component) => !component.includes('/layouts/'));
  assert.deepEqual(
    found.map((entry) => [entry.component, entry.region.path, entry.region.top]),
    [
      ['/p/src/components/Hero.astro', '0.0', 0],
      ['/p/src/components/Section.astro', 'src/components/Hero.astro|0', 0],
      ['/p/src/components/Faq.astro', '0.1.0', 700],
    ],
    'the second Hero in the condition is not a new component',
  );
});

test('components taken on an earlier page, unwanted ones and regions too thin to show are passed over', () => {
  const regions = [region('0.0', 0, 600), region('0.1.0', 700, COMPONENT_SHOT_LIMITS.heightMin - 1), region('0.2.0.0', 1200)];
  const taken = new Set(['/p/src/components/Hero.astro']);
  assert.deepEqual(assignShots(regions, 'src/pages/index.astro', taken, known, everything), []);
  assert.deepEqual(
    assignShots([region('0.0', 0, 600)], 'src/pages/index.astro', new Set(), known, () => false),
    [],
  );
  assert.equal(assignShots([region('0.1.0', 700, COMPONENT_SHOT_LIMITS.heightMin)], 'src/pages/index.astro', new Set(), known, everything).length, 1);
  assert.deepEqual(assignShots([region('9.9', 0)], 'src/pages/index.astro', new Set(), known, everything), [], 'a trail with no call site');
  assert.deepEqual(assignShots([region('src/other.astro|0', 0)], 'src/pages/index.astro', new Set(), known, everything), [], 'a file that was not indexed');
});

test('the height of a photograph is the region, within the bounds', () => {
  assert.equal(shotHeight({ height: 500.2 }), 501);
  assert.equal(shotHeight({ height: 1 }), COMPONENT_SHOT_LIMITS.heightMin);
  assert.equal(shotHeight({ height: 99999 }), COMPONENT_SHOT_LIMITS.heightMax);
  assert.throws(() => shotHeight({ height: Infinity }), /has a height/);
});

// --- the page script, in a DOM ------------------------------------------------------------------

function pageWithMarkers() {
  const dom = new JSDOM(
    `<!doctype html><body>
      <!--avb-s:0--><main>
        <!--avb-s:0.0--><section id="hero"><div id="hero-inner"></div></section><!--avb-e:0.0-->
        <!--avb-s:0.1--><section id="faq-a"></section><section id="faq-b"></section><!--avb-e:0.1-->
        <!--avb-s:0.2--><section id="loop-1"></section><!--avb-e:0.2-->
        <!--avb-s:0.2--><section id="loop-2"></section><!--avb-e:0.2-->
        <!--avb-s:0.3--><section id="gone"></section><!--avb-e:0.3-->
        <!--avb-s:0.4--><section id="unclosed"></section>
        <!--avb-s:src/components/Hero.astro|0--><div id="wrapped" class="section"></div><!--avb-e:src/components/Hero.astro|0-->
      </main><!--avb-e:0-->
    </body>`,
    { runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const box = (id, left, top, width, height) => {
    const element = dom.window.document.getElementById(id);
    assert.ok(element, id);
    element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  };
  box('hero', 0, 0, 1440, 700);
  box('faq-a', 0, 700, 1440, 300);
  box('faq-b', 10, 1000, 1400, 200);
  box('loop-1', 0, 1200, 1440, 100);
  box('loop-2', 0, 1300, 1440, 100);
  box('gone', 0, 0, 0, 0);
  box('unclosed', 0, 1400, 1440, 100);
  box('wrapped', 0, 1500, 1440, 250);
  return dom;
}

test('the page script returns each closed pair with the union of its element boxes, first loop item only', () => {
  const dom = pageWithMarkers();
  const collect = dom.window.eval(`(${COLLECT_ANCHOR_REGIONS})`);
  const regions = parseAnchorRegions(collect(COMPONENT_SHOT_LIMITS.anchorsMax, COMPONENT_SHOT_LIMITS.siblingsMax));
  const byPath = new Map(regions.map((entry) => [entry.path, entry]));
  assert.deepEqual(
    [...byPath.keys()],
    ['0.0', '0.1', '0.2', 'src/components/Hero.astro|0'],
    'document order; a box that is empty, an unclosed pair and a repeated loop item are not regions',
  );
  assert.deepEqual(byPath.get('0.0'), { path: '0.0', left: 0, top: 0, width: 1440, height: 700 });
  assert.deepEqual(byPath.get('0.1'), { path: '0.1', left: 0, top: 700, width: 1440, height: 500 }, 'two siblings are one region');
  assert.equal(byPath.get('0.2')?.top, 1200, 'the first loop item');
  assert.equal(byPath.get('0.2')?.height, 100);
  assert.deepEqual(byPath.get('src/components/Hero.astro|0'), { path: 'src/components/Hero.astro|0', left: 0, top: 1500, width: 1440, height: 250 });
  dom.window.close();
});

test('the page script respects its bounds', () => {
  const dom = pageWithMarkers();
  const collect = dom.window.eval(`(${COLLECT_ANCHOR_REGIONS})`);
  assert.equal(
    parseAnchorRegions(collect(2, COMPONENT_SHOT_LIMITS.siblingsMax)).length,
    1,
    'stops reading anchors at the bound: the outer pair has no box, the second is the hero',
  );
  assert.equal(parseAnchorRegions(collect(COMPONENT_SHOT_LIMITS.anchorsMax, 1)).length, 0, 'a pair farther apart than the bound is not closed');
  dom.window.close();
});

test('the hide script hides fixed and sticky elements outside the region, and only those', () => {
  const dom = new JSDOM(
    `<!doctype html><body>
      <header id="bar" style="position: fixed"></header>
      <!--avb-s:0.0--><section id="in"><div id="pin" style="position: sticky"></div></section><!--avb-e:0.0-->
      <aside id="other" style="position: sticky"></aside><p id="plain"></p>
    </body>`,
    { runScripts: 'outside-only' },
  );
  const hidden = dom.window.eval(hideOutsideScript('0.0'));
  assert.equal(hidden, 2);
  const visibility = (id) => dom.window.document.getElementById(id)?.style.visibility;
  assert.equal(visibility('bar'), 'hidden');
  assert.equal(visibility('other'), 'hidden');
  assert.equal(visibility('pin'), '', 'inside the region stays');
  assert.equal(dom.window.document.getElementById('pin')?.style.position, 'static', 'and is unstuck, so it sits where it was measured');
  assert.equal(visibility('plain'), '');
  // A child that sets visibility: visible would show through, so opacity goes to 0 as well.
  assert.equal(dom.window.document.getElementById('bar')?.style.opacity, '0');
  // Putting them back restores each element's own inline style, and removes one it did not have.
  dom.window.eval(SHOW_FIXED);
  assert.equal(dom.window.document.getElementById('bar')?.getAttribute('style'), 'position: fixed');
  assert.equal(dom.window.document.querySelectorAll('[data-shot-hidden]').length, 0);
  dom.window.close();
});

test('a sticky or fixed ancestor of the region stays visible', () => {
  const dom = new JSDOM(
    `<!doctype html><body>
      <div id="wrap" style="position: sticky"><div id="outer" style="position: fixed"><!--avb-s:0.0--><section id="in"></section><!--avb-e:0.0--></div></div>
      <aside id="other" style="position: sticky"></aside>
    </body>`,
    { runScripts: 'outside-only' },
  );
  assert.equal(dom.window.eval(hideOutsideScript('0.0')), 1, 'only the element beside the region is hidden');
  const visibility = (id) => dom.window.document.getElementById(id)?.style.visibility;
  assert.equal(visibility('wrap'), '');
  assert.equal(visibility('outer'), '');
  assert.equal(visibility('other'), 'hidden');
  // Left sticky, the wrapper would stick below the top of the window once the page scrolls to the region.
  const position = (id) => dom.window.document.getElementById(id)?.style.position;
  assert.equal(position('wrap'), 'static', 'a sticky holder is unstuck');
  assert.equal(position('outer'), 'fixed', 'a fixed holder stays where it is');
  dom.window.eval(SHOW_FIXED);
  assert.equal(position('wrap'), 'sticky', 'putting back restores it');
  dom.window.close();
});

test('negative space: every wrong answer from the page script is refused', () => {
  const good = { path: '0', left: 0, top: 0, width: 10, height: 10 };
  assert.deepEqual(parseAnchorRegions([good]), [good]);
  const bad = [
    ['not a list', {}],
    ['null', jsonNull],
    ['entry not an object', [jsonNull]],
    ['path missing', [{ ...good, path: undefined }]],
    ['path empty', [{ ...good, path: '' }]],
    ['left a string', [{ ...good, left: '0' }]],
    ['top NaN', [{ ...good, top: NaN }]],
    ['width infinite', [{ ...good, width: Infinity }]],
    ['width zero', [{ ...good, width: 0 }]],
    ['height negative', [{ ...good, height: -1 }]],
    ['too many', Array.from({ length: COMPONENT_SHOT_LIMITS.anchorsMax + 1 }, () => good)],
  ];
  for (const [what, input] of bad) {
    assert.throws(() => parseAnchorRegions(input), Error, what);
  }
});

// --- dynamic routes -------------------------------------------------------------------------------

test('a route pattern serves what its parameters can take, and nothing else', () => {
  const yes = [
    ['/blog/[slug]', '/blog/hello'],
    ['/blog/[slug]', '/blog/hello/'],
    ['/blog/[...page]', '/blog'],
    ['/blog/[...page]', '/blog/2'],
    ['/blog/[...page]', '/blog/a/b/c'],
    ['/blog/kategorie/[kategorie]/[...page]', '/blog/kategorie/seo'],
    ['/blog/kategorie/[kategorie]/[...page]', '/blog/kategorie/seo/2'],
    ['/[lang]/about', '/en/about'],
    ['/[...all]', '/'],
  ];
  const no = [
    ['/blog/[slug]', '/blog'],
    ['/blog/[slug]', '/blog/a/b'],
    ['/blog/[slug]', '/news/hello'],
    ['/blog/[...page]', '/news'],
    ['/blog/kategorie/[kategorie]/[...page]', '/blog/kategorie'],
    ['/blog/kategorie/[kategorie]/[...page]', '/blog/tag/seo'],
    ['/[lang]/about', '/en/contact'],
    ['/blog/[slug', '/blog/hello'],
    ['/blog/[...x]/more', '/blog/a/more'],
    ['/blog', '/blog/hello'],
  ];
  for (const [pattern, route] of yes) {
    assert.equal(routeMatchesPattern(pattern, route), true, `${pattern} serves ${route}`);
  }
  for (const [pattern, route] of no) {
    assert.equal(routeMatchesPattern(pattern, route), false, `${pattern} does not serve ${route}`);
  }
});

test('links: same site only, without hash and query, and no files that are not pages', () => {
  const origin = 'http://127.0.0.1:4321';
  const found = sameOriginPaths(
    [
      'http://127.0.0.1:4321/blog/hello/?utm=1#top',
      'http://127.0.0.1:4321/blog/hello',
      'http://127.0.0.1:4321/',
      'http://127.0.0.1:4321/about.html',
      'http://127.0.0.1:4321/files/menu.pdf',
      'http://127.0.0.1:4321/img/logo.svg',
      'http://127.0.0.1:4321/rss.xml',
      'https://example.com/blog/x',
      'http://127.0.0.1:9999/blog/y',
      'mailto:a@b.de',
      'javascript:void(0)',
      'not a url',
    ],
    origin,
  );
  assert.deepEqual(found, ['/blog/hello', '/', '/about.html']);
  assert.deepEqual(sameOriginPaths([], origin), []);
  assert.throws(
    () =>
      sameOriginPaths(
        Array.from({ length: COMPONENT_SHOT_LIMITS.linksMax + 1 }, () => origin),
        origin,
      ),
    /bound/,
  );
});

const dynamic = (route, path) => ({ route, path: `/p/src/pages${path}` });
const blogSlug = dynamic('/blog/[slug]', '/blog/[slug].astro');
const blogRest = dynamic('/blog/[...page]', '/blog/[...page].astro');
const category = dynamic('/blog/kategorie/[kategorie]/[...page]', '/blog/kategorie/[kategorie]/[...page].astro');
const enSlug = dynamic('/en/blog/[slug]', '/en/blog/[slug].astro');
const files = [category, enSlug, blogRest, blogSlug];

test('each dynamic file gets at most one address, the first link its route serves best', () => {
  const links = ['/', '/blog', '/blog/first-post', '/blog/second-post', '/blog/kategorie/seo', '/en/blog/hello', '/about'];
  const picked = pickDynamicPages(files, links, new Set(['/', '/about']), 10);
  assert.deepEqual(
    picked.map((page) => [page.route, page.path.split('/pages')[1]]),
    [
      ['/blog', '/blog/[...page].astro'],
      ['/blog/first-post', '/blog/[slug].astro'],
      ['/blog/kategorie/seo', '/blog/kategorie/[kategorie]/[...page].astro'],
      ['/en/blog/hello', '/en/blog/[slug].astro'],
    ],
    'a plain parameter beats a rest parameter, and translations come last',
  );
});

test('addresses of fixed pages are not dynamic, the budget caps the list, and nothing matches nothing', () => {
  assert.deepEqual(pickDynamicPages(files, ['/blog'], new Set(['/blog']), 10), []);
  assert.equal(pickDynamicPages(files, ['/blog/a', '/blog/kategorie/x', '/en/blog/y'], new Set(), 2).length, 2);
  assert.deepEqual(pickDynamicPages(files, ['/blog/a'], new Set(), 0), []);
  assert.deepEqual(pickDynamicPages(files, ['/contact', '/'], new Set(), 5), []);
  assert.deepEqual(pickDynamicPages([], ['/blog/a'], new Set(), 5), []);
  assert.throws(() => pickDynamicPages(files, [], new Set(), -1), /budget/);
});

test('the plan splits pages with an address from pages behind a parameter', () => {
  const plan = planShotPages([
    { route: '/', path: '/p/src/pages/index.astro' },
    blogSlug,
    { route: '/en/about', path: '/p/src/pages/en/about.astro' },
    blogRest,
  ]);
  assert.deepEqual(
    plan.pages.map((page) => page.route),
    ['/', '/en/about'],
  );
  assert.deepEqual(
    plan.dynamicPages.map((page) => page.route),
    ['/blog/[slug]', '/blog/[...page]'],
  );
});

// --- hidden at the desktop width -------------------------------------------------------------------

test('the empty-anchor script lists closed pairs that take no room, and only those', () => {
  const dom = pageWithMarkers();
  const collect = dom.window.eval(`(${COLLECT_EMPTY_ANCHORS})`);
  assert.deepEqual(parseAnchorPaths(collect(COMPONENT_SHOT_LIMITS.anchorsMax, COMPONENT_SHOT_LIMITS.siblingsMax)), ['0', '0.3']);
  dom.window.close();
});

test('components worth a narrower look: on the page, without room, without a photograph, and wanted', () => {
  const sites = new Map([
    [
      'src/pages/privacy.astro',
      new Map([
        ['0', '/p/src/components/LegalToc.astro'],
        ['1', '/p/src/components/Body.astro'],
        ['2', '/p/src/components/Faq.astro'],
        ['3', '/p/src/layouts/Layout.astro'],
      ]),
    ],
  ]);
  const hidden = hiddenComponents(
    ['0', '2', '3', '9'],
    'src/pages/privacy.astro',
    new Set(['/p/src/components/Faq.astro']),
    (file) => sites.get(file),
    (component) => component.includes('/components/'),
  );
  assert.deepEqual([...hidden], ['/p/src/components/LegalToc.astro']);
  assert.equal(
    hiddenComponents(
      [],
      'src/pages/privacy.astro',
      new Set(),
      (file) => sites.get(file),
      () => true,
    ).size,
    0,
  );
});

test('negative space: the strings the page answers are checked', () => {
  assert.deepEqual(parseLinks(['http://a/']), ['http://a/']);
  for (const input of [jsonNull, {}, [1], [jsonNull], Array.from({ length: COMPONENT_SHOT_LIMITS.linksMax + 1 }, () => 'x')]) {
    assert.throws(() => parseLinks(input), Error);
  }
  for (const input of [jsonNull, 'x', [2], Array.from({ length: COMPONENT_SHOT_LIMITS.anchorsMax + 1 }, () => 'x')]) {
    assert.throws(() => parseAnchorPaths(input), Error);
  }
});
