// Goal: one link verdict serves every pass, and a broken link set on a component
// instance is found at that instance. Internal paths resolve against the routes
// (dynamic and rest segments included), public files, the trailing-slash rule and
// the base; fragments on the page are judged, `#` and `#top` are not; relative
// links resolve against the page; other origins and schemes are not judged. An
// instance's literal prop is followed only where the component writes it straight
// into an `<a href>` (or passes it unchanged to a nested component that does);
// a rewritten, spread, missing or non-string prop is not a finding.
// The rendered pass hands on every link the page renders that the project does not
// serve, with the instances it rendered inside, and the trace climbs those very
// instances: the second Button's own href, Card's link passed on to Button.
// Method: pin `linkTarget` for each kind of href, positive and negative, then
// parse real .astro fixtures (a Button, a Card that passes `link` on to Button, a
// Prefixed button that rewrites its href, a Spread button) with the editor's
// parser and run `instanceLinkFindings` over them, pinning each finding's file,
// path, tag, prop and detail, and the cases that must find nothing; build rendered
// trees by hand (the shape renderedDom.ts makes) and trace them over the same files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { instanceLinkFindings, linkPropsOf, linkTarget, routeExists, type LinkFacts } from '#dist/shared/page/auditLinks.js';
import type { AuditFileInput } from '#dist/shared/page/auditStatic.js';
import { auditRenderedPage, type RenderedElement, type RenderedNode } from '#dist/shared/page/auditRendered.js';
import { traceThrough } from '#dist/shared/page/auditTrace.js';

const FACTS: LinkFacts = {
  routes: ['/', '/about', '/blog/[slug]', '/docs/[...path]'],
  publicFiles: new Set(['/files/guide.pdf']),
};

test('internal paths resolve against routes, dynamic segments and public files', () => {
  assert.deepEqual(linkTarget('/about', FACTS, '/'), { tag: 'found', url: '/about', route: '/about', id: undefined });
  assert.deepEqual(linkTarget('/about/', FACTS, '/'), { tag: 'found', url: '/about/', route: '/about/', id: undefined }, 'a trailing slash is the same page');
  assert.equal(linkTarget('/blog/first-post', FACTS, '/').tag, 'found', 'a dynamic segment takes any value');
  assert.equal(linkTarget('/docs/a/b/c', FACTS, '/').tag, 'found', 'a rest segment takes any depth');
  assert.equal(linkTarget('/files/guide.pdf', FACTS, '/').tag, 'found', 'a public file');
  assert.equal(linkTarget('/about?tab=team', FACTS, '/').tag, 'found', 'a query does not change the page');
  assert.deepEqual(linkTarget('/abuot', FACTS, '/'), { tag: 'missing', url: '/abuot' });
  assert.equal(linkTarget('/blog/first-post/extra', FACTS, '/').tag, 'missing', 'one segment past a dynamic route');
  assert.equal(linkTarget('/files/missing.pdf', FACTS, '/').tag, 'missing');
  assert.equal(routeExists('/blog/a', ['/blog/[slug]']), true);
});

test('fragments: on the page they are judged, on another page they travel with the path', () => {
  assert.deepEqual(linkTarget('#team', FACTS, '/'), { tag: 'here', id: 'team' });
  assert.deepEqual(linkTarget('#', FACTS, '/'), { tag: 'ignored' });
  assert.deepEqual(linkTarget('#top', FACTS, '/'), { tag: 'ignored' }, '#top scrolls to the top of any page');
  assert.deepEqual(linkTarget('/about#team', FACTS, '/'), { tag: 'found', url: '/about', route: '/about', id: 'team' });
  assert.deepEqual(linkTarget('/nowhere#team', FACTS, '/'), { tag: 'missing', url: '/nowhere' });
});

test('relative links resolve against the page; without a page or on a pattern they are not judged', () => {
  assert.equal(linkTarget('about', FACTS, '/').tag, 'found');
  assert.deepEqual(linkTarget('team', FACTS, '/about'), { tag: 'missing', url: '/team' });
  assert.equal(linkTarget('../about', FACTS, '/blog/').tag, 'found');
  assert.equal(linkTarget('team', FACTS, undefined).tag, 'ignored', 'in a component the page is not known');
  assert.equal(linkTarget('team', FACTS, '/blog/[slug]').tag, 'ignored', 'a route pattern is not a page');
});

test('other origins, schemes and generated files are not judged', () => {
  for (const href of [
    'https://example.com/missing',
    '//cdn.example/x',
    'mailto:a@b.example',
    'tel:+15551234',
    'javascript:void(0)',
    'data:text/plain,x',
    '',
    '   ',
  ]) {
    assert.deepEqual(linkTarget(href, FACTS, '/'), { tag: 'ignored' }, href);
  }
  assert.deepEqual(linkTarget('/_astro/chunk.js', FACTS, '/'), { tag: 'ignored' });
  assert.deepEqual(linkTarget('/missing', { ...FACTS, routes: [] }, '/'), { tag: 'ignored' }, 'no routes known: nothing is judged');
});

test('the trailing-slash rule and the base make the other spelling a 404', () => {
  assert.equal(linkTarget('/about', { ...FACTS, trailingSlash: 'always' }, '/').tag, 'missing');
  assert.equal(linkTarget('/about/', { ...FACTS, trailingSlash: 'always' }, '/').tag, 'found');
  assert.equal(linkTarget('/about/', { ...FACTS, trailingSlash: 'never' }, '/').tag, 'missing');
  assert.equal(linkTarget('/files/guide.pdf', { ...FACTS, trailingSlash: 'always' }, '/').tag, 'found', 'a file keeps its name');
  assert.equal(linkTarget('/', { ...FACTS, trailingSlash: 'never' }, '/').tag, 'found', 'the root is always /');
  const based = { ...FACTS, base: '/docs-site' };
  assert.deepEqual(linkTarget('/docs-site/about', based, '/'), { tag: 'found', url: '/docs-site/about', route: '/about', id: undefined });
  assert.deepEqual(linkTarget('/about', based, '/'), { tag: 'missing', url: '/about' }, 'outside the base');
  assert.equal(linkTarget('/docs-site', based, '/').tag, 'found', 'the base itself is the home page');
});

function file(name: string, kind: AuditFileInput['kind'], source: string, route?: string): AuditFileInput {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, `${name} parses`);
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  return { file: name, kind, nodes: parsed.model.nodes, imports: parsed.model.imports, frontmatter, source, route };
}

const BUTTON = file(
  'src/components/Button.astro',
  'component',
  `---\nconst { href, element = 'link', label } = Astro.props;\n---\n{element === 'link' ? <a href={href}>{label}<slot /></a> : <button>{label}</button>}`,
);
const SHORTHAND = file('src/components/Short.astro', 'component', `---\nconst { href } = Astro.props;\n---\n<a {href}><slot /></a>`);
const CARD = file(
  'src/components/Card.astro',
  'component',
  `---\nimport Button from './Button.astro';\nconst { link, title } = Astro.props;\n---\n<div><h3>{title}</h3><Button href={link} /></div>`,
);
const PREFIXED = file('src/components/Prefixed.astro', 'component', '---\nconst { href } = Astro.props;\n---\n<a href={`/en${href}`}>Go</a>');
const SPREAD = file('src/components/Spread.astro', 'component', '---\nconst props = Astro.props;\n---\n<a {...props}>Go</a>');
const COMPONENTS = [BUTTON, SHORTHAND, CARD, PREFIXED, SPREAD];
const IMPORTS = COMPONENTS.map(
  (entry) => `import ${entry.file.split('/').pop()?.replace('.astro', '')} from '../components/${entry.file.split('/').pop()}';`,
).join('\n');
const resolve = (from: AuditFileInput, tag: string) => {
  const decl = from.imports.find((entry) => entry.name === tag);
  return decl === undefined ? undefined : COMPONENTS.find((entry) => entry.file.endsWith(`/${decl.path.split('/').pop()}`))?.file;
};
const findingsFor = (markup: string, route = '/') => {
  const page = file('src/pages/index.astro', 'page', `---\n${IMPORTS}\n---\n${markup}`, route);
  const files = new Map([page, ...COMPONENTS].map((entry) => [entry.file, entry]));
  return instanceLinkFindings({ files, resolve, facts: FACTS });
};

test('a component writes these props straight into a link, directly or through a nested component', () => {
  const files = new Map(COMPONENTS.map((entry) => [entry.file, entry]));
  const memo = new Map<string, ReadonlySet<string>>();
  assert.deepEqual([...linkPropsOf(BUTTON, { files, resolve }, memo, 0)], ['href']);
  assert.deepEqual([...linkPropsOf(SHORTHAND, { files, resolve }, memo, 0)], ['href'], '`{href}` is `href={href}`');
  assert.deepEqual([...linkPropsOf(CARD, { files, resolve }, memo, 0)], ['link'], 'Card passes `link` on to Button’s href');
  assert.deepEqual([...linkPropsOf(PREFIXED, { files, resolve }, memo, 0)], [], 'a rewritten href is the render’s to judge');
  assert.deepEqual([...linkPropsOf(SPREAD, { files, resolve }, memo, 0)], [], 'a spread is the render’s to judge');
});

test('a broken prop href is one finding per instance, at the instance, with its prop', () => {
  const found = findingsFor('<main><Button href="/abuot" label="One" /><Button href="/about" label="Two" /><Button href="/gone">Three</Button></main>');
  assert.deepEqual(
    found.map((finding) => [finding.file, finding.element?.path, finding.element?.tag, finding.prop, finding.detail, finding.fileKind]),
    [
      ['src/pages/index.astro', [0, 0], 'Button', 'href', 'href="/abuot"', 'page'],
      ['src/pages/index.astro', [0, 2], 'Button', 'href', 'href="/gone"', 'page'],
    ],
  );
  assert.equal(typeof found[0]?.element?.line, 'number', 'located on its line');
});

test('nested components and shorthand bindings are followed; a valid href is not a finding', () => {
  const nested = findingsFor('<Card title="A" link="/nope" /><Card title="B" link="/blog/hello" />');
  assert.deepEqual(
    nested.map((finding) => [finding.element?.path, finding.prop]),
    [[[0], 'link']],
  );
  assert.equal(findingsFor('<Short href="/missing">Go</Short>').length, 1);
  assert.equal(findingsFor('<Short href="/about">Go</Short>').length, 0);
});

test('negative space: missing, expression, non-string, rewritten, spread and outside props are not findings', () => {
  assert.deepEqual(findingsFor('<Button label="No href" />'), [], 'missing prop');
  assert.deepEqual(findingsFor('<Button href={`/blog/${slug}`} />'), [], 'expression href: only the render knows it');
  assert.deepEqual(findingsFor('<Button href={42} />'), [], 'non-string value');
  assert.deepEqual(findingsFor('<Button {...cta} />'), [], 'spread props');
  assert.deepEqual(findingsFor('<Prefixed href="/missing" />'), [], 'the component rewrites it');
  assert.deepEqual(findingsFor('<Spread href="/missing" />'), [], 'the component spreads its props');
  assert.deepEqual(findingsFor('<Button label="/missing" />'), [], 'a prop the component does not link');
  assert.deepEqual(findingsFor('<Button href="https://example.com/missing" />'), [], 'another origin');
  assert.deepEqual(findingsFor('<Button href="mailto:hi@example.com" />'), [], 'mailto');
  assert.deepEqual(findingsFor('<Button href="#team" />'), [], 'a fragment is the render’s to judge');
  assert.deepEqual(findingsFor('<Unknown href="/missing" />'), [], 'a component the run did not read');
});

test('relative prop links resolve against the page they are on', () => {
  assert.equal(findingsFor('<Button href="team" />', '/about').length, 1);
  assert.equal(findingsFor('<Button href="about" />', '/').length, 0);
  assert.equal(findingsFor('<Button href="team" />', '/blog/[slug]').length, 0, 'a pattern is not a page');
});

// --- The rendered pass and the trace back to the instance ----------------------------------

type Child = RenderedNode | string;
const element = (tag: string, attrs: Record<string, string> = {}, children: readonly Child[] = [], source?: RenderedElement['source']): RenderedElement => ({
  kind: 'element',
  tag,
  attrs,
  children: children.map((child) => (typeof child === 'string' ? { kind: 'text', value: child } : child)),
  source,
  style: undefined,
});
const HEAD = element('head', {}, [element('title', {}, ['Home'])]);
const renderedLinks = (body: readonly Child[], route = '/') =>
  auditRenderedPage(
    { file: 'src/pages/index.astro', route, root: element('html', { lang: 'en' }, [HEAD, element('body', {}, body)]) },
    { noindexRoutes: [], placeholders: [], links: FACTS },
  );

test('the rendered pass hands on every link the project does not serve, wherever it was written', () => {
  const inButton = { file: BUTTON.file, path: [0, 0], within: [{ file: 'src/pages/index.astro', path: [0, 1] }] };
  const audit = renderedLinks([
    element('section', { id: 'team' }, [element('a', { href: '#team' }, ['Team'])]),
    element('a', { href: '/abuot' }, ['Button'], inButton),
    element('a', { href: '#nowhere' }, ['Jump']),
    element('a', { href: '/about#team' }, ['Their team']),
    element('a', { href: '/about' }, ['About']),
    element('a', { href: 'https://example.com/x' }, ['Out']),
    element('a', { href: 'mailto:a@b.example' }, ['Mail']),
    element('a', { name: 'legacy' }, ['Old anchor']),
    element('a', { href: '#legacy' }, ['To the old anchor']),
  ]);
  assert.deepEqual(
    audit.links.map((link) => [link.finding.detail, link.target]),
    [
      ['href="/abuot"', { tag: 'missing', url: '/abuot' }],
      ['href="#nowhere"', { tag: 'fragment', route: '/', id: 'nowhere' }],
      ['href="/about#team"', { tag: 'fragment', route: '/about', id: 'team' }],
    ],
  );
  const [button] = audit.links;
  assert.equal(button?.finding.file, BUTTON.file, 'located at the element its marker names');
  assert.deepEqual(button?.within, inButton.within, 'with the instance it rendered inside');
  assert.deepEqual(button?.finding.routes, ['/']);
  assert.ok(audit.ids.includes('team'));
  assert.ok(audit.ids.includes('legacy'), 'an <a name> is a fragment target');
  assert.ok(!audit.findings.some((finding) => finding.check === 'link-broken'), 'links are the runner’s to report');
  const unjudged = auditRenderedPage(
    {
      file: 'src/pages/index.astro',
      route: '/',
      root: element('html', { lang: 'en' }, [HEAD, element('body', {}, [element('a', { href: '/abuot' }, ['x'])])]),
    },
    { noindexRoutes: [], placeholders: [] },
  );
  assert.deepEqual(unjudged.links, [], 'without link facts nothing is judged');
});

test('a rendered href traces to the very instance that rendered it, through nested components', () => {
  const page = file(
    'src/pages/index.astro',
    'page',
    `---\n${IMPORTS}\n---\n<main><Button href="/one" /><Button href="/two" /><Card link="/three" /><Card><Button href="/four" /></Card></main>`,
    '/',
  );
  const files = new Map([page, ...COMPONENTS].map((entry) => [entry.file, entry]));
  const leaf = { file: BUTTON.file, path: [0, 0, 0], attr: 'href' };
  const second = traceThrough({
    files,
    resolve,
    within: [
      { file: page.file, path: [0] },
      { file: page.file, path: [0, 1] },
    ],
    leaf,
  });
  assert.deepEqual(second, { kind: 'node', file: page.file, path: [0, 1], tag: 'Button', prop: 'href' }, 'the second Button, not the first');
  const nested = traceThrough({
    files,
    resolve,
    within: [
      { file: page.file, path: [0] },
      { file: page.file, path: [0, 2] },
      { file: CARD.file, path: [0] },
      { file: CARD.file, path: [0, 1] },
    ],
    leaf,
  });
  assert.deepEqual(nested, { kind: 'node', file: page.file, path: [0, 2], tag: 'Card', prop: 'link' }, 'Card’s link prop, passed on to Button');
  // Slot content: the Button is the page's own, passed through Card's markup; Card's markers are passed over.
  const slotted = traceThrough({
    files,
    resolve,
    within: [
      { file: page.file, path: [0, 3] },
      { file: CARD.file, path: [0] },
      { file: page.file, path: [0, 3, 0] },
    ],
    leaf,
  });
  assert.deepEqual(slotted, { kind: 'node', file: page.file, path: [0, 3, 0], tag: 'Button', prop: 'href' });
  // No instance named (an old preview without markers around it): the link in the component itself.
  assert.deepEqual(traceThrough({ files, resolve, within: [], leaf }), { kind: 'node', file: BUTTON.file, path: [0, 0, 0], tag: 'a', prop: undefined });
  const literal = file('src/components/Footer.astro', 'component', '<footer><a href="/gone">Gone</a></footer>');
  assert.deepEqual(
    traceThrough({
      files: new Map([[literal.file, literal]]),
      resolve,
      within: [{ file: page.file, path: [0] }],
      leaf: { file: literal.file, path: [0, 0], attr: 'href' },
    }),
    { kind: 'node', file: literal.file, path: [0, 0], tag: 'a', prop: undefined },
    'a literal in the component’s own markup is its own source',
  );
});
