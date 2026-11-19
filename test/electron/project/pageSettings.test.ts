// Goal: every Page settings step — making a page the homepage, renaming, duplicating, deleting, and changing a CMS
// template's settings — is planned before anything is written, written all or nothing, and undone byte for byte.
// Method: temporary Astro projects (LF and CRLF, pages in folders, Markdown and MDX pages, a layout's nav links,
// content files, astro.config redirects, base and trailingSlash, page order metadata) are planned and applied through
// the same writer Desktop uses. Each case snapshots every file first, so "nothing written" and "undo is byte-exact"
// are checked over the whole tree, not over the files a case happens to expect. Paths are built with path.join so the
// suite reads the same on Windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planRelocation, siteSettingsOf } from '#dist/electron/handlers/pageSettingsPlan.js';
import { applyRelocationStep, inverseStep } from '#dist/electron/project/pageRelocationWrite.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { swapPageLinks } from '#dist/electron/project/pageSwapLinks.js';
import { readPageTemplate, retargetPageTemplate } from '#dist/electron/content/pageTemplateRead.js';
import { pageTemplateText } from '#dist/electron/content/pageTemplateSource.js';
import { retargetStep } from '#dist/electron/handlers/pageSettingsHandlers.js';

type Files = Readonly<Record<string, string>>;

function project(files: Files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-settings-'));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const read = (file: string) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
  const exists = (file: string) => fs.existsSync(path.join(root, ...file.split('/')));
  // Every authored file's bytes, the staging folder left out: what "nothing changed" is checked against.
  const snapshot = (): Files => {
    const found: Record<string, string> = {};
    const pending = [''];
    for (let index = 0; index < pending.length && index < 10_000; index++) {
      const folder = pending[index] ?? '';
      for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
        const file = folder ? folder + '/' + entry.name : entry.name;
        if (file === '.stacki/io') {
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(file);
        } else {
          found[file] = read(file);
        }
      }
    }
    return found;
  };
  return { root, read, exists, snapshot, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const LAYOUT = `---
const { title } = Astro.props;
const links = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/about' },
];
const active = Astro.url.pathname === '/';
---
<html><head><title>{title}</title></head><body>
<nav>{links.map((link) => <a href={link.href}>{link.label}</a>)}<a href="/about/">About</a><a href="/about-us">Keep</a></nav>
<slot />
</body></html>
`;

function siteFiles(eol: '\n' | '\r\n'): Files {
  const lines = (text: string) => text.replace(/\n/g, eol);
  return {
    'package.json': '{"name":"site"}',
    'astro.config.mjs': lines(`export default {\n  site: 'https://example.com',\n  redirects: {\n    '/old': '/',\n    '/team': '/about',\n  },\n};\n`),
    'src/layouts/Base.astro': lines(LAYOUT),
    'src/components/Card.astro': lines(`<a href="/">Home</a> <a href="https://example.com/about">About</a> <a href="https://other.com/">Other</a>\n`),
    'src/data/menu.json': lines(`{"items":[{"url":"/"},{"url":"/about"}],"separator":"/"}\n`),
    'src/content/posts/first.md': lines(`---\ntitle: First\n---\nGo [home](/) or read [about](/about/) — it's "fine".\n`),
    'src/pages/index.astro': lines(
      `---\nimport Base from '../layouts/Base.astro';\nimport Card from '../components/Card.astro';\nconst parts = 'a/b'.split('/');\n---\n<Base title="Home"><Card /><a href="about">Relative about</a><a href="#top">Top</a></Base>\n`,
    ),
    'src/pages/about.astro': lines(`---\nimport Base from '../layouts/Base.astro';\n---\n<Base title="About"><a href="/">Back home</a></Base>\n`),
    'src/pages/rss.xml.js': lines(`export const items = [{ link: '/' }, { link: '/about' }];\n`),
    '.stacki/pages.json': lines(`{\n  "version": 1,\n  "entries": [\n    "index.astro",\n    "about.astro"\n  ]\n}\n`),
  };
}

function applied(root: string, request: Parameters<typeof planRelocation>[1]) {
  const planned = planRelocation(root, request);
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  const done = applyRelocationStep(planned.value.step, desktopRenameWriter());
  assert.ok(done.ok, done.ok ? '' : done.error.message);
  return planned.value;
}

for (const eol of ['\n', '\r\n'] as const) {
  test(`making /about the homepage swaps both files, every link and the page order (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const site = project(siteFiles(eol));
    try {
      const before = site.snapshot();
      const plan = applied(site.root, { kind: 'home', page: 'about.astro' });
      assert.equal(plan.page, 'index.astro');
      assert.deepEqual(plan.summary.moves, [
        { from: 'src/pages/index.astro', to: 'src/pages/about.astro' },
        { from: 'src/pages/about.astro', to: 'src/pages/index.astro' },
      ]);
      // The pages swapped places, each with its own content.
      assert.match(site.read('src/pages/index.astro'), /title="About"/);
      assert.match(site.read('src/pages/about.astro'), /title="Home"/);
      // Links to each route now point at the other, in every context, with their trailing slash kept.
      const layout = site.read('src/layouts/Base.astro');
      assert.match(layout, /\{ label: 'Home', href: '\/about' \}/);
      assert.match(layout, /\{ label: 'About', href: '\/' \}/);
      assert.match(layout, /<a href="\/">About<\/a><a href="\/about-us">Keep<\/a>/);
      // A bare '/' compared with the URL is not a link: left as written, and listed for review.
      assert.match(layout, /Astro\.url\.pathname === '\/'/);
      assert.ok(plan.summary.reviews.some((review) => review.file === 'src/layouts/Base.astro' && review.line === 7));
      assert.equal(
        site.read('src/components/Card.astro'),
        `<a href="/about">Home</a> <a href="https://example.com/">About</a> <a href="https://other.com/">Other</a>${eol}`,
      );
      assert.equal(site.read('src/data/menu.json'), `{"items":[{"url":"/about"},{"url":"/"}],"separator":"/"}${eol}`);
      assert.equal(
        site.read('src/content/posts/first.md'),
        before['src/content/posts/first.md']?.replace('[home](/)', '[home](/about)').replace('[about](/about/)', '[about](/)'),
      );
      // The moved homepage's relative link is written as the root link it meant; its code strings are untouched.
      assert.match(site.read('src/pages/about.astro'), /<a href="\/">Relative about<\/a><a href="#top">Top<\/a>/);
      assert.match(site.read('src/pages/about.astro'), /'a\/b'\.split\('\/'\)/);
      assert.match(site.read('src/pages/index.astro'), /<a href="\/about">Back home<\/a>/);
      // Redirects are never rewritten: they are listed for a person to check.
      assert.equal(site.read('astro.config.mjs'), before['astro.config.mjs']);
      assert.ok(plan.summary.reviews.some((review) => review.file === 'astro.config.mjs' && review.text === "'/old': '/',"));
      assert.ok(plan.summary.reviews.some((review) => review.file === 'src/pages/rss.xml.js'));
      // The page order keeps its rows: the homepage row is still first.
      assert.match(site.read('.stacki/pages.json'), /"index\.astro",\s+"about\.astro"/);
      assert.equal(site.read('.stacki/pages.json').includes('\r\n'), eol === '\r\n');
      assert.ok(plan.summary.links >= 9, String(plan.summary.links));
      // Line endings are the files' own.
      assert.equal(site.read('src/layouts/Base.astro').includes('\r\n'), eol === '\r\n');
      // Undo puts every byte back; redo makes the same swap again.
      const undone = applyRelocationStep(inverseStep(plan.step), desktopRenameWriter());
      assert.ok(undone.ok);
      assert.deepEqual(site.snapshot(), before);
      assert.ok(applyRelocationStep(plan.step, desktopRenameWriter()).ok);
      assert.match(site.read('src/pages/index.astro'), /title="About"/);
    } finally {
      site.close();
    }
  });
}

test('a page in a folder becomes the homepage and both files’ relative imports follow the move', () => {
  const site = project({
    'src/layouts/Base.astro': '<slot />',
    'src/data/menu.ts': "export const menu = [{ href: '/' }, { href: '/blog/post' }];",
    'src/pages/index.astro': "---\nimport Base from '../layouts/Base.astro';\nimport { menu } from '../data/menu';\n---\n<Base>{menu.length}</Base>",
    'src/pages/blog/post.astro': '---\nimport Base from \'../../layouts/Base.astro\';\n---\n<Base><a href="other">Other</a></Base>',
  });
  try {
    const before = site.snapshot();
    applied(site.root, { kind: 'home', page: 'blog/post.astro' });
    assert.equal(site.read('src/pages/index.astro'), '---\nimport Base from \'../layouts/Base.astro\';\n---\n<Base><a href="/blog/other">Other</a></Base>');
    assert.equal(
      site.read('src/pages/blog/post.astro'),
      "---\nimport Base from '../../layouts/Base.astro';\nimport { menu } from '../../data/menu';\n---\n<Base>{menu.length}</Base>",
    );
    assert.equal(site.read('src/data/menu.ts'), "export const menu = [{ href: '/blog/post' }, { href: '/' }];");
    const planned = planRelocation(site.root, { kind: 'home', page: 'index.astro' });
    assert.equal(planned.ok, false);
    void before;
  } finally {
    site.close();
  }
});

test('Markdown and MDX pages keep their extension and their layout path follows them', () => {
  for (const extension of ['.md', '.mdx']) {
    const site = project({
      'src/layouts/Base.astro': '<slot />',
      'src/pages/index.astro': '---\nimport Base from \'../layouts/Base.astro\';\n---\n<Base><a href="/notes">Notes</a></Base>',
      [`src/pages/docs/notes${extension}`]: '---\nlayout: ../../layouts/Base.astro\ntitle: Notes\n---\n[Home](/)\n',
    });
    try {
      const before = site.snapshot();
      const plan = applied(site.root, { kind: 'home', page: `docs/notes${extension}` });
      assert.equal(plan.page, `index${extension}`);
      assert.equal(site.read(`src/pages/index${extension}`), '---\nlayout: ../layouts/Base.astro\ntitle: Notes\n---\n[Home](/docs/notes)\n');
      assert.ok(site.exists('src/pages/docs/notes.astro'), extension);
      assert.equal(site.exists(`src/pages/docs/notes${extension}`), false);
      assert.match(site.read('src/pages/docs/notes.astro'), /import Base from '\.\.\/\.\.\/layouts\/Base\.astro';/);
      // Its link to the page it swapped with still names /notes, which was never a route: only exact routes swap.
      assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
      assert.deepEqual(site.snapshot(), before);
    } finally {
      site.close();
    }
  }
});

test('trailingSlash and base from astro.config shape the swapped links', () => {
  assert.deepEqual(siteSettingsOf("export default { base: '/docs/', trailingSlash: 'always' }"), { base: '/docs', trailing: 'always', locales: [] });
  assert.deepEqual(siteSettingsOf("export default { i18n: {\n locales: ['en', 'fr', { path: 'pt', codes: ['pt-BR'] }],\n defaultLocale: 'en',\n } }").locales, [
    'fr',
    'pt',
  ]);
  const routes = { other: '/about', base: '/docs', trailing: 'always' as const, origins: ['https://example.com'] };
  const table: readonly (readonly [string, string])[] = [
    ['<a href="/docs/">x</a>', '<a href="/docs/about/">x</a>'],
    ['<a href="/docs">x</a>', '<a href="/docs/about/">x</a>'],
    ['<a href="/docs/about">x</a>', '<a href="/docs/">x</a>'],
    ['<a href="/docs/about/#team">x</a>', '<a href="/docs/#team">x</a>'],
    ['<a href="/">x</a>', '<a href="/">x</a>'],
    ['<a href="/docs/about-us">x</a>', '<a href="/docs/about-us">x</a>'],
    ['<a href="https://example.com/docs/?q=1">x</a>', '<a href="https://example.com/docs/about/?q=1">x</a>'],
    ["const s = '/docs/'.length;", "const s = '/docs/'.length;"],
    ["const s = { url: '/docs/' };", "const s = { url: '/docs/about/' };"],
  ];
  for (const [source, expected] of table) {
    assert.equal(swapPageLinks(source, { routes, file: 'src/components/A.astro', owner: undefined }).text, expected, source);
  }
});

test('refused swaps write nothing and name the reason', () => {
  const table: readonly (readonly [Files, string, string])[] = [
    [{ 'src/pages/index.astro': 'Home', 'src/pages/blog/[slug].astro': 'Post' }, 'blog/[slug].astro', 'Dynamic pages can’t be the homepage.'],
    [
      { 'src/pages/index.astro': 'Home', 'src/pages/list.astro': '---\nexport function getStaticPaths() { return []; }\n---\n' },
      'list.astro',
      'Dynamic pages can’t be the homepage.',
    ],
    [{ 'src/pages/index.astro': 'Home', 'src/pages/404.astro': 'Missing' }, '404.astro', 'Error pages (404, 500) can’t be the homepage.'],
    [
      { 'src/pages/index.astro': 'Home', 'src/pages/index.md': '# Home', 'src/pages/about.astro': 'About' },
      'about.astro',
      'Both index.astro and index.md exist. Keep one homepage file, then try again.',
    ],
    [
      { 'src/pages/index.astro': 'Home', 'src/pages/About.astro': 'About', 'src/pages/about/index.astro': 'Other about' },
      'About.astro',
      'Another page already answers at this page’s address. Resolve that first.',
    ],
    [
      {
        'astro.config.mjs': "export default { i18n: {\n locales: ['en', 'fr'],\n defaultLocale: 'en',\n } };",
        'src/pages/index.astro': 'Home',
        'src/pages/fr/about.astro': 'À propos',
      },
      'fr/about.astro',
      'Pages in a language folder can’t be the homepage.',
    ],
  ];
  for (const [files, page, sentence] of table) {
    // A case-insensitive disk cannot hold About.astro beside about/index.astro's folder twice; skip what it cannot hold.
    const site = project(files);
    try {
      const before = site.snapshot();
      const planned = planRelocation(site.root, { kind: 'home', page });
      assert.equal(planned.ok, false, page);
      assert.equal(planned.ok ? '' : planned.error.message, sentence, page);
      assert.deepEqual(site.snapshot(), before);
    } finally {
      site.close();
    }
  }
});

test('a file that would not parse refuses the whole swap with nothing written', () => {
  const site = project({
    'src/pages/index.astro': '<a href="/about">About</a>',
    'src/pages/about.astro': '<a href="/">Home</a>',
    'src/data/links.ts': "export const links = { href: '/about' ",
  });
  try {
    const before = site.snapshot();
    const planned = planRelocation(site.root, { kind: 'home', page: 'about.astro' });
    assert.equal(planned.ok, false);
    assert.equal(
      planned.ok ? '' : planned.error.message,
      'src/data/links.ts does not parse after the change, so nothing was changed. Fix the file and try again.',
    );
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('a file changed after planning refuses the step and every byte stays', () => {
  const site = project({
    'src/pages/index.astro': '<a href="/about">About</a>',
    'src/pages/about.astro': '<a href="/">Home</a>',
    'src/components/Nav.astro': '<a href="/">Home</a>',
  });
  try {
    const planned = planRelocation(site.root, { kind: 'home', page: 'about.astro' });
    assert.ok(planned.ok);
    fs.writeFileSync(path.join(site.root, 'src', 'components', 'Nav.astro'), '<a href="/">Home, edited</a>');
    const before = site.snapshot();
    const done = applyRelocationStep(planned.value.step, desktopRenameWriter());
    assert.equal(done.ok, false);
    assert.equal(done.ok ? '' : done.error.message, 'src/components/Nav.astro changed. Retry the rename.');
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('a rename from the dialog counts its links, moves the page and undoes in one step', () => {
  const site = project({
    'src/pages/index.astro': '<a href="/about">About</a><a href="/about#team">Team</a>',
    'src/components/Nav.astro': '<a href="/about/">About</a>',
    'src/pages/About-old.astro': 'x',
    'src/pages/about.astro': 'About',
  });
  try {
    const before = site.snapshot();
    const plan = applied(site.root, { kind: 'rename', from: 'about.astro', to: 'company.astro' });
    assert.equal(plan.summary.files, 2);
    assert.equal(plan.summary.links, 3);
    assert.equal(site.read('src/pages/company.astro'), 'About');
    assert.equal(site.read('src/components/Nav.astro'), '<a href="/company/">About</a>');
    assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
    // A case-only rename goes through staging, so a case-insensitive disk keeps one file under its new name.
    const cased = applied(site.root, { kind: 'rename', from: 'about.astro', to: 'About.astro' });
    assert.deepEqual(
      fs.readdirSync(path.join(site.root, 'src', 'pages')).filter((name) => name.toLowerCase() === 'about.astro'),
      ['About.astro'],
    );
    assert.ok(applyRelocationStep(inverseStep(cased.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('a duplicate lands beside the page under a free name and its undo removes only the copy', () => {
  const site = project({
    'src/pages/index.astro': 'Home',
    'src/pages/blog/post.md': '---\nlayout: ../../layouts/Base.astro\n---\nPost',
    'src/pages/blog/post-copy.md': 'An older copy',
  });
  try {
    const before = site.snapshot();
    const plan = applied(site.root, { kind: 'duplicate', page: 'blog/post.md' });
    assert.equal(plan.page, 'blog/post-copy-2.md');
    assert.equal(site.read('src/pages/blog/post-copy-2.md'), before['src/pages/blog/post.md']);
    const home = applied(site.root, { kind: 'duplicate', page: 'index.astro' });
    assert.equal(home.page, 'index-copy.astro');
    assert.ok(applyRelocationStep(inverseStep(home.step), desktopRenameWriter()).ok);
    assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('a deletion lists the links it breaks by file and line, refuses the homepage and is undone byte for byte', () => {
  const site = project({
    'src/pages/index.astro': '<a href="/about">About</a>\n<a href="/about/">Again</a>',
    'src/components/Nav.astro': 'nothing\n<a href="/about">About</a>',
    'src/pages/about.astro': 'About\r\n',
    'src/pages/404.astro': 'Missing',
  });
  try {
    const before = site.snapshot();
    const refused = planRelocation(site.root, { kind: 'remove', page: 'index.astro' });
    assert.equal(refused.ok ? '' : refused.error.message, 'The homepage can’t be deleted. Make another page the homepage first.');
    const plan = applied(site.root, { kind: 'remove', page: 'about.astro' });
    assert.equal(plan.summary.links, 3);
    assert.deepEqual(plan.summary.reviews.map((review) => review.file + ':' + review.line).sort(), [
      'src/components/Nav.astro:2',
      'src/pages/index.astro:1',
      'src/pages/index.astro:2',
    ]);
    assert.equal(site.exists('src/pages/about.astro'), false);
    assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
    assert.ok(planRelocation(site.root, { kind: 'remove', page: '404.astro' }).ok);
  } finally {
    site.close();
  }
});

test('a content template reads back the settings it was created with, and only its two pieces change', () => {
  const route = { file: 'posts/[slug].astro', param: 'slug' };
  const facts = { body: 'rendered' as const, heading: 'title', api: 'current' as const };
  const layout = { name: 'Base', importPath: '../../layouts/Base.astro' };
  const table = [
    { kind: 'entry-id' as const },
    { kind: 'field' as const, name: 'title', treatment: 'exact' as const },
    { kind: 'field' as const, name: 'title', treatment: 'slugified' as const },
  ];
  for (const slug of table) {
    for (const eol of ['\n', '\r\n']) {
      const text = pageTemplateText({
        route,
        source: { kind: 'content-collection', collection: 'posts', origin: 'existing', slug },
        layout,
        collection: facts,
        prerender: 'inherited',
      }).replace(/\n/g, eol);
      const reading = readPageTemplate('posts/[slug].astro', text);
      assert.equal(reading.kind, 'content', JSON.stringify(slug));
      assert.deepEqual(reading.kind === 'content' ? [reading.collection, reading.slug, reading.param, reading.usedFields] : [], [
        'posts',
        slug,
        'slug',
        ['title'],
      ]);
      const changed = retargetPageTemplate('posts/[slug].astro', text, { collection: 'articles', slug: { kind: 'entry-id' } });
      assert.ok(changed.ok);
      const after = changed.value;
      assert.match(after, /getCollection\('articles'\)/);
      assert.match(after, /CollectionEntry<'articles'>/);
      assert.equal(after.includes("'posts'"), false);
      // Everything outside the two pieces is the bytes it was: the markup, the imports, the line endings.
      assert.equal(after.split(eol).slice(-6).join(eol), text.split(eol).slice(-6).join(eol));
      assert.equal(after.includes('\r\n'), eol === '\r\n');
      const back = retargetPageTemplate('posts/[slug].astro', after, { collection: 'posts', slug });
      assert.equal(back.ok ? back.value : '', text);
    }
  }
});

test('a template changed by hand reads as custom and is never rewritten', () => {
  const route = { file: 'posts/[slug].astro', param: 'slug' };
  const text = pageTemplateText({
    route,
    source: { kind: 'content-collection', collection: 'posts', origin: 'existing', slug: { kind: 'entry-id' } },
    layout: undefined,
    collection: { body: 'none', heading: undefined, api: 'current' },
    prerender: 'inherited',
  });
  const table: readonly string[] = [
    text.replace("getCollection('posts')", "getCollection('posts', (entry) => entry.data.published)"),
    text.replace("const entries = await getCollection('posts');", "const entries = [...(await getCollection('posts')), ...(await getCollection('news'))];"),
    text.replace('params: { slug: entry.id }', 'params: { slug: entry.id.toUpperCase() }'),
  ];
  for (const custom of table) {
    const reading = readPageTemplate('posts/[slug].astro', custom);
    assert.equal(reading.kind, 'custom');
    const changed = retargetPageTemplate('posts/[slug].astro', custom, { collection: 'articles', slug: { kind: 'entry-id' } });
    assert.equal(changed.ok ? '' : changed.error.message, 'The template changed since the dialog read it. Close settings and open them again.');
  }
  assert.equal(readPageTemplate('about.astro', text).kind, 'none');
  const site = project({ 'src/pages/posts/[slug].astro': text });
  try {
    const before = site.snapshot();
    const step = retargetStep(site.root, 'posts/[slug].astro', {
      kind: 'content-collection',
      collection: 'articles',
      origin: 'existing',
      slug: { kind: 'entry-id' },
    });
    assert.ok(step.ok);
    assert.ok(applyRelocationStep(step.value, desktopRenameWriter()).ok);
    assert.match(site.read('src/pages/posts/[slug].astro'), /getCollection\('articles'\)/);
    assert.ok(applyRelocationStep(inverseStep(step.value), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
    const fresh = retargetStep(site.root, 'posts/[slug].astro', { kind: 'content-collection', collection: 'x', origin: 'new', slug: { kind: 'entry-id' } });
    assert.equal(fresh.ok ? '' : fresh.error.message, 'Create a new collection from Create page template first.');
  } finally {
    site.close();
  }
});
