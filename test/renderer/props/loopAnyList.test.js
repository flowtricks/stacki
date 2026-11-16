// Goal: Filters, Sort and Limit show on EVERY loop, whatever its list is: a
// content collection, a page's props array, a member path (`platformIntro.cards`),
// an imported list, a constant, a call, `Object.entries(...)`, an inline array,
// and a list that already has code in its chain. Code the settings cannot say is
// kept byte for byte; nothing the person wrote is rewritten by showing controls.
//
// Method: the reader, the writer and the plan run as pure code over each kind of
// list, with the negative space (unparseable code, chains the controls cannot
// split, optional calls, reshaping steps) read and written back unchanged. Then the
// real LoopSettings, bundled as the app bundles it, renders in jsdom for each kind
// of loop and must show all three sections; a field typed by name for an untyped
// list writes a filter and a sort through the real plan, and the rest of the head
// stays as it was.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');

const { readLoop } = load('src/editor/loopQueryRead.ts');
const { readSections } = load('src/editor/loopSections.ts');
const { planLoop } = load('src/editor/loopQueryPlan.ts');
const loopQuery = load('src/editor/loopQuery.ts');
const typedModel = load('src/features/props/loopTypedField.ts');
const { literalListFields } = load('src/editor/loopLiteral.ts');
const { treeListFields } = load('src/features/props/loopProjectData.ts');

const directory = repoPath('node_modules/.stacki-test/loop-any-list');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-any-list.cjs');
buildSync({
  stdin: { contents: "export { default as LoopSettings } from './src/features/props/LoopSettings';", resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const FRONTMATTER = `import plans from '../data/plans.json';
import { getCollection } from 'astro:content';
const { platformIntro, items } = Astro.props;
const cards = platformIntro.cards;
const posts = await getCollection('blog');
`;
const IMPORTS = [
  { name: 'plans', path: '../data/plans.json' },
  { name: 'getCollection', path: 'astro:content' },
];
const read = (data, extra = {}) => readLoop({ frontmatter: FRONTMATTER, imports: IMPORTS, data, ...extra });

// Every kind of loop source, by the head's data expression.
const KINDS = {
  'content collection': "(await getCollection('blog'))",
  'collection held in a constant': 'posts',
  'array variable': 'cards',
  'member expression': 'platformIntro.cards',
  'props array': 'items',
  'imported JSON': 'plans',
  'inline array': '["a", "b", "c"]',
  'object entries': 'Object.entries(platformIntro)',
  'object values': 'Object.values(platformIntro.cards)',
  'function call': 'getCards()',
  'awaited call': 'await getCards()',
  'optional chain': 'platformIntro?.cards',
  fallback: '(platformIntro.cards ?? [])',
  'chained filter, sort and slice': 'platformIntro.cards.filter((card) => card.on).sort((a, b) => a.order - b.order).slice(0, 3)',
};

test('every kind of loop source reads as something the controls can edit', () => {
  for (const [name, data] of Object.entries(KINDS)) {
    const reading = read(data);
    assert.ok(reading.kind === 'query' || reading.kind === 'partial', `${name}: ${reading.kind}`);
    const sections = readSections({ frontmatter: FRONTMATTER, imports: IMPORTS, data });
    assert.ok(sections !== undefined, `${name}: its sections are read`);
  }
});

test('an existing chain is read into the controls, and written back byte for byte when nothing changes', () => {
  const data = KINDS['chained filter, sort and slice'];
  const reading = read(data);
  assert.equal(reading.kind, 'query');
  assert.deepEqual(reading.query.source, { kind: 'list', collection: 'platformIntro.cards' });
  assert.equal(reading.query.conditions.length, 1);
  assert.equal(reading.query.sorts.length, 1);
  assert.equal(reading.query.limit, 3);
  const sections = readSections({ frontmatter: FRONTMATTER, imports: IMPORTS, data });
  assert.equal(sections.filter.code, '(card) => card.on');
  assert.equal(sections.sort.code, '(a, b) => a.order - b.order');
  assert.equal(sections.limit.code, '3');
  // Editing only the limit leaves the filter and the sort bytes alone.
  const loop = { id: 'loop', kind: 'map', head: `${data}.map((card) => (`, children: [] };
  const model = { extraFrontmatter: FRONTMATTER, imports: IMPORTS, nodes: [loop] };
  const result = planLoop({ model, loop, target: { kind: 'section', section: 'limit', code: '5' }, sanityClient: 'unavailable' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.loop.head, data.replace('slice(0, 3)', 'slice(0, 5)') + '.map((card) => (');
  assert.equal(result.plan.extraFrontmatter, FRONTMATTER, 'the frontmatter is untouched');
});

test('every setting writes onto any list and reads back as the same query', () => {
  for (const [name, data] of Object.entries(KINDS)) {
    if (name === 'content collection' || name === 'collection held in a constant' || name === 'chained filter, sort and slice') {
      continue;
    }
    const source = read(data).query.source;
    assert.equal(source.kind, 'list', name);
    const query = {
      ...loopQuery.emptyQuery(source),
      conditions: [{ kind: 'test', field: 'title', operator: 'is', value: { kind: 'text', text: 'Pro' } }],
      sorts: [{ field: 'order', direction: 'descending', order: 'number' }],
      offset: 1,
      limit: 2,
    };
    const code = loopQuery.listQueryCode(query);
    const back = read(code, { fieldKind: (_source, field) => ({ title: 'text', order: 'number' })[field] });
    assert.equal(back.kind, 'query', `${name}: ${code}`);
    assert.equal(back.query.source.collection, source.collection, name);
    assert.equal(back.query.conditions.length, 1, name);
    assert.equal(back.query.sorts.length, 1, name);
    assert.equal(back.query.offset, 1, name);
    assert.equal(back.query.limit, 2, name);
  }
});

test('a list that is not a bare name is wrapped so the steps bind to the whole of it', () => {
  const source = read('platformIntro.cards ?? []').query.source;
  assert.equal(loopQuery.listQueryCode({ ...loopQuery.emptyQuery(source), limit: 2 }), '(platformIntro.cards ?? []).slice(0, 2)');
  const awaited = read('await getCards()').query.source;
  assert.equal(loopQuery.listQueryCode({ ...loopQuery.emptyQuery(awaited), limit: 2 }), '(await getCards()).slice(0, 2)');
  assert.equal(loopQuery.chainableListCode('Object.entries(a)'), 'Object.entries(a)');
  assert.equal(loopQuery.chainableListCode('a ? b : c'), '(a ? b : c)');
});

test('code the controls cannot say stays in the list, not in a setting, and is never rewritten', () => {
  // A reshaping step is part of the list, so a filter added to it goes after it.
  const flat = read('platformIntro.cards.flatMap((card) => card.items)');
  assert.equal(flat.query.source.collection, 'platformIntro.cards.flatMap((card) => card.items)');
  // An optional call is not rewritten into one that can throw.
  const optional = read('platformIntro?.cards?.filter((card) => card.on)');
  assert.equal(optional.query.source.collection, 'platformIntro?.cards?.filter((card) => card.on)');
  assert.equal(optional.query.conditions.length, 0);
  // Steps in the wrong order read as a partial list; kept, the whole expression is the list.
  const messy = 'cards.filter((card) => card.a).slice(1).filter((card) => card.b)';
  assert.equal(read(messy).kind, 'partial');
  assert.equal(readSections({ frontmatter: FRONTMATTER, imports: IMPORTS, data: messy }), undefined);
  const kept = read(messy, { unreadSteps: 'kept' });
  assert.equal(kept.kind, 'query');
  assert.equal(kept.query.source.collection, messy);
  const keptSections = readSections({ frontmatter: FRONTMATTER, imports: IMPORTS, data: messy, unreadSteps: 'kept' });
  assert.equal(keptSections.filter.code, '');
  // A filter written onto the kept list goes after the code that was there.
  const written = loopQuery.listQueryCode({
    ...kept.query,
    conditions: [{ kind: 'test', field: 'title', operator: 'isSet' }],
  });
  assert.ok(written.startsWith(`${messy}.filter(`), written);
});

test('what does not parse is still code, and never becomes a list', () => {
  assert.equal(read('cards.filter((').kind, 'code');
  assert.equal(read('').kind, 'empty');
  assert.equal(read('[]').kind, 'empty');
  assert.equal(readSections({ frontmatter: FRONTMATTER, imports: IMPORTS, data: 'cards.filter((' }), undefined);
});

test('a list source is checked: empty, too long and unparseable expressions are refused', () => {
  assert.equal(loopQuery.listExpressionProblem(''), 'empty');
  assert.equal(loopQuery.listExpressionProblem('a'.repeat(loopQuery.LOOP_QUERY_LIMITS.customCodeCharsMax + 1)), 'tooLong');
  assert.equal(loopQuery.listExpressionProblem('a.('), 'unparseable');
  assert.equal(loopQuery.listExpressionProblem('a.b'), undefined);
  assert.throws(() => loopQuery.emptyQuery({ kind: 'list', collection: 'a.(' }), /A list source is an expression that parses/);
  assert.throws(() => loopQuery.emptyQuery({ kind: 'astro', collection: 'a b' }), /names a collection/);
});

test('a list called through another file keeps its traced settings unless asked to read the head', () => {
  const frontmatter = 'const cards = await getCards();\n';
  const imports = [{ name: 'getCards', path: '@/sanity/queries' }];
  assert.equal(readLoop({ frontmatter, imports, data: 'cards' }).kind, 'value');
  const listed = readLoop({ frontmatter, imports, data: 'cards.filter((card) => card.on)', calls: 'list' });
  assert.equal(listed.kind, 'query');
  assert.equal(listed.query.conditions.length, 1);
});

test('fields come from what the list holds: a typed prop, an inline array, a sample', () => {
  assert.deepEqual(literalListFields('[{ title: "a", n: 1 }]'), [
    { path: 'title', kind: 'text' },
    { path: 'n', kind: 'number' },
  ]);
  assert.equal(literalListFields('cards'), undefined);
  const tree = [
    {
      path: 'platformIntro',
      key: 'platformIntro',
      kind: 'prop',
      preview: '',
      children: [
        {
          path: 'platformIntro.cards',
          key: 'cards',
          kind: 'list',
          preview: '',
          children: [
            {
              path: 'platformIntro.cards[0]',
              key: '0',
              kind: 'object',
              preview: '',
              children: [{ path: 'platformIntro.cards[0].title', key: 'title', kind: 'text', preview: '' }],
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(treeListFields(tree, 'platformIntro.cards'), [{ path: 'title', kind: 'text' }], 'a list inside a prop is found by its path');
  assert.equal(treeListFields(tree, 'platformIntro.nothing'), undefined);
});

test('a field typed by name is checked, and fields the code already uses show as fields', () => {
  assert.deepEqual(typedModel.typedPathOf('card.title', 'card'), { ok: true, path: 'title' });
  assert.deepEqual(typedModel.typedPathOf('title', 'card'), { ok: true, path: 'title' });
  assert.deepEqual(typedModel.typedPathOf('card', 'card'), { ok: true, path: '$item' });
  assert.deepEqual(typedModel.typedPathOf('author.name', undefined), { ok: true, path: 'author.name' });
  for (const bad of ['', ' ', 'a b', 'a..b', '.a', 'a.', 'x;y', 'a'.repeat(200)]) {
    assert.deepEqual(typedModel.typedPathOf(bad, 'card'), { ok: false }, JSON.stringify(bad));
  }
  const source = { kind: 'list', collection: 'cards' };
  const query = {
    ...loopQuery.emptyQuery(source),
    conditions: [{ kind: 'test', field: 'price', operator: 'greater', value: 3 }],
    sorts: [{ field: 'date', direction: 'ascending', order: 'date' }],
  };
  const fields = typedModel.withTypedFields(undefined, query);
  assert.deepEqual(
    fields.map((field) => [field.path, field.kind]),
    [
      ['price', 'number'],
      ['date', 'date'],
    ],
  );
  const known = [{ path: 'price', title: 'Price', kind: 'number', options: [], references: [] }];
  assert.equal(typedModel.withTypedFields(known, query).length, 2, 'a known field is not added twice');
  assert.equal(typedModel.withTypedFields(undefined, { ...query, source: { kind: 'astro', collection: 'blog' } }), undefined, 'only a list has fields typed');
});

// ---------------------------------------------------------------------------
// The panel.
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
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
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
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

// A host that applies what the panel asks through the real plan and renders again from what it wrote.
async function panel(context, data, frontmatter = FRONTMATTER) {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = { head: `${data}.map((card) => (`, frontmatter, applied: [] };
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = () => {
    const current = state.head.slice(0, state.head.lastIndexOf('.map('));
    root.render(
      React.createElement(modules.LoopSettings, {
        input: { frontmatter: state.frontmatter, imports: IMPORTS, data: current },
        item: 'card',
        projectPath: undefined,
        filePath: 'src/pages/index.astro',
        lists: [],
        onApply,
      }),
    );
  };
  const onApply = (target) => {
    state.applied.push(target);
    const loop = { id: 'loop', kind: 'map', head: state.head, children: [] };
    const model = { extraFrontmatter: state.frontmatter, imports: IMPORTS, nodes: [loop] };
    const result = planLoop({ model, loop, target, sanityClient: 'unavailable' });
    if (!result.ok) {
      return result;
    }
    state.head = result.plan.loop.head;
    state.frontmatter = result.plan.extraFrontmatter;
    render();
    return { ok: true, unbound: 0, lost: [], restored: false };
  };
  await act(async () => render());
  return { host, state };
}

const press = async (element) => {
  assert.ok(element, 'the control is there');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
};
const sectionNamed = (host, title) => [...host.querySelectorAll('.loop-settings-section')].find((section) => section.textContent.startsWith(title));

test('every kind of loop shows Filters, Sort and Limit items', async (context) => {
  for (const [name, data] of Object.entries(KINDS)) {
    const { host } = await panel(context, data);
    const text = host.textContent;
    for (const title of ['Filters', 'Sort', 'Limit items']) {
      assert.ok(text.includes(title), `${name} shows ${title}`);
    }
    for (const title of ['Filters', 'Sort', 'Limit items']) {
      const section = sectionNamed(host, title);
      assert.ok(section, `${name}: the ${title} section`);
      const add = section.querySelector('.loop-settings-add');
      assert.ok(add === null || add.disabled === false, `${name}: ${title} can be added to`);
    }
  }
});

test('an untyped list says its fields are not seen, and a field typed by name makes a filter and a sort', async (context) => {
  const { host, state } = await panel(context, 'platformIntro.cards');
  assert.ok(host.textContent.includes('Stacki cannot see what this list holds'));
  const start = state.head;
  const setValue = async (element, text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, text);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  // Filters: add, name a field, give a value: the filter is written after the list as written.
  await press(sectionNamed(host, 'Filters').querySelector('.loop-settings-add'));
  await setValue(document.querySelector('input[aria-label="Field name"]'), 'card.title');
  await press([...document.querySelectorAll('button.loop-settings-link')].find((button) => button.textContent === 'Use this field'));
  assert.equal(state.applied.length, 0, 'choosing a field writes nothing until its filter is valid');
  assert.equal(state.head, start);
  const value = document.querySelector('.loop-settings-editor input[placeholder="Value"]');
  assert.ok(value, 'the value row');
  await setValue(value, 'Pro');
  await act(async () => value.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(state.head, "platformIntro.cards.filter((card) => card.title === 'Pro').map((card) => (");
  assert.equal(state.frontmatter, FRONTMATTER, 'the frontmatter is untouched');
  // A field the filter already names is a field to sort by: adding a sort starts on it.
  await press(sectionNamed(host, 'Sort').querySelector('.loop-settings-add'));
  assert.equal(state.applied.length, 2);
  assert.match(state.head, /^platformIntro\.cards\.filter\(\(card\) => card\.title === 'Pro'\)\.toSorted\(/);
});

test('a sort on an untyped list starts by naming its field', async (context) => {
  const { host, state } = await panel(context, 'items');
  await press(sectionNamed(host, 'Sort').querySelector('.loop-settings-add'));
  const input = document.querySelector('input[aria-label="Field name"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'order');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(state.applied.length, 1, 'a text field sorts by its text');
  assert.match(state.head, /^items\.toSorted\(/);
  assert.equal(state.frontmatter, FRONTMATTER);
});

test('a loop nobody touches stays byte for byte, and hovering controls writes nothing', async (context) => {
  for (const [name, data] of Object.entries(KINDS)) {
    const { host, state } = await panel(context, data);
    assert.equal(state.head, `${data}.map((card) => (`, name);
    assert.equal(state.applied.length, 0, name);
    assert.ok(host.querySelector('.loop-settings'), name);
  }
});
