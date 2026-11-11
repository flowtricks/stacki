// Goal: the rendered checks judge the final page — the outline across layouts
// and components, names after slots, page-wide ids, the head the layout wrote,
// colour contrast — and locate each finding in the file its marker names; the
// contrast maths matches WCAG; the site checks find what no file holds.
// Method: build plain rendered trees by hand (the shape renderedDom.ts makes),
// with and without markers, and pin each check's positive and negative case and
// the case that turns invalid; pin WCAG's reference ratios; run the site checks
// over fixed facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditRenderedPage, parseMarker, renderedText, type RenderedElement, type RenderedNode } from '#dist/shared/page/auditRendered.js';
import { blend, contrastRatio, contrastVerdict, largeText, parseCssColor } from '#dist/shared/page/auditContrast.js';
import { DEFAULT_PLACEHOLDERS } from '#dist/shared/properties/auditIgnores.js';
import { SITE_FILE_ENDPOINTS, auditSite, configMakes, exportedString, noindexRoutesIn } from '#dist/shared/page/auditSite.js';

type Child = RenderedNode | string;
const element = (
  tag: string,
  attrs: Record<string, string> = {},
  children: readonly Child[] = [],
  extra: Pick<RenderedElement, 'source' | 'style'> = { source: undefined, style: undefined },
): RenderedElement => ({
  kind: 'element',
  tag,
  attrs,
  children: children.map((child) => (typeof child === 'string' ? { kind: 'text', value: child } : child)),
  ...extra,
});
const GOOD_HEAD = element('head', {}, [
  element('title', {}, ['Home']),
  element('meta', { name: 'description', content: 'A description long enough to sit inside the snippet range, well past fifty.' }),
  element('link', { rel: 'canonical', href: 'https://acme.example/' }),
]);
const page = (body: readonly Child[], head: RenderedElement = GOOD_HEAD, lang = 'en') => ({
  file: 'src/pages/index.astro',
  route: '/',
  root: element('html', lang === '' ? {} : { lang }, [head, element('body', {}, body)]),
});
const checks = (input: ReturnType<typeof page>, noindexRoutes: readonly string[] = []) =>
  auditRenderedPage(input, { noindexRoutes, placeholders: [] }).findings.map((finding) => finding.check);

test('a good page renders no findings', () => {
  assert.deepEqual(checks(page([element('h1', {}, ['Hi']), element('a', { href: '/a' }, ['About us'])])), []);
});

test('the document checks read the final head', () => {
  assert.ok(checks(page([element('h1', {}, ['x'])], GOOD_HEAD, '')).includes('html-lang'));
  assert.ok(checks(page([element('h1', {}, ['x'])], element('head'))).includes('title-missing'));
  assert.ok(checks(page([element('h1', {}, ['x'])], element('head', {}, [element('title', {}, ['  '])]))).includes('title-missing'));
  const short = element('head', {}, [
    element('title', {}, ['T']),
    element('meta', { name: 'description', content: 'Short' }),
    element('link', { rel: 'canonical', href: '/' }),
  ]);
  assert.ok(checks(page([element('h1', {}, ['x'])], short)).includes('description-short'));
  const wrong = element('head', {}, [
    element('title', {}, ['T']),
    element('meta', { name: 'description', content: 'x'.repeat(80) }),
    element('link', { rel: 'canonical', href: 'https://acme.example/other' }),
  ]);
  assert.ok(checks(page([element('h1', {}, ['x'])], wrong)).includes('canonical'));
  const robots = element('head', {}, [...GOOD_HEAD.children, element('meta', { name: 'robots', content: 'noindex' })]);
  assert.ok(checks(page([element('h1', {}, ['x'])], robots)).includes('noindex'));
  assert.ok(!checks(page([element('h1', {}, ['x'])], robots), ['/']).includes('noindex'), 'the project lists / as noindex');
});

test('the outline runs across the whole page', () => {
  assert.ok(checks(page([element('h2', {}, ['x'])])).includes('h1-count'), 'no h1');
  assert.ok(checks(page([element('h1', {}, ['a']), element('h1', {}, ['b'])])).includes('h1-count'), 'two h1');
  assert.ok(checks(page([element('h1', {}, ['a']), element('div', {}, [element('h3', {}, ['b'])])])).includes('heading-order'));
  assert.ok(!checks(page([element('h1', {}, ['a']), element('div', {}, [element('h2', {}, ['b'])])])).includes('heading-order'));
});

test('names after slots: text, alt, aria-label; aria-hidden content does not count', () => {
  const body = (link: RenderedElement) => [element('h1', {}, ['x']), link];
  assert.ok(checks(page(body(element('a', { href: '/' }, [element('span', { 'aria-hidden': 'true' }, ['→'])])))).includes('link-name'));
  assert.ok(!checks(page(body(element('a', { href: '/' }, [element('img', { alt: 'Home' })])))).includes('link-name'));
  assert.ok(!checks(page(body(element('a', { href: '/', 'aria-label': 'Home' })))).includes('link-name'));
  assert.ok(checks(page(body(element('button')))).includes('button-name'));
  assert.ok(checks(page(body(element('a', { href: '/' }, ['here'])))).includes('link-text'));
  assert.ok(!checks(page(body(element('a', {}, [])))).includes('link-name'), 'an anchor without href is no link');
});

test('ids collide across files, and the finding is located by its marker', () => {
  const source = { file: 'src/components/Card.astro', path: [0, 1] };
  const result = auditRenderedPage(
    page([element('h1', {}, ['x']), element('p', { id: 'a' }, ['1']), element('p', { id: 'a' }, ['2'], { source, style: undefined })]),
    {
      noindexRoutes: [],
      placeholders: [],
    },
  );
  const duplicate = result.findings.find((finding) => finding.check === 'duplicate-id');
  assert.equal(duplicate?.file, 'src/components/Card.astro');
  assert.equal(duplicate?.fileKind, 'component');
  assert.deepEqual(duplicate?.element?.path, [0, 1]);
  assert.deepEqual(duplicate?.routes, ['/'], 'a component finding names the routes it shows on');
  assert.equal(result.title, 'Home');
});

test('contrast fails below AA, passes at it, and is unknown behind images', () => {
  const styled = (color: string, background: string | 'unknown', fontSizePx = 16) =>
    element('p', {}, ['Text'], { source: undefined, style: { color, background, fontSizePx, fontWeight: 400 } });
  assert.ok(checks(page([element('h1', {}, ['x']), styled('rgb(170, 170, 170)', 'rgb(255, 255, 255)')])).includes('contrast'));
  assert.ok(!checks(page([element('h1', {}, ['x']), styled('rgb(118, 118, 118)', 'rgb(255, 255, 255)')])).includes('contrast'), '#767676 on white is 4.54:1');
  assert.ok(!checks(page([element('h1', {}, ['x']), styled('rgb(140, 140, 140)', 'rgb(255, 255, 255)', 24)])).includes('contrast'), 'large text needs 3:1');
  assert.ok(!checks(page([element('h1', {}, ['x']), styled('rgb(250, 250, 250)', 'unknown')])).includes('contrast'));
});

test('WCAG contrast maths', () => {
  const white = parseCssColor('#fff');
  const black = parseCssColor('rgb(0, 0, 0)');
  assert.ok(white !== undefined && black !== undefined);
  assert.equal(Math.round(contrastRatio(white, black) * 100) / 100, 21);
  assert.equal(contrastRatio(white, white), 1);
  assert.deepEqual(parseCssColor('rgba(0, 0, 0, 0.5)'), { red: 0, green: 0, blue: 0, alpha: 0.5 });
  assert.deepEqual(parseCssColor('#00000080')?.alpha, 128 / 255);
  assert.equal(parseCssColor('color(display-p3 1 0 0)'), undefined);
  assert.equal(parseCssColor('rgb(300, 0, 0)'), undefined);
  assert.deepEqual(blend({ red: 0, green: 0, blue: 0, alpha: 0.5 }, white), { red: 127.5, green: 127.5, blue: 127.5, alpha: 1 });
  assert.equal(largeText(18.66, 700), true);
  assert.equal(largeText(18.66, 400), false);
  assert.deepEqual(contrastVerdict({ foreground: 'red', background: '#fff', fontSizePx: 16, fontWeight: 400 }), { tag: 'unknown' });
  assert.deepEqual(contrastVerdict({ foreground: '#000', background: 'rgba(0,0,0,0.2)', fontSizePx: 16, fontWeight: 400 }), { tag: 'unknown' });
  assert.throws(() => blend({ red: 0, green: 0, blue: 0, alpha: 2 }, white), /alpha/);
});

test('markers name the page or a component file and a structural path', () => {
  assert.deepEqual(parseMarker('avb-s:n0.2.1', 'src/pages/index.astro'), { file: 'src/pages/index.astro', path: [0, 2, 1] });
  assert.deepEqual(parseMarker('avb-s:src/components/Card.astro|n1', 'src/pages/index.astro'), { file: 'src/components/Card.astro', path: [1] });
  assert.equal(parseMarker('avb-e:n0', 'src/pages/index.astro'), undefined);
  assert.equal(parseMarker('avb-s:layout', 'src/pages/index.astro'), undefined);
  assert.deepEqual(parseMarker('avb-s:0.3', 'src/pages/index.astro'), { file: 'src/pages/index.astro', path: [0, 3] }, 'the dev server’s bare form');
  assert.deepEqual(parseMarker('avb-s:src/components/Card.astro|2', 'src/pages/index.astro'), { file: 'src/components/Card.astro', path: [2] });
  assert.equal(parseMarker('avb-s:|n0', 'src/pages/index.astro'), undefined);
  assert.equal(renderedText(element('p', {}, ['a ', element('script', {}, ['x']), element('b', {}, ['b'])])), 'a b');
});

test('site checks: sitemap, robots, structured data and duplicates', () => {
  const pages = [
    { file: 'src/pages/index.astro', route: '/', title: 'Acme', description: 'Same' },
    { file: 'src/pages/about.astro', route: '/about', title: 'Acme', description: 'Same' },
    { file: 'src/pages/blog.astro', route: '/blog', title: 'Blog', description: undefined },
  ];
  const found = auditSite({
    astroConfig: { file: 'astro.config.mjs' },
    sitemap: false,
    robots: false,
    pages,
    summaries: [{ head: true, structuredData: false }],
    launch: undefined,
  });
  const names = found.map((finding) => finding.check).sort();
  assert.deepEqual(names, ['description-duplicate', 'description-duplicate', 'robots', 'sitemap', 'structured-data', 'title-duplicate', 'title-duplicate']);
  const clean = auditSite({
    astroConfig: { file: 'astro.config.mjs' },
    sitemap: true,
    robots: true,
    pages: pages.map((entry, index) => ({ ...entry, title: `T${index}`, description: `D${index}` })),
    summaries: [{ head: true, structuredData: true }],
    launch: undefined,
  });
  assert.deepEqual(clean, []);
});

test('site constants and noindex routes are read from an exports module', () => {
  const source =
    "export const SITE_TITLE = 'Acme';\nexport const SITE_DESCRIPTION: string = \"We make things.\";\nexport const NOINDEX_ROUTES = ['/private', '/drafts/'];\nexport const DYNAMIC = `${x}`;";
  assert.deepEqual(exportedString(source, ['SITE_TITLE']), { name: 'SITE_TITLE', value: 'Acme' });
  assert.deepEqual(exportedString(source, ['MISSING', 'SITE_DESCRIPTION']), { name: 'SITE_DESCRIPTION', value: 'We make things.' });
  assert.equal(exportedString(source, ['DYNAMIC']), undefined, 'a template with substitutions is not a constant');
  assert.deepEqual(noindexRoutesIn(source), ['/private', '/drafts/']);
  assert.deepEqual(noindexRoutesIn('export const OTHER = [1];'), []);
});

test('the rendered pages are the truth for structured data, and config integrations count as made', () => {
  const pages = [{ file: 'src/pages/index.astro', route: '/', title: 'A', description: 'B', structuredData: true }];
  assert.deepEqual(
    auditSite({ astroConfig: undefined, sitemap: true, robots: true, pages, summaries: [{ head: true, structuredData: false }], launch: undefined }),
    [],
    'a rendered ld+json counts over the source',
  );
  assert.equal(configMakes("integrations: [sitemap()], import sitemap from '@astrojs/sitemap'", 'sitemap'), true);
  assert.equal(configMakes("import robotsTxt from 'astro-robots-txt'", 'robots'), true);
  assert.equal(configMakes('export default {}', 'robots'), false);
  assert.ok(SITE_FILE_ENDPOINTS.robots.includes('src/pages/robots.txt.ts'));
});

test('placeholder copy is found as rendered, and a marked text is located at the node that holds it', () => {
  const placeholders = (body: readonly Child[]) =>
    auditRenderedPage(page([element('h1', {}, ['Welcome']), ...body]), { noindexRoutes: [], placeholders: DEFAULT_PLACEHOLDERS }).findings.filter((finding) =>
      finding.check.startsWith('placeholder-'),
    );
  // A constant's lorem, rendered through a component's slot: its marker names the page's instance.
  const lorem = { kind: 'text', value: 'Lorem ipsum dolor sit amet, consectetur.', source: { file: 'src/pages/index.astro', path: [0, 4, 1] } } as const;
  const [slotted] = placeholders([element('p', {}, [lorem], { source: { file: 'src/components/Paragraph.astro', path: [0] }, style: undefined })]);
  assert.equal(slotted?.file, 'src/pages/index.astro');
  assert.deepEqual(slotted?.element?.path, [0, 4]);
  assert.equal(slotted?.source, 'rendered');
  // A component's own default, unmarked: located at the element its marker names.
  const [fallback] = placeholders([
    element('a', { href: '/' }, ['Button Text'], { source: { file: 'src/components/Button.astro', path: [0] }, style: undefined }),
  ]);
  assert.equal(fallback?.file, 'src/components/Button.astro');
  assert.deepEqual(fallback?.routes, ['/']);
  assert.equal(placeholders([element('img', { src: 'https://placehold.co/600x400', alt: 'A cat' })])[0]?.check, 'placeholder-image');
  // Real copy, code and the head are not placeholders; a single word must be the whole text.
  assert.deepEqual(
    placeholders([element('p', {}, ['Our heading sets the tone']), element('code', {}, ['lorem ipsum']), element('p', {}, ['Examples of our work'])]),
    [],
  );
  assert.equal(placeholders([element('h2', {}, ['Heading'])]).length, 1);
  assert.equal(
    auditRenderedPage(page([element('h1', {}, ['Lorem ipsum dolor'])]), { noindexRoutes: [], placeholders: [] }).findings.filter(
      (finding) => finding.check === 'placeholder-text',
    ).length,
    0,
  );
});
