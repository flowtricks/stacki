// Goal: Filters, Sort and Limit each have the `{}` a prop field has, and hold
// their own code. Code the controls cannot show opens as code in that section
// alone, the sections around it stay controls, a section's edit changes only that
// section's bytes in the order the source gave, and nothing broken is written.
//
// Method: the reader, the checks and the plan run as pure code over list props
// and Astro collections, with each section's edit compared byte for byte against
// the text it started from. Heads the plan writes go through main's real page
// parser. Then the real LoopSettings, bundled as the app bundles it, renders in
// jsdom over a small host that runs the real planLoop and re-renders with what it
// wrote, so a toggle, a commit and a refusal behave as in the panel. CodeMirror is
// the app's own editor, driven through its view.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const { readSections, sectionCodeProblem, sectionRefusal, groqSectionProblem, groqSectionQuery, sectionCodeOf, changedSection } =
  load('src/editor/loopSections.ts');
const { planLoop, targetKey } = load('src/editor/loopQueryPlan.ts');
const loopQuery = load('src/editor/loopQuery.ts');

const directory = repoPath('node_modules/.stacki-test/loop-section-code');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-section-code.cjs');
buildSync({
  stdin: {
    contents: ["export { default as LoopSettings } from './src/features/props/LoopSettings';", "export { EditorView } from '@codemirror/view';"].join('\n'),
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

const LIST = `interface Props {
  features?: readonly { title: string; number: number; on: boolean }[];
}
const { features = [] } = Astro.props;
`;
const IMPORTS = [{ name: 'getCollection', path: 'astro:content' }];
const collection = (statement) => `${statement} // stacki:query\n`;
const listInput = (data) => ({ frontmatter: LIST, imports: [], data });
const headOf = (data) => `${data}.map((item, index) => (`;

function write(model, section, code) {
  const loop = { id: 'loop', kind: 'map', head: model.head, children: [] };
  const other = model.other === undefined ? [] : [{ id: 'other', kind: 'map', head: model.other, children: [] }];
  const page = { extraFrontmatter: model.frontmatter, imports: model.imports, nodes: [loop, ...other] };
  return planLoop({ model: page, loop, target: { kind: 'section', section, code }, sanityClient: 'unavailable' });
}

function written(model, section, code) {
  const result = write(model, section, code);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { head: result.plan.loop.head, frontmatter: result.plan.extraFrontmatter };
}

const listModel = (data) => ({ head: headOf(data), frontmatter: LIST, imports: [] });

test('each section holds its own code, in the shortest form that says it', () => {
  const sections = readSections(listInput('features.filter((item) => item.number > 1).toSorted((a, b) => a.number - b.number).slice(0, 3)'));
  assert.equal(sections.filter.code, '(item) => item.number > 1');
  assert.equal(sections.sort.code, '(a, b) => a.number - b.number');
  assert.equal(sections.limit.code, '3');
  for (const section of ['filter', 'sort', 'limit']) {
    assert.equal(sections[section].custom, undefined, section);
  }
});

test('what the short form cannot say shows as the chain', () => {
  const chains = [
    ['features.filter((a) => a.on).filter(isLive)', 'filter', '.filter((a) => a.on).filter(isLive)'],
    ['features.filter(isLive, context)', 'filter', '.filter(isLive, context)'],
    ['features.toSorted((a, b) => a.number - b.number).reverse()', 'sort', '.toSorted((a, b) => a.number - b.number).reverse()'],
    ['features.toReversed()', 'sort', '.toReversed()'],
    ['features.toSorted()', 'sort', '.toSorted()'],
    ['features.slice(2, 5)', 'limit', '.slice(2, 5)'],
    ['features.slice(-3)', 'limit', '.slice(-3)'],
  ];
  for (const [data, section, code] of chains) {
    assert.equal(readSections(listInput(data))[section].code, code, data);
  }
  assert.equal(readSections(listInput('features.slice(0, count)')).limit.code, 'count');
});

test('code no control can show is custom in its section alone', () => {
  const sections = readSections(listInput('features.filter(isLive).toSorted((a, b) => a.number - b.number).slice(0, 3)'));
  assert.ok(sections.filter.custom, 'a named predicate has no rows');
  assert.equal(sections.sort.custom, undefined);
  assert.equal(sections.limit.custom, undefined);
  assert.deepEqual(sections.query.conditions, [], 'the custom section adds nothing to the controls');
  assert.equal(sections.query.sorts.length, 1);
  assert.equal(sections.query.limit, 3);
  assert.ok(readSections(listInput('features.slice(0, count)')).limit.custom, 'a limit that is not a number');
  assert.ok(readSections(listInput('features.toSorted(byDate)')).sort.custom, 'a named comparator');
  assert.ok(readSections(listInput('features.filter(({ on }) => on)')).filter.custom, 'a destructured item');
});

test('a step out of the order the controls imply is custom, and says why', () => {
  const sections = readSections(listInput('features.slice(0, 2).filter((item) => item.on)'));
  assert.match(sections.filter.custom, /runs after the limit/);
  assert.equal(sections.limit.custom, undefined, 'the step that comes first still means what its controls say');
  assert.equal(sections.limit.code, '2');
  assert.equal(sections.query.limit, 2);
  assert.match(sectionRefusal(listInput('features.slice(0, 2).filter((item) => item.on)'), 'filter', '(item) => item.number > 1'), /runs after the limit/);
});

test('a list that cannot be split keeps the whole-list notice', () => {
  const unsplit = [
    'features.filter(isLive).flatMap((item) => item.parts)',
    'features.filter(a).slice(1).filter(b)',
    'features.toSorted(a).filter(b).toSorted(c)',
  ];
  for (const data of unsplit) {
    assert.equal(readSections(listInput(data)), undefined, data);
  }
  const held = `${LIST}const visible = features.filter((item) => item.on);\n`;
  assert.equal(readSections({ frontmatter: held, imports: [], data: 'visible' }), undefined, 'a helper variable');
  assert.equal(readSections({ frontmatter: '', imports: [], data: '[1, 2]' }), undefined, 'a list typed in place');
});

test('a section edit leaves the other sections byte for byte', () => {
  const filter = '.filter((item)=>item.number>1)';
  const sort = '.toSorted(  (a, b)   => a.number - b.number)';
  const limit = '.slice(0,   3)';
  const model = listModel(`features${filter}${sort}${limit}`);
  assert.equal(written(model, 'filter', 'isLive').head, headOf(`features.filter(isLive)${sort}${limit}`));
  assert.equal(written(model, 'sort', 'byDate').head, headOf(`features${filter}.toSorted(byDate)${limit}`));
  assert.equal(written(model, 'limit', 'count').head, headOf(`features${filter}${sort}.slice(0, count)`));
  assert.equal(written(model, 'limit', '').head, headOf(`features${filter}${sort}`), 'emptying a section removes its steps');
  assert.equal(written(model, 'limit', 'count').frontmatter, LIST, 'the frontmatter is not touched');
});

test('steps keep the source’s order, and a new one goes where it means what it says', () => {
  const late = listModel('features.slice(0, 2).filter((item) => item.on)');
  assert.equal(written(late, 'limit', '4').head, headOf('features.slice(0, 4).filter((item) => item.on)'));
  assert.equal(written(late, 'filter', 'isLive').head, headOf('features.slice(0, 2).filter(isLive)'));
  const sliced = listModel('features.slice(0, 2)');
  assert.equal(written(sliced, 'filter', 'isLive').head, headOf('features.filter(isLive).slice(0, 2)'), 'before the steps that should follow it');
  assert.equal(written(sliced, 'sort', 'byDate').head, headOf('features.toSorted(byDate).slice(0, 2)'));
  assert.equal(written(listModel('features.filter(isLive)'), 'limit', '3').head, headOf('features.filter(isLive).slice(0, 3)'), 'or after the last');
  assert.equal(written(listModel('features'), 'sort', 'byDate').head, headOf('features.toSorted(byDate)'), 'a prop is never sorted in place');
});

test('the method written is kept, a chain replaces the section, and line breaks survive', () => {
  assert.equal(written(listModel('features.sort(a)'), 'sort', 'b').head, headOf('features.sort(b)'));
  assert.equal(written(listModel('features.filter(a)'), 'filter', '.filter(b).filter(c)').head, headOf('features.filter(b).filter(c)'));
  assert.equal(written(listModel('features.filter(a).filter(b).slice(0, 1)'), 'filter', 'c').head, headOf('features.filter(c).slice(0, 1)'));
  const lines = 'features\n  .filter(a)\n  .slice(0, 1)';
  assert.equal(written(listModel(lines), 'filter', 'b').head, headOf('features\n  .filter(b)\n  .slice(0, 1)'));
  assert.equal(written(listModel(lines), 'filter', '').head, headOf('features\n  .slice(0, 1)'));
});

test('the rest of the head is kept as written', () => {
  const model = { head: 'features.filter(a).map( (item) => (', frontmatter: LIST, imports: [] };
  assert.equal(written(model, 'filter', 'b').head, 'features.filter(b).map( (item) => (');
});

test('invalid code is refused, with a reason, and writes nothing', () => {
  const cases = [
    ['filter', '(item) =>'],
    ['filter', '(item) => item.number >'],
    ['filter', 'a, b'],
    ['filter', '(item) => item.on // always'],
    ['filter', '.filter(a).slice(0, 1)'],
    ['filter', '.map((item) => item)'],
    ['filter', '1 + 2'],
    ['filter', "'text'"],
    ['filter', 'a).map((b) => (b'],
    ['sort', '(a, b, c) => 0'],
    ['sort', '.slice(0, 1)'],
    ['sort', '5'],
    ['limit', "'six'"],
    ['limit', '(item) => item'],
    ['limit', '1, 2'],
    ['limit', '.filter(a)'],
    ['limit', 'x'.repeat(loopQuery.LOOP_QUERY_LIMITS.customCodeCharsMax + 1)],
  ];
  const model = listModel('features.filter(isLive)');
  for (const [section, code] of cases) {
    assert.equal(typeof sectionCodeProblem(section, code), 'string', code);
    const result = write(model, section, code);
    assert.equal(result.ok, false, code);
  }
});

test('valid code of each form is accepted', () => {
  const cases = [
    ['filter', '(item) => item.on'],
    ['filter', 'isLive'],
    ['filter', 'filters.live'],
    ['filter', 'makeFilter(1)'],
    ['filter', 'Boolean'],
    ['filter', '.filter(a).filter(b)'],
    ['filter', '(item) => {\n  return item.on;\n}'],
    ['sort', '() => Math.random() - 0.5'],
    ['sort', '.toSorted(a).reverse()'],
    ['sort', '.reverse()'],
    ['limit', '3'],
    ['limit', 'count'],
    ['limit', 'Math.min(count, 3)'],
    ['limit', '.slice(1, 4)'],
    ['limit', ''],
  ];
  for (const [section, code] of cases) {
    assert.equal(sectionCodeProblem(section, code), undefined, code);
  }
});

test('code the controls can hold round-trips; other code is refused the switch', () => {
  const input = listInput('features.filter(isLive)');
  assert.equal(sectionRefusal(input, 'filter', '(item) => item.number > 1'), undefined);
  assert.equal(sectionRefusal(input, 'filter', ''), undefined, 'an empty section has nothing to show');
  assert.match(sectionRefusal(input, 'filter', 'isLive'), /cannot show this code, so it stays as code/);
  assert.equal(sectionRefusal(input, 'limit', '3'), undefined);
  assert.match(sectionRefusal(input, 'limit', 'count'), /limit controls cannot show/);
  assert.equal(sectionRefusal(input, 'sort', '(a, b) => a.number % 2 - b.number % 2'), undefined, 'a custom sort has a row');
});

test('a control’s change around a custom section is that section’s code', () => {
  const sections = readSections(listInput('features.filter(isLive).slice(0, 3)'));
  const before = sections.query;
  const sorted = { ...before, sorts: [{ field: 'number', direction: 'descending', order: 'number' }] };
  assert.equal(changedSection(before, sorted), 'sort');
  assert.equal(sectionCodeOf(sorted, 'sort', []), '(a, b) => (b.number ?? 0) - (a.number ?? 0)');
  assert.equal(changedSection(before, { ...before, limit: 4 }), 'limit');
  assert.equal(sectionCodeOf({ ...before, limit: 4 }, 'limit', []), '4');
  assert.equal(sectionCodeOf({ ...before, offset: 1, limit: 4 }, 'limit', []), '.slice(1, 5)');
  assert.equal(changedSection(before, before), undefined);
  const condition = { kind: 'test', field: 'number', operator: 'greater', value: 3 };
  assert.equal(sectionCodeOf({ ...before, conditions: [condition] }, 'filter', []), '(item) => item.number > 3');
});

// ---------------------------------------------------------------------------
// Collections.
// ---------------------------------------------------------------------------

const astroInput = (statement, data = 'posts') => ({ frontmatter: collection(statement), imports: IMPORTS, data });
const astroModel = (statement, data = 'posts') => ({ head: headOf(data), frontmatter: collection(statement), imports: IMPORTS });

test('a collection’s sections are read from its declaration', () => {
  const sections = readSections(
    astroInput("const posts = (await getCollection('posts', ({ data }) => data.on)).sort((a, b) => a.data.order - b.data.order).slice(0, 3);"),
  );
  assert.equal(sections.filter.code, '({ data }) => data.on');
  assert.equal(sections.sort.code, '(a, b) => a.data.order - b.data.order');
  assert.equal(sections.limit.code, '3');
  assert.deepEqual(sections.itemPath, ['data']);
});

test('custom code in a collection stays in its section, whether the steps are in the head or the declaration', () => {
  const fetched = "const posts = (await getCollection('posts')).filter(isLive).slice(0, 3);";
  const sections = readSections(astroInput(fetched));
  assert.ok(sections.filter.custom);
  assert.equal(sections.limit.custom, undefined);
  assert.equal(sections.query.limit, 3);
  const split = readSections(astroInput("const posts = await getCollection('posts');", 'posts.filter(isLive).slice(0, 3)'));
  assert.ok(split.filter.custom);
  assert.equal(split.query.limit, 3);
});

test('a collection’s step is rewritten where it is written, and only that step', () => {
  const statement = "const posts = (await getCollection('posts')).filter(isLive).sort(byDate).slice(0, 3);";
  const after = written(astroModel(statement), 'sort', '(a, b) => a.data.order - b.data.order');
  assert.equal(
    after.frontmatter,
    collection("const posts = (await getCollection('posts')).filter(isLive).sort((a, b) => a.data.order - b.data.order).slice(0, 3);"),
  );
  assert.equal(after.head, headOf('posts'), 'the head that reads it stays');
});

test('getCollection’s own filter is edited in place, and goes with its comma', () => {
  const statement = "const posts = await getCollection('posts', ({ data }) => data.on);";
  assert.equal(written(astroModel(statement), 'filter', 'isLive').frontmatter, collection("const posts = await getCollection('posts', isLive);"));
  assert.equal(written(astroModel(statement), 'filter', '.filter(isLive)').frontmatter, collection("const posts = await getCollection('posts', isLive);"));
  assert.equal(written(astroModel(statement), 'filter', '').frontmatter, collection("const posts = await getCollection('posts');"));
  const refused = write(astroModel(statement), 'filter', '.filter(a).filter(b)');
  assert.equal(refused.ok, false, 'its argument takes one function');
  const both = "const posts = (await getCollection('posts', a)).filter(b);";
  assert.equal(readSections(astroInput(both)).filter.code, '.filter(a).filter(b)');
  assert.equal(
    written(astroModel(both), 'filter', '.filter(c).filter(d)').frontmatter,
    collection("const posts = (await getCollection('posts')).filter(c).filter(d);"),
  );
});

test('a new step on a plain collection is written in the loop’s head alone', () => {
  const statement = "const posts = await getCollection('posts');";
  const after = written(astroModel(statement), 'filter', '(entry) => entry.data.on');
  assert.equal(after.head, headOf('posts.filter((entry) => entry.data.on)'));
  assert.equal(after.frontmatter, collection(statement));
});

test('a declaration something else reads is left alone', () => {
  const statement = "const posts = (await getCollection('posts')).filter(isLive);";
  const model = { ...astroModel(statement), other: headOf('posts') };
  const refused = write(model, 'filter', 'other');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Other code reads posts too/);
  assert.equal(written(model, 'limit', '3').head, headOf('posts.slice(0, 3)'), 'a new step goes in this loop’s head');
  assert.equal(written(model, 'limit', '3').frontmatter, collection(statement));
});

test('settings kept as data, and picked items, have no code', () => {
  const picked =
    "const posts = (await getCollection('posts')).filter((entry) => ['a'].includes(entry.id)).sort((a, b) => ['a'].indexOf(a.id) - ['a'].indexOf(b.id));";
  assert.equal(readSections(astroInput(picked)), undefined);
});

test('a section target keeps the source’s key out of the loop’s memory', () => {
  assert.equal(targetKey({ kind: 'section', section: 'filter', code: 'a' }), 'section:filter');
});

// ---------------------------------------------------------------------------
// Sanity: one GROQ string, read back through readGroq.
// ---------------------------------------------------------------------------

const sanity = (groq) => ({
  frontmatter: `const pastors = await sanityClient.fetch(${JSON.stringify(groq)});\n`,
  imports: [{ name: 'sanityClient', path: 'sanity:client' }],
  data: 'pastors',
});

test('a Sanity list’s sections are its GROQ, and read back as the query', () => {
  const sections = readSections(sanity('*[_type == "pastor" && featured == true] | order(name asc) [0...6]'));
  assert.equal(sections.store, 'groq');
  assert.equal(sections.filter.code, 'featured == true');
  assert.equal(sections.sort.code, 'order(name asc)');
  assert.equal(sections.limit.code, '[0...6]');
  const query = sections.query;
  assert.deepEqual(groqSectionQuery('limit', '[2...5]', query).limit, 3);
  assert.deepEqual(groqSectionQuery('limit', '[2...5]', query).offset, 2);
  assert.deepEqual(groqSectionQuery('sort', 'order(age desc)', query).sorts[0].direction, 'descending');
  assert.equal(groqSectionQuery('sort', '(a, b) => a.age - b.age', query).customSort, '(a, b) => a.age - b.age');
  assert.equal(groqSectionQuery('sort', '(a, b) => a.age - b.age', query).sorts.length, 0);
  assert.deepEqual(groqSectionQuery('filter', '', query).conditions, []);
  assert.equal(groqSectionQuery('filter', 'count(tags) > 1', query).conditions[0].kind, 'custom', 'kept as a custom row');
  assert.equal(groqSectionProblem('limit', 'six', query), 'Write a GROQ slice, such as [0...6].');
  assert.equal(groqSectionProblem('limit', '[0...0]', query), 'Write a GROQ slice, such as [0...6].', 'a limit outside the bounds is input, not a crash');
  assert.equal(groqSectionProblem('filter', 'a == (', query), 'This is not a GROQ condition.');
});

// ---------------------------------------------------------------------------
// The panel. The DOM goes in after the parser's tests: the Astro compiler takes
// a global `document` as a browser.
// ---------------------------------------------------------------------------

test('heads written with arrows and comparisons survive the page parser', () => {
  const page = '---\nconst { features = [] } = Astro.props;\n---\n<div>{\n  features.map((item) => (\n    <p>{item.title}</p>\n  ))\n}</div>\n';
  const loop = parsePage(page, { locs: true }).model.nodes[0].children[0];
  const interface_ = 'interface Props {\n  features?: { title: string }[];\n}\nconst { features = [] } = Astro.props;\n';
  const after = written({ head: loop.head, frontmatter: interface_, imports: [] }, 'filter', '(item) => item.title.length > 1 && item.title !== "<b>"');
  const saved = page.replace(loop.head, after.head);
  assert.equal(parsePage(saved, { locs: true }).model.nodes[0].children[0].head, after.head);
});

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
  // CodeMirror measures text; jsdom lays nothing out.
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

// A host that applies what the panel asks through the real plan, as the app
// does, and renders again from what the plan wrote.
async function panel(context, start) {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = { ...start, applied: [] };
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = () => {
    const data = state.head.slice(0, state.head.lastIndexOf('.map('));
    root.render(
      React.createElement(modules.LoopSettings, {
        input: { frontmatter: state.frontmatter, imports: state.imports, data },
        projectPath: undefined,
        filePath: 'src/components/Card.astro',
        lists: [],
        onApply,
      }),
    );
  };
  const onApply = (target) => {
    state.applied.push(target);
    const loop = { id: 'loop', kind: 'map', head: state.head, children: [] };
    const model = { extraFrontmatter: state.frontmatter, imports: state.imports, nodes: [loop] };
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

const TITLES = { filter: 'Filters', sort: 'Sort', limit: 'Limit items' };
const toggle = (host, section) => host.querySelector(`button[aria-label="${TITLES[section]} as code"]`);
const sectionOf = (host, section) => toggle(host, section).closest('.loop-settings-section');
const editorOf = (host, section) => sectionOf(host, section).querySelector('.cm-content');
const codeOf = (host, section) => modules.EditorView.findFromDOM(editorOf(host, section)).state.doc.toString();
const noteOf = (host, section) => sectionOf(host, section).querySelector('.prop-field-note.problem')?.textContent;
const press = async (element) => {
  assert.ok(element, 'the control is there');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
};

async function type(host, section, text) {
  const view = modules.EditorView.findFromDOM(editorOf(host, section));
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

async function leave(host, section) {
  await act(async () => editorOf(host, section).dispatchEvent(new window.FocusEvent('blur')));
}

test('the toggle is on all three sections, off and writing nothing, for both kinds of loop', async (context) => {
  const models = [listModel('features'), astroModel("const posts = await getCollection('posts');")];
  for (const model of models) {
    const { host, state } = await panel(context, model);
    for (const section of ['filter', 'sort', 'limit']) {
      const button = toggle(host, section);
      assert.ok(button, section);
      assert.ok(button.classList.contains('prop-expr-toggle'), 'the prop field’s own control');
      assert.equal(button.getAttribute('aria-pressed'), 'false');
    }
    assert.deepEqual(state.applied, []);
  }
});

test('UI to code shows the expression, and switching back and forth writes nothing', async (context) => {
  const data = 'features.filter((item) => item.number > 1).toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0)).slice(0, 3)';
  const { host, state } = await panel(context, listModel(data));
  const expected = { filter: '(item) => item.number > 1', sort: '(a, b) => (a.number ?? 0) - (b.number ?? 0)', limit: '3' };
  for (const section of ['filter', 'sort', 'limit']) {
    await press(toggle(host, section));
    assert.equal(toggle(host, section).getAttribute('aria-pressed'), 'true', section);
    assert.ok(toggle(host, section).classList.contains('on'), 'the active purple state');
    assert.equal(codeOf(host, section), expected[section]);
    await press(toggle(host, section));
    assert.equal(toggle(host, section).getAttribute('aria-pressed'), 'false', section);
    assert.ok(sectionOf(host, section).querySelector('.cm-content') === null, 'back to its controls');
  }
  assert.deepEqual(state.applied, []);
  assert.equal(state.head, headOf(data));
});

test('representable code typed in code view shows as controls on the way back', async (context) => {
  const { host, state } = await panel(context, listModel('features'));
  await press(toggle(host, 'filter'));
  await type(host, 'filter', '(item) => item.number > 2');
  await leave(host, 'filter');
  assert.equal(state.head, headOf('features.filter((item) => item.number > 2)'));
  await press(toggle(host, 'filter'));
  assert.equal(toggle(host, 'filter').getAttribute('aria-pressed'), 'false');
  assert.equal(noteOf(host, 'filter'), undefined);
  assert.match(sectionOf(host, 'filter').querySelector('.loop-settings-list').textContent, /Number/);
});

test('unrepresentable code opens as code, stays with the note, and keeps its text', async (context) => {
  const { host, state } = await panel(context, listModel('features.filter(isLive).slice(0, 3)'));
  assert.equal(host.textContent.includes('Custom code shapes this list'), false, 'no whole-list notice');
  assert.equal(toggle(host, 'filter').getAttribute('aria-pressed'), 'true', 'opened on its own');
  assert.equal(codeOf(host, 'filter'), 'isLive');
  assert.equal(toggle(host, 'limit').getAttribute('aria-pressed'), 'false', 'the sections around it stay controls');
  await press(toggle(host, 'filter'));
  assert.equal(toggle(host, 'filter').getAttribute('aria-pressed'), 'true');
  assert.match(noteOf(host, 'filter'), /cannot show this code, so it stays as code/);
  assert.equal(codeOf(host, 'filter'), 'isLive');
  assert.deepEqual(state.applied, []);
});

test('the controls around a custom section write only their own section', async (context) => {
  const { host, state } = await panel(context, listModel('features.filter( isLive ).slice(0, 3)'));
  await press(sectionOf(host, 'limit').querySelector('[role="switch"]'));
  assert.equal(state.head, headOf('features.filter( isLive )'), 'the custom filter is untouched');
  assert.deepEqual(
    state.applied.map((target) => target.kind),
    ['section'],
  );
  const add = sectionOf(host, 'sort').querySelector('.loop-settings-add');
  await press(add);
  assert.equal(state.head, headOf("features.filter( isLive ).toSorted((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))"));
});

test('invalid code writes nothing, shows why, and keeps the text', async (context) => {
  const data = 'features.filter((item) => item.on)';
  const { host, state } = await panel(context, listModel(data));
  await press(toggle(host, 'filter'));
  await type(host, 'filter', '(item) => item.number >');
  await leave(host, 'filter');
  assert.equal(noteOf(host, 'filter'), 'This is not one JavaScript expression.');
  assert.equal(codeOf(host, 'filter'), '(item) => item.number >');
  assert.deepEqual(state.applied, []);
  assert.equal(state.head, headOf(data));
  await press(toggle(host, 'filter'));
  assert.equal(toggle(host, 'filter').getAttribute('aria-pressed'), 'true', 'the switch back waits for code that is valid');
  assert.equal(codeOf(host, 'filter'), '(item) => item.number >');
  assert.deepEqual(state.applied, []);
});

test('a refused write stays in the box with its reason', async (context) => {
  const start = astroModel("const posts = await getCollection('posts', isLive);");
  const { host, state } = await panel(context, start);
  assert.equal(codeOf(host, 'filter'), 'isLive');
  await type(host, 'filter', '.filter(a).filter(b)');
  await leave(host, 'filter');
  assert.match(noteOf(host, 'filter'), /takes one function/);
  assert.equal(codeOf(host, 'filter'), '.filter(a).filter(b)');
  assert.equal(state.frontmatter, start.frontmatter);
});

test('a collection’s code view edits its declaration and leaves the rest', async (context) => {
  const start = astroModel("const posts = (await getCollection('posts')).filter(isLive).slice(0, 3);");
  const { host, state } = await panel(context, start);
  assert.equal(codeOf(host, 'filter'), 'isLive');
  await press(toggle(host, 'limit'));
  assert.equal(codeOf(host, 'limit'), '3');
  await type(host, 'limit', 'count');
  await leave(host, 'limit');
  assert.equal(state.frontmatter, collection("const posts = (await getCollection('posts')).filter(isLive).slice(0, count);"));
  assert.equal(state.head, start.head);
  assert.equal(toggle(host, 'limit').getAttribute('aria-pressed'), 'true');
});

test('a list that cannot be split keeps the notice and has no toggles', async (context) => {
  const { host } = await panel(context, listModel('features.filter(isLive).flatMap((item) => item.parts)'));
  assert.ok(host.textContent.includes('Custom code shapes this list'));
  assert.ok(toggle(host, 'filter') === null);
});

test('a filter or sort row’s custom code is the highlighted editor, and ⌘↵ commits it', async (context) => {
  const { host, state } = await panel(context, listModel('features.filter((item) => item.title.startsWith("P"))'));
  await press(host.querySelector('.loop-settings-item-main'));
  const box = document.querySelector('.loop-settings-code');
  assert.equal(box.getAttribute('aria-label'), 'Filter code');
  assert.ok(box.querySelector('textarea') === null, 'no plain box');
  const content = box.querySelector('.cm-content');
  const view = modules.EditorView.findFromDOM(content);
  assert.equal(view.state.doc.toString(), 'item.title.startsWith("P")');
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'item.title >' } }));
  const enter = () => new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
  await act(async () => content.dispatchEvent(enter()));
  assert.equal(document.querySelector('.loop-settings-code-problem').textContent, 'This is not one JavaScript expression.');
  assert.equal(view.state.doc.toString(), 'item.title >', 'the key is not the editor’s blank line, and the text stays');
  assert.deepEqual(state.applied, []);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'item.title.endsWith("P")' } }));
  await act(async () => content.dispatchEvent(enter()));
  assert.equal(state.applied.length, 1);
  assert.equal(state.head, headOf('features.filter((item) => item.title.endsWith("P"))'));
});

test('the code view offers no `--` variables: its text is not CSS', () => {
  const source = fs.readFileSync(repoPath('src/features/props/LoopSectionCode.tsx'), 'utf8');
  assert.match(source, /from '\.\.\/\.\.\/ui\/ExprInput'/, 'the editor a prop’s code view uses');
  assert.doesNotMatch(source, /import[^\n]*(CssCodeEditor|useCodeVariables|codeVariableExtension)/);
  const editor = fs.readFileSync(repoPath('src/ui/ExprInput.tsx'), 'utf8');
  assert.doesNotMatch(editor, /codeVariableExtension|useCodeVariables/, 'ExprInput has no variable chooser to offer');
});

test('a heading’s `{}` stands as far from its label as a prop field’s does', () => {
  const css = fs.readFileSync(repoPath('src/features/props/loopSettings.css'), 'utf8');
  const shared = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const margin = shared.match(/\.prop-expr-toggle \{[^}]*margin-left: (\d+px)/)?.[1];
  const gap = css.match(/\.loop-settings-label \{[^}]*gap: (\d+px)/)?.[1];
  assert.equal(gap, margin, 'the label’s gap stands in for the toggle’s margin');
  assert.match(css, /\.loop-settings-label > \.prop-expr-toggle \{\s*margin-left: 0;/, 'so the two are not added together');
});

test('the item rows of Select items stand a token apart, with no margin against their fills', () => {
  const css = fs.readFileSync(repoPath('src/features/props/loopSettings.css'), 'utf8');
  const list = css.match(/\.loop-settings-picker-list \{[^}]*\}/)?.[0];
  assert.match(list, /gap: var\(--space-1\)/);
  const row = css.match(/\.loop-settings-picker-row \{[^}]*\}/)?.[0];
  assert.doesNotMatch(row, /margin|border(?!-radius)/);
});
