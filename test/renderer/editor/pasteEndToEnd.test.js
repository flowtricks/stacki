// Goal: the owner's exact scenario, end to end through main's real write path. `.stat_wrap` (its
// `::before` rule in StatWrap's scoped style, its props, its Button and named-import helpers) is
// copied from inside StatWrap.astro and pasted into a page body. The page must then hold
// everything it needs and nothing broken: the imports in their named/default form and re-aimed
// for the page's folder, the values and the props as constants after the imports, a new style
// tag with the carried rules, and the pasted element in the page tree (what the Navigator shows);
// pre-flight finds nothing; and one undo restores the page byte for byte. The negative space: the
// same markup pasted bare is refused by main's pre-flight with the plain reason, writing nothing.
//
// Method: a generated project in a temporary folder (never a real site), main's real handlers in
// the windowless harness (page:read, page:importPathFor, page:rebaseImport, page:edit), and the
// app's real planner, gesture and sender bundled with esbuild, step for step as appContextPaste.ts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { preflightFile, PREFLIGHT_CODES } = require('#dist/shared/engine/preflight.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/paste-end-to-end');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'paste-end-to-end.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { planPaste } from './src/editor/pasteDependencies';",
      "export { pasteSourceOf, pasteTargetOf, withBundleFrontmatter, carriedStyleNode, contextPasteGesture, bundleImportsFor } from './src/app/model/contextPaste';",
      "export { insertGesture } from './src/editor/insertGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { withNewIds } from './src/app/model/nodeFactory';",
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
interface Props { title?: string; items?: { label: string; value: number }[] }
const { title = 'Our stats', items = [{ label: 'Projects', value: 120 }] } = Astro.props;
const heading = title.toUpperCase();
---
<div class="stat_wrap">
  <h2>{heading}</h2>
  <div class="stat_contain">
    {items.map((item) => <p>{formatNumber(item.value)} {item.label}</p>)}
  </div>
  <Button label={title} />
</div>
<style>
  .stat_wrap { position: relative; padding: 2rem; }
  .stat_wrap::before { content: ''; position: absolute; inset: 0; background: #eee; }
  .stat_contain { display: grid; gap: 1rem; }
</style>
`;

const PAGE = `---
import Layout from '../layouts/Layout.astro';
---
<Layout>
  <main class="page">
    <h1>Home</h1>
  </main>
</Layout>
`;

async function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-paste-e2e-'));
  const files = {
    'package.json': '{"dependencies":{"astro":"*"}}',
    'src/components/StatWrap.astro': STAT_WRAP,
    'src/components/Button.astro': '---\nconst { label } = Astro.props;\n---\n<button>{label}</button>\n',
    'src/lib/format.ts': 'export function formatNumber(value: number): string { return String(value); }\n',
    'src/layouts/Layout.astro': '<html><body><slot /></body></html>\n',
    'src/pages/index.astro': PAGE,
  };
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  fs.mkdirSync(path.join(root, 'user'));
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, harness, pagePath: path.join(root, 'src/pages/index.astro'), componentPath: path.join(root, 'src/components/StatWrap.astro') };
}

function find(nodes, test) {
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift();
    if (test(node)) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
}

const hasClass = (name) => (node) => node.kind === 'element' && node.props?.class?.type === 'string' && node.props.class.value === name;

test('owner scenario: stat_wrap copied out of StatWrap and pasted into the page body works, and one undo restores the page', async (context) => {
  const { root, harness, pagePath, componentPath } = await project(context);
  // Copy, as useCopyNode does: the node and its whole file.
  const component = parsePageDiskRead(await harness.invoke('page:read', componentPath));
  assert.ok(component.editable);
  const copied = find(component.model.nodes, hasClass('stat_wrap'));
  const source = modules.pasteSourceOf(component.model, { path: componentPath, role: 'component', name: 'StatWrap' }, copied);
  // Paste into the page's <main>, as useContextPaste does.
  const read = parsePageDiskRead(await harness.invoke('page:read', pagePath));
  assert.ok(read.editable);
  const main = find(read.model.nodes, (node) => node.kind === 'element' && node.name === 'main');
  const pasted = modules.withNewIds(copied);
  const plan = modules.planPaste(pasted, source, modules.pasteTargetOf(read.model, { path: pagePath, role: 'page' }));
  assert.equal(plan.kind, 'ready');
  const imports = await modules.bundleImportsFor(plan.bundle, {
    insertables: [{ name: 'Button', path: path.join(root, 'src/components/Button.astro') }],
    sourcePath: componentPath,
    targetModel: read.model,
    resolveImportPath: (targetPath) => harness.invoke('page:importPathFor', { pagePath, targetPath, projectPath: root }),
    rebase: async (fromPagePath, spec) => (await harness.invoke('page:rebaseImport', { fromPagePath, toPagePath: pagePath, spec })).path,
  });
  const style = modules.carriedStyleNode(plan.bundle, { attributes: [{ name: 'is:global', value: undefined }], content: '' }, read.source);
  const place = { parentId: main.id, index: main.children.length };
  const gesture = modules.contextPasteGesture(
    read.model,
    { node: plan.bundle.node, place, style },
    modules.withBundleFrontmatter(imports, plan.bundle.statements),
  );
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const sendBatch = async (request) => parsePageEditResult(await harness.invoke('page:editBatch', request));
  const origin = { checksum: read.checksum, source: read.source, model: read.model };
  const outcome = await modules.sendGesture({ path: pagePath, origin, gesture, record, send, sendBatch });
  assert.equal(outcome.tag, 'applied', `the page took the paste: ${JSON.stringify(outcome)}`);

  const written = fs.readFileSync(pagePath, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)^---/m.exec(written)?.[1] ?? '';
  assert.match(frontmatter, /import Button from '\.\.\/components\/Button\.astro';/);
  assert.match(frontmatter, /import \{ formatNumber \} from '\.\.\/lib\/format';/, 'the helper stays a named import, re-aimed for the page');
  assert.match(frontmatter, /const title = 'Our stats';/);
  assert.match(frontmatter, /const items = \[\{ label: 'Projects', value: 120 \}\];/);
  assert.match(frontmatter, /const heading = title\.toUpperCase\(\);/);
  assert.doesNotMatch(frontmatter, /Astro\.props/, 'no prop read is left in a page');
  assert.ok(frontmatter.indexOf('import Layout') < frontmatter.indexOf('const title'), 'the code comes after the imports');
  assert.match(written, /<style is:global>[\s\S]*\.stat_wrap::before[\s\S]*<\/style>/);
  assert.match(written, /<main class="page">[\s\S]*<div class="stat_wrap">[\s\S]*<\/main>/);

  const after = parsePageDiskRead(await harness.invoke('page:read', pagePath));
  assert.ok(after.editable, 'the page still parses');
  assert.ok(find(after.model.nodes, hasClass('stat_wrap')), 'the Navigator shows the pasted element');
  const errors = preflightFile({ path: pagePath, model: after.model }, PREFLIGHT_CODES).filter((finding) => finding.severity === 'error');
  assert.deepEqual(errors, [], 'pre-flight finds nothing that would break the page');

  for (const step of [...record.outcome.applied].reverse()) {
    if (step.inverse.length > 0) {
      const answer = await send({ pagePath, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
      assert.ok(answer.ok, 'main reverted the write');
    }
  }
  assert.equal(fs.readFileSync(pagePath, 'utf8'), PAGE, 'one undo restores the page byte for byte');
});

test('the same markup pasted bare is refused by main’s pre-flight, and nothing is written', async (context) => {
  const { harness, pagePath, componentPath } = await project(context);
  const component = parsePageDiskRead(await harness.invoke('page:read', componentPath));
  const copied = modules.withNewIds(find(component.model.nodes, hasClass('stat_wrap')));
  const read = parsePageDiskRead(await harness.invoke('page:read', pagePath));
  const main = find(read.model.nodes, (node) => node.kind === 'element' && node.name === 'main');
  const gesture = modules.insertGesture(read.model, copied, { parentId: main.id, index: main.children.length }, { urgency: true });
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const sendBatch = async (request) => parsePageEditResult(await harness.invoke('page:editBatch', request));
  const outcome = await modules.sendGesture({
    path: pagePath,
    origin: { checksum: read.checksum, source: read.source, model: read.model },
    gesture,
    record,
    send,
    sendBatch,
  });
  assert.notEqual(outcome.tag, 'applied');
  assert.match(JSON.stringify(outcome), /would-break-page|would break the page/);
  assert.equal(fs.readFileSync(pagePath, 'utf8'), PAGE, 'the page is untouched');
});
