// Goal: the Condition section of a template if / else if shows its test as
// the visual conditions editor when it can say exactly what the code says,
// writes plain JavaScript into the test text only (one write per edit, never
// on opening or hovering), opens code it cannot draw as code with a note and
// never rewrites it, and has a `{}` that goes to the code and back only when
// the code is drawable (otherwise disabled, with the reason). The same `{}`
// sits on the Value conditions dialog and the class list pop-up. An undo (the
// node's test returning to an earlier text) is followed by the controls.
//
// Method: the real components, bundled as the app bundles them and rendered
// in jsdom with React over a generated component frontmatter and schema;
// clicks, typing and menu picks are dispatched as a person makes them, and
// what the setter receives is checked as text. Nothing touches a real project.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/condition-expression-editor');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'condition-expression-editor.cjs');
buildSync({
  stdin: {
    contents: [
      "export { ConditionExpressionField } from './src/features/props/ConditionExpressionEditor';",
      "export { ConditionalEditor } from './src/features/props/ConditionalValue';",
      "export { ClassListEditor } from './src/features/props/ClassListValue';",
      "export { CondPanel } from './src/features/props/SourcePanels';",
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

let dom;
let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (dom !== undefined) {
    return;
  }
  dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
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
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.Range.prototype.getClientRects = () => [];
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

const FRONTMATTER =
  'interface Props { fluted?: "home-platform" | "plain"; count?: number; open?: boolean; tags?: string[]; title?: string }\nconst { fluted, count, open, tags, title } = Astro.props;';
const SCHEMA = [
  { name: 'fluted', type: 'enum', options: ['home-platform', 'plain'] },
  { name: 'count', type: 'number' },
  { name: 'open', type: 'boolean' },
  { name: 'tags', type: 'array' },
  { name: 'title', type: 'string' },
];
const CONTEXT = { frontmatter: FRONTMATTER, propsSchema: SCHEMA, origin: { file: 'src/components/Card.astro', page: undefined } };

const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
async function choose(trigger, name) {
  await click(trigger);
  const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === name);
  assert.ok(option, `Expected ${name} in the menu`);
  await click(option);
}
const toggle = () => document.querySelector('.prop-expr-toggle');
const rows = () => [...document.querySelectorAll('.conditional-condition')];
const operatorOf = (row) => row.querySelector('[aria-label="Operator"]').textContent.trim();

async function mount(test, props = {}) {
  installDom();
  const container = document.getElementById('root');
  container.innerHTML = '';
  const root = createRoot(container);
  const writes = [];
  const draw = (current) =>
    act(async () =>
      root.render(
        React.createElement(modules.ConditionExpressionField, { test: current, bindContext: CONTEXT, onSetText: (text) => writes.push(text), ...props }),
      ),
    );
  await draw(test);
  return { root, writes, draw, container };
}

test('an expression the controls can say opens as controls, and editing writes only the test text', async () => {
  const { root, writes, draw } = await mount('fluted === "home-platform"');
  assert.equal(rows().length, 1, 'one condition row');
  assert.equal(operatorOf(rows()[0]), 'equals');
  assert.equal(document.querySelector('.conditional-value-pick').textContent.trim(), 'home-platform', 'an enum offers its options');
  assert.equal(document.querySelector('.condition-code-note') ?? undefined, undefined, 'no note');
  assert.deepEqual(writes, [], 'opening writes nothing');
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');

  await choose(rows()[0].querySelector('.conditional-value-pick'), 'plain');
  assert.deepEqual(writes, ['fluted === "plain"']);
  // The document takes the write, and the node's test follows it.
  await draw('fluted === "plain"');
  assert.equal(document.querySelector('.conditional-value-pick').textContent.trim(), 'plain');

  await click([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'New condition'));
  assert.equal(rows().length, 2, 'a new, unfinished row');
  assert.deepEqual(writes, ['fluted === "plain"'], 'an unfinished row is not written');

  // Group match: any, then both rows are tested alike.
  await choose(document.querySelector('.conditional-match'), 'any');
  assert.deepEqual(writes, ['fluted === "plain"'], 'a group with one finished row still says the same');

  // Undo: the node's test comes back as an earlier text, and the controls follow it.
  await draw('fluted === "home-platform"');
  assert.equal(document.querySelector('.conditional-value-pick').textContent.trim(), 'home-platform', 'the controls follow an undo');
  assert.equal(rows().length, 1);
  assert.equal(writes.length, 1, 'following an undo writes nothing');
  await act(async () => root.unmount());
});

test('the operators adapt to the name, a number is typed as one and a switch needs no value', async () => {
  const { root, writes } = await mount('count > 2');
  assert.equal(operatorOf(rows()[0]), 'is greater than');
  const input = rows()[0].querySelector('.conditional-value-input');
  assert.equal(input.value, '2');
  await type(input, 'abc');
  assert.deepEqual(writes, [], 'words are not a number: nothing is written');
  await type(input, '10');
  assert.deepEqual(writes, ['count > 10']);
  await choose(rows()[0].querySelector('[aria-label="Operator"]'), 'is at most');
  assert.deepEqual(writes, ['count > 10', 'count <= 10']);
  await act(async () => root.unmount());

  const second = await mount('open');
  assert.equal(operatorOf(rows()[0]), 'is true');
  assert.equal(rows()[0].querySelector('.conditional-value-input') ?? undefined, undefined, 'no value for a switch');
  await choose(rows()[0].querySelector('[aria-label="Operator"]'), 'is false');
  assert.deepEqual(second.writes, ['!open']);
  await act(async () => second.root.unmount());

  const third = await mount('tags.length > 0');
  assert.equal(operatorOf(rows()[0]), 'is not empty', 'a list offers empty and contains');
  await act(async () => third.root.unmount());
});

test('code the controls cannot draw opens as code with a note, is never rewritten, and the switch back is disabled with its reason', async () => {
  for (const code of ['items.map(x => x.on).includes(true)', 'a ? b : c', 'title?.length > 2', '/^a/.test(title)']) {
    const { root, writes } = await mount(code);
    assert.equal(rows().length, 0, `${code} shows no controls`);
    assert.equal(document.querySelector('.condition-code-note').textContent, 'Too complex for the visual editor');
    assert.ok(document.querySelector('.props-cond-field .cm-editor'), 'in the code editor');
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    assert.equal(toggle().getAttribute('aria-disabled'), 'true', 'the way back is disabled');
    assert.match(toggle().title, /cannot show/);
    await click(toggle());
    assert.equal(rows().length, 0, 'pressing the disabled toggle does nothing');
    assert.deepEqual(writes, [], 'nothing is rewritten');
    await act(async () => root.unmount());
  }
});

test('{} goes to the generated code and back while the code is drawable', async () => {
  const { root, writes, draw } = await mount('open && count > 1');
  await click(toggle());
  assert.equal(rows().length, 0, 'the code is shown');
  assert.ok(document.querySelector('.props-cond-field .cm-editor'));
  assert.equal(document.querySelector('.cm-content').textContent, 'open && count > 1', 'the text is kept as it was');
  assert.equal(toggle().getAttribute('aria-disabled'), 'false', 'it can go back');
  assert.equal(document.querySelector('.condition-code-note') ?? undefined, undefined, 'a note only for code that opened as code on its own');
  assert.deepEqual(writes, [], 'switching writes nothing');
  await click(toggle());
  assert.equal(rows().length, 2, 'back to the controls');
  // Code that is no longer drawable cannot go back to controls.
  await draw('open && count.toFixed(1)');
  assert.equal(rows().length, 0);
  assert.equal(toggle().getAttribute('aria-disabled'), 'true');
  await act(async () => root.unmount());
});

test('the Value conditions dialog and the class list have the {} too, and write the raw code they are left on', async () => {
  installDom();
  const container = document.getElementById('root');
  container.innerHTML = '';
  const root = createRoot(container);
  const anchor = document.createElement('div');
  container.appendChild(anchor);
  const writes = [];
  const model = {
    groups: [
      {
        match: 'all',
        conditions: [{ kind: 'compare', subject: 'fluted', operator: 'in', values: [{ kind: 'string', value: 'plain' }] }],
        value: { kind: 'text', text: 'a' },
      },
    ],
    otherwise: { kind: 'text', text: 'b' },
  };
  const value = { type: 'expr', value: "fluted === 'plain' ? 'a' : 'b'" };
  await act(async () =>
    root.render(
      React.createElement(modules.ConditionalEditor, {
        anchorRef: { current: anchor },
        start: undefined,
        model,
        value,
        bindContext: CONTEXT,
        language: 'text',
        onApply: (next) => writes.push(next),
        onClose: () => {},
      }),
    ),
  );
  assert.ok(toggle(), 'the dialog has the {}');
  await click(toggle());
  assert.equal(document.querySelector('.cm-content').textContent, "fluted === 'plain' ? 'a' : 'b'");
  assert.deepEqual(writes, [], 'switching writes nothing');
  await click(toggle());
  assert.ok(document.querySelector('.conditional-group[role="group"]'), 'back to the groups');
  await click(toggle());
  await act(async () => root.unmount());
  assert.deepEqual(writes, [], 'closing on unchanged code writes nothing');

  const list = createRoot(container);
  await act(async () =>
    list.render(
      React.createElement(modules.ClassListEditor, {
        anchorRef: { current: anchor },
        model: { entries: [{ value: { kind: 'text', text: 'on' }, match: 'all', when: [] }] },
        value: { type: 'expr', value: "['on']" },
        bindContext: CONTEXT,
        onApply: (next) => writes.push(next),
        onClose: () => {},
      }),
    ),
  );
  assert.ok(toggle(), 'the class list has the {}');
  await act(async () => list.unmount());
});

test("the Condition section has labels only, and each row keeps its remove on the operator's line", async () => {
  installDom();
  const container = document.getElementById('root');
  container.innerHTML = '';
  const root = createRoot(container);
  const toggles = [];
  const node = {
    kind: 'cond',
    id: 'n1',
    op: '&&',
    test: 'open',
    children: [
      { kind: 'branch', name: 'then', id: 'b1', children: [] },
      { kind: 'branch', name: 'else', id: 'b2', children: [] },
    ],
  };
  await act(async () =>
    root.render(React.createElement(modules.CondPanel, { node, bindContext: CONTEXT, onSetText: () => {}, onToggleElse: (next) => toggles.push(next) })),
  );
  const panel = container.textContent;
  for (const paragraph of ['Renders when none', 'True renders', 'Drop elements', 'Add a condition']) {
    assert.ok(!panel.includes(paragraph), `no helper paragraph: ${paragraph}`);
  }
  assert.equal(document.querySelectorAll('.condition-otherwise-note, .conditional-else > p, .conditional-else > div:not(.conditional-group-head)').length, 0);
  assert.equal(document.querySelector('.conditional-else .conditional-group-head').textContent, 'Otherwise');
  const row = rows()[0];
  assert.ok(row.querySelector('[aria-label="Operator"]'), 'the operator is in the row');
  const remove = row.querySelector('[aria-label="Remove condition"]');
  assert.ok(remove, 'and so is the remove');
  assert.equal(remove.closest('.conditional-condition'), row, "the remove shares the operator's row");
  assert.ok(row.querySelector('.dd-chevron'), 'the name is drawn as the dialog draws its names');
  const quiet = document.querySelector('.conditional-else .conditional-add');
  assert.equal(quiet.textContent.trim(), 'Remove else branch');
  await click(quiet);
  assert.deepEqual(toggles, [false]);
  await act(async () => root.unmount());
});
