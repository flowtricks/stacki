// Goal: the code check never refuses what the editor itself writes for a role without code permission (a refusal
// there would break ordinary editing), and still refuses the ways round it.
// Method: build changes with the editor's own writers (attribute and asset writes, binding and loop settings, the
// palette's inserts) and with the code the loop settings generate, over a temporary project, and run the real check as
// a role that may edit pages' layout but no code. Then run hostile variants of the same shapes.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeGuard } from '../src/features/roles/codeGuard';
import { parseAstro } from '../src/features/roles/codeCompiler';
import { applyEdits, nodesOf, flatten } from '../src/features/source/source';
import { assetProp, frontmatterEdit } from '../src/features/settings/settingsEdits';
import { writeAttributes } from '../src/features/settings/attributeEdit';
import { collectionQueryEdit, dataImportEdit } from '../src/features/settings/frontmatterAdditionEdit';
import { contentInsertionEdits } from '../src/features/source/insertContent';
import { componentInsertionEdits } from '../src/features/source/componentInsertion';
import { LIST_ITEMS_HELPER } from '../vendor/stacki/src/editor/listItemsHelper';
import {
  astroComparatorCode,
  astroConditionCode,
  astroQueryCode,
  listPickedCode,
  type LoopCondition,
  type LoopQuery,
  type LoopSort,
} from '../vendor/stacki/src/editor/loopQuery';
import { DEFAULT_PROJECT_ROLES, roleViewOf, type RoleView } from '../vendor/stacki/shared/properties/projectRoles';

const DESIGNER: RoleView = {
  ...roleViewOf(DEFAULT_PROJECT_ROLES, 'client'),
  id: 'designer-role',
  name: 'Designer',
  features: new Set(['panel:settings', 'panel:style', 'page:layout', 'panel:cms']),
};

const PAGE = 'src/pages/index.astro';
const SOURCE = `---
import Layout from '../layouts/Layout.astro';
import { getCollection } from 'astro:content';
import { sanityClient } from 'sanity:client';
import { formatDate } from '../lib/format';
const posts = await getCollection('blog');
const heading = formatDate('Hello');
const team = [{ name: 'Ada', joined: formatDate(new Date()) }, { name: 'Lin', joined: 'today' }];
---

<Layout>
  <h1>{heading}</h1>
  <div class="box"></div>
  <ul>
    {posts.map((post) => (<li>{post.data.title}</li>))}
  </ul>
</Layout>
`;

async function project(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-guard-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, PAGE), SOURCE);
  return new CodeGuard(root);
}

const node = (source: string, name: string) => {
  const found = flatten(nodesOf(source)).find((item) => item.name === name);
  assert.ok(found, name);
  assert.ok(found.id !== undefined, name);
  return found.id;
};

const query = (extra: Partial<LoopQuery>): LoopQuery => ({
  source: { kind: 'astro', collection: 'blog' },
  match: 'all',
  conditions: [],
  sorts: [],
  offset: 0,
  limit: undefined,
  random: false,
  projection: undefined,
  parameter: { kind: 'data' },
  customSort: undefined,
  selection: undefined,
  selectionField: undefined,
  ...extra,
});

const test_ = (operator: string, value?: unknown): LoopCondition =>
  ({ kind: 'test', field: 'meta.title', operator, ...(value === undefined ? {} : { value }) }) as LoopCondition;

const CONDITIONS: readonly LoopCondition[] = [
  test_('is', { kind: 'text', text: "it's" }),
  test_('isNot', { kind: 'reference', id: 'a' }),
  test_('contains', 'x'),
  test_('has', { kind: 'number', number: 2 }),
  test_('has', { kind: 'reference', id: 'a' }),
  test_('isSet'),
  test_('isEmpty'),
  test_('isTrue'),
  test_('isFalse'),
  test_('greater', 1),
  test_('atMost', 3),
  test_('before', '2026-01-01'),
  test_('inPast'),
  test_('inFuture'),
];
const SORTS: readonly LoopSort[] = (['text', 'number', 'date', 'boolean', 'natural', 'length', 'count', 'fileSize'] as const).map((order) => ({
  field: 'campus-name',
  direction: 'ascending',
  order,
}));

const frontmatterWith = (source: string, line: string) => source.replace("const posts = await getCollection('blog');", line);
const markupWith = (source: string, markup: string) => source.replace('<div class="box"></div>', markup);

test('every query the loop settings generate is allowed', async (context) => {
  const guard = await project(context);
  const written = [
    astroQueryCode(query({ conditions: CONDITIONS.slice(0, 12), limit: 3, offset: 1 })),
    astroQueryCode(query({ conditions: CONDITIONS.slice(12) })),
    astroQueryCode(query({ conditions: CONDITIONS.slice(0, 2), match: 'any', parameter: { kind: 'entry', name: 'entry' } })),
    astroQueryCode(query({ random: true, limit: 2 })),
    astroQueryCode(query({ selection: ['one', 'two'] })),
    ...SORTS.map((sort) => astroQueryCode(query({ sorts: [sort] }))),
    `(await getCollection('blog')).toSorted(${astroComparatorCode(SORTS)})`,
    `(await getCollection('blog')).filter((entry) => ${CONDITIONS.slice(0, 12)
      .map((condition) => astroConditionCode(condition, 'entry.data'))
      .join(' && ')})`,
    listPickedCode('posts', ['1', '2'], undefined),
    listPickedCode('posts', ['a'], 'slug'),
    'await sanityClient.fetch(\'*[_type == "post"] | order(title asc)[0...3]\')',
    `listItems(await getCollection("blog"), {"filter":{"filterFor":"ANY","fields":[]},"sort":[],"limit":3})`,
  ];
  for (const code of written) {
    const helper = code.startsWith('listItems') ? `${LIST_ITEMS_HELPER.replaceAll('\t', '  ')}\n` : '';
    const after = frontmatterWith(SOURCE, `${helper}const posts = ${code};`);
    await guard.assertAllowed(DESIGNER, { file: PAGE, before: SOURCE, after }).catch((error: unknown) => assert.fail(`${String(error)}\n${code}`));
  }
});

test('every write the Settings panel, binding picker and palette make is allowed', async (context) => {
  const guard = await project(context);
  const box = node(SOURCE, 'div');
  const added = collectionQueryEdit(SOURCE, 'team-members');
  const changes: readonly string[] = [
    writeAttributes(SOURCE, box, {
      'data-count': { type: 'expr', value: '3' },
      hidden: { type: 'bare' },
      title: { type: 'string', value: 'process.env is only text here' },
      'class:list': { type: 'expr', value: "['box', { active: posts.length > 0 }]" },
      style: { type: 'expr', value: '{ color: "red", order: posts.length }' },
      'data-name': { type: 'expr', value: '`${posts[0]?.data.title} (${posts.length})`' },
      'data-first': { type: 'expr', value: "posts[0]?.data['title'] ?? 'None'" },
      'data-year': { type: 'expr', value: 'new Date().getFullYear()' },
      'data-url': { type: 'expr', value: 'Astro.url.pathname' },
    }),
    assetProp(SOURCE, box, PAGE, 'data-image', 'src/assets/photo.png'),
    assetProp(SOURCE, box, PAGE, 'data-image', 'public/photo.png'),
    added.source,
    dataImportEdit(SOURCE, { spec: '@/consts', exported: 'SITE', name: 'SITE' }).source,
    ...(['map', 'cond', 'text', 'comment', 'expr', 'style', 'script'] as const).map((type) =>
      applyEdits(SOURCE, contentInsertionEdits(SOURCE, { kind: 'insert-content', target: box, placement: 'inside', content: { type } })),
    ),
    applyEdits(
      SOURCE,
      contentInsertionEdits(SOURCE, { kind: 'insert-content', target: box, placement: 'after', content: { type: 'astroAsset', name: 'Image' } }),
    ),
    applyEdits(
      SOURCE,
      componentInsertionEdits(SOURCE, { kind: 'insert', target: box, name: 'Card', importPath: '../components/Card.astro', paired: true }, PAGE),
    ),
    markupWith(SOURCE, '{posts.length > 1 && <p>{posts[1].data.title}</p>}'),
    markupWith(SOURCE, '{posts.filter((post) => !post.data.draft).slice(0, 3).map((post, index) => (<p data-i={index}>{post.data.title.toUpperCase()}</p>))}'),
    markupWith(SOURCE, '<a href={`/blog/${posts[0].id}`}>Read</a>'),
    markupWith(SOURCE, '<script type="application/ld+json">{"@type":"Thing"}</script>'),
    markupWith(SOURCE, '<iframe src="https://www.youtube.com/embed/x" title="Video"></iframe>'),
    // A developer's call beside edited data, and text typed where the page prints a string inside a call.
    SOURCE.replace("{ name: 'Lin', joined: 'today' }", "{ name: 'Linus', joined: 'now' }, { name: 'Mo', joined: 'later' }"),
    applyEdits(SOURCE, [frontmatterEdit(SOURCE, /^---\n([\s\S]*?)\n---/.exec(SOURCE)?.[1] ?? '')]),
  ];
  for (const [index, after] of changes.entries()) {
    await guard.assertAllowed(DESIGNER, { file: PAGE, before: SOURCE, after }).catch((error: unknown) => {
      assert.fail(`change ${index}: ${String(error)}\n${after}`);
    });
  }
});

test('ways round the check are refused', async (context) => {
  const guard = await project(context);
  const markup: readonly string[] = [
    '<p>{process.env.TOKEN}</p>',
    '<p>{global.process}</p>',
    '<p>{[1].map((process) => 1)}{process.env.TOKEN}</p>',
    '<p>{posts["constr" + "uctor"]}</p>',
    '<p>{posts["\\u0063onstructor"]}</p>',
    '<p>{posts.map(({ constructor: make }) => make("return 1")())}</p>',
    "<p>{['return 1'].map(Function)}</p>",
    "<p>{['x'].forEach(formatDate)}</p>",
    "<p>{['x'].map(formatDate)}</p>",
    "<p>{await import('node:fs')}</p>",
    '<p>{import.meta.env.SECRET}</p>',
    '<p>{Astro.request.headers}</p>',
    '<p>{Astro["cookies"]}</p>',
    '<p>{Object.getPrototypeOf(posts)}</p>',
    '<p>{String.raw`a`}{globalThis}</p>',
    "<p>{fetch('https://elsewhere.test')}</p>",
    "<p>{sanityClient.fetch('https://elsewhere.test')}</p>",
    '<p>{(posts.length = 0)}</p>',
    '<p>{1); process.exit(1); (1}</p>',
    '<p {...process.env}></p>',
    '<p data-x={`${process.env.TOKEN}`}></p>',
    '<p data-x=`${process.env.TOKEN}`></p>',
    '<div onclick={"alert(1)"}></div>',
    "<a href={'javascript:alert(1)'}>x</a>",
    '<a href="jAvAsCrIpT&colon;alert(1)">x</a>',
    "<div set:html={'<img src=x onerror=alert(1)>'}></div>",
    '<script src="https://elsewhere.test/a.js"></script>',
    '<script set:html={heading}></script>',
    "<p>{formatDate(globalThis.process?.getBuiltinModule?.('node:fs'))}</p>",
    // Putting a function under a data method's name, so that calling the method calls it.
    '<p>{({ join: formatDate }).join("x")}</p>',
    '<p>{({ join: Object.getOwnPropertyDescriptor }).join(posts, "x")}</p>',
    '<p>{Object.getPrototypeOf}</p>',
    '<p>{Object.fromEntries([["join", formatDate]]).join("x")}</p>',
    '<p>{String({ toString: formatDate })}</p>',
    '<p>{JSON.stringify({ toJSON: formatDate })}</p>',
    '<p>{await { then: formatDate }}</p>',
    '<p>{[formatDate].map((join) => ({ join }).join("x"))}</p>',
    '<p>{[formatDate].map((getCollection) => getCollection("x"))}</p>',
    '<p>{[formatDate].map((String) => ["x"].map(String))}</p>',
    '<p>{JSON.stringify(posts, [process.env])}</p>',
    '<p>{["constructor"].map((key) => posts[key])}</p>',
    '<p>{[0].map((index) => posts[index + "constructor"])}</p>',
    "<p>{['constructor'].map((index) => posts[index])}</p>",
  ];
  const frontmatter: readonly string[] = [
    'declare const process: any;\nconst posts = process.env;',
    'import type { process } from "x";\nconst posts = process.env;',
    "const posts = await getCollection('blog'); globalThis.x = 1;",
    "const posts = await getCollection('blog');\nexport const GET = function () { return process; };",
    "import posts from '../../.env?raw';",
    "import posts from '../../../outside.mjs';",
    "import posts from 'node:child_process';",
    "import posts from 'child_process';",
    "export * from 'node:fs';\nconst posts = 1;",
    "const posts = formatDate('../../etc');",
    "const posts = await getCollection('blog');\nconst listItems = (items) => process.env;",
    `${LIST_ITEMS_HELPER.replace('return list.slice', 'return process.env ?? list.slice')}\nconst posts = listItems([], {});`,
  ];
  const changes = [
    ...markup.map((text) => markupWith(SOURCE, text)),
    ...frontmatter.map((text) => frontmatterWith(SOURCE, text)),
    // A developer's call must not be pointed elsewhere.
    SOURCE.replace("formatDate('Hello')", 'formatDate(process.env.TOKEN)'),
    SOURCE.replace('joined: formatDate(new Date())', 'joined: formatDate(process.env)'),
  ];
  for (const [index, after] of changes.entries()) {
    assert.notEqual(after, SOURCE, `change ${index} is a change`);
    await assert.rejects(guard.assertAllowed(DESIGNER, { file: PAGE, before: SOURCE, after }), /cannot add or change code/, `change ${index}: ${after}`);
  }
});

test('an idle page compiler does not hold the process open', async () => {
  await parseAstro('<h1>Title</h1>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!process.getActiveResourcesInfo().includes('MessagePort'), 'The compiler thread lets the process exit once nothing waits on it');
});
