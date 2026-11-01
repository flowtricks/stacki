// Goal: page labels reflect layout titles without executing site code or changing routes.
// Methodology: scan real Astro source variants, including aliases, invalid markup,
// nested content titles, blank titles and dynamic expressions; assert source identity survives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanPageTitles } from '#dist/electron/properties/pageTitles.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { layoutPageTitle } from '#dist/shared/page/pageTitle.js';

const page = { path: '/site/src/pages/example.astro', name: 'example.astro', route: '/example' };
const wrap = (props: string) => `---\nimport Shell from '../layouts/Base.astro';\n---\n<Shell ${props}><h1>Hello</h1></Shell>`;

for (const [source, title] of [
  [wrap('title="Example Components"'), 'Example Components'],
  [wrap("title='About &amp; Contact'"), 'About & Contact'],
  [wrap('title="  Our Story  "'), 'Our Story'],
  [wrap('title=""'), undefined],
  [wrap('title="   "'), undefined],
  [wrap('title={getTitle()}'), undefined],
  [wrap(''), undefined],
  ['<div title="Not a layout">Content</div>', undefined],
  [wrap('').replace('<h1>Hello</h1>', '<Card title="Not the page" />'), undefined],
  ['<Shell', undefined],
] as const) {
  test(`scan title: ${source}`, () => {
    const scanned = scanPageTitles([page], [{ file: page.path, text: source }])[0];
    assert.equal(scanned?.title, title);
    assert.equal(scanned?.name, page.name);
    assert.equal(scanned?.path, page.path);
    assert.equal(scanned?.route, page.route);
  });
}

test('missing source and non-Astro pages retain their file identity', () => {
  assert.deepEqual(scanPageTitles([page], []), [page]);
  const markdown = { ...page, path: '/site/src/pages/post.md', name: 'post.md' };
  assert.deepEqual(scanPageTitles([markdown], [{ file: markdown.path, text: wrap('') }]), [markdown]);
});

test('imported wrappers supply inherited titles without overriding explicit page props', () => {
  const wrapper = {
    file: '/site/src/components/ResourcesLayout.astro',
    text: wrap('title="The Church Resources"'),
  };
  const aliases = [{ prefix: '@/', wildcard: true, targets: ['/site/src'] }];
  for (const [props, expected] of [
    ['', 'The Church Resources'],
    ['title="Worship Team"', 'Worship Team'],
    ['title=""', undefined],
    ['title={runtimeTitle}', undefined],
  ] as const) {
    const source = wrap(props).replace('../layouts/Base.astro', '@/components/ResourcesLayout.astro');
    const scanned = scanPageTitles([page], [{ file: page.path, text: source }, wrapper], aliases)[0];
    assert.equal(scanned?.title, expected);
    assert.equal(scanned?.inheritedTitle, 'The Church Resources');
    const parsed = parsePage(source);
    assert.equal(parsed.editable, true);
    if (parsed.editable) {
      assert.equal(layoutPageTitle(parsed.model.nodes, scanned?.inheritedTitle), expected);
    }
  }
});

test('missing, cyclic, dynamic and excessively deep wrappers fall back safely', () => {
  const pageSource = { file: page.path, text: wrap('') };
  const wrapper = { file: '/site/src/layouts/Base.astro', text: wrap('') };
  assert.equal(scanPageTitles([page], [pageSource, wrapper])[0]?.title, undefined);
  assert.equal(scanPageTitles([page], [pageSource])[0]?.title, undefined);
  const sources = Array.from({ length: 34 }, (_, index) => ({
    file: `/site/src/layouts/Layer${index}.astro`,
    text: wrap(index === 33 ? 'title="Too deep"' : '').replace('../layouts/Base.astro', `./Layer${index + 1}.astro`),
  }));
  const first = { ...pageSource, text: wrap('').replace('Base.astro', 'Layer0.astro') };
  assert.equal(scanPageTitles([page], [first, ...sources])[0]?.title, undefined);
  const dynamic = { ...wrapper, text: wrap('title={dynamicTitle}') };
  assert.equal(scanPageTitles([page], [pageSource, dynamic])[0]?.title, undefined);
});

test('equivalent source paths resolve inherited titles without changing page identity', () => {
  const source = wrap('').replace('../layouts/Base.astro', '@/components/ResourcesLayout.astro');
  const scanned = scanPageTitles(
    [page],
    [
      { file: '/site/src/pages/../pages/example.astro', text: source },
      {
        file: '/site/src/layouts/../components/ResourcesLayout.astro',
        text: wrap('title="The Church Resources"'),
      },
    ],
    [{ prefix: '@/', wildcard: true, targets: ['/site/src'] }],
  )[0];
  assert.equal(scanned?.title, 'The Church Resources');
  assert.equal(scanned?.inheritedTitle, 'The Church Resources');
  assert.equal(scanned?.path, page.path);
});
