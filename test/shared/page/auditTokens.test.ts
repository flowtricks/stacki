// Goal: the design-token linter flags raw colours and raw sizes where the rules
// ask for variables, and only there: never a variable definition, a var() (its
// fallback included), a keyword, an allowed value, a zero, or a unitless factor
// in calc(); the unit rules flag px or rem outside variables; offsets point at
// the raw token so a fix swaps exactly that value. Style blocks, placeholders,
// launch facts and measured performance are pinned beside it.
// Method: lint small stylesheets under the default rules and variations, then
// check the static pass's style-block, inline-style and placeholder findings,
// the site's launch findings, and the performance report's parser, score and
// findings, each with a passing and a failing case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankVariables, lintCss, tokenVariables, variablesFor } from '#dist/shared/page/auditTokens.js';
import { DEFAULT_PLACEHOLDERS, DEFAULT_TOKEN_SETTINGS } from '#dist/shared/properties/auditIgnores.js';
import { auditFile, placeholderImage, placeholderPhrase } from '#dist/shared/page/auditStatic.js';
import { auditSite } from '#dist/shared/page/auditSite.js';
import { parseMeasurement, performanceFindings, performanceScore } from '#dist/shared/page/auditPerformance.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';

const rules = DEFAULT_TOKEN_SETTINGS;
const kinds = (css: string, settings = rules) => lintCss(css, settings).map((issue) => `${issue.kind}:${issue.token}`);

test('raw colours and sizes are flagged; variables, definitions, keywords and zeros are not', () => {
  assert.deepEqual(kinds('.a { color: #121212; padding: 12px 1.5rem; gap: 0; margin: auto; }'), [
    'token-color:#121212',
    'token-value:12px',
    'token-value:1.5rem',
  ]);
  assert.deepEqual(
    kinds(':root { --space: 12px; --ink: #121212; } .a { color: var(--ink, #000); padding: var(--space); }'),
    [],
    'definitions and var() fallbacks',
  );
  assert.deepEqual(
    kinds('.a { width: calc(var(--x) * 2); max-width: calc(var(--x) + 10px); }'),
    ['token-value:10px'],
    'a unitless factor scales a variable; a raw length does not',
  );
  assert.deepEqual(kinds('.a { background: rgb(0 0 0 / 50%); border-color: hsl(0deg 0% 0%); }'), [
    'token-color:rgb(0 0 0 / 50%)',
    'token-color:hsl(0deg 0% 0%)',
  ]);
  assert.deepEqual(kinds('a:hover { color: currentColor; } /* color: #fff; */'), [], 'a selector’s colon and a comment are not declarations');
  assert.deepEqual(kinds('.a { width: 100%; font-size: inherit; }'), [], 'allowed values');
});

test('unit rules flag px or rem outside variables; offsets point at the token', () => {
  const px = { ...rules, px: true };
  assert.deepEqual(kinds('.a { border: 1px solid; top: 4px; --x: 2px; }', px), ['token-unit:1px', 'token-unit:4px']);
  assert.deepEqual(kinds('.a { transform: translateY(1rem); }', { ...rules, remOutsideVariables: true }), ['token-unit:1rem']);
  const text = '.a { padding: 12px; }';
  const [issue] = lintCss(text, rules);
  assert.equal(text.slice(issue?.offset, (issue?.offset ?? 0) + 4), '12px');
  assert.deepEqual(kinds('.a { color: #fff; }', { ...rules, colors: false }), []);
  const blanked = blankVariables('a var(--x, var(--y)) b');
  assert.equal(blanked.length, 'a var(--x, var(--y)) b'.length, 'offsets are kept');
  assert.equal(blanked.replace(/ +/g, ' '), 'a b', 'the whole var(), nested one included, is blanked');
  assert.deepEqual(
    variablesFor(
      '#121212',
      new Map([
        ['--b', '#121212'],
        ['--a', ' #121212 '],
        ['--c', '#000'],
      ]),
    ),
    ['--a', '--b'],
  );
});

function audit(source: string, kind: 'page' | 'component' = 'component') {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable);
  return auditFile(
    { file: 'src/components/Card.astro', kind, nodes: parsed.model.nodes, imports: parsed.model.imports, frontmatter: '', source, route: undefined },
    {
      routes: ['/'],
      publicFiles: new Map(),
      imageSizes: new Map(),
      site: { title: undefined, description: undefined, lang: undefined },
      noindexRoutes: [],
      tokens: rules,
      variables: new Map([
        ['--color-ink', '#121212'],
        ['--color-neutral-900', '#121212'],
        ['--space-m', '1rem'],
      ]),
      placeholders: DEFAULT_PLACEHOLDERS,
    },
  ).findings;
}

test('style blocks: scoped and unlayered blocks are flagged, never fixed; raw values offer their variables', () => {
  const scoped = audit('<div>x</div><style>.a { color: red; }</style>');
  assert.equal(scoped.find((finding) => finding.check === 'style-global')?.fix, undefined, 'scoping is the person’s call');
  const global = audit('<style is:global>.a { padding: 1rem; color: #121212; }</style>');
  assert.ok(global.some((finding) => finding.check === 'style-layer'));
  const value = global.find((finding) => finding.check === 'token-value');
  assert.equal(value?.fix?.label, 'Use var(--space-m)');
  assert.deepEqual(value?.fix?.edits[0], { tag: 'raw-text', path: [0], expect: 'style', offset: 14, before: '1rem', after: 'var(--space-m)' });
  const colour = global.find((finding) => finding.check === 'token-color');
  assert.deepEqual(
    colour?.choices?.map((choice) => choice.label),
    ['Use var(--color-ink)', 'Use var(--color-neutral-900)'],
    'several equal matches are a choice',
  );
  assert.ok(
    !audit('<style is:global>@layer base { .a { color: var(--color-ink); } }</style>').some(
      (finding) => finding.check.startsWith('style-') || finding.check.startsWith('token-'),
    ),
  );
  // BaseHead's own block in my-site: inline, and only the layer order.
  assert.ok(
    !audit('<style is:inline>@layer base, patterns, components, utilities;</style>').some((finding) => finding.check.startsWith('style-')),
    'is:inline is global; a layer order statement is layered',
  );
  assert.ok(audit('<style is:inline>.a { color: red; }</style>').some((finding) => finding.check === 'style-layer'));
  for (const parent of ['noscript', 'template', 'svg']) {
    assert.ok(
      !audit(`<${parent}><style>.a { display: none; }</style></${parent}>`).some((finding) => finding.check.startsWith('style-')),
      `a <style> in <${parent}> is its own`,
    );
  }
  assert.equal(value?.css?.selector, '.a');
  assert.equal(value?.css?.group, 'spacing');
  const inline = audit('<div style="padding: 1rem">x</div>').find((finding) => finding.check === 'token-value');
  assert.equal(inline?.fix?.after, '<div style="padding: var(--space-m)">');
});

test('placeholder copy and images', () => {
  assert.ok(audit('<p>Lorem ipsum dolor sit amet</p>').some((finding) => finding.check === 'placeholder-text'));
  assert.ok(audit('<button>Button Text</button>').some((finding) => finding.check === 'placeholder-text'));
  assert.ok(!audit('<h2>Heading levels in practice</h2>').some((finding) => finding.check === 'placeholder-text'), 'one word must be the whole text');
  assert.equal(placeholderPhrase('Heading', DEFAULT_PLACEHOLDERS), 'heading');
  assert.ok(audit('<img src="https://placehold.co/600x400" alt="x">').some((finding) => finding.check === 'placeholder-image'));
  assert.equal(placeholderImage('/images/hero-placeholder.jpg'), true);
  assert.equal(placeholderImage('/images/hero.jpg'), false);
});

test('the launch checklist reports a missing favicon, 404 page and analytics', () => {
  const launch = (over: Record<string, unknown>) =>
    auditSite({
      astroConfig: undefined,
      sitemap: true,
      robots: true,
      pages: [],
      summaries: [],
      launch: { favicon: true, notFound: true, analytics: true, headFile: 'src/layouts/Base.astro', ...over },
    }).map((finding) => finding.check);
  assert.deepEqual(launch({}), []);
  assert.deepEqual(launch({ favicon: false, notFound: false, analytics: false }), ['launch-favicon', 'launch-404', 'launch-analytics']);
});

const REPORT = {
  lcpMs: 3_200,
  lcpElement: { tag: 'IMG', marker: 'avb-s:0.1', label: '/hero.jpg' },
  cls: 0.18,
  shifts: [{ tag: 'DIV', marker: 'avb-s:src/components/Banner.astro|0', label: '' }],
  tbtMs: 350,
  transferBytes: 3_500_000,
  requests: 80,
  blocking: ['http://localhost:4321/styles.css'],
  thirdParty: ['https://www.googletagmanager.com/gtag/js'],
  images: [
    {
      element: { tag: 'IMG', marker: 'avb-s:0.1', label: '' },
      url: 'http://localhost:4321/hero.jpg',
      naturalWidth: 4000,
      naturalHeight: 3000,
      displayWidth: 600,
      displayHeight: 450,
      belowFold: false,
      loading: '',
      fetchPriority: '',
    },
    {
      element: { tag: 'IMG', marker: 'avb-s:0.5', label: '' },
      url: 'http://localhost:4321/a.webp',
      naturalWidth: 600,
      naturalHeight: 400,
      displayWidth: 600,
      displayHeight: 400,
      belowFold: true,
      loading: '',
      fetchPriority: '',
    },
  ],
  fontsWithoutDisplay: ['Inter'],
  devicePixelRatio: 1,
};

test('a measurement parses at the boundary, scores, and becomes findings with fixes where they are deterministic', () => {
  const measurement = parseMeasurement(REPORT);
  assert.equal(performanceScore(measurement), 100 - 15 - 10 - 10 - 5);
  const findings = performanceFindings(measurement, { file: 'src/pages/index.astro', route: '/' });
  const checks = findings.map((finding) => finding.check).sort();
  assert.deepEqual(checks, [
    'perf-blocking',
    'perf-cls',
    'perf-fetchpriority',
    'perf-font-display',
    'perf-image-format',
    'perf-image-size',
    'perf-lazy',
    'perf-lcp',
    'perf-tbt',
    'perf-third-party',
    'perf-weight',
  ]);
  const lazy = findings.find((finding) => finding.check === 'perf-lazy');
  assert.deepEqual(lazy?.fix?.edits, [{ tag: 'attributes', path: [0, 5], expect: 'img', patch: { loading: { type: 'string', value: 'lazy' } } }]);
  assert.equal(findings.find((finding) => finding.check === 'perf-cls')?.file, 'src/components/Banner.astro', 'located by the dev server’s marker');
  assert.equal(performanceScore({ lcpMs: 1_000, cls: 0, tbtMs: 0, transferBytes: 0, requests: 1 }), 100);
  assert.throws(() => parseMeasurement({ ...REPORT, cls: -1 }), /cls/);
  assert.throws(() => parseMeasurement({ ...REPORT, images: 'x' }), /images: expected an array/);
  assert.throws(() => parseMeasurement(undefined), /expected an object/);
  assert.equal(parseMeasurement({ ...REPORT, images: Array.from({ length: 500 }, () => REPORT.images[0]) }).images.length, 200, 'bounded');
});

test('only root and theme variables in stylesheets are offered as tokens; private and component ones never are', () => {
  const files = [
    {
      rel: 'src/styles/tokens.css',
      declarations: [
        {
          selector: ':root',
          entries: [
            { kind: 'var', name: '--radius-small', value: '6px' },
            { kind: 'var', name: '--_private', value: '6px' },
          ],
        },
        { selector: '.button', entries: [{ kind: 'var', name: '--button-pad', value: '6px' }] },
      ],
    },
    { rel: 'src/styles/theme.css', declarations: [{ selector: '[data-theme="dark"], .theme-dark', entries: [{ kind: 'var', name: '--ink', value: '#fff' }] }] },
    { rel: 'src/components/Button.astro', declarations: [{ selector: ':root', entries: [{ kind: 'var', name: '--size', value: '1.5em' }] }] },
  ];
  assert.deepEqual(
    [...tokenVariables(files)],
    [
      ['--radius-small', '6px'],
      ['--ink', '#fff'],
    ],
  );
  assert.deepEqual([...tokenVariables('not files')], []);
});
