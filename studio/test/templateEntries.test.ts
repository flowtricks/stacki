// Goal: a template page (`[...slug].astro`) lists its entries as Desktop's picker does, the
// canvas and the address find the template from an entry's route, and the bake keeps each
// entry's document as a page sharing the template's file, in the build's order and within
// its limit. Method: drive the pure route arithmetic, the server's getStaticPaths mapping,
// the wire parser, the bake's entry selection and the demo's answer with known-good and
// known-bad values; no Astro build runs here (demoBake covers a real build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  fillTemplateRoute,
  isTemplateRoute,
  matchTemplateRoute,
  pageForRoute,
  parseTemplateEntries,
  templateEntryLabel,
  TEMPLATE_ENTRIES_MAX,
} from '../src/features/pages/templateRoutes';
import { templateEntries } from '../src/features/pages/templateEntriesServer';
import {
  documentRoute,
  entryPropsMarkup,
  extractEntryProps,
  parseTemplateOutputs,
  templateEntryPages,
  TemplateOutputs,
} from '../src/features/bake/bakeTemplates';
import { ENTRY_PROPS_CHARS_MAX, ENTRY_PROPS_SAMPLED_MAX, parseEntryProps, sampleEntryProps } from '../src/features/pages/entryPropsSample';
import { BAKE_LIMITS, type BakePage } from '../src/features/bake/bakeSnapshot';
import { bakedTemplateEntries } from '../demo/templateEntries';
import { routeFor } from '../src/features/project/projectClient';

const TEMPLATE = 'src/pages/docs/[...slug].astro';

test('a pattern matches the paths it renders, with their params, and nothing else', () => {
  assert.equal(isTemplateRoute('/docs/[...slug]'), true);
  assert.equal(isTemplateRoute('/docs'), false);
  assert.deepEqual(matchTemplateRoute('/docs/[...slug]', '/docs/introduction'), { slug: 'introduction' });
  assert.deepEqual(matchTemplateRoute('/docs/[...slug]', '/docs/guides/intro/'), { slug: 'guides/intro' });
  assert.deepEqual(matchTemplateRoute('/docs/[...slug]', '/docs'), {}, 'A rest param may be empty, as in Astro');
  assert.deepEqual(matchTemplateRoute('/blog/[slug]', '/blog/hello%20world'), { slug: 'hello world' });
  assert.deepEqual(matchTemplateRoute('/post-[id]', '/post-7'), { id: '7' });
  assert.equal(matchTemplateRoute('/blog/[slug]', '/blog/a/b'), undefined);
  assert.equal(matchTemplateRoute('/blog/[slug]', '/blog'), undefined);
  assert.equal(matchTemplateRoute('/docs/[...slug]', '/docsx/a'), undefined);
  assert.equal(matchTemplateRoute('/[slug]', '/'), undefined);
  assert.throws(() => matchTemplateRoute('docs/[slug]', '/docs/a'), /site path/);
});

test('an entry is filled and labelled as Desktop does', () => {
  assert.equal(fillTemplateRoute('/docs/[...slug]', { slug: 'guides/intro' }), '/docs/guides/intro');
  assert.equal(fillTemplateRoute('/docs/[...slug]', { slug: undefined }), '/docs');
  assert.equal(fillTemplateRoute('/blog/[slug]', { slug: 'a b' }), '/blog/a%20b');
  assert.equal(templateEntryLabel('/docs/[...slug]', { slug: 'introduction' }), 'introduction');
  assert.equal(templateEntryLabel('/[lang]/[slug]', { lang: 'en', slug: 'a' }), 'en / a');
  assert.equal(templateEntryLabel('/docs/[...slug]', {}), '/docs/[...slug]');
});

test('a route opens its own page first, then the most specific template', () => {
  const files = ['src/pages/docs/index.astro', TEMPLATE, 'src/pages/[...all].astro', 'src/pages/index.astro'];
  assert.deepEqual(pageForRoute(files, '/docs', routeFor), { file: 'src/pages/docs/index.astro', entry: undefined });
  assert.deepEqual(pageForRoute(files, '/docs/quick-start/', routeFor), { file: TEMPLATE, entry: '/docs/quick-start' });
  assert.deepEqual(pageForRoute(files, '/pricing', routeFor), { file: 'src/pages/[...all].astro', entry: '/pricing' });
  assert.equal(pageForRoute(['src/pages/index.astro'], '/pricing', routeFor), undefined);
});

test('getStaticPaths answers become entries in order, without duplicates or junk', () => {
  const result = [
    { params: { slug: 'introduction' } },
    { params: { slug: 'quick-start' } },
    { params: { slug: 'introduction' } },
    'junk',
    { params: [] },
    { props: {} },
  ];
  assert.deepEqual(templateEntries('/docs/[...slug]', result), [
    { route: '/docs/introduction', label: 'introduction' },
    { route: '/docs/quick-start', label: 'quick-start' },
  ]);
  assert.deepEqual(templateEntries('/docs/[...slug]', 'not a list'), []);
  const many = Array.from({ length: TEMPLATE_ENTRIES_MAX + 5 }, (_, index) => ({ params: { slug: `e${index}` } }));
  assert.equal(templateEntries('/docs/[...slug]', many).length, TEMPLATE_ENTRIES_MAX);
  assert.throws(() => templateEntries('/docs', []), /template route/);
});

test('the entries answer is parsed, and every known-bad shape is refused', () => {
  assert.deepEqual(parseTemplateEntries({ entries: [{ route: '/docs/a', label: 'a' }] }), { entries: [{ route: '/docs/a', label: 'a' }], error: undefined });
  assert.deepEqual(parseTemplateEntries({ entries: [], error: 'boom' }), { entries: [], error: 'boom' });
  const bad: readonly [string, unknown, RegExp][] = [
    ['not an object', 'x', /expected an object/],
    ['no list', { entries: 'x' }, /expected a list/],
    ['too many', { entries: Array.from({ length: TEMPLATE_ENTRIES_MAX + 1 }, () => ({ route: '/a', label: 'a' })) }, /exceeds its limit/],
    ['relative route', { entries: [{ route: 'a', label: 'a' }] }, /site route/],
    ['protocol-relative route', { entries: [{ route: '//evil', label: 'a' }] }, /site route/],
    ['a pattern', { entries: [{ route: '/docs/[slug]', label: 'a' }] }, /not a pattern/],
    ['no label', { entries: [{ route: '/a' }] }, /label/],
  ];
  for (const [name, input, message] of bad) {
    assert.throws(() => parseTemplateEntries(input), message, name);
  }
});

test('the bake keeps each entry document in build order, within its limit, after fixed pages', () => {
  const fixed: readonly BakePage[] = [{ file: 'src/pages/docs/index.astro', route: '/docs', document: 'docs/index.html' }];
  const documents = ['docs/introduction/index.html', 'docs/index.html', 'docs/quick-start/index.html', 'docs/broken/index.html', 'other/x/index.html'];
  const kept = templateEntryPages([{ file: TEMPLATE, documents }], fixed, (document) => document !== 'docs/broken/index.html');
  assert.deepEqual(kept.pages, [
    { file: TEMPLATE, route: '/docs/introduction', document: 'docs/introduction/index.html', entry: 'introduction' },
    { file: TEMPLATE, route: '/docs/quick-start', document: 'docs/quick-start/index.html', entry: 'quick-start' },
  ]);
  assert.equal(kept.dropped, 0);
  const many = Array.from({ length: BAKE_LIMITS.templateEntriesMax + 3 }, (_, index) => `docs/e${index}/index.html`);
  const bounded = templateEntryPages([{ file: TEMPLATE, documents: many }], [], () => true);
  assert.equal(bounded.pages.length, BAKE_LIMITS.templateEntriesMax);
  assert.equal(bounded.dropped, 3);
  assert.equal(bounded.pages[0]?.route, '/docs/e0', 'The build order is kept');
});

test("Astro's hooks name each template's documents relative to the output", () => {
  const outputs = new TemplateOutputs('/site');
  outputs.resolved([
    { pattern: '/docs/[...slug]', entrypoint: TEMPLATE, type: 'page' },
    { pattern: '/docs', entrypoint: 'src/pages/docs/index.astro', type: 'page' },
    { pattern: '/api/[id]', entrypoint: 'src/pages/api/[id].ts', type: 'endpoint' },
    { pattern: '/[...x]', entrypoint: 'node_modules/pkg/page.astro', type: 'page' },
  ]);
  const directory = pathToFileURL('/site/dist/');
  const assets = new Map([['/docs/[...slug]', [pathToFileURL('/site/dist/docs/b/index.html'), pathToFileURL('/site/dist/docs/a/index.html')]]]);
  assert.deepEqual(outputs.done(directory, assets), [{ file: TEMPLATE, documents: ['docs/b/index.html', 'docs/a/index.html'] }]);
});

test("the child's template reply is parsed and bounded", () => {
  assert.deepEqual(parseTemplateOutputs(undefined), []);
  assert.deepEqual(parseTemplateOutputs([{ file: TEMPLATE, documents: ['docs/a/index.html'] }]), [{ file: TEMPLATE, documents: ['docs/a/index.html'] }]);
  assert.throws(() => parseTemplateOutputs('x'), /bounded list/);
  assert.throws(() => parseTemplateOutputs([{ file: 'src/pages/docs/index.astro', documents: [] }]), /template page/);
  assert.throws(() => parseTemplateOutputs([{ file: TEMPLATE, documents: ['../escape.html'] }]), /outside the site/);
  assert.throws(() => parseTemplateOutputs([{ file: TEMPLATE, documents: ['/abs.html'] }]), /outside the site/);
  assert.equal(documentRoute('index.html'), '/');
  assert.equal(documentRoute('docs/a/index.html'), '/docs/a');
  assert.equal(documentRoute('404.html'), '/404');
});

test('the demo answers a template with the entries the bake kept, and anything else with none', () => {
  const pages: readonly BakePage[] = [
    { file: 'src/pages/index.astro', route: '/', document: 'index.html' },
    { file: TEMPLATE, route: '/docs/introduction', document: 'docs/introduction/index.html', entry: 'introduction' },
    { file: TEMPLATE, route: '/docs/quick-start', document: 'docs/quick-start/index.html', entry: 'quick-start' },
  ];
  assert.deepEqual(bakedTemplateEntries(pages, TEMPLATE), {
    entries: [
      { route: '/docs/introduction', label: 'introduction' },
      { route: '/docs/quick-start', label: 'quick-start' },
    ],
    error: undefined,
  });
  assert.deepEqual(bakedTemplateEntries(pages, 'src/pages/index.astro'), { entries: [], error: undefined });
  assert.match(bakedTemplateEntries(pages, 'src/pages/blog/[slug].astro').error ?? '', /no entries/);
});

test("an entry's props are sampled by Desktop's rules, and the sampler runs from its own source", () => {
  const doc = {
    id: 'introduction',
    body: 'x'.repeat(500),
    data: {
      title: 'Introduction',
      order: 1,
      draft: false,
      keywords: Array.from({ length: 10 }, (_, index) => `k${index}`),
      when: new Date('2026-01-02T00:00:00Z'),
    },
    render: () => 'no',
    deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
  };
  const sampled = sampleEntryProps({ doc }, 0);
  assert.deepEqual(sampled, {
    doc: {
      id: 'introduction',
      body: `${'x'.repeat(160)}…`,
      data: {
        title: 'Introduction',
        order: 1,
        draft: false,
        keywords: ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', { __stacki: 'more', count: 2 }],
        when: { __stacki: 'date', value: '2026-01-02T00:00:00.000Z' },
      },
      deep: { a: { b: { c: { d: { __stacki: 'deep' } } } } },
    },
  });
  // The bake inlines the function's source into the site's build; it must need nothing else.
  const run: unknown = new Function('value', `return (${sampleEntryProps.toString()})(value, 0);`);
  assert.equal(typeof run, 'function');
  const inlined: unknown = typeof run === 'function' ? Reflect.apply(run, undefined, [{ doc }]) : undefined;
  assert.deepEqual(inlined, sampled);
});

test("a rendered entry's props are read and cut out of its document, and bad ones are refused", () => {
  const markup = entryPropsMarkup(sampleEntryProps);
  assert.match(markup, /set:html=\{JSON\.stringify\(/);
  const html = `<body><main>Page</main>\n<script type="application/json" id="stacki-bake-entry-props">{"doc":{"data":{"title":"A \\u003c B"}}}</script></body>`;
  const extracted = extractEntryProps(html);
  assert.equal(extracted.html, '<body><main>Page</main></body>');
  assert.deepEqual(extracted.props, { doc: { data: { title: 'A < B' } } });
  assert.deepEqual(extractEntryProps('<body></body>'), { html: '<body></body>', props: undefined });
  assert.throws(() => parseEntryProps({ text: 'x'.repeat(ENTRY_PROPS_CHARS_MAX) }), /exceeds its limit/);
  const kept = templateEntryPages(
    [{ file: TEMPLATE, documents: ['docs/a/index.html'] }],
    [],
    () => true,
    () => ({ doc: { id: 'a' } }),
  );
  assert.deepEqual(kept.pages[0]?.entryProps, { doc: { id: 'a' } });
});

test('entries carry their props to the picker, from the server and from the bake', () => {
  const entries = templateEntries('/docs/[...slug]', [{ params: { slug: 'a' }, props: { doc: { data: { title: 'A' } } } }, { params: { slug: 'b' } }]);
  assert.deepEqual(entries, [
    { route: '/docs/a', label: 'a', props: { doc: { data: { title: 'A' } } } },
    { route: '/docs/b', label: 'b' },
  ]);
  const many = Array.from({ length: ENTRY_PROPS_SAMPLED_MAX + 2 }, (_, index) => ({ params: { slug: `e${index}` }, props: { n: index } }));
  assert.equal(templateEntries('/docs/[...slug]', many).filter((entry) => entry.props !== undefined).length, ENTRY_PROPS_SAMPLED_MAX);
  assert.deepEqual(parseTemplateEntries({ entries: [{ route: '/docs/a', label: 'a', props: { doc: { id: 'a' } } }] }).entries[0]?.props, { doc: { id: 'a' } });
  const page: BakePage = { file: TEMPLATE, route: '/docs/a', document: 'docs/a/index.html', entry: 'a', entryProps: { doc: { id: 'a' } } };
  assert.deepEqual(bakedTemplateEntries([page], TEMPLATE).entries, [{ route: '/docs/a', label: 'a', props: { doc: { id: 'a' } } }]);
});
