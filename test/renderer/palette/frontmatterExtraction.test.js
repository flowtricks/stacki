// Goal: making a component from a section moves the frontmatter that section
// reads into the new file by default. What the parent still uses leaves a copy,
// what can't move safely falls back to a prop with a plain reason, relative paths
// are re-aimed, and the whole thing is one undo step.
//
// The wrong answers here are not cosmetic. A statement taken from a parent that
// still reads it, or a moved statement missing what it needs, is a ReferenceError
// that blanks the page. So each case checks both files as text, and the negative
// space: what must stay, what must not be copied, and what must not move.
//
// Method: the real planner, gesture and sender, bundled with esbuild, against
// main's real handlers in the windowless harness on a temporary project. `extract`
// goes step for step as useCreateComponent does: read the file, plan, component:create,
// then the extraction gesture as one request. Planner-only cases read a parsed page
// and look at the plan. The last section runs undo and redo through stepWithFiles,
// with the page reverted by main as revertedSteps does.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { parseIpcPayload } = require('#dist/shared/ipc/ipcPayloads.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/frontmatter-extraction');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'frontmatter-extraction.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { createdComponentFiles, stepWithFiles } from './src/app/model/componentCreation';",
      "export { extractionGesture } from './src/app/model/pageGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { namesInScope } from './src/editor/dataSuggest';",
      "export { propsForExtraction } from './src/editor/extractProps';",
      "export { planExtraction, readExtraction } from './src/editor/extractFrontmatter';",
      "export { loopVarsAt } from './src/editor/loopBindings';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const modules = require(bundle);

// Every node of a tree with its ancestors, walked without recursion.
function placed(nodes) {
  const out = [];
  const pending = nodes.map((node, index) => ({ node, parents: [], index }));
  while (pending.length > 0) {
    const next = pending.shift();
    out.push(next);
    (next.node.children ?? []).forEach((child, index) => pending.push({ node: child, parents: [...next.parents, next.node], index }));
  }
  return out;
}

const hasClass = (wanted) => (node) => node.kind === 'element' && node.props?.class?.value === wanted;

// What useComponentQueries works out for a node, against one read of the file.
function planOf(read, wanted, asProp = [], parent = 'page') {
  const { model, source } = read;
  const entry = placed(model.nodes).find(({ node }) => wanted(node));
  assert.ok(entry, 'the section is in the page');
  const { node, parents } = entry;
  const scope = modules.namesInScope(model.extraFrontmatter, model.imports);
  const loopNames = new Set(modules.loopVarsAt(model.nodes, node.id));
  for (const name of loopNames) {
    scope.add(name);
  }
  for (const entryImport of model.imports) {
    scope.delete(entryImport.name);
  }
  const extraction = modules.readExtraction({
    origin: { source, model },
    nodeId: node.id,
    names: modules.propsForExtraction(node, scope),
    loopNames,
    inLoop: parents.some((ancestor) => ancestor.kind === 'map'),
    parent,
    shown: model,
  });
  return { node, entry, plan: modules.planExtraction(extraction, new Set(asProp)) };
}

// The plan of a page that is only parsed: for cases that have nothing to write.
function planned(page, wanted = hasClass('stats'), asProp = [], parent = 'page') {
  const parsed = parsePage(page, { locs: true });
  assert.ok(parsed.editable !== false, 'the fixture parses');
  return planOf({ source: page, model: parsed.model }, wanted, asProp, parent).plan;
}

const valueNamed = (plan, name) => {
  const value = plan.values.find((entry) => entry.name === name);
  assert.ok(value, `${name} is one of the values`);
  return value;
};

async function project(context, page, pageRel = 'src/pages/index.astro') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-frontmatter-extraction-'));
  const pagePath = path.join(root, pageRel);
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(pagePath, page);
  return { root, harness, pagePath };
}

// What useCreateComponent does, step for step, against main's real handlers.
async function extract({ root, harness, pagePath }, options = {}) {
  const { wanted = hasClass('stats'), asProp = [], name = 'Stats' } = options;
  const read = parsePageDiskRead(await harness.invoke('page:read', pagePath));
  assert.ok(read.editable);
  const { model } = read;
  const { node, entry, plan } = planOf(read, wanted, asProp);
  const input = { projectPath: root, pagePath, name, nodes: [node], imports: model.imports, props: plan.props, frontmatter: plan.moved };
  const created = await harness.invoke('component:create', input);
  const paths = await harness.invoke('page:importPathFor', { pagePath, targetPath: created.path, projectPath: root });
  const place = { parentId: entry.parents[entry.parents.length - 1]?.id, index: entry.index };
  const extracted = { id: 'g' + '0'.repeat(32), name, props: plan.props, place, paths, parent: plan.parent };
  const gesture = modules.extractionGesture(model, node.id, extracted);
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const origin = { checksum: read.checksum, source: read.source, model };
  const sendBatch = async (request) => parsePageEditResult(await harness.invoke('page:editBatch', request));
  const outcome = await modules.sendGesture({ path: pagePath, origin, gesture, record, send, sendBatch });
  assert.equal(outcome.tag, 'applied', `the page took the edit: ${JSON.stringify(outcome)}`);
  return {
    plan,
    created,
    input,
    record,
    send,
    page: fs.readFileSync(pagePath, 'utf8'),
    component: fs.readFileSync(created.path, 'utf8'),
  };
}

// The block between a file's fences.
const frontmatterOf = (text) => /^---\r?\n([\s\S]*?)^---/m.exec(text)?.[1] ?? '';

const STATS_PAGE = `---
import { getCollection } from 'astro:content';
import Layout from '../layouts/Base.astro';

const statsEntries2 = await getCollection('stats');
---
<Layout>
  <section class="stats">
    {statsEntries2.map((entry) => <p>{entry.id}</p>)}
  </section>
</Layout>
`;

// ── 1. Moved by default ─────────────────────────────────────────────────────

test('a value and its import move into the component and leave the page when nothing else uses them', async (context) => {
  const setup = await project(context, STATS_PAGE);
  const { plan, page, component } = await extract(setup);

  assert.deepEqual(plan.values, [{ kind: 'move', name: 'statsEntries2', note: undefined }]);
  assert.deepEqual(plan.props, [], 'nothing is passed in');
  assert.match(frontmatterOf(component), /import \{ getCollection \} from 'astro:content';/, 'a named import stays named');
  assert.match(frontmatterOf(component), /const statsEntries2 = await getCollection\('stats'\);/);
  assert.ok(!component.includes('Astro.props'), 'the component takes no props');

  assert.ok(!frontmatterOf(page).includes('statsEntries2'), 'the statement left the page');
  assert.ok(!frontmatterOf(page).includes('getCollection'), 'and so did the import under it');
  assert.match(frontmatterOf(page), /import Layout from '\.\.\/layouts\/Base\.astro';/, 'the page keeps what it still uses');
  assert.match(page, /<Stats \/>/, 'the instance takes no attributes');
  assert.equal(
    page,
    `---
import Layout from '../layouts/Base.astro';
import Stats from '../components/Stats.astro';
---
<Layout>
  <Stats />
</Layout>
`,
    'and nothing else of the page changed, with no gap left in the block',
  );
});

test('a comment directly above a statement travels with it', async (context) => {
  const setup = await project(
    context,
    `---
const kept = 1;

// The numbers for the hero.
const stats = [1, 2];
---
<div>{kept}</div>
<section class="stats">{stats.length}</section>
`,
  );
  const { page, component } = await extract(setup);
  assert.match(frontmatterOf(component), /\/\/ The numbers for the hero\.\nconst stats = \[1, 2\];/);
  assert.ok(!page.includes('The numbers for the hero'), 'it left with the statement');
  assert.equal(frontmatterOf(page).trim().split('\n').length, 2, 'no gap is left: the import and the statement that stayed');
});

// ── 2. A copy stays ─────────────────────────────────────────────────────────

test('a value the page still reads in its template leaves a copy, and says so', async (context) => {
  const setup = await project(
    context,
    `---
import { getCollection } from 'astro:content';

const stats = await getCollection('stats');
---
<section class="stats">{stats.length}</section>
<p>{stats.length} in total</p>
`,
  );
  const { plan, page, component } = await extract(setup);
  assert.equal(plan.values[0].kind, 'move');
  assert.match(plan.values[0].note, /A copy stays on this page because it’s also used here/);
  assert.match(frontmatterOf(component), /const stats = await getCollection\('stats'\);/, 'the component has its own');
  assert.match(frontmatterOf(component), /import \{ getCollection \}/);
  assert.match(frontmatterOf(page), /const stats = await getCollection\('stats'\);/, 'and so does the page');
  assert.match(frontmatterOf(page), /import \{ getCollection \}/, 'with the import its copy needs');
});

test('a value other frontmatter still reads leaves a copy, and what the copy reads stays too', () => {
  const plan = planned(`---
import { getCollection } from 'astro:content';
const stats = await getCollection('stats');
const total = stats.length;
---
<section class="stats">{stats.length}</section>
<p>{total}</p>
`);
  assert.match(valueNamed(plan, 'stats').note, /A copy stays/);
  assert.match(plan.parent.extraFrontmatter, /const stats =/);
  assert.match(plan.parent.extraFrontmatter, /const total =/);
  assert.deepEqual(
    plan.parent.imports.map((entry) => entry.name),
    ['getCollection'],
  );
});

test('a read only a parameter or a string spells is no read of the page value', () => {
  const plan = planned(`---
const stats = [1];
---
<section class="stats">{stats.length}</section>
<ul>{[1].map((stats) => <li>{stats}</li>)}</ul>
<p title="stats">stats</p>
`);
  assert.equal(valueNamed(plan, 'stats').note, undefined, 'a shadowing parameter and plain words read nothing');
  assert.equal(plan.parent.extraFrontmatter, '');
});

test('a value used as a tag moves with the section, and counts as used elsewhere', () => {
  const page = (rest) => `---
const Heading = 'h2';
---
<section class="stats"><Heading>Title</Heading></section>
${rest}
`;
  assert.equal(planned(page('')).moved.code, "const Heading = 'h2';");
  assert.match(valueNamed(planned(page('<Heading>Again</Heading>')), 'Heading').note, /A copy stays/);
});

test('a value a dynamic tag or an attribute reads counts as used', () => {
  const plan = planned(`---
const link = '/a';
---
<section class="stats"><a href={link}>a</a></section>
<a {link}>b</a>
`);
  assert.match(valueNamed(plan, 'link').note, /A copy stays/);
});

// ── 3. Dependency chains ────────────────────────────────────────────────────

test('a chain moves whole and in order, imports and all', async (context) => {
  const setup = await project(
    context,
    `---
import { getCollection } from 'astro:content';
import { byDate } from '../lib/sort';
import unused from '../lib/unused';

const entries = await getCollection('stats');
const sorted = [...entries].sort(byDate);
const limit = 3;
const shown = sorted.slice(0, limit);
---
<section class="stats">{shown.length}</section>
`,
  );
  const { plan, page, component } = await extract(setup);
  assert.deepEqual(
    plan.values.map((value) => value.name),
    ['shown'],
    'only what the section reads is listed',
  );
  const moved = frontmatterOf(component);
  const order = ['const entries', 'const sorted', 'const limit', 'const shown'].map((text) => moved.indexOf(text));
  assert.ok(
    order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])),
    moved,
  );
  assert.match(moved, /import \{ byDate \} from '\.\.\/lib\/sort';/);
  assert.ok(!moved.includes('unused'), 'an import nothing moved reads is left behind');
  assert.ok(!frontmatterOf(page).includes('entries'), 'the whole chain left the page');
  assert.ok(!frontmatterOf(page).includes('byDate'));
  assert.match(frontmatterOf(page), /import unused from/, 'one this extraction did not free is not touched');
});

test('a type a moved statement names comes with it', () => {
  const plan = planned(`---
import type { Stat } from '../types';
interface Row { stat: Stat }
const rows: Row[] = [];
---
<section class="stats">{rows.length}</section>
`);
  assert.match(plan.moved.code, /interface Row/);
  assert.match(plan.moved.code, /const rows: Row\[\]/);
  // A whole `import type` stays code, so it travels as a statement.
  assert.match(plan.moved.code, /import type \{ Stat \} from '\.\.\/types';/);
  assert.equal(plan.parent.extraFrontmatter, '', 'and none of it is left behind');

  const member = planned(`---
import { type Stat } from '../types';
const rows: Stat[] = [];
---
<section class="stats">{rows.length}</section>
`);
  assert.deepEqual(
    member.moved.imports.map((entry) => entry.name),
    ['Stat'],
    'a type member is an import like any other',
  );
});

test('a line that reorders a value travels with it, and stays beside any copy', () => {
  const page = (rest) => `---
const all = [2, 1];
const sorted = all.sort();
const copied = [...all].sort();
---
<section class="stats">{sorted.length}</section>
${rest}
`;
  const alone = planned(page(''));
  assert.equal(valueNamed(alone, 'sorted').kind, 'move');
  assert.match(alone.moved.code, /const all = \[2, 1\];\nconst sorted = all\.sort\(\);/);
  assert.ok(!alone.moved.code.includes('copied'), '`[...all].sort()` changes nothing, so it does not come along');

  const both = planned(page('<p>{all.length}</p>'));
  assert.match(both.parent.extraFrontmatter, /const all = \[2, 1\];\nconst sorted = all\.sort\(\);/, 'the parent keeps the order it was written against');

  const readAlone = planned(`---
const all = [2, 1];
const sorted = all.sort();
---
<section class="stats">{all.length}</section>
`);
  assert.match(readAlone.moved.code, /const sorted = all\.sort\(\);/, 'read directly, the value still comes with what reorders it');
});

// ── 4. Relative paths ───────────────────────────────────────────────────────

test('relative imports are re-aimed from the new file, in the import and in moved code', async (context) => {
  const setup = await project(
    context,
    `---
import { rows } from '../../data/rows';
import * as all from '../../data/all';
import { get } from '@/lib/get';

const shown = [rows, all, get];
const later = () => import('../../data/lazy');
---
<section class="stats">{shown.length}{later.length}</section>
`,
    'src/pages/blog/index.astro',
  );
  const { component } = await extract(setup);
  const moved = frontmatterOf(component);
  assert.match(moved, /import \{ rows \} from '\.\.\/data\/rows';/, 'a modelled import');
  assert.match(moved, /import \* as all from "\.\.\/data\/all";/, 'an import kept as code');
  assert.match(moved, /import\("\.\.\/data\/lazy"\)/, 'a dynamic import');
  assert.match(moved, /from '@\/lib\/get'/, 'an alias means the same everywhere');
});

// ── 5. What can't move ──────────────────────────────────────────────────────

test('an Astro.props value is a prop with a reason, and stays in the parent', async (context) => {
  const setup = await project(
    context,
    `---
const { title } = Astro.props;
---
<section class="stats">{title}</section>
`,
  );
  const { plan, page, component } = await extract(setup);
  assert.equal(plan.values[0].kind, 'locked');
  assert.match(plan.values[0].reason, /this page’s Astro\.props, which the new component can’t see/);
  assert.deepEqual(plan.props, ['title']);
  assert.match(frontmatterOf(page), /const \{ title \} = Astro\.props;/);
  assert.match(page, /<Stats title=\{title\} \/>/);
  assert.match(frontmatterOf(component), /const \{ title \} = Astro\.props;/);
});

test('a value built on one the child cannot see is a prop too', () => {
  const plan = planned(`---
const slug = Astro.params.slug;
const url = '/x/' + slug;
---
<section class="stats">{url}</section>
`);
  const value = valueNamed(plan, 'url');
  assert.equal(value.kind, 'locked');
  assert.match(value.reason, /It needs slug, which has to stay on this page/);
  assert.equal(plan.moved.code, '');
});

test('reading a parent component’s props is worded for a component', () => {
  const plan = planned(
    `---
const title = Astro.props.title;
---
<section class="stats">{title}</section>
`,
    hasClass('stats'),
    [],
    'component',
  );
  assert.match(valueNamed(plan, 'title').reason, /the parent component’s Astro\.props/);
});

test('what Astro answers the same in a child can move', () => {
  const plan = planned(`---
const path = Astro.url.pathname;
---
<section class="stats">{path}</section>
`);
  assert.equal(valueNamed(plan, 'path').kind, 'move');
});

test('a let reassigned elsewhere falls back, and so does a value something mutates', () => {
  const reassigned = planned(`---
let count = 0;
count = 5;
---
<section class="stats">{count}</section>
`);
  assert.equal(valueNamed(reassigned, 'count').kind, 'locked');
  assert.match(valueNamed(reassigned, 'count').reason, /changed elsewhere on this page/);
  assert.match(reassigned.parent.extraFrontmatter, /let count = 0;\ncount = 5;/, 'both lines stay');

  const pushed = planned(`---
const list = [];
list.push(1);
---
<section class="stats">{list.length}</section>
`);
  assert.match(valueNamed(pushed, 'list').reason, /changed elsewhere/);

  const fromFunction = planned(`---
let seen = 0;
const mark = () => { seen += 1; };
---
<section class="stats">{seen}</section>
<p>{mark()}</p>
`);
  assert.match(valueNamed(fromFunction, 'seen').reason, /changed elsewhere/);

  const fromTemplate = planned(`---
let seen = 0;
---
<section class="stats">{seen}</section>
<p>{seen++}</p>
`);
  assert.match(valueNamed(fromTemplate, 'seen').reason, /changed elsewhere/);

  const untouched = planned(`---
let seen = 0;
---
<section class="stats">{seen}</section>
`);
  assert.equal(valueNamed(untouched, 'seen').kind, 'move', 'a let nothing reassigns is a const in all but name');
});

test('side-effect statements never move, and what they touch stays with them', () => {
  const plan = planned(`---
const rows = [1];
console.log(rows);
if (rows.length === 0) {
  return Astro.redirect('/404');
}
---
<section class="stats">{rows.length}</section>
`);
  assert.equal(valueNamed(plan, 'rows').kind, 'locked');
  assert.match(valueNamed(plan, 'rows').reason, /Other code at the top on this page also works with it/);
  assert.equal(plan.moved.code, '');
});

test('exports stay: an exported value is a prop', () => {
  const plan = planned(`---
export const prerender = true;
const rows = [1];
export { rows };
---
<section class="stats">{prerender}{rows.length}</section>
`);
  assert.match(valueNamed(plan, 'prerender').reason, /exported/);
  assert.match(valueNamed(plan, 'rows').reason, /exported/);
});

test('a function capturing another value falls back; one that captures only imports moves', () => {
  const capturing = planned(`---
const rate = 2;
function price(value) {
  return value * rate;
}
---
<section class="stats">{price(1)}</section>
`);
  assert.match(valueNamed(capturing, 'price').reason, /a function that uses rate/);

  const arrow = planned(`---
const rate = 2;
const price = (value) => value * rate;
---
<section class="stats">{price(1)}</section>
`);
  assert.match(valueNamed(arrow, 'price').reason, /a function that uses rate/);

  const clean = planned(`---
import { format } from '../lib/format';
function label(value) {
  return format(value);
}
---
<section class="stats">{label(1)}</section>
`);
  assert.equal(valueNamed(clean, 'label').kind, 'move');
  assert.deepEqual(
    clean.moved.imports.map((entry) => entry.name),
    ['format'],
  );
});

test('code that finds files from where it is written does not move', () => {
  const plan = planned(`---
const files = import.meta.glob('./posts/*.md');
---
<section class="stats">{files.length}</section>
`);
  assert.match(valueNamed(plan, 'files').reason, /finds files from where it’s written/);
});

test('a value that would answer differently twice moves alone, but never leaves a copy', () => {
  const alone = planned(`---
const now = Date.now();
---
<section class="stats">{now}</section>
`);
  assert.equal(valueNamed(alone, 'now').kind, 'move', 'one run in another file is still one run');

  for (const code of ['const now = Date.now();', 'const now = Math.random();', 'const now = new Date();', "const now = await fetch('/x');"]) {
    const shared = planned(`---
${code}
---
<section class="stats">{now}</section>
<p>{now}</p>
`);
    assert.equal(valueNamed(shared, 'now').kind, 'locked', code);
    assert.match(valueNamed(shared, 'now').reason, /running it twice could give a different result/);
    assert.equal(shared.moved.code, '', 'nothing was copied');
  }
  const dated = planned(`---
const start = new Date('2020-01-01');
---
<section class="stats">{start}</section>
<p>{start}</p>
`);
  assert.equal(valueNamed(dated, 'start').kind, 'move', 'a date from a value is a value');
});

test('a page that cannot be read safely passes everything in, and touches nothing', () => {
  const page = `---
const rows = [1];
---
<section class="stats">{rows.length}</section>
`;
  const parsed = parsePage(page, { locs: true });
  const read = modules.readExtraction({
    origin: undefined,
    nodeId: 'x',
    names: ['rows'],
    loopNames: new Set(),
    inLoop: false,
    parent: 'page',
    shown: parsed.model,
  });
  const plan = modules.planExtraction(read, new Set());
  assert.equal(plan.values[0].kind, 'locked');
  assert.match(plan.values[0].reason, /still saving/);
  assert.deepEqual(plan.props, ['rows']);
  assert.equal(plan.parent.extraFrontmatter, parsed.model.extraFrontmatter);
});

// ── 6. Loops ────────────────────────────────────────────────────────────────

const LOOP_PAGE = `---
const rows = [1, 2];
const label = 'Row';
const remote = await load();
---
<ul>
  {rows.map((row, index) => (
    <li class="stats">{label}{row}{index}{remote}</li>
  ))}
</ul>
`;

test('a section in a loop has one instance; its item is a prop and page values still move', async (context) => {
  const setup = await project(context, LOOP_PAGE);
  const { plan, page, component } = await extract(setup);
  assert.equal(valueNamed(plan, 'row').kind, 'locked');
  assert.match(valueNamed(plan, 'row').reason, /comes from the loop around this element/);
  assert.equal(valueNamed(plan, 'index').kind, 'locked');
  assert.equal(valueNamed(plan, 'label').kind, 'move');
  assert.match(page, /<Stats row=\{row\} index=\{index\} remote=\{remote\} \/>/, 'the instance sits where the markup was, passing the item in');
  assert.equal((page.match(/<Stats/g) ?? []).length, 1);
  assert.match(frontmatterOf(component), /const \{ row, index, remote \} = Astro\.props;/);
  assert.match(frontmatterOf(component), /const label = 'Row';/);
  assert.match(frontmatterOf(page), /const rows = \[1, 2\];/, 'the list the loop reads stays');
});

test('deeper in a loop, and under a condition, the swap still lands whole', async (context) => {
  const deep = await project(
    context,
    `---
const rows = [1];
const label = 'Row';
---
<ul>{rows.map((row) => <li><b class="stats">{label}{row}</b><i>{row}</i></li>)}</ul>
`,
  );
  const inside = await extract(deep);
  assert.match(inside.page, /<li>\s*<Stats row=\{row\} \/>\s*<i>\{row\}<\/i>\s*<\/li>/);
  assert.ok(!frontmatterOf(inside.page).includes('label'), 'the frontmatter half of the edit was not lost');
  assert.match(frontmatterOf(inside.page), /import Stats from '\.\.\/components\/Stats\.astro';/);

  const conditional = await project(
    context,
    `---
const show = true;
const label = 'Row';
---
{show && <section class="stats">{label}</section>}
`,
  );
  const shown = await extract(conditional);
  assert.match(shown.page, /\{show && <Stats \/>\}/);
  assert.ok(!frontmatterOf(shown.page).includes('label'));
});

test('work a loop would repeat stays in the parent', () => {
  const plan = planned(LOOP_PAGE);
  assert.equal(valueNamed(plan, 'remote').kind, 'locked');
  assert.match(valueNamed(plan, 'remote').reason, /inside a loop, so it would run again for every item/);
});

// ── 7. The prop option ──────────────────────────────────────────────────────

test('chosen, Pass in as a prop works as it always did and leaves the page alone', async (context) => {
  const setup = await project(context, STATS_PAGE);
  const { plan, page, component } = await extract(setup, { asProp: ['statsEntries2'] });
  assert.deepEqual(plan.values, [{ kind: 'prop', name: 'statsEntries2' }]);
  assert.deepEqual(plan.props, ['statsEntries2']);
  assert.equal(plan.moved.code, '');
  assert.match(frontmatterOf(component), /const \{ statsEntries2 \} = Astro\.props;/);
  assert.ok(!component.includes('getCollection'), 'nothing travelled');
  assert.match(frontmatterOf(page), /const statsEntries2 = await getCollection\('stats'\);/);
  assert.match(frontmatterOf(page), /import \{ getCollection \} from 'astro:content';/);
  assert.match(page, /<Stats statsEntries2=\{statsEntries2\} \/>/);
});

test('a moved value that reads a prop reads it off Astro.props in the component', async (context) => {
  const setup = await project(
    context,
    `---
const rows = [1];
const total = rows.length;
---
<section class="stats">{rows.length}{total}</section>
`,
  );
  const { plan, page, component } = await extract(setup, { asProp: ['rows'] });
  assert.equal(valueNamed(plan, 'total').kind, 'move');
  const moved = frontmatterOf(component);
  assert.ok(moved.indexOf('Astro.props') < moved.indexOf('const total'), 'the prop is there before the code that reads it');
  assert.ok(!moved.includes('const rows'), 'and it is not declared twice');
  assert.match(frontmatterOf(page), /const rows = \[1\];/);
  assert.ok(!frontmatterOf(page).includes('const total'));
});

test('two values of one statement move together or not at all, and the choice can be taken back', () => {
  const page = `---
const { a, b } = { a: 1, b: 2 };
---
<section class="stats">{a}{b}</section>
`;
  const both = planned(page);
  assert.equal(both.moved.code, 'const { a, b } = { a: 1, b: 2 };', 'one statement, once');
  const split = planned(page, hasClass('stats'), ['b']);
  assert.equal(valueNamed(split, 'b').kind, 'prop', 'the chosen value stays a choice');
  assert.equal(valueNamed(split, 'a').kind, 'locked');
  assert.match(valueNamed(split, 'a').reason, /declared together with b/);
  assert.deepEqual(split.props, ['a', 'b']);
});

// ── 2b. What leaves the page ────────────────────────────────────────────────
// The page must stop declaring what only the section used, and only that: each case
// reads both files as text, then checks what was kept as hard as what was taken.

test('moved and read nowhere else: the declaration and its import leave, and only they', async (context) => {
  const setup = await project(
    context,
    `---
import Layout from '../layouts/Base.astro';
import { getCollection } from 'astro:content';

const title = 'Home';
const statsEntries = (await getCollection('stats')).sort((a, b) => a.data.order - b.data.order);
const subtitle = 'Numbers';
---
<Layout title={title}>
  <h2>{subtitle}</h2>
  <section class="stats">
    {statsEntries.map((entry) => <p>{entry.data.title}</p>)}
  </section>
</Layout>
`,
  );
  const { page, component } = await extract(setup);
  assert.equal(
    page,
    `---
import Layout from '../layouts/Base.astro';
import Stats from '../components/Stats.astro';

const title = 'Home';
const subtitle = 'Numbers';
---
<Layout title={title}>
  <h2>{subtitle}</h2>
  <Stats />
</Layout>
`,
    'the blank line the file had is the single one left, and nothing else was reprinted',
  );
  assert.match(frontmatterOf(component), /const statsEntries = \(await getCollection\('stats'\)\)\.sort/);
  assert.ok(!/\n\n\n/.test(page), 'no run of blank lines');
});

test('moved but read again by other markup: the declaration stays and the dialog says so', async (context) => {
  const setup = await project(
    context,
    `---
import { getCollection } from 'astro:content';
const statsEntries = await getCollection('stats');
---
<section class="stats">{statsEntries.length}</section>
<footer>{statsEntries.length} stats</footer>
`,
  );
  const { plan, page } = await extract(setup);
  assert.match(valueNamed(plan, 'statsEntries').note, /A copy stays on this page/);
  assert.match(frontmatterOf(page), /const statsEntries = await getCollection\('stats'\);/);
  assert.match(frontmatterOf(page), /import \{ getCollection \} from 'astro:content';/);
});

test('moved but read by a script or another statement: it stays', () => {
  const byScript = planned(`---
const statsEntries = [1, 2];
---
<section class="stats">{statsEntries.length}</section>
<script define:vars={{ statsEntries }}>console.log(statsEntries)</script>
`);
  assert.match(byScript.parent.extraFrontmatter, /const statsEntries = \[1, 2\];/);
  const byStatement = planned(`---
const statsEntries = [1, 2];
const first = statsEntries[0];
---
<section class="stats">{statsEntries.length}</section>
<p>{first}</p>
`);
  assert.match(byStatement.parent.extraFrontmatter, /const statsEntries = /);
});

test('only the moved declaration leaves when its neighbours stay', () => {
  const plan = planned(`---
import { getCollection } from 'astro:content';
const pages = await getCollection('pages');
const statsEntries = await getCollection('stats');
const posts = await getCollection('posts');
---
<section class="stats">{statsEntries.length}</section>
<p>{pages.length}{posts.length}</p>
`);
  assert.equal(plan.parent.extraFrontmatter, "const pages = await getCollection('pages');\nconst posts = await getCollection('posts');");
  assert.deepEqual(
    plan.parent.imports.map((entry) => entry.name),
    ['getCollection'],
    'the import is still used by the statements that stayed',
  );
  assert.equal(plan.moved.code, "const statsEntries = await getCollection('stats');", 'and nothing of the neighbours travels');
});

test('an import another remaining use needs is kept; one nobody else uses goes', () => {
  const plan = planned(`---
import { getCollection, getEntry } from 'astro:content';
const statsEntries = await getCollection('stats');
const home = await getEntry('pages', 'home');
---
<section class="stats">{statsEntries.length}</section>
<h1>{home.data.title}</h1>
`);
  assert.deepEqual(
    plan.parent.imports.map((entry) => entry.name),
    ['getEntry'],
  );
  assert.deepEqual(
    plan.moved.imports.map((entry) => entry.name),
    ['getCollection'],
  );
});

test('an import still read by the template stays when the declaration leaves', () => {
  const plan = planned(`---
import { getCollection } from 'astro:content';
const statsEntries = await getCollection('stats');
---
<section class="stats">{statsEntries.length}</section>
<p>{String(getCollection)}</p>
`);
  assert.equal(plan.parent.extraFrontmatter, '', 'the declaration left');
  assert.deepEqual(
    plan.parent.imports.map((entry) => entry.name),
    ['getCollection'],
  );
});

test('a declaration shared with a neighbour in one statement is split: only the moved declarator leaves', async (context) => {
  const setup = await project(
    context,
    `---
import { getCollection } from 'astro:content';
const pages = await getCollection('pages'), statsEntries = await getCollection('stats');
---
<section class="stats">{statsEntries.length}</section>
<p>{pages.length}</p>
`,
  );
  const { plan, page, component } = await extract(setup);
  assert.equal(valueNamed(plan, 'statsEntries').note, undefined, 'nothing of it stays');
  assert.equal(frontmatterOf(component).includes('pages'), false, 'the neighbour does not travel');
  assert.match(frontmatterOf(component), /const statsEntries = await getCollection\('stats'\);/);
  assert.match(frontmatterOf(page), /^const pages = await getCollection\('pages'\);$/m, 'the neighbour stays, as one declaration');
  assert.ok(!frontmatterOf(page).includes('statsEntries'));
  assert.match(frontmatterOf(page), /import \{ getCollection \} from 'astro:content';/);
});

test('splitting a statement leaves every other declarator as written, wherever the moved one stood', () => {
  const first = planned(`---
const statsEntries = [1], a = { x: 1, y: [2, 3] }, b = (n) => n;
---
<section class="stats">{statsEntries.length}</section>
<p>{a.x}{b(1)}</p>
`);
  assert.equal(first.parent.extraFrontmatter, 'const a = { x: 1, y: [2, 3] }, b = (n) => n;');
  const middle = planned(`---
const a = { x: 1 }, statsEntries = [1], b = 2;
---
<section class="stats">{statsEntries.length}</section>
<p>{a.x}{b}</p>
`);
  assert.equal(middle.parent.extraFrontmatter, 'const a = { x: 1 }, b = 2;');
  const last = planned(`---
const a = 1, b = [2, 3], statsEntries = [1];
---
<section class="stats">{statsEntries.length}</section>
<p>{a}{b}</p>
`);
  assert.equal(last.parent.extraFrontmatter, 'const a = 1, b = [2, 3];');
  const both = planned(`---
const a = 1, statsEntries = [1], c = [4];
---
<section class="stats">{statsEntries.length}{c.length}</section>
<p>{a}</p>
`);
  assert.equal(both.parent.extraFrontmatter, 'const a = 1;', 'two declarators leave, one stays');
  assert.equal(both.moved.code, 'const statsEntries = [1];\nconst c = [4];');
});

test('a statement whose declarators all move leaves whole, comment and all', () => {
  const plan = planned(`---
const kept = 1;

// The numbers.
const a = [1], statsEntries = [a];
---
<p>{kept}</p>
<section class="stats">{statsEntries.length}</section>
`);
  assert.equal(plan.parent.extraFrontmatter, 'const kept = 1;');
});

test('a declarator a staying neighbour reads is kept with it', () => {
  const plan = planned(`---
const statsEntries = [1, 2], total = statsEntries.length;
---
<section class="stats">{statsEntries.length}</section>
<p>{total}</p>
`);
  assert.match(valueNamed(plan, 'statsEntries').note, /A copy stays/);
  assert.equal(plan.parent.extraFrontmatter, 'const statsEntries = [1, 2], total = statsEntries.length;');
});

test('a pattern declaration is not split: it moves whole or stays whole', () => {
  const plan = planned(`---
const [pages, statsEntries] = await Promise.all([get('pages'), get('stats')]);
---
<section class="stats">{statsEntries.length}</section>
<p>{pages.length}</p>
`);
  assert.match(plan.parent.extraFrontmatter, /^const \[pages, statsEntries\] = /, 'a destructure is one declarator and stays intact');
});

test('when the moved code was all the frontmatter held, the page keeps only what it imports', async (context) => {
  const setup = await project(
    context,
    `---
const statsEntries = [1, 2];
---
<section class="stats">{statsEntries.length}</section>
`,
  );
  const { page } = await extract(setup);
  assert.equal(
    page,
    `---
import Stats from '../components/Stats.astro';
---
<Stats />
`,
    'a clean block, with no gap where the declaration was',
  );
});

test('an import only the markup read leaves with it; one the rest of the page reads stays', async (context) => {
  const setup = await project(
    context,
    `---
import Icon from '../components/Icon.astro';
import Badge from '../components/Badge.astro';
---
<section class="stats"><Icon /><Badge /></section>
<Badge />
`,
  );
  const { page, component } = await extract(setup);
  assert.match(frontmatterOf(component), /import Icon from '\.\/Icon\.astro';/);
  assert.match(frontmatterOf(component), /import Badge from '\.\/Badge\.astro';/);
  assert.ok(!frontmatterOf(page).includes('Icon'), 'nothing on the page reads it now');
  assert.match(frontmatterOf(page), /import Badge from/);
});

// ── 8. The boundary ─────────────────────────────────────────────────────────

test('component:create keeps all of an import, and refuses moved code that is not text', () => {
  const request = { projectPath: '/site', pagePath: '/site/src/pages/index.astro', name: 'Stats', nodes: [{}] };
  const entry = { name: 'all', path: 'astro:content', quote: "'", named: true, imported: 'getCollection', typeOnly: false };
  const parsed = parseIpcPayload('component:create', { ...request, imports: [entry], frontmatter: { imports: [entry], code: 'const a = 1;' } });
  assert.deepEqual(parsed.imports, [entry], 'a named import stays named');
  assert.deepEqual(parsed.frontmatter, { imports: [entry], code: 'const a = 1;' });
  assert.equal(parseIpcPayload('component:create', request).frontmatter, undefined, 'moved code is optional');
  assert.throws(() => parseIpcPayload('component:create', { ...request, frontmatter: { imports: [], code: 1 } }), /Expected string/);
  assert.throws(() => parseIpcPayload('component:create', { ...request, frontmatter: { code: '' } }));
  assert.throws(() => parseIpcPayload('component:create', { ...request, frontmatter: { imports: [], code: 'x'.repeat(100_000_000) } }), /exceeds limit/);
});

// ── 9. One undo step ────────────────────────────────────────────────────────

// The inverses of `applied`, newest first, as revertedSteps sends them; the
// inverses of those writes, for the other direction.
async function reverted(send, pagePath, applied) {
  const done = [];
  for (const step of [...applied].reverse()) {
    if (step.inverse.length === 0) {
      continue;
    }
    const answer = await send({ pagePath, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
    assert.ok(answer.ok, 'main reverted the write');
    done.push({ checksum: answer.value.checksum, inverse: answer.value.inverse });
  }
  return done;
}

test('one undo puts the moved code back and takes the file; one redo does both again', async (context) => {
  const setup = await project(context, STATS_PAGE);
  const made = await extract(setup);
  const { root, harness, pagePath } = setup;
  const files = modules.createdComponentFiles(
    {
      discard: async ({ checksum, force }) =>
        (await harness.invoke('component:discard', { projectPath: root, path: made.created.path, checksum, force })).outcome,
      create: async () => (await harness.invoke('component:create', made.input)).checksum,
      confirmDelete: async () => false,
      rescan: async () => {},
    },
    made.created.checksum,
  );

  let undone = [];
  const undo = await modules.stepWithFiles('undo', files, async () => {
    undone = await reverted(made.send, pagePath, made.record.outcome.applied);
    return 'whole';
  });
  assert.deepEqual(undo, { tag: 'stepped', page: 'whole' });
  assert.equal(fs.readFileSync(pagePath, 'utf8'), STATS_PAGE, 'the page is restored byte for byte, the moved code with it');
  assert.ok(!fs.existsSync(made.created.path), 'and the component file is gone');

  const redo = await modules.stepWithFiles('redo', files, async () => {
    await reverted(made.send, pagePath, undone);
    return 'whole';
  });
  assert.deepEqual(redo, { tag: 'stepped', page: 'whole' });
  assert.equal(fs.readFileSync(made.created.path, 'utf8'), made.component, 'redo writes the moved code into the component again');
  assert.equal(fs.readFileSync(pagePath, 'utf8'), made.page, 'and takes it out of the page again');
});

// ── 10. The default ──────────────────────────────────────────────────────────

test('with nothing chosen, every value that can move does', () => {
  const plan = planned(`---
const one = 1;
const two = 2;
---
<section class="stats">{one}{two}</section>
`);
  assert.deepEqual(
    plan.values.map((value) => value.kind),
    ['move', 'move'],
  );
  assert.deepEqual(plan.props, []);
});
