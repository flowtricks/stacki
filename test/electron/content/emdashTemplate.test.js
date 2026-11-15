// Goal: a page template for an EmDash content type is written exactly as EmDash documents reading one entry
// (`getEmDashEntry` at request time, EmDash's `decodeSlug`, `Image` and `PortableText` from `emdash/ui`), from
// the content type's own schema and nothing else; it changes no other file of the project; a type EmDash does not
// list is refused before anything is written; and the page opens in the editor like any hand-written one.
// Method: the generated text is compared exactly for a type with an image and rich text, with a layout and
// without; the plan and the write run against a copy of test/fixtures/emdash/site in a temporary folder, listing
// the files before and after; the written page goes through the real page parser.
const test = require('node:test');
const { repoPath } = require('../../helpers/sources.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pageTemplateText } = require('#dist/electron/content/pageTemplateSource.js');
const { applyPageTemplate, planPageTemplate } = require('#dist/electron/content/pageTemplatePlan.js');
const { parsePageSource } = require('#dist/electron/documents/pageRequests.js');
const { parseDataSource, parsePageTemplateDraft } = require('#dist/shared/properties/pageTemplate.js');

const FIXTURE = repoPath('test/fixtures/emdash/site');
const route = { file: 'posts/[slug].astro', param: 'slug' };
const source = { kind: 'emdash', collection: 'posts' };

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-emdash-template-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}
const host = (root) => ({ projectPath: root, readConfig: async () => ({ collections: [] }), env: new Map() });
const filesIn = (root) =>
  fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .sort();

test('the page reads its entry from EmDash when it is requested, with the type’s own heading, image and body', () => {
  const text = pageTemplateText({
    route,
    source,
    layout: { name: 'Base', importPath: '../../layouts/Base.astro' },
    collection: undefined,
    emdash: { heading: 'title', image: 'featured_image', body: 'content' },
    prerender: 'explicit',
  });
  assert.equal(
    text,
    [
      '---',
      "import { decodeSlug, getEmDashEntry } from 'emdash';",
      "import { Image, PortableText } from 'emdash/ui';",
      "import Base from '../../layouts/Base.astro';",
      '',
      'const slug = decodeSlug(Astro.params.slug);',
      'if (!slug) {',
      "\treturn Astro.rewrite('/404');",
      '}',
      '',
      "const { entry, error } = await getEmDashEntry('posts', slug);",
      'if (error) {',
      "\treturn new Response('Unable to load this page.', { status: 500 });",
      '}',
      'if (!entry) {',
      "\treturn Astro.rewrite('/404');",
      '}',
      '---',
      '',
      '<Base>',
      '\t{entry.data.featured_image && <Image image={entry.data.featured_image} />}',
      '\t<h1>{entry.data.title}</h1>',
      '\t<PortableText value={entry.data.content} />',
      '</Base>',
      '',
    ].join('\n'),
  );
  assert.ok(!text.includes('getStaticPaths'), 'served when requested, so a CMS edit shows with no rebuild');
  assert.ok(!text.includes('prerender'), 'never prerendered: that would freeze the content at build time');
});

test('a type with no image or body imports only what it uses', () => {
  const text = pageTemplateText({
    route,
    source,
    layout: undefined,
    collection: undefined,
    emdash: { heading: 'name', image: undefined, body: undefined },
    prerender: 'inherited',
  });
  assert.ok(!text.includes('emdash/ui'));
  assert.ok(text.includes('<article>'));
  assert.ok(text.includes('<h1>{entry.data.name}</h1>'));
});

test('planning reads the schema from EmDash, and writing adds one page and changes nothing else', async () => {
  const root = project();
  const before = filesIn(root);
  const draft = parsePageTemplateDraft({ route: '/work/[slug]', layout: undefined, source: { kind: 'emdash', collection: 'case_studies' } });
  const plan = await planPageTemplate(draft, host(root));
  assert.deepEqual(plan.env, []);
  assert.equal(plan.changes.length, 1, 'one file: no content config, no entry, no secret');
  assert.equal(plan.changes[0].path, 'src/pages/work/[slug].astro');
  assert.ok(plan.changes[0].text.includes("getEmDashEntry('case_studies', slug)"));
  assert.ok(plan.changes[0].text.includes('<h1>{entry.data.title}</h1>'));
  assert.ok(plan.changes[0].text.includes('<PortableText value={entry.data.result} />'), 'the first rich text field of that type');
  assert.ok(!plan.changes[0].text.includes('Image'), 'case studies define no image field here');
  const { pagePath } = await applyPageTemplate(draft, host(root));
  assert.equal(fs.readFileSync(pagePath, 'utf8'), plan.changes[0].text, 'what was shown is what was written');
  assert.deepEqual(
    filesIn(root).filter((name) => !before.includes(name)),
    [path.join('src', 'pages', 'work', '[slug].astro')],
  );
  const read = parsePageSource(pagePath, fs.readFileSync(pagePath, 'utf8'));
  assert.equal(read.editable, true, 'the page opens in the editor');
});

test('a type EmDash does not list, and a project without EmDash, are refused before anything is written', async () => {
  const root = project();
  const before = filesIn(root);
  const unknown = parsePageTemplateDraft({ route: '/x/[slug]', layout: undefined, source: { kind: 'emdash', collection: 'unicorns' } });
  await assert.rejects(() => planPageTemplate(unknown, host(root)), /no content type named .unicorns./);
  await assert.rejects(() => applyPageTemplate(unknown, host(root)), /no content type named/);
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-emdash-plain-')));
  const draft = parsePageTemplateDraft({ route: '/posts/[slug]', layout: undefined, source });
  await assert.rejects(() => planPageTemplate(draft, host(plain)), /does not use EmDash/);
  assert.deepEqual(filesIn(root), before);
  assert.deepEqual(filesIn(plain), []);
});

test('an address that already has a page is refused, as for every template', async () => {
  const root = project();
  const draft = parsePageTemplateDraft({ route: '/posts/[slug]', layout: undefined, source });
  await assert.rejects(() => planPageTemplate(draft, host(root)), /already exists/);
});

test('the data source parser accepts a slug-named type and refuses anything that could be code', () => {
  assert.deepEqual(parseDataSource({ kind: 'emdash', collection: 'case_studies' }), { kind: 'emdash', collection: 'case_studies' });
  for (const bad of ['', 'Posts', 'a-b', "x'); evil('", 'a b', '1abc', 'x'.repeat(200), 7, undefined]) {
    assert.throws(() => parseDataSource({ kind: 'emdash', collection: bad }), undefined, String(bad));
  }
});
