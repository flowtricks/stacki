// Goal: every static audit check flags exactly the markup it is about, leaves
// alone the markup that is fine or that only the render can judge (expressions,
// spreads, components, slots), and every deterministic fix plans the edit the
// rule names, with a before and after preview.
// Method: parse real .astro sources with the editor's own parser (located, so
// lines are known), run `auditFile` against fixed facts, and for each check pin
// a positive fixture, a negative one, and the negative made invalid by one
// change; then pin each fix's patch and preview, and the bounds and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { auditFile, destructuresProp, frameHost, markedDecorative, routeExists, type AuditFacts } from '#dist/shared/page/auditStatic.js';
import type { AuditFinding } from '#dist/shared/page/auditFindings.js';
import { DEFAULT_PLACEHOLDERS, DEFAULT_TOKEN_SETTINGS } from '#dist/shared/properties/auditIgnores.js';

const facts = (over: { readonly routes?: AuditFacts['routes']; readonly site?: AuditFacts['site'] } = {}): AuditFacts => ({
  routes: ['/', '/about', '/blog/[slug]', '/docs/[...path]'],
  publicFiles: new Map([
    ['/hero.png', 2_000],
    ['/big.jpg', 900 * 1024],
    ['/files/guide.pdf', 10],
  ]),
  imageSizes: new Map([['/hero.png', { width: 800, height: 600 }]]),
  site: { title: { name: 'SITE_TITLE', value: 'Acme & Co', module: '../consts' }, description: undefined, lang: 'en-GB' },
  noindexRoutes: ['/private'],
  tokens: DEFAULT_TOKEN_SETTINGS,
  variables: new Map([
    ['--color-ink', '#121212'],
    ['--color-neutral-900', '#121212'],
    ['--space-m', '1rem'],
  ]),
  placeholders: DEFAULT_PLACEHOLDERS,
  ...over,
});

function audit(
  source: string,
  options: { readonly kind?: 'page' | 'component' | 'layout'; readonly route?: string | undefined; readonly facts?: AuditFacts } = {},
) {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, 'the fixture parses');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  return auditFile(
    {
      file: 'src/pages/index.astro',
      kind: options.kind ?? 'page',
      nodes: parsed.model.nodes,
      imports: parsed.model.imports,
      frontmatter,
      source,
      route: 'route' in options ? options.route : '/',
    },
    options.facts ?? facts(),
  );
}

const checks = (source: string, options?: Parameters<typeof audit>[1]) => audit(source, options).findings.map((finding): string => finding.check);
const only = (source: string, check: string, options?: Parameters<typeof audit>[1]): AuditFinding => {
  const found = audit(source, options).findings.filter((finding) => finding.check === check);
  assert.equal(found.length, 1, `exactly one ${check} in ${source}`);
  const [first] = found;
  assert.ok(first !== undefined);
  return first;
};

// [check, flagged, fine, fine made invalid by one change]
const CASES: readonly (readonly [string, string, string, string])[] = [
  ['img-alt', '<img src="/x.png">', '<img src="/x.png" alt="A cat">', '<img src="/x.png" alt2="A cat">'],
  [
    'img-decorative',
    '<img src="/x.png" role="presentation" alt="Swirl">',
    '<img src="/x.png" role="presentation" alt="">',
    '<img src="/x.png" role="presentation" alt="x">',
  ],
  ['link-name', '<a href="/about"></a>', '<a href="/about">About us</a>', '<a href="/about"> </a>'],
  ['button-name', '<button></button>', '<button>Save</button>', '<button><span></span></button>'],
  [
    'svg-button-label',
    '<button><svg viewBox="0 0 1 1"></svg></button>',
    '<button aria-label="Close"><svg viewBox="0 0 1 1"></svg></button>',
    '<button aria-label=""><svg viewBox="0 0 1 1"></svg></button>',
  ],
  ['control-label', '<input type="text" name="q">', '<label>Search <input type="text" name="q"></label>', '<label>Search</label><input type="text" name="q">'],
  ['heading-order', '<h2>A</h2><h4>B</h4>', '<h2>A</h2><h3>B</h3>', '<h2>A</h2><h3>B</h3><h5>C</h5>'],
  ['h1-count', '<h1>A</h1><h1>B</h1>', '<h1>A</h1><h2>B</h2>', '<h1>A</h1><h2>B</h2><h1>C</h1>'],
  ['html-lang', '<html><body></body></html>', '<html lang="en"><body></body></html>', '<html lang=""><body></body></html>'],
  ['duplicate-id', '<p id="a">1</p><p id="a">2</p>', '<p id="a">1</p><p id="b">2</p>', '<p id="a">1</p><p id="b">2</p><p id="b">3</p>'],
  ['aria-role', '<div role="buton">x</div>', '<div role="button" tabindex="0">x</div>', '<div role="buttons" tabindex="0">x</div>'],
  ['aria-hidden-focusable', '<a href="/" aria-hidden="true">Home</a>', '<span aria-hidden="true">★</span>', '<span aria-hidden="true" tabindex="0">★</span>'],
  ['tabindex-positive', '<div tabindex="3">x</div>', '<div tabindex="0">x</div>', '<div tabindex="1">x</div>'],
  [
    'video-autoplay',
    '<video src="/v.mp4" autoplay></video>',
    '<video src="/v.mp4" autoplay muted controls></video>',
    '<video src="/v.mp4" autoplay muted></video>',
  ],
  [
    'iframe-title',
    '<iframe src="https://www.youtube.com/embed/x"></iframe>',
    '<iframe src="https://www.youtube.com/embed/x" title="Intro video"></iframe>',
    '<iframe src="https://www.youtube.com/embed/x" title=" "></iframe>',
  ],
  [
    'img-dimensions',
    '<img src="/hero.png" alt="Hero">',
    '<img src="/hero.png" alt="Hero" width="800" height="600">',
    '<img src="/hero.png" alt="Hero" width="800">',
  ],
  [
    'img-large',
    '<img src="/big.jpg" alt="Big" width="1" height="1">',
    '<img src="/hero.png" alt="Hero" width="800" height="600">',
    '<img src="/big.jpg" alt="Hero" width="800" height="600">',
  ],
  ['link-broken', '<a href="/missing">Missing page</a>', '<a href="/blog/first-post">First post</a>', '<a href="/blog/first-post/extra">First post</a>'],
  ['link-text', '<a href="/about">Click here</a>', '<a href="/about">About the team</a>', '<a href="/about">Read more…</a>'],
  [
    'link-noopener',
    '<a href="https://example.com" target="_blank">Example site</a>',
    '<a href="https://example.com" target="_blank" rel="noopener">Example site</a>',
    '<a href="https://example.com" target="_blank" rel="external">Example site</a>',
  ],
  [
    'title-missing',
    '<html lang="en"><head><meta name="description" content="x"></head></html>',
    '<html lang="en"><head><title>Home</title></head></html>',
    '<html lang="en"><head><title></title></head></html>',
  ],
  [
    'description-missing',
    '<html lang="en"><head><title>Home</title></head></html>',
    '<html lang="en"><head><title>Home</title><meta name="description" content="A description that is long enough to sit inside the snippet range."></head></html>',
    '<html lang="en"><head><title>Home</title><meta name="description" content=""></head></html>',
  ],
  [
    'description-short',
    '<html lang="en"><head><title>Home</title><meta name="description" content="Too short"></head></html>',
    '<html lang="en"><head><title>Home</title><meta name="description" content="A description that is long enough to sit inside the snippet range."></head></html>',
    '<html lang="en"><head><title>Home</title><meta name="description" content="Now too short again"></head></html>',
  ],
  [
    'description-long',
    `<html lang="en"><head><title>Home</title><meta name="description" content="${'Long '.repeat(40)}"></head></html>`,
    '<html lang="en"><head><title>Home</title><meta name="description" content="A description that is long enough to sit inside the snippet range."></head></html>',
    `<html lang="en"><head><title>Home</title><meta name="description" content="${'Longer '.repeat(30)}"></head></html>`,
  ],
  [
    'canonical',
    '<html lang="en"><head><title>T</title></head></html>',
    '<html lang="en"><head><title>T</title><link rel="canonical" href="https://a.example/"></head></html>',
    '<html lang="en"><head><title>T</title><link rel="stylesheet" href="https://a.example/"></head></html>',
  ],
  [
    'social-tags',
    '<html lang="en"><head><title>T</title></head></html>',
    '<html lang="en"><head><title>T</title><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="/i.png"><meta name="twitter:card" content="summary"></head></html>',
    '<html lang="en"><head><title>T</title><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="/i.png"></head></html>',
  ],
  [
    'noindex',
    '<html lang="en"><head><meta name="robots" content="noindex, follow"></head></html>',
    '<html lang="en"><head><meta name="robots" content="index, follow"></head></html>',
    '<html lang="en"><head><meta name="robots" content="NOINDEX"></head></html>',
  ],
];

for (const [check, flagged, fine, broken] of CASES) {
  test(`${check}: flags the bad shape, passes the good one, and flags it once it breaks`, () => {
    assert.ok(checks(flagged).includes(check), `flagged: ${flagged}`);
    assert.ok(!checks(fine).includes(check), `fine: ${fine}`);
    assert.ok(checks(broken).includes(check), `broken: ${broken}`);
  });
}

test('what only the render knows is never flagged statically', () => {
  for (const source of [
    '<img src="/x.png" {...rest}>',
    '<img src="/x.png" alt={alt}>',
    '<a href="/about">{label}</a>',
    '<a href="/about"><Icon /></a>',
    '<a href="/about"><slot /></a>',
    '<button aria-label={label}></button>',
    '<input type="text" id={id}>',
    '<input type="hidden" name="token">',
    '<html lang={lang}></html>',
    '<a href={url}>Go somewhere useful</a>',
  ]) {
    const found = checks(source).filter((check) => ['img-alt', 'link-name', 'button-name', 'control-label', 'html-lang', 'link-broken'].includes(check));
    assert.deepEqual(found, [], source);
  }
  // A head that renders a component may write any of its tags.
  const head = checks('<html lang="en"><head><BaseHead /></head></html>');
  for (const check of ['title-missing', 'description-missing', 'canonical', 'social-tags']) {
    assert.ok(!head.includes(check), check);
  }
});

test('a control is labelled by <label for>, a wrapping label, or an ARIA label', () => {
  assert.ok(!checks('<label for="q">Search</label><input id="q" type="search">').includes('control-label'));
  assert.ok(!checks('<input type="email" aria-label="Email">').includes('control-label'));
  assert.ok(checks('<label for="other">Search</label><input id="q" type="search">').includes('control-label'));
  assert.match(only('<input type="email" placeholder="Email">', 'control-label').detail, /only a placeholder/);
});

test('findings carry the element’s path, tag and line', () => {
  const finding = only('<div>\n  <p>x</p>\n  <img src="/x.png">\n</div>', 'img-alt');
  assert.equal(finding.element?.tag, 'img');
  assert.equal(finding.element?.line, 3);
  assert.equal(finding.file, 'src/pages/index.astro');
  assert.equal(finding.source, 'static');
  assert.ok(finding.id.startsWith('img-alt|src/pages/index.astro|'));
  assert.equal(finding.fix, undefined, 'meaningful alt text is never guessed');
});

test('a decorative image gets alt="" and a presentational role only when marked decorative', () => {
  const hidden = only('<img src="/x.png" aria-hidden="true">', 'img-alt');
  assert.deepEqual(hidden.fix?.edits, [
    { tag: 'attributes', path: [0], expect: 'img', patch: { alt: { type: 'string', value: '' }, role: { type: 'string', value: 'presentation' } } },
  ]);
  assert.equal(hidden.fix?.after, '<img src="/x.png" aria-hidden="true" alt="" role="presentation">');
  const roled = only('<img src="/x.png" role="none">', 'img-alt');
  assert.deepEqual(Object.keys(roled.fix?.edits[0]?.tag === 'attributes' ? roled.fix.edits[0].patch : {}), ['alt'], 'a written role is kept');
  assert.equal(markedDecorative({ class: { type: 'string', value: 'hero decorative' } }), true);
  assert.equal(markedDecorative({ class: { type: 'string', value: 'hero' } }), false);
});

test('lang comes from the site constant, else en', () => {
  assert.equal(only('<html><body></body></html>', 'html-lang').fix?.after, '<html lang="en-GB">');
  const plain = audit('<html><body></body></html>', { facts: facts({ site: { title: undefined, description: undefined, lang: undefined } }) });
  assert.equal(plain.findings[0]?.fix?.after, '<html lang="en">');
});

test('width and height come from the image file, the missing side from its aspect ratio', () => {
  const both = only('<img src="/hero.png" alt="Hero">', 'img-dimensions');
  assert.equal(both.fix?.after, '<img src="/hero.png" alt="Hero" width="800" height="600">');
  const one = only('<img src="/hero.png" alt="Hero" width="400">', 'img-dimensions');
  assert.equal(one.fix?.label, 'Add height="300"');
  const percent = only('<img src="/hero.png" alt="Hero" width="100%">', 'img-dimensions');
  assert.equal(percent.fix, undefined, 'a CSS length says nothing about the other side');
  const unknown = only('<img src="/other.png" alt="Other">', 'img-dimensions');
  assert.equal(unknown.fix, undefined, 'no file size known, no fix');
});

test('duplicate ids are renamed only when nothing points at them', () => {
  const renamed = only('<p id="a">1</p><p id="a">2</p><p id="a-2">3</p>', 'duplicate-id');
  assert.equal(renamed.fix?.label, 'Rename to "a-3"', 'the rename skips ids the file already holds');
  const referenced = only('<label for="a">A</label><input id="a" type="text"><input id="a" type="text">', 'duplicate-id');
  assert.equal(referenced.fix, undefined);
  assert.match(only('{items.map((item) => <li id="row">{item}</li>)}', 'duplicate-id').detail, /loop/);
});

test('a positive tabindex is removed from focusable elements and set to 0 elsewhere', () => {
  assert.deepEqual(only('<button tabindex="2">Go</button>', 'tabindex-positive').fix?.edits[0], {
    tag: 'attributes',
    path: [0],
    expect: 'button',
    patch: { tabindex: undefined },
  });
  assert.equal(only('<div tabindex="2">x</div>', 'tabindex-positive').fix?.after, '<div tabindex="0">');
});

test('autoplay gets muted and controls; frames get a title from their host; new tabs get noopener', () => {
  assert.equal(only('<video src="/v.mp4" autoplay></video>', 'video-autoplay').fix?.after, '<video src="/v.mp4" autoplay muted controls>');
  assert.equal(
    only('<iframe src="https://www.youtube.com/embed/x"></iframe>', 'iframe-title').fix?.after,
    '<iframe src="https://www.youtube.com/embed/x" title="Embedded content from youtube.com">',
  );
  assert.equal(only('<iframe src="/local.html"></iframe>', 'iframe-title').fix, undefined, 'a relative source names no host');
  assert.equal(
    only('<a href="https://x.example" target="_blank" rel="external">X site</a>', 'link-noopener').fix?.after,
    '<a href="https://x.example" target="_blank" rel="external noopener">',
  );
  assert.equal(frameHost('https://www.vimeo.com/1'), 'vimeo.com');
  assert.equal(frameHost('//cdn.example/x'), undefined);
});

test('a missing title or description is written from a prop, an imported constant, or the constant’s value', () => {
  const layout = `---\nconst { title, description } = Astro.props;\n---\n<html lang="en"><head></head></html>`;
  assert.deepEqual(only(layout, 'title-missing').fix?.edits[0], {
    tag: 'append-child',
    path: [0, 0],
    expect: 'head',
    element: { name: 'title', props: {}, content: { kind: 'expr', value: 'title' } },
  });
  assert.equal(only(layout, 'description-missing').fix?.after, '<head> … <meta name="description" content={description} /> </head>');
  const imported = `---\nimport { SITE_TITLE } from '../consts';\n---\n<html lang="en"><head></head></html>`;
  assert.equal(only(imported, 'title-missing').fix?.after, '<head> … <title>{SITE_TITLE}</title> </head>');
  assert.equal(only('<html lang="en"><head></head></html>', 'title-missing').fix?.after, '<head> … <title>Acme & Co</title> </head>');
  assert.equal(only('<html lang="en"><head></head></html>', 'description-missing').fix, undefined, 'no description anywhere: nothing is invented');
  assert.equal(only('<html lang="en"><head></head></html>', 'canonical').fix?.label, 'Add canonical link');
});

test('noindex respects the project’s own list, and says when a layout hides every page', () => {
  const head = '<html lang="en"><head><meta name="robots" content="noindex"></head></html>';
  assert.ok(!checks(head, { route: '/private' }).includes('noindex'));
  assert.match(only(head, 'noindex', { kind: 'layout', route: undefined }).detail, /every page/);
});

test('internal links match static routes, dynamic segments, rest parameters and public files', () => {
  assert.equal(routeExists('/', ['/']), true);
  assert.equal(routeExists('/blog/a', ['/blog/[slug]']), true);
  assert.equal(routeExists('/blog/a/b', ['/blog/[slug]']), false);
  assert.equal(routeExists('/docs/a/b/c', ['/docs/[...path]']), true);
  assert.equal(routeExists('/about/', ['/about']), true);
  assert.ok(!checks('<a href="/files/guide.pdf">The guide</a>').includes('link-broken'));
  assert.ok(!checks('<a href="/missing">Missing</a>', { facts: facts({ routes: [] }) }).includes('link-broken'), 'no routes known: nothing is judged');
});

test('Astro’s <Image> needs alt; the summary notes heads and structured data', () => {
  assert.ok(checks(`---\nimport { Image } from 'astro:assets';\n---\n<Image src={hero} />`).includes('img-alt'));
  assert.ok(!checks(`---\nimport { Image } from './Image.astro';\n---\n<Image src={hero} />`).includes('img-alt'));
  const summary = audit('<html lang="en"><head><title>T</title><script type="application/ld+json">{}</script></head></html>').summary;
  assert.deepEqual(summary, { structuredData: true, head: true });
});

test('destructuresProp reads Astro.props destructuring, renames and defaults included', () => {
  assert.equal(destructuresProp('const { title = "x", other } = Astro.props;', 'title'), true);
  assert.equal(destructuresProp('const { heading: title } = Astro.props;', 'title'), false);
  assert.equal(destructuresProp('const title = Astro.props.title;', 'title'), false);
  assert.throws(() => destructuresProp('', 'not a name'), /identifier/);
});

test('placeholder copy is found in elements, component slots and copy props, not in code or settings', () => {
  const placeholders = (source: string) => audit(source).findings.filter((finding) => finding.check === 'placeholder-text');
  // Text passed to a component's slot is located at the instance.
  const [slotted] = placeholders('---\nimport Button from "../components/Button.astro";\n---\n<Button href="/">\n  Button Text\n</Button>');
  assert.equal(slotted?.element?.tag, 'Button');
  assert.equal(slotted?.detail, '"Button Text"');
  assert.equal(placeholders('<p>Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>').length, 1);
  assert.equal(placeholders('<h2>Heading</h2>').length, 1);
  // A copy prop holds a single-word placeholder; a setting does not.
  const [prop] = placeholders('---\nimport Hero from "../components/Hero.astro";\n---\n<Hero heading="Heading" variant="heading" />');
  assert.equal(prop?.prop, 'heading');
  assert.equal(prop?.detail, 'heading="Heading"');
  assert.equal(placeholders('---\nimport Card from "../components/Card.astro";\n---\n<Card variant="heading" />').length, 0);
  assert.equal(placeholders('---\nimport Card from "../components/Card.astro";\n---\n<Card intro="Your text here, please" />').length, 1);
  // Real copy, the placeholder attribute, code and the head stay quiet; phrases match whole words.
  assert.deepEqual(placeholders('<p>Our heading sets the tone</p><input placeholder="Placeholder"><code>lorem ipsum</code><p>Dolorem ipsumque</p>'), []);
  assert.deepEqual(placeholders('<html><head><title>Heading</title></head><body><h1>Real</h1></body></html>'), []);
  assert.equal(placeholders('<img src="/hero.png" alt="Placeholder">').length, 1);
});
