// Goal: a loop over a list written out in a frontmatter constant
// (`const promises = ["…", "…"]`, the stacki.build home page's promises) has the
// list settings a collection loop and a List prop have: Filters, Sort and Limit.
// A list of objects offers the fields its values are written with; a list of
// plain values offers the item itself (ITEM_FIELD, labelled "Item"), so a filter
// compares each text or number and a sort orders by it. Each setting is written
// into the loop's head, naming the item as the loop does, so the constant is
// never rewritten.
//
// Method: the reader, the field reader and the planner run as pure code over
// the marketing page's own frontmatter and loop, parsed by main's real page
// parser, with each setting written and read back as the same query. What must
// stay out is checked too: a constant holding a computed list, a list held in a
// second constant, an inline list. Then the real LoopSettings, bundled as the
// app bundles it, renders in jsdom: the sections it shows, and what each control
// hands to onApply, which the planner turns into the head the file gets.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');

const { readLoop, readPipeline } = load('src/editor/loopQueryRead.ts');
const loopQuery = load('src/editor/loopQuery.ts');
const { planLoop, targetKey } = load('src/editor/loopQueryPlan.ts');
const { writtenListFields } = load('src/editor/loopLiteral.ts');
const { readSections } = load('src/editor/loopSections.ts');

const directory = repoPath('node_modules/.stacki-test/loop-written-list');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-written-list.cjs');
buildSync({
  stdin: {
    contents: "export { default as LoopSettings } from './src/features/props/LoopSettings';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The reported page, cut to the loop: its frontmatter and markup as written.
const PAGE = `---
import Icon from "@/components/Icon.astro";
import check from "@/assets/icons/check.svg";

const promises = [
  "Free and open source",
  "Works on any Astro site",
  "Easy to customize",
];
---
<ul class="promises" data-enter>
  {promises.map((promise) => (
    <li class="promises_item text-style-ui">
      <Icon src={check} variant="small" class="promises_check" />
      {promise}
    </li>
  ))}
</ul>
`;

const PLANS = `const plans = [
  { title: "Starter", price: 0, featured: false, tags: ["solo"] },
  { title: "Pro", price: 12, featured: true, note: 3 },
  { title: "Team", price: 40, featured: false, note: "ask" },
];
`;

function parsedLoop(text) {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true, result.reason);
  const loop = result.model.nodes[0]?.children?.[0];
  assert.equal(loop?.kind, 'map');
  return { model: result.model, loop };
}

function planned(model, loop, target) {
  const result = planLoop({ model, loop, target, sanityClient: 'unavailable' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.plan;
}

const promises = { kind: 'list', collection: 'promises' };
const ITEM = loopQuery.ITEM_FIELD;
const plans = { kind: 'list', collection: 'plans' };

test('the page’s loop reads as a list query held in its constant', () => {
  const { model, loop } = parsedLoop(PAGE);
  assert.equal(serializePage(model), PAGE, 'an untouched file writes back byte for byte');
  assert.equal(loop.head, 'promises.map((promise) => (');
  const reading = readLoop({ frontmatter: model.extraFrontmatter, imports: model.imports, data: 'promises' });
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.query, loopQuery.emptyQuery(promises));
  assert.deepEqual(reading.chain, ['promises'], 'the Source row opens the constant');
  const pipeline = readPipeline({ frontmatter: model.extraFrontmatter, imports: model.imports, data: 'promises.slice(0, 2)' });
  assert.deepEqual(pipeline.source, promises);
  assert.equal(pipeline.base, 'promises');
  assert.equal(pipeline.steps.length, 1);
  assert.equal(pipeline.steps[0].place, 'head', 'every step is the head’s');
  const sections = readSections({ frontmatter: model.extraFrontmatter, imports: model.imports, data: 'promises.slice(0, 2)' });
  assert.equal(sections.store, 'steps');
  assert.equal(sections.limit.code, '2');
  assert.equal(sections.limit.custom, undefined);
});

test('a list of plain values is its own field; a list of objects has the fields it is written with', () => {
  const { model } = parsedLoop(PAGE);
  assert.deepEqual(writtenListFields(model.extraFrontmatter, 'promises'), [{ path: loopQuery.ITEM_FIELD, kind: 'text' }]);
  assert.deepEqual(writtenListFields('const sizes = [3, 1, 2];\n', 'sizes'), [{ path: loopQuery.ITEM_FIELD, kind: 'number' }]);
  assert.deepEqual(writtenListFields('const mixed = ["a", 1];\n', 'mixed'), [{ path: loopQuery.ITEM_FIELD, kind: 'other' }]);
  assert.deepEqual(writtenListFields('const odd = [{ $item: 1 }];\n', 'odd'), [], 'a key named like the item itself is never a field');
  assert.deepEqual(writtenListFields(PLANS, 'plans'), [
    { path: 'title', kind: 'text' },
    { path: 'price', kind: 'number' },
    { path: 'featured', kind: 'boolean' },
    { path: 'tags', kind: 'list' },
    { path: 'note', kind: 'other' },
  ]);
  assert.equal(writtenListFields(PLANS, 'other'), undefined, 'a name nothing declares');
  assert.equal(writtenListFields('const plans = getPlans();\n', 'plans'), undefined, 'a list some code computes');
  assert.equal(writtenListFields('const plans = "Pro";\n', 'plans'), undefined, 'a constant holding words');
});

test('what is not a written-out list named by the loop reads as it always did', () => {
  const read = (frontmatter, data) => readLoop({ frontmatter, imports: [], data });
  assert.equal(read('const plans = getPlans();\n', 'plans').kind, 'value', 'a computed list');
  const held = `${PLANS}const shown = plans.slice(0, 2);\n`;
  const reading = read(held, 'shown');
  assert.equal(reading.kind, 'value', 'a list held in a second constant stays a value: its steps live in the frontmatter');
  assert.equal(read('', '["a", "b"]').kind, 'code', 'an inline list is the typed rows, not a query');
});

test('each control writes the head and reads back as the same query', () => {
  const empty = loopQuery.emptyQuery(plans);
  const kinds = (_source, field) => ({ title: 'text', price: 'number', featured: 'boolean' })[field];
  const cheap = { kind: 'test', field: 'price', operator: 'less', value: 20 };
  const byPrice = { field: 'price', direction: 'descending', order: 'number' };
  const cases = [
    [{ ...empty, limit: 2 }, 'plans.slice(0, 2)'],
    [{ ...empty, conditions: [cheap] }, 'plans.filter((item) => item.price < 20)'],
    [{ ...empty, sorts: [byPrice] }, 'plans.toSorted((a, b) => (b.price ?? 0) - (a.price ?? 0))'],
    [
      { ...empty, conditions: [cheap], sorts: [byPrice], limit: 1 },
      'plans.filter((item) => item.price < 20).toSorted((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 1)',
    ],
  ];
  for (const [query, code] of cases) {
    assert.equal(loopQuery.listQueryCode(query), code);
    const reading = readLoop({ frontmatter: PLANS, imports: [], data: code, fieldKind: kinds });
    assert.equal(reading.kind, 'query', code);
    assert.deepEqual(reading.query, query, code);
  }
});

test('applying a limit, a filter and a sort writes the page’s head and leaves the constant', () => {
  const { model, loop } = parsedLoop(PAGE);
  const empty = loopQuery.emptyQuery(promises);
  const query = {
    ...empty,
    conditions: [{ kind: 'custom', code: 'item !== "Easy to customize"' }],
    customSort: '(a, b) => b.localeCompare(a)',
    limit: 2,
  };
  const target = { kind: 'query', query, fields: [] };
  assert.equal(targetKey(target), 'value:promises', 'the key the plain constant has');
  const plan = planned(model, loop, target);
  const head = 'promises.filter((item) => item !== "Easy to customize").toSorted((a, b) => b.localeCompare(a)).slice(0, 2).map((promise) => (';
  assert.equal(plan.loop.head, head);
  assert.equal(plan.extraFrontmatter, model.extraFrontmatter, 'the constant is not rewritten');
  assert.deepEqual(plan.imports, model.imports);
  assert.equal(plan.loop.children, loop.children, 'the loop’s children stay as they are');
  assert.equal(plan.previous, 'value:promises');
  const saved = PAGE.replace(loop.head, head);
  const again = parsedLoop(saved);
  assert.equal(again.loop.head, head, 'the parser hands the head back whole');
  assert.equal(serializePage(again.model), saved);
  const data = head.slice(0, -'.map((promise) => ('.length);
  // Hand-written code over the item itself reads as the settings that say it.
  const { customSort: _custom, ...rest } = query;
  assert.deepEqual(readLoop({ frontmatter: again.model.extraFrontmatter, imports: again.model.imports, data }).query, {
    ...rest,
    conditions: [{ kind: 'test', field: ITEM, operator: 'isNot', value: { kind: 'text', text: 'Easy to customize' } }],
    sorts: [{ field: ITEM, direction: 'descending', order: 'text' }],
  });
  const cleared = planned(again.model, again.loop, { kind: 'query', query: empty, fields: [] });
  assert.equal(cleared.loop.head, 'promises.map((promise) => (', 'clearing every setting leaves the plain loop');
});

test('a string list’s filter, sort and limit compare the item itself and read back', () => {
  const { model, loop } = parsedLoop(PAGE);
  const empty = loopQuery.emptyQuery(promises);
  const query = {
    ...empty,
    conditions: [{ kind: 'test', field: ITEM, operator: 'contains', value: 'astro' }],
    sorts: [{ field: ITEM, direction: 'ascending', order: 'text' }],
    limit: 2,
  };
  const plan = planned(model, loop, { kind: 'query', query, fields: [] });
  const data =
    "promises.filter((promise) => String(promise ?? '').toLowerCase().includes('astro')).toSorted((a, b) => String(a ?? '').localeCompare(String(b ?? ''))).slice(0, 2)";
  assert.equal(plan.loop.head, `${data}.map((promise) => (`, 'the filter names each item as the loop does');
  const saved = PAGE.replace(loop.head, plan.loop.head);
  const again = parsedLoop(saved);
  assert.equal(again.loop.head, plan.loop.head, 'the parser hands the head back whole');
  assert.equal(serializePage(again.model), saved);
  const kinds = (_source, field) => (field === ITEM ? 'text' : undefined);
  const reading = readLoop({ frontmatter: again.model.extraFrontmatter, imports: [], data, fieldKind: kinds });
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.query, { ...query, parameter: { kind: 'entry', name: 'promise' } });
  const equal = { ...empty, conditions: [{ kind: 'test', field: ITEM, operator: 'is', value: { kind: 'text', text: 'Easy to customize' } }] };
  const descending = { ...empty, sorts: [{ field: ITEM, direction: 'descending', order: 'text' }], offset: 1 };
  for (const [settings, code] of [
    [equal, "promises.filter((promise) => promise === 'Easy to customize')"],
    [descending, "promises.toSorted((a, b) => String(b ?? '').localeCompare(String(a ?? ''))).slice(1)"],
  ]) {
    assert.equal(planned(model, loop, { kind: 'query', query: settings, fields: [] }).loop.head, `${code}.map((promise) => (`);
    const read = readLoop({ frontmatter: model.extraFrontmatter, imports: [], data: code, fieldKind: kinds }).query;
    assert.deepEqual(read.conditions, settings.conditions, code);
    assert.deepEqual(read.sorts, settings.sorts, code);
  }
});

test('a number list compares and sorts each number', () => {
  const frontmatter = 'const sizes = [3, 12, 7];\n';
  const sizes = { kind: 'list', collection: 'sizes' };
  const empty = { ...loopQuery.emptyQuery(sizes), parameter: { kind: 'entry', name: 'size' } };
  const kinds = (_source, field) => (field === ITEM ? 'number' : undefined);
  const cases = [
    [{ ...empty, conditions: [{ kind: 'test', field: ITEM, operator: 'greater', value: 5 }] }, 'sizes.filter((size) => size > 5)'],
    [{ ...empty, conditions: [{ kind: 'test', field: ITEM, operator: 'atMost', value: 7 }] }, 'sizes.filter((size) => size <= 7)'],
    [{ ...empty, conditions: [{ kind: 'test', field: ITEM, operator: 'is', value: { kind: 'number', number: 12 } }] }, 'sizes.filter((size) => size === 12)'],
    [
      { ...loopQuery.emptyQuery(sizes), sorts: [{ field: ITEM, direction: 'descending', order: 'number' }], limit: 2 },
      'sizes.toSorted((a, b) => (b ?? 0) - (a ?? 0)).slice(0, 2)',
    ],
  ];
  for (const [query, code] of cases) {
    assert.equal(loopQuery.listQueryCode(query), code);
    const reading = readLoop({ frontmatter, imports: [], data: code, fieldKind: kinds });
    assert.equal(reading.kind, 'query', code);
    assert.deepEqual(reading.query, query, code);
  }
});

test('the item itself is a list’s field only', () => {
  const astro = loopQuery.emptyQuery({ kind: 'astro', collection: 'posts' });
  assert.throws(
    () => loopQuery.assertLoopQuery({ ...astro, conditions: [{ kind: 'test', field: ITEM, operator: 'isSet' }] }),
    /Only a list’s filter compares the item itself/,
  );
  assert.throws(
    () => loopQuery.assertLoopQuery({ ...astro, sorts: [{ field: ITEM, direction: 'ascending', order: 'text' }] }),
    /Only a list sorts by the item itself/,
  );
  const imports = [{ name: 'getCollection', path: 'astro:content' }];
  const reading = readLoop({ frontmatter: "const posts = await getCollection('posts');\n", imports, data: "posts.filter(({ data }) => data === 'x')" });
  assert.deepEqual(reading.query.conditions, [{ kind: 'custom', code: "data === 'x'" }], 'a collection’s data is never compared whole');
});

test('a limit typed as a section is written into the head', () => {
  const { model, loop } = parsedLoop(PAGE);
  const plan = planned(model, loop, { kind: 'section', section: 'limit', code: '1' });
  assert.equal(plan.loop.head, 'promises.slice(0, 1).map((promise) => (');
  assert.equal(plan.extraFrontmatter, model.extraFrontmatter);
});

// ---------------------------------------------------------------------------
// The panel. The DOM goes in after the parser's tests: the Astro compiler takes
// a global `document` as a browser.
// ---------------------------------------------------------------------------

let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (modules !== undefined) {
    return;
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

async function panel(context, input) {
  installDom();
  const applied = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const onApply = (target) => {
    applied.push(target);
    return { ok: true, unbound: 0, lost: [], restored: false };
  };
  await act(async () => {
    root.render(
      React.createElement(modules.LoopSettings, {
        input: { imports: [], ...input },
        projectPath: undefined,
        filePath: 'src/pages/index.astro',
        lists: [],
        onApply,
      }),
    );
  });
  return { host, applied };
}

const labels = (host) => [...host.querySelectorAll('.prop-label')].map((label) => label.textContent);
const header = (host, title) => [...host.querySelectorAll('.loop-settings-header')].find((element) => element.textContent.includes(title));
const click = async (element) => {
  assert.ok(element, 'the control is there');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
};

test('the page’s loop shows Filters, Sort and Limit, and writes nothing on open', async (context) => {
  const { model } = parsedLoop(PAGE);
  const { host, applied } = await panel(context, { frontmatter: model.extraFrontmatter, data: 'promises' });
  const shown = labels(host);
  for (const label of ['Source', 'Filters', 'Sort', 'Limit items']) {
    assert.ok(shown.includes(label), `${label} in ${shown.join(', ')}`);
  }
  assert.ok(!shown.includes('Items'), 'a written-out list’s items have no ids to pick by');
  assert.ok(host.querySelector('.loop-settings-list') === null, 'no filter or sort rows yet');
  assert.ok(header(host, 'Filters').querySelector('.loop-settings-add'), 'a filter can be added, as code');
  assert.ok(header(host, 'Sort').querySelector('.loop-settings-add'), 'a sort can be added, as code');
  assert.deepEqual(applied, []);
});

test('the Limit switch hands back a query the planner writes into the page’s head', async (context) => {
  const { model, loop } = parsedLoop(PAGE);
  const { host, applied } = await panel(context, { frontmatter: model.extraFrontmatter, data: 'promises' });
  await click(host.querySelector('[role="switch"]'));
  assert.equal(applied.length, 1);
  assert.equal(loopQuery.listQueryCode(applied[0].query), 'promises.slice(0, 6)');
  assert.equal(planned(model, loop, applied[0]).loop.head, 'promises.slice(0, 6).map((promise) => (');
});

test('a list of objects sorts by the first field its values are written with', async (context) => {
  const { host, applied } = await panel(context, { frontmatter: PLANS, data: 'plans' });
  await click(header(host, 'Sort').querySelector('.loop-settings-add'));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].query.sorts, [{ field: 'title', direction: 'ascending', order: 'text' }]);
  assert.equal(loopQuery.listQueryCode(applied[0].query), "plans.toSorted((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))");
  await click(header(host, 'Filters').querySelector('.loop-settings-add'));
  assert.match(host.textContent, /Title/, 'a new filter starts on the first field');
});

test('a string list sorts and filters by the item, labelled Item', async (context) => {
  const { model, loop } = parsedLoop(PAGE);
  const { host, applied } = await panel(context, { frontmatter: model.extraFrontmatter, data: 'promises' });
  await click(header(host, 'Sort').querySelector('.loop-settings-add'));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].query.sorts, [{ field: ITEM, direction: 'ascending', order: 'text' }]);
  assert.equal(planned(model, loop, applied[0]).loop.head, "promises.toSorted((a, b) => String(a ?? '').localeCompare(String(b ?? ''))).map((promise) => (");
  await click(header(host, 'Filters').querySelector('.loop-settings-add'));
  assert.match(host.textContent, /Item/, 'a new filter starts on the item itself');
  assert.doesNotMatch(host.textContent, /\$item/, 'the field’s name is never shown');
});
