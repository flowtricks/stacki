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
const { installToastLog } = require('../../helpers/toastLog.js');
const { literalListFields } = load('src/editor/loopLiteral.ts');
const { treeListFields } = load('src/features/props/loopProjectData.ts');

const directory = repoPath('node_modules/.stacki-test/loop-any-list');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-any-list.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as LoopSettings } from './src/features/props/LoopSettings';",
      "export { CmsIcon } from './src/ui/Icons';",
      "export { EditorView } from '@codemirror/view';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
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
  // The project's files, which a picked item's thumbnail is read from.
  dom.window.avb = { listAssets: async () => ({ entries: [] }), onAssetsChanged: () => () => {} };
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
  const toasts = installToastLog(modules.subscribeErrorToasts);
  const state = { head: `${data}.map((card) => (`, frontmatter, applied: [], toasts };
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    toasts.uninstall();
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
    if (target.kind === 'remove') {
      // The page unwraps the loop itself (appLoopEdits.ts); the host only records the request.
      return { ok: true, unbound: 2, lost: [], restored: false, removed: { replaced: 2, emptied: 1 } };
    }
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

// The field name is code, so it is the highlighted editor: typed through its view, used with Enter.
const fieldInput = () => document.querySelector('.loop-typed-form .cm-content');
async function typeField(text) {
  const view = modules.EditorView.findFromDOM(fieldInput());
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}
const enterField = async () =>
  act(async () => fieldInput().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
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
  assert.equal(host.textContent.includes('Stacki cannot see what this list holds'), false, 'the explanation is not a paragraph in the panel');
  const tip = host.querySelector('.loop-settings-mode .prop-tip-icon');
  assert.ok(tip, 'the Items row has a "?" beside its label');
  assert.ok(tip.getAttribute('aria-label').includes('Stacki cannot see what this list holds'), 'and it carries the explanation');
  assert.equal(tip.getAttribute('tabindex'), '0', 'reachable by keyboard');
  const start = state.head;
  const setValue = async (element, text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, text);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  // Filters: add, name a field, give a value: the filter is written after the list as written.
  await press(sectionNamed(host, 'Filters').querySelector('.loop-settings-add'));
  assert.ok(fieldInput().closest('.loop-typed-form'), 'the field name is the highlighted editor, in the form');
  await typeField('card.title');
  await press([...document.querySelectorAll('button.primary')].find((button) => button.textContent === 'Use field'));
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
  await typeField('order');
  await enterField();
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

// ---------------------------------------------------------------------------
// Items: Dynamic or Selected, on every loop.
// ---------------------------------------------------------------------------

const pickModel = load('src/features/props/loopPickModel.ts');
const CARDS_FRONTMATTER = `const cards = [
  { slug: 'fast', title: 'Fast', image: 'https://example.com/fast.png' },
  { slug: 'safe', title: 'Safe' },
  { slug: 'free', title: 'Free' },
];
`;

test('the items of a list are read where they can be seen, and named by their key field when they have one', () => {
  const written = pickModel.listPicks({ frontmatter: CARDS_FRONTMATTER, expression: 'cards', tree: undefined });
  assert.equal(written.field, 'slug');
  assert.deepEqual(
    written.items.map((item) => [item.id, item.title]),
    [
      ['fast', 'Fast'],
      ['safe', 'Safe'],
      ['free', 'Free'],
    ],
  );
  assert.deepEqual(written.items[0].picture, { kind: 'url', url: 'https://example.com/fast.png' }, 'a picture field is the thumbnail');
  assert.equal(written.items[1].picture, undefined);
  // A list typed in the loop, plain words, is picked by position.
  const inline = pickModel.listPicks({ frontmatter: '', expression: '["a", "b"]', tree: undefined });
  assert.equal(inline.field, undefined);
  assert.deepEqual(
    inline.items.map((item) => [item.id, item.title]),
    [
      ['0', 'a'],
      ['1', 'b'],
    ],
  );
  // A key two items share names nothing: positions.
  const clash = pickModel.listPicks({ frontmatter: "const xs = [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }];", expression: 'xs', tree: undefined });
  assert.equal(clash.field, undefined);
  // Nothing to see: no items, so nothing to pick.
  assert.equal(pickModel.listPicks({ frontmatter: '', expression: 'items', tree: undefined }), undefined);
  assert.equal(pickModel.listPicks({ frontmatter: 'const xs = [];', expression: 'xs', tree: undefined }), undefined);
});

test('the items of a sampled list come from the page’s data', () => {
  const leaf = (key, preview, kind = 'text') => ({ path: key, key, kind, preview, children: undefined });
  const tree = [
    {
      path: 'items',
      key: 'items',
      kind: 'list',
      preview: '',
      children: [
        {
          path: 'items[0]',
          key: '0',
          kind: 'object',
          preview: '',
          children: [leaf('id', 'one'), leaf('name', 'One'), leaf('photo', 'https://x.test/1.png', 'image')],
        },
        { path: 'items[1]', key: '1', kind: 'object', preview: '', children: [leaf('id', 'two'), leaf('name', 'Two')] },
      ],
    },
  ];
  const picks = pickModel.listPicks({ frontmatter: '', expression: 'items', tree });
  assert.equal(picks.field, 'id');
  assert.deepEqual(
    picks.items.map((item) => [item.id, item.title]),
    [
      ['one', 'One'],
      ['two', 'Two'],
    ],
  );
  assert.equal(picks.items[0].picture.kind, 'url');
});

test('picked items are written as a readable expression and read back as Selected', () => {
  const source = { kind: 'list', collection: 'cards' };
  const byKey = { ...loopQuery.emptyQuery(source), selection: ['safe', 'fast'], selectionField: 'slug' };
  const keyCode = loopQuery.listQueryCode(byKey);
  assert.equal(keyCode, "['safe', 'fast'].map((key) => cards.find((item) => item.slug === key)).filter(Boolean)");
  const keyed = readLoop({ frontmatter: FRONTMATTER, imports: IMPORTS, data: keyCode });
  assert.deepEqual([keyed.query.selection, keyed.query.selectionField, keyed.query.source.collection], [['safe', 'fast'], 'slug', 'cards']);
  const byPosition = { ...loopQuery.emptyQuery({ kind: 'list', collection: '["a", "b", "c"]' }), selection: ['2', '0'] };
  const positionCode = loopQuery.listQueryCode(byPosition);
  assert.equal(positionCode, '[2, 0].map((index) => ["a", "b", "c"][index]).filter(Boolean)');
  const positioned = readLoop({ frontmatter: '', imports: [], data: positionCode });
  assert.deepEqual(
    [positioned.query.selection, positioned.query.selectionField, positioned.query.source.collection],
    [['2', '0'], undefined, '["a", "b", "c"]'],
  );
  // A list that is not a bare name is wrapped, in either form.
  const wrapped = { ...loopQuery.emptyQuery({ kind: 'list', collection: 'a ?? []' }), selection: ['1'] };
  assert.equal(loopQuery.listQueryCode(wrapped), '[1].map((index) => (a ?? [])[index]).filter(Boolean)');
  // A field that is not a plain name is written as a key.
  const odd = { ...loopQuery.emptyQuery(source), selection: ['a'], selectionField: 'the-slug' };
  assert.match(loopQuery.listQueryCode(odd), /item\['the-slug'\] === key/);
  // Nothing picked yet writes an empty pick, which reads back as Selected too.
  const none = { ...loopQuery.emptyQuery(source), selection: [], selectionField: 'slug' };
  assert.equal(readLoop({ frontmatter: FRONTMATTER, imports: IMPORTS, data: loopQuery.listQueryCode(none) }).query.selection.length, 0);
});

test('code that only looks like picks is not read as picks, and is never rewritten', () => {
  const read = (data) => readLoop({ frontmatter: FRONTMATTER, imports: IMPORTS, data });
  for (const data of [
    '["a"].map((key) => cards.find((item) => item.slug !== key)).filter(Boolean)',
    '["a"].map((key) => cards.find((item) => item.slug === other)).filter(Boolean)',
    '[x].map((key) => cards.find((item) => item.slug === key)).filter(Boolean)',
    '[-1].map((index) => cards[index]).filter(Boolean)',
    '[1.5].map((index) => cards[index]).filter(Boolean)',
    '["a"].map((key) => cards.find((item) => item.slug === key)).filter(Boolean).slice(0, 1)',
    '["a"].map((key, at) => cards.find((item) => item.slug === key)).filter(Boolean)',
  ]) {
    const reading = read(data);
    assert.equal(reading.query?.selection, undefined, data);
    assert.ok(reading.kind === 'query' || reading.kind === 'partial', data);
  }
  assert.throws(() => loopQuery.listPickedCode('cards', ['x'], undefined), /A picked position is a whole number/);
  assert.throws(() => loopQuery.listPickedCode('cards', ['1'], 'a b'));
  assert.throws(() => loopQuery.listPickedCode('cards.(', ['1'], undefined), /A picked list is an expression/);
});

test('the Items switch moves between the modes, and Selected needs items to pick from', () => {
  const source = { kind: 'list', collection: 'cards' };
  const dynamic = { ...loopQuery.emptyQuery(source), limit: 2 };
  const picks = pickModel.listPicks({ frontmatter: CARDS_FRONTMATTER, expression: 'cards', tree: undefined });
  const selected = pickModel.listItemsModeQuery(dynamic, 'selected', picks);
  assert.deepEqual([selected.selection, selected.selectionField, selected.limit], [[], 'slug', undefined], 'the settings of the other mode go');
  assert.equal(pickModel.listItemsModeQuery(selected, 'selected', picks), undefined, 'already Selected');
  assert.equal(pickModel.listItemsModeQuery(dynamic, 'dynamic', picks), undefined, 'already Dynamic');
  assert.equal(pickModel.listItemsModeQuery(dynamic, 'selected', undefined), undefined, 'no items to pick from');
  const back = pickModel.listItemsModeQuery({ ...selected, selection: ['fast'] }, 'dynamic', picks);
  assert.deepEqual([back.selection, back.selectionField], [undefined, undefined]);
});

const switchOf = (host) => host.querySelector('.loop-settings-mode .bool-seg');
const buttonNamed = (host, label) => [...switchOf(host).querySelectorAll('button')].find((button) => button.textContent === label);

test('every kind of loop has the Items switch, Selected on only where its items can be seen', async (context) => {
  for (const [name, data] of Object.entries(KINDS)) {
    const { host } = await panel(context, data);
    assert.ok(switchOf(host), `${name} has Items`);
    assert.ok(buttonNamed(host, 'Dynamic'), name);
    assert.equal(buttonNamed(host, 'Dynamic').getAttribute('aria-pressed'), 'true', name);
    const selected = buttonNamed(host, 'Selected');
    assert.ok(selected, name);
    if (selected.disabled) {
      assert.ok(selected.title.length > 20, `${name}: the reason is specific (${selected.title})`);
    }
  }
  const inline = await panel(context, '["a", "b", "c"]');
  assert.equal(buttonNamed(inline.host, 'Selected').disabled, false, 'an inline array can be picked from');
  const unseen = await panel(context, 'items');
  assert.equal(buttonNamed(unseen.host, 'Selected').disabled, true);
  assert.match(buttonNamed(unseen.host, 'Selected').title, /not known here/);
});

test('Selected on a list picks its items by their key and writes the picks, in the order picked', async (context) => {
  const { host, state } = await panel(context, 'cards', CARDS_FRONTMATTER);
  const before = state.frontmatter;
  await press(buttonNamed(host, 'Selected'));
  assert.equal(state.head, '[].map((key) => cards.find((item) => item.slug === key)).filter(Boolean).map((card) => (');
  assert.equal(buttonNamed(host, 'Selected').getAttribute('aria-pressed'), 'true', 'it opens in Selected mode, as the code says');
  assert.equal(state.frontmatter, before, 'the frontmatter is untouched');
  await press(sectionNamed(host, 'Select items').querySelector('.loop-settings-add'));
  const rows = [...document.querySelectorAll('.loop-settings-picker-row:not(.all)')];
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['Fast', 'Safe', 'Free'],
  );
  await act(async () => rows[2].querySelector('input').click());
  await act(async () => rows[0].querySelector('input').click());
  assert.equal(state.head, "['free', 'fast'].map((key) => cards.find((item) => item.slug === key)).filter(Boolean).map((card) => (");
  // A head that already picks opens in Selected, and Dynamic gives the whole list back.
  await press(buttonNamed(host, 'Dynamic'));
  assert.equal(state.head, 'cards.map((card) => (');
});

test('an inline array is picked by position', async (context) => {
  const { host, state } = await panel(context, '["a", "b", "c"]');
  await press(buttonNamed(host, 'Selected'));
  await press(sectionNamed(host, 'Select items').querySelector('.loop-settings-add'));
  const rows = [...document.querySelectorAll('.loop-settings-picker-row:not(.all)')];
  await act(async () => rows[1].querySelector('input').click());
  assert.equal(state.head, '[1].map((index) => ["a", "b", "c"][index]).filter(Boolean).map((card) => (');
});

// A list typed in the loop keeps its own Text icon: its Source entry is "Custom list", on purpose.
test('a list source shows the CMS icon, like a collection', async (context) => {
  const { renderToStaticMarkup } = require('react-dom/server');
  const cms = renderToStaticMarkup(React.createElement(modules.CmsIcon, { size: 13 }));
  const name = /data-central-icon="([^"]+)"/.exec(cms)[1];
  for (const data of ['platformIntro.cards', 'cards', 'Object.entries(platformIntro)']) {
    const { host } = await panel(context, data);
    assert.ok(host.querySelector('.loop-source-trigger .dd-icon').innerHTML.includes(`data-central-icon="${name}"`), data);
  }
});

test('the field picker leads with the search, then the fields, then a quiet row for another field name', async (context) => {
  const { host } = await panel(context, 'cards', CARDS_FRONTMATTER);
  await press(sectionNamed(host, 'Filters').querySelector('.loop-settings-add'));
  assert.ok(document.querySelector('.loop-typed-form') === null, 'with fields to pick, the form is not open');
  await press(document.querySelector('button[aria-label="Field"]'));
  const picker = document.querySelector('.loop-source-picker');
  assert.ok(picker, 'the picker is open');
  const parts = [...picker.children].map((child) => child.className.split(' ')[0]);
  assert.deepEqual(parts, ['data-picker', 'loop-field-extras'], 'the data picker, with its search first, then the extras');
  assert.ok(picker.querySelector('.data-picker').firstElementChild.classList.contains('dp-search'), 'the search comes first');
  const more = [...picker.querySelectorAll('.loop-field-extras .dp-row')].at(-1);
  assert.equal(more.textContent, 'Use a custom field name…');
  await press(more);
  const form = picker.querySelector('.loop-typed-form');
  assert.ok(form, 'the form opens in place');
  assert.deepEqual(
    [...form.querySelectorAll('.loop-typed-label')].map((label) => label.textContent),
    ['Field name', 'Type'],
  );
  assert.ok(form.querySelector('button.primary'), 'one primary action');
});

test('None takes the loop away, with a notice that says what became of the bindings', async (context) => {
  const { host, state } = await panel(context, 'cards', CARDS_FRONTMATTER);
  await press(host.querySelector('.loop-source-trigger'));
  const none = [...document.querySelectorAll('.loop-source-extras .dp-row')].find((row) => row.textContent.startsWith('None'));
  assert.ok(none, 'None is in the Source menu');
  await press(none);
  assert.equal(state.applied.length, 1);
  assert.equal(state.applied[0].kind, 'remove', 'None removes the loop, it does not leave an empty one');
  assert.deepEqual(state.applied[0].samples, {}, 'with nothing sampled, nothing is claimed');
  assert.match(state.toasts.messages().join('\n'), /Loop removed · 2 bindings replaced with their current values · 1 had no value to keep/);
  assert.equal(
    host.querySelector('[role="alert"], [role="status"], [class*="-notice"]') ?? undefined,
    undefined,
    'what became of the bindings is a toast, not a banner in the panel',
  );
});

test('None on a loop that already has no list writes nothing', async (context) => {
  const { host, state } = await panel(context, '[]');
  await press(host.querySelector('.loop-source-trigger'));
  const none = [...document.querySelectorAll('.loop-source-extras .dp-row')].find((row) => row.textContent.startsWith('None'));
  await press(none);
  assert.ok(state.applied.length === 0 || state.applied[0].kind === 'empty', 'an empty loop has nothing to remove');
});
