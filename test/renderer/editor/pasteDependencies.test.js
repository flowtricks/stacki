// Goal: a paste into another file brings what the markup needs, so it never breaks the page it
// lands in. The owner's case first: `.stat_wrap` (with its ::before rule) copied from inside the
// StatWrap component and pasted into a page body must arrive with its imports (named stays
// named), its props flattened to values, its frontmatter values, and its scoped style rules.
// Then the matrix: page to component, page to page, name collisions renamed in code and markup,
// imports the target already has reused, rules the target holds not written twice, slots in a
// page, and what cannot travel (an env secret, a request read) turned into a choice whose
// "filled in" answer leaves no undefined name behind. A paste inside the same file is untouched.
// Finally the gesture: the whole paste is one gesture whose model, applied, holds all of it.
//
// Method: generated fixtures parsed by the real Astro parser (dist), the real planner and
// gesture helpers bundled with esbuild. Every result is checked as text, including the negative
// space: what must not be copied and what must not be written.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/paste-dependencies');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'paste-dependencies.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { planPaste, freeName, placeholderFor } from './src/editor/pasteDependencies';",
      "export { carriedStyles } from './src/editor/pasteStyles';",
      "export { pasteSourceOf, pasteTargetOf, copiedFile, withBundleFrontmatter, carriedStyleNode, contextPasteGesture, pasteSummary, pasteChangeLines, bundleImportsFor } from './src/app/model/contextPaste';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
});
const modules = require(bundle);

const STAT_WRAP = `---
import Button from './Button.astro';
import { formatNumber } from '../lib/format';
import { getCollection } from 'astro:content';
interface Props { title?: string; items: { label: string; value: number }[] }
const { title = 'Our stats', items } = Astro.props;
const accent = '#f40';
const heading = title.toUpperCase();
const posts = await getCollection('blog');
const hasFooter = Astro.slots.has('footer');
---
<div class="stat_wrap" class:list={[{ active: items.length > 0 }]}>
  <h2>{heading}</h2>
  <div class="stat_contain">
    {items.map((item) => <p>{formatNumber(item.value)} {item.label}</p>)}
  </div>
  <p>{posts.length} posts</p>
  {hasFooter && <footer />}
  <Button label={title} />
  <slot><span>Fallback</span></slot>
</div>
<style define:vars={{ accent }}>
  .stat_wrap { position: relative; color: var(--accent); }
  .stat_wrap::before { content: ''; position: absolute; inset: 0; }
  .stat_wrap .stat_contain { display: grid; }
  h2 { font-size: 2rem; }
  .footer { color: red; }
  @media (max-width: 600px) { .stat_contain { display: block; } }
</style>
`;

const PAGE = `---
import Layout from '../layouts/Layout.astro';
const title = 'Home';
---
<Layout>
  <main class="page"></main>
</Layout>
`;

function model(source) {
  const result = parsePage(source, {});
  assert.equal(result.editable, true, 'The fixture parses');
  return result.model;
}

function firstElement(nodes, name) {
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node.kind === 'element' && node.name === name) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
}

function sourceOf(text, file) {
  const parsed = model(text);
  const node = firstElement(parsed.nodes, 'div');
  return { node, source: modules.pasteSourceOf(parsed, file, node) };
}

const component = { path: '/site/src/components/StatWrap.astro', role: 'component', name: 'StatWrap' };
const page = { path: '/site/src/pages/index.astro', role: 'page' };

function codeOf(node) {
  return JSON.stringify(node);
}

test('owner scenario: stat_wrap from StatWrap into a page body brings imports, values, props and styles', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  assert.equal(source.copiedRoot, true, 'The copied div is the component root');
  const target = modules.pasteTargetOf(model(PAGE), page);
  const plan = modules.planPaste(node, source, target);
  assert.equal(plan.kind, 'ready');
  const { bundle: pasted } = plan;
  // Imports: the component and the helper; the named import stays named.
  const names = pasted.imports.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['Button', 'formatNumber', 'getCollection']);
  const collection = pasted.imports.find((entry) => entry.name === 'getCollection');
  assert.equal(collection.named, true, 'A named import is pasted named');
  assert.equal(collection.path, 'astro:content');
  // Props become values: the default where the destructure gives one, a placeholder otherwise.
  // The page already binds `title`, so the prop is renamed in the code and in the markup.
  assert.ok(pasted.statements.includes("const title2 = 'Our stats';"));
  assert.ok(pasted.statements.includes('const items = [];'));
  assert.ok(pasted.statements.includes('const heading = title2.toUpperCase();'));
  assert.ok(pasted.statements.includes("const posts = await getCollection('blog');"));
  assert.ok(pasted.statements.includes("const hasFooter = Astro.slots.has('footer');"));
  assert.ok(!pasted.statements.some((statement) => statement.includes('Astro.props')), 'No Astro.props read is copied into a page');
  assert.ok(!pasted.statements.some((statement) => statement.includes('interface Props')), 'The props type is not needed');
  assert.match(codeOf(pasted.node), /label":\{"type":"expr","value":"title2"/);
  assert.doesNotMatch(codeOf(pasted.node), /"name":"slot"/, 'A slot is replaced by its fallback in a page');
  assert.match(codeOf(pasted.node), /Fallback/);
  // Styles: the rules for the copy, ::before included; tag-only rules and other classes stay.
  const rules = pasted.styles.rules.join('\n');
  assert.match(rules, /\.stat_wrap::before/);
  assert.match(rules, /\.stat_wrap \.stat_contain/);
  assert.match(rules, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(rules, /\.footer/);
  assert.doesNotMatch(rules, /\bh2\s*\{/);
  assert.deepEqual(pasted.styles.leftBehind, ['h2']);
  assert.equal(pasted.styles.defineVars, '{ accent }', 'define:vars travels when a carried rule reads it');
  const summary = modules.pasteSummary(pasted.changes, (key, params) => `${key}${params ? JSON.stringify(params) : ''}`);
  assert.match(summary, /editor\.paste\.broughtCheck/, 'A placeholder makes the summary ask to check');
});

test('the paste gesture writes frontmatter, markup and one new style tag in a single model step', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  const pageModel = model(PAGE);
  const plan = modules.planPaste(node, source, modules.pasteTargetOf(pageModel, page));
  const main = firstElement(pageModel.nodes, 'main');
  const style = modules.carriedStyleNode(plan.bundle, { scope: 'global', content: '' }, PAGE);
  assert.equal(style.props['is:global'].type, 'bare', 'The project default is honoured');
  assert.equal(style.props['define:vars'].value, '{ accent }');
  const gesture = modules.contextPasteGesture(
    pageModel,
    { node: plan.bundle.node, place: { parentId: main.id, index: 0 }, style },
    modules.withBundleFrontmatter(plan.bundle.imports, plan.bundle.statements),
  );
  const after = gesture.apply(pageModel);
  assert.ok(after.imports.some((entry) => entry.name === 'Button'));
  assert.ok(after.extraFrontmatter.startsWith("const title = 'Home';"), 'Existing code is left as written');
  assert.match(after.extraFrontmatter, /const heading = title2\.toUpperCase\(\);/);
  assert.ok(firstElement(after.nodes, 'main').children.some((child) => child.id === plan.bundle.node.id));
  assert.ok(after.nodes.some((child) => child.kind === 'raw' && child.name === 'style'));
  assert.equal(firstElement(pageModel.nodes, 'main').children.length, 0, 'The shown model is not mutated');
});

test('a template with a layer wrapper puts the carried rules inside it', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  const plan = modules.planPaste(node, source, modules.pasteTargetOf(model(PAGE), page));
  const style = modules.carriedStyleNode(plan.bundle, { scope: 'scoped', content: '@layer components {\n  /* stacki:rules */\n}' }, PAGE);
  assert.equal(style.props['is:global'], undefined);
  assert.match(style.inner, /@layer components \{[\s\S]*\.stat_wrap::before[\s\S]*\}/);
  assert.doesNotMatch(style.inner, /stacki:rules/);
});

test('rules the target already holds are not written twice', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  const held = `${PAGE}<style>\n  .stat_wrap::before { content: ''; position: absolute; inset: 0; }\n</style>\n`;
  const plan = modules.planPaste(node, source, modules.pasteTargetOf(model(held), page));
  assert.ok(!plan.bundle.styles.rules.some((rule) => rule.startsWith('.stat_wrap::before')));
  assert.ok(plan.bundle.styles.rules.some((rule) => rule.startsWith('.stat_wrap {')));
});

test('an import the target already has is reused, a colliding one is renamed with its tag', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  const reuse = modules.planPaste(node, source, modules.pasteTargetOf(model(`---\nimport { getCollection } from 'astro:content';\n---\n<main />\n`), page));
  assert.ok(!reuse.bundle.imports.some((entry) => entry.name === 'getCollection'), 'Same module, same name: reused');
  const clash = modules.planPaste(node, source, modules.pasteTargetOf(model(`---\nimport Button from '../ui/OtherButton.astro';\n---\n<main />\n`), page));
  const button = clash.bundle.imports.find((entry) => entry.path === './Button.astro');
  assert.equal(button.name, 'Button2');
  assert.match(codeOf(clash.bundle.node), /"kind":"component","name":"Button2"/);
  assert.doesNotMatch(codeOf(clash.bundle.node), /"name":"Button"[,}]/);
});

test('what cannot travel becomes a choice, and the filled answer leaves no undefined name', () => {
  const unsafe = STAT_WRAP.replace(
    "const accent = '#f40';",
    "const accent = '#f40';\nconst secret = import.meta.env.SECRET;\nconst ip = Astro.request.headers.get('x');",
  ).replace('<p>{posts.length} posts</p>', '<p>{posts.length} posts {secret} {ip.length}</p>');
  const { node, source } = sourceOf(unsafe, component);
  const plan = modules.planPaste(node, source, modules.pasteTargetOf(model(PAGE), page));
  assert.equal(plan.kind, 'choose');
  assert.deepEqual(
    plan.blockers.map((blocker) => [blocker.name, blocker.reason]),
    [
      ['secret', 'import-meta'],
      ['ip', 'astro'],
    ],
  );
  assert.deepEqual(plan.instance, { name: 'StatWrap', recommended: true });
  const filled = plan.filled.statements;
  assert.ok(filled.includes("const secret = '';"));
  assert.ok(filled.includes('const ip = [];'), 'A value read with .length is filled with a list');
  assert.ok(!filled.some((statement) => statement.includes('import.meta') || statement.includes('Astro.request')), 'Nothing unsafe is copied');
});

test('page to component and page to page carry code and keep relative imports for rebasing', () => {
  const source = `---\nimport Card from '../components/Card.astro';\nconst jobs = ['Designer', 'Engineer'];\nconst count = jobs.length;\n---\n<div class="jobs">{count}<Card options={jobs} /></div>\n`;
  const parsed = model(source);
  const node = firstElement(parsed.nodes, 'div');
  const from = modules.pasteSourceOf(parsed, { path: '/site/src/pages/careers.astro', role: 'page', name: 'careers' }, node);
  for (const into of [
    { path: '/site/src/components/Section.astro', role: 'component' },
    { path: '/site/src/pages/about.astro', role: 'page' },
  ]) {
    const plan = modules.planPaste(node, from, modules.pasteTargetOf(model('<section />\n'), into));
    assert.equal(plan.kind, 'ready');
    assert.deepEqual(plan.bundle.statements, ["const jobs = ['Designer', 'Engineer'];", 'const count = jobs.length;']);
    assert.deepEqual(
      plan.bundle.imports.map((entry) => [entry.name, entry.path]),
      [['Card', '../components/Card.astro']],
    );
  }
});

test('imports are re-aimed for the target: components from the scan, relative paths rebased, packages kept', async () => {
  const imports = await modules.bundleImportsFor(
    {
      imports: [
        { name: 'Button', path: './Button.astro', quote: "'", at: 0 },
        { name: 'formatNumber', path: '../lib/format', quote: "'", named: true, imported: 'formatNumber', at: 37 },
        { name: 'getCollection', path: 'astro:content', quote: "'", named: true, imported: 'getCollection' },
      ],
    },
    {
      insertables: [{ name: 'Button', path: '/site/src/components/Button.astro' }],
      sourcePath: '/site/src/components/StatWrap.astro',
      targetModel: { imports: [{ name: 'Layout', path: '@/layouts/Layout.astro', quote: "'" }] },
      resolveImportPath: async () => ({ relative: '../components/Button.astro', srcRelative: 'components/Button.astro' }),
      rebase: async (_from, spec) => (spec === '../lib/format' ? '../lib/format' : spec),
    },
  );
  assert.deepEqual(
    imports.map((entry) => [entry.name, entry.path, entry.named === true, entry.at]),
    [
      ['Button', '@/components/Button.astro', false, undefined],
      ['formatNumber', '../lib/format', true, undefined],
      ['getCollection', 'astro:content', true, undefined],
    ],
  );
});

test('a default import of a named-only module is repaired before the write (pre-flight auto-fix)', () => {
  const apply = modules.withBundleFrontmatter([{ name: 'getCollection', path: 'astro:content', quote: "'" }], []);
  const after = apply(model('<main />\n'));
  const entry = after.imports.find((candidate) => candidate.name === 'getCollection');
  assert.equal(entry.named, true);
  assert.equal(entry.imported, 'getCollection');
});

test('a paste inside the file it was copied from is the ordinary paste', () => {
  const { node, source } = sourceOf(STAT_WRAP, component);
  const plan = modules.planPaste(node, source, modules.pasteTargetOf(model(STAT_WRAP), { path: component.path, role: 'component' }));
  assert.equal(plan.kind, 'same-file');
});

test('names and placeholders', () => {
  assert.equal(modules.freeName('title', new Set(['title', 'title2'])), 'title3');
  assert.equal(modules.freeName('title', new Set()), 'title');
  assert.equal(modules.placeholderFor('items', 'items.map((item) => item)'), '[]');
  assert.equal(modules.placeholderFor('post', 'post.data.title'), '{}');
  assert.equal(modules.placeholderFor('title', '{title}'), "''");
  assert.equal(modules.placeholderFor('items', 'otheritems.map(x)'), "''", 'Only the name itself counts');
});

test('the What changed list says each thing in plain words, bounded', () => {
  const translate = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;
  const many = Array.from({ length: 60 }, (_, index) => ({ kind: 'style', selector: `.c${index}` }));
  const lines = modules.pasteChangeLines(many, translate);
  assert.equal(lines.length, 41);
  assert.match(lines[40], /editor\.paste\.change\.more:\{"count":20\}/);
});
