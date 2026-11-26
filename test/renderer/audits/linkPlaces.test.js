// Goal: a broken link is listed where it must be fixed, even when the component that draws it
// spreads the href onto a dynamic tag (`<Tag {...tagAttrs}>`) and the page's markers were
// stripped from slot content. Each usage that passes the value is its own row at that usage,
// on its page or in its component, with the pages that show it; a value from data points at
// the instance that sets it; the 404 page is checked although it answers 404. An ignore saved
// while the findings were listed on the component still hides them, and showing one again
// keeps the others hidden. The panel's pure helpers name the places and tell like rows apart.
// Method: a fixture of real .astro sources parsed with the editor's parser, the served HTML
// written by hand as the dev server writes slot content (paths in `data-avb-p` only, no
// comment markers), read by the panel's own renderedDom.ts and run through the real runner
// with fake IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/link-places.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { runAudit } from './src/features/audits/auditRunner';",
      "export { parsedTree } from './src/features/audits/renderedDom';",
      "export * from './src/features/audits/auditPlaces';",
      "export { parsePageResult } from './shared/page/pageNode';",
      "export { EMPTY_AUDIT_IGNORES, withIgnore } from './shared/properties/auditIgnores';",
      "export { ignoreReasons, ignoredGroups } from './shared/properties/auditIgnoreList';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
global.window = dom.window;
global.DOMParser = dom.window.DOMParser;
for (const name of ['document', 'Element', 'Node']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
const audits = require(output);
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const readOf = (source) => {
  const parsed = audits.parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, 'the fixture parses');
  return { editable: true, nodes: parsed.model.nodes, imports: parsed.model.imports, source };
};

const BUTTON = `---
const { href, element = "link", class: className, ...rest } = Astro.props;
const isLink = element === "link";
const Tag = isLink ? "a" : "button";
const tagAttrs = isLink ? { href: href || "#" } : {};
---
{isLink && (<Tag class:list={["button_wrap", className]} {...tagAttrs} {...rest}><slot /></Tag>)}
`;
const FILES = {
  '/site/src/components/Button.astro': BUTTON,
  '/site/src/components/Footer.astro':
    "---\nimport Button from './Button.astro';\nconst links = [{ url: '/from-data' }];\n---\n" +
    '<footer><Button href="/contact">Contact us</Button><div>{links.map((item) => <Button href={item.url}>Data</Button>)}</div></footer>',
  '/site/src/pages/index.astro':
    '---\nimport Footer from \'../components/Footer.astro\';\n---\n<html lang="en"><head><title>Home</title></head><body><Footer /></body></html>',
  '/site/src/pages/work.astro':
    "---\nimport Button from '../components/Button.astro';\nimport Footer from '../components/Footer.astro';\n---\n" +
    '<html lang="en"><head><title>Work</title></head><body><Button href="/about">Get started</Button><Button href="/about">Get started</Button><Footer /></body></html>',
  '/site/src/pages/404.astro':
    '---\nimport Footer from \'../components/Footer.astro\';\n---\n<html lang="en"><head><title>Missing</title></head><body><Footer /></body></html>',
};

const component = (name) => ({ path: `/site/src/components/${name}.astro`, file: `src/components/${name}.astro`, name, folder: '', instances: 1 });
const page = (name, route) => ({ path: `/site/src/pages/${name}.astro`, name: `${name}.astro`, route, title: name });
const scan = {
  pages: [page('index', '/'), page('work', '/work'), page('404', '/404')],
  pageFolders: [],
  layouts: [],
  components: [component('Button'), component('Footer')],
};

// As served: slot content keeps only the paths on its elements, the drawing node first, then who passed it.
const link = (href, caller) => `<a class="button_wrap" href="${href}" data-avb-p="src/components/Button.astro|0.0.0 ${caller}">x</a>`;
const FOOTER = `<footer>${link('/contact', 'src/components/Footer.astro|0.0')}<div>${link('/from-data', 'src/components/Footer.astro|0.1.0.0')}</div></footer>`;
const html = (parts) => `<html lang="en"><head><title>T</title></head><body>${parts}</body></html>`;
const SERVED = {
  '/': { status: 200, html: html(FOOTER) },
  '/work': { status: 200, html: html(`${link('/about', '0.1.0')}${link('/about', '0.1.1')}${FOOTER}`) },
  '/404': { status: 404, html: html(FOOTER) },
};

const run = () =>
  audits.runAudit(
    { settings: audits.EMPTY_AUDIT_IGNORES, scope: 'site', projectPath: '/site', scan, open: undefined },
    {
      readFile: async (file) => readOf(FILES[file]),
      readText: async () => undefined,
      listAssets: async () => ({ ok: true, value: [] }),
      imageSize: async () => undefined,
      renderPage: async (route) => (SERVED[route] === undefined ? { ok: true, status: 404, html: '' } : { ok: true, ...SERVED[route] }),
      tree: async (source, file) => audits.parsedTree(source, file),
      variables: async () => new Map(),
      styleFiles: async () => [],
      readStyle: async () => undefined,
    },
  );
const brokenIn = (report) => report.findings.filter((finding) => finding.check === 'link-broken');
const at = (finding) => `${finding.file} ${finding.element.path.join('.')} ${finding.element.tag} ${finding.prop} ${finding.detail}`;

test('each broken link is listed at the usage that passes it, through a dynamic tag', async () => {
  const found = brokenIn(await run());
  const places = found.map(at).sort();
  assert.equal(found.length, 4, places.join('\n'));
  assert.ok(places[0].startsWith('src/components/Footer.astro 0.0 Button href href="/contact"'), places[0]);
  assert.ok(places[1].includes('Footer.astro 0.1.0.0 Button href href="/from-data"'), 'a value from data: the instance that sets it');
  assert.ok(places[2].startsWith('src/pages/work.astro 0.1.0 Button href href="/about"'), places[2]);
  assert.ok(places[3].startsWith('src/pages/work.astro 0.1.1 Button href href="/about"'), places[3]);
  assert.ok(!found.some((finding) => finding.file.endsWith('Button.astro')), 'nothing is left on the component that only draws it');
});

test('a component group names every page that shows the link, the 404 page included', async () => {
  const report = await run();
  const contact = brokenIn(report).find((finding) => finding.detail === 'href="/contact"');
  assert.deepEqual(contact.routes, ['/', '/404', '/work']);
  assert.deepEqual(report.usage.get('src/components/Footer.astro'), ['/', '/404', '/work']);
  assert.deepEqual(report.usage.get('src/pages/work.astro'), ['/work']);
  assert.deepEqual(audits.routesUsing('src/components/Footer.astro', [contact], report.usage), ['/', '/404', '/work']);
  assert.deepEqual(audits.routesUsing('src/components/Footer.astro', [{}], report.usage), ['/', '/404', '/work'], 'else the markup says');
});

test('an ignore saved on the component still holds, and showing one again keeps the others hidden', async () => {
  const found = brokenIn(await run());
  const about = found.filter((finding) => finding.detail === 'href="/about"');
  const old = 'link-broken|src/components/Button.astro|0.0.0|href="/about"';
  assert.deepEqual(
    about.map((finding) => finding.formerIds),
    [[old], [old]],
  );
  const ignored = audits.withIgnore(audits.EMPTY_AUDIT_IGNORES, { id: old, reason: 'later' });
  const reasons = audits.ignoreReasons(found, ignored);
  assert.deepEqual([...reasons.keys()].sort(), about.map((finding) => finding.id).sort());
  const [group] = audits.ignoredGroups(found, ignored);
  assert.equal(group.file, 'src/components/Button.astro', 'the entry stays where the person made it');
  assert.equal(group.findings[0].live, true);
  const page = { ignored: [], ignoredPages: [{ file: 'src/components/Button.astro', reason: undefined }] };
  assert.equal(audits.ignoreReasons(about, page).size, 2, 'a whole-file ignore of the component holds too');
  const shown = audits.ignoresWithout(ignored, about[0], found);
  assert.deepEqual(shown.ignored, [{ id: about[1].id, reason: 'later' }]);
  assert.deepEqual([...audits.ignoreReasons(found, shown).keys()], [about[1].id]);
});

test('rows name their place: host page, like rows, words and the kind of broken link', () => {
  assert.equal(audits.hostRoute(['/404', '/work'], '/'), '/work', 'an ordinary page before the 404 page');
  assert.equal(audits.hostRoute(['/', '/work'], '/work'), undefined, 'the shown page already uses it');
  assert.equal(audits.hostRoute([], '/'), undefined);
  assert.equal(audits.hostRoute(['/blog/[slug]'], '/'), undefined, 'a pattern is not a page to show');
  const rows = ['a', 'b', 'a'].map((text) => ({ text }));
  const numbers = audits.copyNumbers(rows, (row) => row.text);
  assert.deepEqual(
    rows.map((row) => numbers.get(row)),
    [{ index: 1, count: 2 }, undefined, { index: 2, count: 2 }],
  );
  const [button] = readOf('<Button href="/x">\n  <span>  Get\n started </span>\n</Button>').nodes;
  assert.equal(audits.nodeWords(button), 'Get started');
  assert.deepEqual(audits.namedRoutes(['/', '/a', '/b']), { named: '/, /a', more: 1 });
  assert.equal(audits.placeKind('src/pages/work.astro', undefined), 'page');
  assert.equal(audits.placeKind('src/layouts/Base.astro', 'layout'), 'layout');
  assert.equal(audits.placeKind('src/styles/a.css', 'site'), 'file');
  const broken = (detail, missing) => audits.brokenLink({ check: 'link-broken', detail }, missing);
  assert.deepEqual(broken('href="/about"', '/about'), { url: '/about', missing: 'page' });
  assert.deepEqual(broken('href="/work#team"', undefined), { url: '/work#team', missing: 'section' });
  assert.equal(audits.brokenLink({ check: 'img-alt', detail: 'src="/a.png"' }, undefined), undefined);
});
