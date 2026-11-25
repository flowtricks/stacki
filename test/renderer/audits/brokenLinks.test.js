// Goal: the Broken link audit sees every link a page ends up rendering, from
// whoever wrote it, and reports each where it is written. A prop href on a
// Button instance is one finding per instance, at that instance with its prop;
// a link Card passes on to its Button is Card's `link` prop on the page; a link
// hard-coded in Footer's own markup is one finding with the number of instances
// that render it; a fragment is judged against the ids its page renders; an
// href an expression computes is judged by its rendered value; a path the dev
// server serves after all (an endpoint) is not broken; valid links, other
// origins and mailto: are never findings. Offline, the static instance pass
// still finds the prop links. The panel offers "Create page" only for a path no
// page has, and "Change link" only where a literal is written.
// Method: a fixture project of real .astro sources parsed with the editor's
// parser, the dev server's HTML written by hand with the `avb-s` / `avb-e`
// markers the marked preview puts around every node, parsed by the panel's own
// renderedDom.ts, and the real runner driven with fake IO; then the panel's
// pure helpers on the findings it made.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/broken-links.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { runAudit, configBase } from './src/features/audits/auditRunner';",
      "export { parsedTree } from './src/features/audits/renderedDom';",
      "export { missingRoute } from './src/features/audits/AuditsPanel';",
      "export { relinkTarget, linkFix } from './shared/page/auditRepairs';",
      "export { parsePageResult } from './shared/page/pageNode';",
      "export { EMPTY_AUDIT_IGNORES } from './shared/properties/auditIgnores';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.DOMParser = dom.window.DOMParser;
// The panel module loads React DOM, which reads the document at load time.
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
const links = require(output);
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const readOf = (source) => {
  const parsed = links.parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, 'the fixture parses');
  return { editable: true, nodes: parsed.model.nodes, imports: parsed.model.imports, source };
};

const IMPORTS = [
  "import Button from '../components/Button.astro';",
  "import Card from '../components/Card.astro';",
  "import Footer from '../components/Footer.astro';",
].join('\n');
// index.astro's body children, by path: 0 Button(/abuot), 1 Button(/about), 2 Card(/nope), 3 Footer,
// 4 #missing, 5 a computed valid href, 6 a computed broken href, 7 /about#team, 8 /about#intro, 9 mailto, 10 outside.
const FILES = {
  '/site/src/pages/index.astro':
    `---\n${IMPORTS}\nconst slug = 'hello';\n---\n<html lang="en"><head><title>Home</title></head><body>` +
    '<Button href="/abuot">One</Button><Button href="/about">Two</Button><Card link="/nope" /><Footer />' +
    '<a href="#missing">Jump</a><a href={`/blog/${slug}`}>Post</a><a href={`/posts/${slug}`}>Old post</a>' +
    '<a href="/about#team">Team</a><a href="/about#intro">Intro</a><a href="mailto:hi@acme.example">Mail</a><a href="https://example.com/gone">Out</a>' +
    '</body></html>',
  '/site/src/pages/about.astro': `---\nimport Footer from '../components/Footer.astro';\n---\n<html lang="en"><head><title>About</title></head><body><h1 id="intro">About</h1><Footer /></body></html>`,
  '/site/src/pages/blog/[slug].astro': '<html lang="en"><head><title>Post</title></head><body><h1>Post</h1></body></html>',
  '/site/src/components/Button.astro': '---\nconst { href } = Astro.props;\n---\n<a href={href}><slot /></a>',
  '/site/src/components/Card.astro':
    "---\nimport Button from './Button.astro';\nconst { link } = Astro.props;\n---\n<div><Button href={link}>More</Button></div>",
  '/site/src/components/Footer.astro': '<footer><a href="/gone">Gone</a><a href="/rss.xml">RSS</a></footer>',
};
const component = (name, instances) => ({ path: `/site/src/components/${name}.astro`, file: `src/components/${name}.astro`, name, folder: '', instances });
const scan = {
  pages: [
    { path: '/site/src/pages/index.astro', name: 'index.astro', route: '/', title: 'Home' },
    { path: '/site/src/pages/about.astro', name: 'about.astro', route: '/about', title: 'About' },
    { path: '/site/src/pages/blog/[slug].astro', name: '[slug].astro', route: '/blog/[slug]', title: 'Post' },
  ],
  pageFolders: [],
  layouts: [],
  components: [component('Button', 2), component('Card', 1), component('Footer', 2)],
  astroConfig: 'astro.config.mjs',
};

// The marked preview: every node between avb-s/avb-e comments, a component's own nodes namespaced by its file.
const marked = (id, html) => `<!--avb-s:${id}-->${html}<!--avb-e:${id}-->`;
const BUTTON = (label, href) => marked('src/components/Button.astro|0', `<a href="${href}">${label}</a>`);
const FOOTER = marked(
  'src/components/Footer.astro|0',
  `<footer>${marked('src/components/Footer.astro|0.0', '<a href="/gone">Gone</a>')}${marked('src/components/Footer.astro|0.1', '<a href="/rss.xml">RSS</a>')}</footer>`,
);
const CARD = marked('src/components/Card.astro|0', `<div>${marked('src/components/Card.astro|0.0', BUTTON('More', '/nope'))}</div>`);
const body = (parts) => parts.map((html, index) => marked(`0.1.${index}`, html)).join('');
const RENDERED = {
  '/': `<html lang="en"><head><title>Home</title></head><body>${body([
    BUTTON('One', '/abuot'),
    BUTTON('Two', '/about'),
    CARD,
    FOOTER,
    '<a href="#missing">Jump</a>',
    '<a href="/blog/hello">Post</a>',
    '<a href="/posts/hello">Old post</a>',
    '<a href="/about#team">Team</a>',
    '<a href="/about#intro">Intro</a>',
    '<a href="mailto:hi@acme.example">Mail</a>',
    '<a href="https://example.com/gone">Out</a>',
  ])}</body></html>`,
  '/about': `<html lang="en"><head><title>About</title></head><body>${body(['<h1 id="intro">About</h1>', FOOTER])}</body></html>`,
  // An endpoint (src/pages/rss.xml.ts) the scan does not list as a page: the dev server serves it.
  '/rss.xml': '<?xml version="1.0"?><rss></rss>',
};
const asked = [];
const io = (over = {}) => ({
  readFile: async (file) => readOf(FILES[file]),
  readText: async (rel) => (rel === 'astro.config.mjs' ? 'export default {}' : undefined),
  listAssets: async () => ({ ok: true, value: [] }),
  imageSize: async () => undefined,
  renderPage: async (route) => {
    asked.push(route);
    return RENDERED[route] === undefined ? { ok: true, status: 404, html: '' } : { ok: true, status: 200, html: RENDERED[route] };
  },
  tree: async (html, file) => links.parsedTree(html, file),
  variables: async () => new Map(),
  styleFiles: async () => [],
  readStyle: async () => undefined,
  ...over,
});
const run = (over) => links.runAudit({ settings: links.EMPTY_AUDIT_IGNORES, scope: 'site', projectPath: '/site', scan, open: undefined }, io(over));
const broken = (report) =>
  report.findings
    .filter((finding) => finding.check === 'link-broken')
    .map((finding) => ({
      file: finding.file,
      path: finding.element?.path,
      tag: finding.element?.tag,
      prop: finding.prop,
      detail: finding.detail,
      ...(finding.routes === undefined ? {} : { routes: finding.routes }),
      ...(finding.measure === undefined ? {} : { measure: finding.measure }),
    }))
    .sort((left, right) => `${left.file}${left.path}`.localeCompare(`${right.file}${right.path}`));

test('every link a page renders is judged and reported where it is written', async () => {
  asked.length = 0;
  const report = await run();
  assert.deepEqual(broken(report), [
    { file: 'src/components/Footer.astro', path: [0, 0], tag: 'a', prop: undefined, detail: 'href="/gone"', routes: ['/', '/about'], measure: '2 instances' },
    { file: 'src/pages/index.astro', path: [0, 1, 0], tag: 'Button', prop: 'href', detail: 'href="/abuot"' },
    { file: 'src/pages/index.astro', path: [0, 1, 2], tag: 'Card', prop: 'link', detail: 'href="/nope"' },
    { file: 'src/pages/index.astro', path: [0, 1, 4], tag: 'a', prop: undefined, detail: 'href="#missing"' },
    { file: 'src/pages/index.astro', path: [0, 1, 6], tag: 'a', prop: undefined, detail: 'href="/posts/hello"' },
    { file: 'src/pages/index.astro', path: [0, 1, 7], tag: 'a', prop: undefined, detail: 'href="/about#team"' },
  ]);
  assert.ok(asked.includes('/rss.xml'), 'a path no page has is asked of the dev server before it is called broken');
  assert.ok(!asked.includes('https://example.com/gone'), 'another origin is never fetched');
});

test('offline, the static passes still find prop links and own-markup links, and say how often the component is used', async () => {
  const report = await run({ renderPage: undefined });
  assert.deepEqual(broken(report), [
    { file: 'src/components/Footer.astro', path: [0, 0], tag: 'a', prop: undefined, detail: 'href="/gone"', measure: '2 instances' },
    { file: 'src/components/Footer.astro', path: [0, 1], tag: 'a', prop: undefined, detail: 'href="/rss.xml"', measure: '2 instances' },
    { file: 'src/pages/index.astro', path: [0, 1, 0], tag: 'Button', prop: 'href', detail: 'href="/abuot"' },
    { file: 'src/pages/index.astro', path: [0, 1, 2], tag: 'Card', prop: 'link', detail: 'href="/nope"' },
  ]);
});

test('the config base is read only when it is a literal path', () => {
  assert.equal(links.configBase("export default defineConfig({ base: '/docs' })"), '/docs');
  assert.equal(links.configBase('export default { base: "/" }'), undefined);
  assert.equal(links.configBase('export default { base: process.env.BASE }'), undefined);
  assert.equal(links.configBase('export default {}'), undefined);
});

test('the panel offers Create page only for a missing path, and Change link only where a literal is written', async () => {
  const routes = ['/', '/about'];
  assert.equal(links.missingRoute({ check: 'link-broken', detail: 'href="/abuot"' }, routes), '/abuot');
  assert.equal(links.missingRoute({ check: 'link-broken', detail: 'href="/abuot?x=1#y"' }, routes), '/abuot');
  assert.equal(links.missingRoute({ check: 'link-broken', detail: 'href="/about#team"' }, routes), undefined, 'the page exists; its id does not');
  assert.equal(links.missingRoute({ check: 'link-broken', detail: 'href="#missing"' }, routes), undefined);
  assert.equal(links.missingRoute({ check: 'link-broken', detail: 'href="team"' }, routes), undefined, 'a relative link names no route');
  assert.equal(links.missingRoute({ check: 'link-text', detail: 'href="/abuot"' }, routes), undefined);
  const page = readOf(FILES['/site/src/pages/index.astro']).nodes;
  const button = links.relinkTarget(page, [0, 1, 0], 'href');
  assert.deepEqual(button, { tag: 'Button', attr: 'href' }, 'a literal prop on the instance');
  const fix = links.linkFix({ file: 'src/pages/index.astro', path: [0, 1, 0], href: '/abuot', at: button }, '/about');
  assert.deepEqual(fix.edits, [{ tag: 'attributes', path: [0, 1, 0], expect: 'Button', patch: { href: { type: 'string', value: '/about' } } }]);
  assert.equal(fix.after, '<Button href="/about">');
  assert.deepEqual(links.relinkTarget(page, [0, 1, 4], undefined), { tag: 'a', attr: 'href' }, 'a literal on the page’s own link');
  assert.equal(links.relinkTarget(page, [0, 1, 6], undefined), undefined, 'a computed href keeps its expression');
  assert.equal(links.relinkTarget(page, [0, 1, 0], undefined), undefined, 'an instance needs the prop that holds the link');
  const buttonSource = readOf(FILES['/site/src/components/Button.astro']).nodes;
  assert.equal(links.relinkTarget(buttonSource, [0], undefined), undefined, 'Button’s own `href={href}` is never replaced');
  assert.equal(links.relinkTarget(page, [9, 9], undefined), undefined, 'a path off the tree');
});
