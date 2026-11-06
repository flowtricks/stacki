// Goal: a loop over a component's List prop has the list settings a collection
// loop has (Filters, Sort, Limit), with fields from the prop's item type, and
// the Source menu heads such a component's own lists with its name, above the
// collections. A loop nobody has touched stays exactly as it was written.
//
// Method: the reader and writer run as pure code, each setting written and read
// back as the same query, for the valid forms of the type and for what must stay
// out (a prop that is no list, a path into one, steps no setting can say). Heads
// the writer makes go through main's real page parser, so `>` and arrows inside
// a head are known to survive a file. Then the real LoopSettings, bundled as the
// app bundles it, renders in jsdom with no project: the sections, their fields
// and what each control hands to onApply. Last, the real DataPicker draws the
// Source tree for a component and a page, and the file names are read back.

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

const { readLoop } = load('src/editor/loopQueryRead.ts');
const loopQuery = load('src/editor/loopQuery.ts');
const { planLoop, targetKey } = load('src/editor/loopQueryPlan.ts');
const { listPropOf } = load('src/editor/propDeclaration.ts');
const { listItemFields } = load('src/features/props/loopCatalog.ts');
const { readingKey } = load('src/features/props/loopSettingsModel.ts');
const { componentNameOf, isComponentSection, sectionHeading } = load('src/features/props/dataPickerModel.ts');

const directory = repoPath('node_modules/.stacki-test/loop-list-prop');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-list-prop.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as LoopSettings } from './src/features/props/LoopSettings';",
      "export { default as DataPicker } from './src/features/props/DataPicker';",
      "export { sourceTree, sourcePath } from './src/features/props/LoopSourcePicker';",
    ].join('\n'),
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

const FRONTMATTER = `interface Props {
  features?: readonly { title: string; number: number; on: boolean; image: string; link: string }[];
}
const { features = [] } = Astro.props;
`;
const read = (data, frontmatter = FRONTMATTER, fieldKind) => readLoop({ frontmatter, imports: [], data, fieldKind });
const source = { kind: 'list', collection: 'features' };
const empty = loopQuery.emptyQuery(source);

function loopNode(head) {
  return { id: 'loop', kind: 'map', head, children: [{ id: 'row', kind: 'element', tag: 'div', props: {}, children: [] }] };
}

function planned(head, query, frontmatter = FRONTMATTER) {
  const loop = loopNode(head);
  const target = { kind: 'query', query, fields: [] };
  const model = { extraFrontmatter: frontmatter, imports: [], nodes: [loop] };
  const result = planLoop({ model, loop, target, sanityClient: 'unavailable' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.plan;
}

test('a list prop reads as a query with nothing narrowed', () => {
  const reading = read('features');
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.query, empty);
  assert.equal(readingKey(reading, 'features'), 'value:features', 'the Source menu still knows it as the prop');
});

test('every form of the type the list reader accepts gives the item fields', () => {
  const inline = '{ title: string; count: number }';
  const named = 'interface Value {\n  title: string;\n  count: number;\n}\n';
  const alias = 'type Value = { title: string; count: number };\n';
  const forms = [
    ['', `readonly ${inline}[]`],
    ['', `${inline}[]`],
    ['', `Array<${inline}>`],
    ['', `ReadonlyArray<${inline}>`],
    [named, 'readonly Value[]'],
    [named, 'Value[]'],
    [named, 'Array<Value>'],
    [alias, 'readonly Value[]'],
  ];
  for (const [declared, type] of forms) {
    const frontmatter = `${declared}interface Props {\n  features?: ${type};\n}\nconst { features = [] } = Astro.props;\n`;
    const prop = listPropOf(frontmatter, 'features');
    assert.deepEqual(
      prop?.fields,
      [
        { name: 'title', kind: 'text' },
        { name: 'count', kind: 'number' },
      ],
      type,
    );
    assert.equal(read('features', frontmatter).kind, 'query', type);
  }
});

test('item fields take the menus’ kinds, and an image is not measured', () => {
  const fields = listItemFields(listPropOf(FRONTMATTER, 'features').fields);
  assert.deepEqual(
    fields.map((field) => [field.path, field.title, field.kind]),
    [
      ['title', 'Title', 'text'],
      ['number', 'Number', 'number'],
      ['on', 'On', 'boolean'],
      ['image', 'Image', 'image'],
      ['link', 'Link', 'text'],
    ],
  );
  assert.deepEqual(loopQuery.sortOrdersFor('image', 'list'), [], 'a list’s image is text, with no file to measure');
  assert.deepEqual(loopQuery.sortOrdersFor('image', 'astro'), ['fileSize'], 'an Astro image keeps its size');
});

test('a local read by another name, and a prop with no type, are lists too', () => {
  const aliased = 'interface Props {\n  features?: { title: string }[];\n}\nconst { features: list = [] } = Astro.props;\n';
  assert.deepEqual(listPropOf(aliased, 'list'), { key: 'features', fields: [{ name: 'title', kind: 'text' }] });
  assert.equal(read('list', aliased).query.source.collection, 'list');
  const untyped = 'const { features = [] } = Astro.props;\n';
  assert.deepEqual(listPropOf(untyped, 'features'), { key: 'features', fields: undefined });
  assert.equal(read('features', untyped).kind, 'query', 'with no fields known, Limit and custom code still apply');
  const words = 'interface Props {\n  features?: string[];\n}\nconst { features = [] } = Astro.props;\n';
  assert.equal(listPropOf(words, 'features').fields, undefined, 'a list of words has no item fields');
});

test('what is not a list prop reads as it always did', () => {
  const text = 'interface Props {\n  features?: string;\n}\nconst { features = "" } = Astro.props;\n';
  assert.equal(read('features', text).kind, 'value', 'a prop that holds words');
  assert.equal(read('features', 'const { features = "" } = Astro.props;\n').kind, 'value', 'an untyped prop with a default of words');
  assert.equal(read('features', 'const { features } = Astro.props;\n').kind, 'value', 'an untyped prop with nothing to say it is a list');
  assert.equal(read('other').kind, 'value', 'a name no prop gives');
  assert.equal(read('features.items').kind, 'value', 'a path into the prop is not the prop');
  const held = `${FRONTMATTER}const visible = features.filter((item) => item.on);\n`;
  assert.equal(read('visible', held).kind, 'value', 'a list held in a constant stays a value');
});

test('each control writes its expression and reads back as the same query', () => {
  const title = { kind: 'test', field: 'title', operator: 'is', value: { kind: 'text', text: 'Pro' } };
  const big = { kind: 'test', field: 'number', operator: 'greater', value: 3 };
  const sort = { field: 'number', direction: 'descending', order: 'number' };
  const cases = [
    [{ ...empty }, 'features'],
    [{ ...empty, conditions: [title] }, "features.filter((item) => item.title === 'Pro')"],
    [{ ...empty, conditions: [title, big], match: 'any' }, "features.filter((item) => item.title === 'Pro' || item.number > 3)"],
    [{ ...empty, sorts: [sort] }, 'features.toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0))'],
    [{ ...empty, limit: 3 }, 'features.slice(0, 3)'],
    [{ ...empty, offset: 2 }, 'features.slice(2)'],
    [{ ...empty, offset: 2, limit: 3 }, 'features.slice(2, 5)'],
    [{ ...empty, random: true }, 'features.toSorted(() => Math.random() - 0.5)'],
    [{ ...empty, customSort: '(a, b) => a.number % 2 - b.number % 2' }, 'features.toSorted((a, b) => a.number % 2 - b.number % 2)'],
    [{ ...empty, conditions: [{ kind: 'custom', code: 'item.title.startsWith("P")' }] }, 'features.filter((item) => item.title.startsWith("P"))'],
    [
      { ...empty, conditions: [big], sorts: [sort], limit: 2 },
      'features.filter((item) => item.number > 3).toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0)).slice(0, 2)',
    ],
  ];
  const kinds = (_source, field) => ({ title: 'text', number: 'number' })[field];
  for (const [query, code] of cases) {
    assert.equal(loopQuery.listQueryCode(query), code);
    const reading = read(code, FRONTMATTER, kinds);
    assert.equal(reading.kind, 'query', code);
    assert.deepEqual(reading.query, query, code);
  }
});

test('a switch field and a text sort read back once the fields are known', () => {
  const on = { ...empty, conditions: [{ kind: 'test', field: 'on', operator: 'isTrue' }] };
  assert.deepEqual(read(loopQuery.listQueryCode(on)).query, on);
  const sorted = { ...empty, sorts: [{ field: 'title', direction: 'ascending', order: 'text' }] };
  assert.deepEqual(read(loopQuery.listQueryCode(sorted)).query, sorted);
});

test('a filter keeps the name its code gave the item', () => {
  const reading = read("features.filter((feature) => feature.title === 'Pro')");
  assert.deepEqual(reading.query.parameter, { kind: 'entry', name: 'feature' });
  assert.equal(loopQuery.listQueryCode({ ...reading.query, limit: 2 }), "features.filter((feature) => feature.title === 'Pro').slice(0, 2)");
});

test('steps no setting can say are kept, and offered for replacing', () => {
  const steps = ['features.filter(isLive)', 'features.slice(0, 2).filter((item) => item.on)', 'features.toReversed()', 'features.filter(({ on }) => on)'];
  for (const data of steps) {
    const reading = read(data);
    assert.equal(reading.kind, 'partial', data);
    assert.deepEqual(reading.source, source, data);
  }
  assert.equal(planned('features.filter(isLive).map((item) => (', empty).loop.head, 'features.map((item) => (', 'replacing leaves the plain prop');
});

test('an invalid list query is a programmer error', () => {
  assert.throws(() => loopQuery.assertLoopQuery({ ...empty, parameter: { kind: 'data' } }), /A list prop’s filter names its item/);
  assert.throws(() => loopQuery.assertLoopQuery({ ...empty, selection: [] }), /A list prop’s items have no ids to pick by/);
  assert.throws(() => loopQuery.listQueryCode(loopQuery.emptyQuery({ kind: 'astro', collection: 'posts' })), /A list query reads a List prop/);
});

test('a setting changes the loop’s head and nothing else', () => {
  const plan = planned('features.map((item, index) => (', { ...empty, limit: 3 });
  assert.equal(plan.loop.head, 'features.slice(0, 3).map((item, index) => (');
  assert.equal(plan.extraFrontmatter, FRONTMATTER);
  assert.deepEqual(plan.imports, []);
  assert.equal(plan.unbound, 0);
  assert.equal(plan.previous, 'value:features');
  assert.equal(targetKey({ kind: 'query', query: empty, fields: [] }), 'value:features', 'the same key the plain prop has');
  const cleared = planned('features.slice(0, 3).map((item) => (', empty);
  assert.equal(cleared.loop.head, 'features.map((item) => (', 'clearing every setting leaves the plain loop');
});

// The reported component, as the app reads it: what the panel gets is the
// parser's frontmatter and head, not text this test wrote for itself.
const PRICING_CARD = `---
interface Props {
  features?: readonly { title: string; number: number }[];
}
const { features = [] } = Astro.props;
---
<div role="list" class="pricing_card_list">
  {
    features.map((item) => (
      <div role="listitem" class="pricing_card_item">{item.title}</div>
    ))
  }
</div>
`;

function parsedLoop(text) {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true, result.reason);
  const loop = result.model.nodes[0]?.children?.[0];
  assert.equal(loop?.kind, 'map');
  return { model: result.model, loop };
}

test('a written head survives the page parser and a save', () => {
  const { model, loop } = parsedLoop(PRICING_CARD);
  assert.equal(serializePage(model), PRICING_CARD, 'an untouched file writes back byte for byte');
  const fields = listPropOf(model.extraFrontmatter, 'features').fields;
  assert.deepEqual(fields, [
    { name: 'title', kind: 'text' },
    { name: 'number', kind: 'number' },
  ]);
  const reading = readLoop({ frontmatter: model.extraFrontmatter, imports: model.imports, data: 'features' });
  assert.deepEqual(reading.query, empty);
  const query = {
    ...empty,
    conditions: [
      { kind: 'test', field: 'number', operator: 'greater', value: 3 },
      { kind: 'test', field: 'title', operator: 'isNot', value: { kind: 'text', text: '<b>' } },
    ],
    sorts: [{ field: 'number', direction: 'descending', order: 'number' }],
    limit: 2,
  };
  const head = planned(loop.head, query, model.extraFrontmatter).loop.head;
  assert.equal(
    head,
    "features.filter((item) => item.number > 3 && item.title !== '<b>').toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0)).slice(0, 2).map((item) => (",
  );
  const saved = PRICING_CARD.replace(loop.head, head);
  const again = parsedLoop(saved);
  assert.equal(again.loop.head, head, 'the parser hands the head back whole');
  assert.equal(serializePage(again.model), saved);
  const data = head.slice(0, -'.map((item) => ('.length);
  const kinds = (_source, field) => ({ title: 'text', number: 'number' })[field];
  assert.deepEqual(read(data, again.model.extraFrontmatter, kinds).query, query);
});

test('collection loops read and write as they did', () => {
  const imports = [{ name: 'getCollection', path: 'astro:content' }];
  const frontmatter = "const posts = (await getCollection('posts')).sort((a, b) => a.data.order - b.data.order).slice(0, 3);\n";
  const reading = readLoop({ frontmatter, imports, data: 'posts' });
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.query.parameter, { kind: 'data' });
  assert.equal(reading.query.limit, 3);
  const code = loopQuery.astroQueryCode({ ...reading.query, sorts: [{ field: 'order', direction: 'ascending', order: 'number' }] });
  assert.match(code, /\.sort\(/, 'a fetched list is the query’s own to sort');
  assert.doesNotMatch(code, /toSorted/);
  assert.equal(targetKey({ kind: 'query', query: reading.query, fields: [] }), 'astro:posts');
  assert.deepEqual(loopQuery.sortOrdersFor('text', 'sanity'), ['text']);
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
        filePath: 'src/components/PricingCard.astro',
        lists: [],
        onApply,
      }),
    );
  });
  return { host, applied };
}

const labels = (host) => [...host.querySelectorAll('.prop-label')].map((label) => label.textContent);
const click = async (element) => {
  assert.ok(element, 'the control is there');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
};

test('a plain loop over a list prop shows Filters, Sort and Limit, and writes nothing on open', async (context) => {
  const { host, applied } = await panel(context, { frontmatter: FRONTMATTER, data: 'features' });
  const shown = labels(host);
  for (const label of ['Source', 'Filters', 'Sort', 'Limit items']) {
    assert.ok(shown.includes(label), `${label} in ${shown.join(', ')}`);
  }
  assert.ok(!shown.includes('Items'), 'a list prop’s items have no ids to pick by');
  assert.ok(host.querySelector('.loop-settings-list') === null, 'no filter or sort rows');
  assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false', 'no limit');
  assert.deepEqual(applied, []);
});

test('Limit and Sort hand back a query the writer turns into code', async (context) => {
  const { host, applied } = await panel(context, { frontmatter: FRONTMATTER, data: 'features' });
  await click(host.querySelector('[role="switch"]'));
  assert.equal(applied.length, 1);
  assert.equal(loopQuery.listQueryCode(applied[0].query), 'features.slice(0, 6)');
  const sort = [...host.querySelectorAll('.loop-settings-header')].find((header) => header.textContent.includes('Sort'));
  await click(sort.querySelector('button'));
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[1].query.sorts, [{ field: 'title', direction: 'ascending', order: 'text' }], 'the first field of the item type');
  assert.equal(loopQuery.listQueryCode(applied[1].query), "features.toSorted((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))");
});

test('a new filter starts on the item type’s first field', async (context) => {
  const { host } = await panel(context, { frontmatter: FRONTMATTER, data: 'features' });
  const filters = [...host.querySelectorAll('.loop-settings-header')].find((header) => header.textContent.includes('Filters'));
  await click(filters.querySelector('button'));
  assert.match(host.textContent, /Title/);
});

test('written settings show again as rows', async (context) => {
  const { host } = await panel(context, { frontmatter: FRONTMATTER, data: 'features.filter((item) => item.number > 3).slice(0, 2)' });
  assert.match(host.querySelector('.loop-settings-list').textContent, /Number/);
  assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
});

test('a collection loop keeps its Items switch', async (context) => {
  const frontmatter = "const posts = await getCollection('posts');\n";
  const { host, applied } = await panel(context, { frontmatter, data: 'posts', imports: [{ name: 'getCollection', path: 'astro:content' }] });
  const shown = labels(host);
  for (const label of ['Source', 'Items', 'Filters', 'Sort', 'Limit items']) {
    assert.ok(shown.includes(label), `${label} in ${shown.join(', ')}`);
  }
  assert.deepEqual(applied, []);
});

// ---------------------------------------------------------------------------
// The Source menu.
// ---------------------------------------------------------------------------

const catalog = { collections: [{ source: { kind: 'astro', collection: 'stats' }, title: 'Stats', count: 4 }], sanity: { kind: 'none' } };
const tree = [{ path: 'features', key: 'features', kind: 'list', preview: '[]', children: undefined, section: 'props' }];
const data = (file) => ({ tree, samples: {}, frontmatter: FRONTMATTER, file });

function headings(file) {
  installDom();
  const { renderToStaticMarkup } = require('react-dom/server');
  const markup = renderToStaticMarkup(
    React.createElement(modules.DataPicker, {
      tree: modules.sourceTree(catalog, data(file), {}),
      origin: { file, page: undefined },
      footer: false,
      onPick() {},
    }),
  );
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return [...holder.querySelectorAll('.dp-section')];
}

test('in a component, its lists come first, named for it with its icon', () => {
  const sections = headings('src/components/PricingCard.astro');
  assert.deepEqual(
    sections.map((section) => section.textContent),
    ['PricingCard', 'Content Collections'],
  );
  const [component, collections] = sections;
  assert.ok(component.classList.contains('component'), 'drawn in the component green');
  assert.ok(component.querySelector('svg.dp-section-icon'), 'with the component mark');
  assert.ok(!collections.classList.contains('component'));
  assert.equal(modules.sourceTree(catalog, data('src/components/PricingCard.astro'), {})[0].path, 'features');
});

test('on a page, the group keeps its words and its place', () => {
  const sections = headings('src/pages/index.astro');
  assert.deepEqual(
    sections.map((section) => section.textContent),
    ['Content Collections', 'On this page'],
  );
  assert.ok(!sections[1].classList.contains('component'));
  assert.ok(sections[1].querySelector('svg') === null, 'no component mark on a page');
  assert.equal(modules.sourceTree(catalog, data('src/pages/index.astro'), {})[0].path, 'astro:stats');
  assert.equal(modules.sourceTree(catalog, data(undefined), {})[0].path, 'astro:stats', 'with no file known, as a page');
});

test('the binding pickers head a component’s props the same way', () => {
  const component = { file: 'src/components/PricingCard.astro', page: 'src/pages/index.astro' };
  const page = { file: 'src/pages/index.astro', page: undefined };
  assert.equal(sectionHeading('props', component), 'PricingCard');
  assert.equal(isComponentSection('props', component), true);
  assert.equal(sectionHeading('props', page), 'index.astro props', 'a page says which file');
  assert.equal(isComponentSection('props', page), false);
  assert.equal(isComponentSection('collections', component), false);
  assert.equal(sectionHeading('frontmatter', component), 'PricingCard.astro frontmatter');
  assert.equal(componentNameOf('C:\\site\\src\\pages\\index.astro'), undefined);
  assert.equal(componentNameOf(undefined), undefined);
  assert.equal(componentNameOf('/site/src/layouts/Base.astro'), 'Base');
});

test('the current prop is marked at its own row, however refined', () => {
  installDom();
  assert.equal(modules.sourcePath(source), 'features');
  assert.equal(modules.sourcePath({ kind: 'astro', collection: 'stats' }), 'astro:stats');
});
