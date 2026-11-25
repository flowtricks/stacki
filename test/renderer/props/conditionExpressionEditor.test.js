// Goal: the Condition section of a template if / else if shows every test as
// the visual conditions editor the Value conditions dialog uses: props by their
// labels with their type icons, values the frontmatter computes under Computed
// in code (with the plainer prop condition offered), and each part the rows
// cannot draw as a locked Computed row with its code. It writes plain
// JavaScript into the test text only (one write per edit, never on opening or
// hovering), keeps locked parts byte for byte, and shows code it cannot
// delimit as highlighted code with no sentence about it. The `{}` goes to the
// code and back while the code is drawable (otherwise it is disabled). The same
// `{}` sits on the Value conditions dialog and the class list pop-up. Otherwise
// is one switch, Nothing or Else branch. An undo is followed by the controls.
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
      "export { EditorView } from '@codemirror/view';",
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

test('a part the rows cannot draw is a locked Computed row; only code that cannot be delimited opens as code, with no sentence', async () => {
  for (const code of ['items.map(x => x.on).includes(true)', 'a ? b : c', 'format(title)']) {
    const { root, writes } = await mount(code);
    assert.equal(rows().length, 1, `${code} is one row`);
    assert.equal(rows()[0].querySelector('.conditional-chip-computed').textContent, 'Computed', `${code} is locked as Computed`);
    assert.equal(rows()[0].querySelector('.conditional-code-condition').title, code, 'its code is the tooltip');
    assert.equal(toggle().getAttribute('aria-disabled'), 'false', 'the {} goes to the code and back');
    assert.deepEqual(writes, [], 'opening writes nothing');
    await act(async () => root.unmount());
  }
  const { root, writes } = await mount('/^a/.test(title)');
  assert.equal(rows().length, 0, 'a regular expression shows no controls');
  assert.ok(document.querySelector('.props-cond-field .cm-editor'), 'it is in the code editor');
  assert.equal(document.querySelector('.condition-code-note') ?? undefined, undefined, 'no sentence explains it');
  assert.ok(!document.body.textContent.includes('Too complex'), 'no "too complex" message');
  assert.equal(toggle().getAttribute('aria-disabled'), 'true', 'the way back is disabled');
  await click(toggle());
  assert.equal(rows().length, 0, 'pressing the disabled toggle does nothing');
  assert.deepEqual(writes, [], 'nothing is rewritten');
  await act(async () => root.unmount());
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
  // Code that cannot be delimited cannot go back to controls.
  await draw('open && /a/.test(title)');
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
  assert.equal(document.querySelectorAll('.condition-otherwise-note, .condition-otherwise > p').length, 0);
  assert.equal(document.querySelector('.condition-otherwise .prop-label').textContent, 'Otherwise');
  const row = rows()[0];
  assert.ok(row.querySelector('[aria-label="Operator"]'), 'the operator is in the row');
  const remove = row.querySelector('[aria-label="Remove condition"]');
  assert.ok(remove, 'and so is the remove');
  assert.equal(remove.closest('.conditional-condition'), row, "the remove shares the operator's row");
  assert.ok(row.querySelector('.dd-chevron'), 'the name is drawn as the dialog draws its names');
  // Otherwise is one switch: Nothing, or an Else branch; the node has one, so Else branch is on.
  const choices = [...document.querySelectorAll('.condition-otherwise .u-segmented-button')];
  assert.deepEqual(
    choices.map((choice) => choice.textContent),
    ['Nothing', 'Else branch'],
  );
  assert.equal(choices[1].getAttribute('aria-checked'), 'true');
  await click(choices[1]);
  assert.deepEqual(toggles, [], 'the state it is in changes nothing');
  await click(choices[0]);
  assert.deepEqual(toggles, [false]);
  await act(async () => root.unmount());
});

// A component shaped like Lumos Button: a choice prop, a switch, and the values its frontmatter computes from them.
const BUTTON_FRONTMATTER = [
  'interface Props { variant?: "main" | "link" | "play" | "close"; render?: boolean; count?: number }',
  'const { variant = "main", render = true, count } = Astro.props;',
  'const isWritten = variant === "main" || variant === "link";',
  'const content = isWritten ? await slotContent(Astro.slots) : "";',
].join('\n');
const BUTTON_CONTEXT = {
  frontmatter: BUTTON_FRONTMATTER,
  propsSchema: [
    { name: 'variant', type: 'enum', options: ['main', 'link', 'play', 'close'] },
    { name: 'render', type: 'boolean' },
    { name: 'count', type: 'number' },
  ],
  origin: { file: 'src/components/Button.astro', page: undefined },
};
const subjectOf = (row) => row.querySelector('[aria-label="Property"]').textContent.trim();

test('Button: render && (isWritten ? content : true) is Render is true and a locked Computed part; an edit keeps the part byte for byte', async () => {
  const source = 'render && (isWritten ? content : true)';
  const { root, writes } = await mount(source, { bindContext: BUTTON_CONTEXT });
  assert.equal(rows().length, 2);
  assert.equal(subjectOf(rows()[0]), 'Render', 'the prop by its label');
  assert.equal(operatorOf(rows()[0]), 'is true');
  assert.equal(rows()[1].querySelector('.conditional-chip-computed').textContent, 'Computed');
  assert.equal(rows()[1].querySelector('.conditional-code-condition-code').textContent, 'isWritten ? content : true', 'its code, highlighted');
  assert.equal(rows()[1].querySelector('[aria-label="Operator"]') ?? undefined, undefined, 'a locked part has no operator');
  assert.ok(!document.body.textContent.includes('Too complex'), 'never the too-complex message');
  assert.deepEqual(writes, [], 'opening writes nothing');
  await choose(rows()[0].querySelector('[aria-label="Operator"]'), 'is false');
  assert.deepEqual(writes, ['!render && (isWritten ? content : true)'], 'only the edited condition changes');
  await act(async () => root.unmount());
});

test('a computed value is listed under Computed in code with its definition, and its row offers the plainer prop condition', async () => {
  const { root, writes } = await mount('isWritten && count > 1', { bindContext: BUTTON_CONTEXT });
  assert.equal(subjectOf(rows()[0]), 'Is Written');
  await click(rows()[0].querySelector('[aria-label="Property"]'));
  const groups = [...document.querySelectorAll('.dd-group-label')].map((label) => label.textContent);
  assert.ok(groups.includes('Computed in code'), `the computed values have their heading: ${groups.join(', ')}`);
  const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === 'Is Written');
  assert.match(option.title, /Is Written is computed in code: Variant is any of Main, Link/);
  assert.match(option.title, /variant === "main" \|\| variant === "link"/, 'and its code');
  await click(rows()[0].querySelector('[aria-label="Property"]'));
  const offer = document.querySelector('.conditional-plainer');
  assert.equal(offer.querySelector('.conditional-plainer-words').textContent, 'Same as: Variant is any of Main, Link');
  assert.deepEqual(writes, [], 'the offer writes nothing until Switch');
  await click(offer.querySelector('.conditional-plainer-switch'));
  assert.deepEqual(writes, ['["main", "link"].includes(variant) && count > 1']);
  assert.equal(operatorOf(rows()[0]), 'is any', 'the row is now the prop with its values');
  assert.deepEqual(
    [...rows()[0].querySelectorAll('.multi-select-chip')].map((chip) => chip.firstChild.textContent),
    ['Main', 'Link'],
    'its values are chips, worded as the choices are',
  );
  await act(async () => root.unmount());
});

test('|| and ! read as one any group: Render is false, or Count is greater than 3', async () => {
  const { root, writes } = await mount('!render || count > 3', { bindContext: BUTTON_CONTEXT });
  assert.equal(document.querySelectorAll('.conditional-group').length, 1);
  assert.equal(document.querySelector('.conditional-match').textContent.trim(), 'any');
  assert.deepEqual(rows().map(subjectOf), ['Render', 'Count']);
  assert.deepEqual(rows().map(operatorOf), ['is false', 'is greater than']);
  assert.equal(rows()[1].querySelector('.conditional-value-input').value, '3');
  assert.deepEqual(writes, []);
  await act(async () => root.unmount());
});

test('a name the props do not list (a loop item, optional chaining) is kept as written in the menu', async () => {
  const { root, writes } = await mount('image?.url && variant !== "play"', { bindContext: BUTTON_CONTEXT });
  assert.deepEqual(rows().map(subjectOf), ['image?.url', 'Variant']);
  assert.deepEqual(rows().map(operatorOf), ['is true', 'does not equal']);
  await click(rows()[0].querySelector('[aria-label="Property"]'));
  const labels = [...document.querySelectorAll('.dd-option .dd-option-label')].map((label) => label.textContent);
  assert.ok(labels.includes('Choose data'), 'any other data is a pick away');
  await click(rows()[0].querySelector('[aria-label="Property"]'));
  assert.deepEqual(writes, []);
  await act(async () => root.unmount());
});

test('a Computed part is edited as code: Enter writes only that part, a part the rows can draw becomes rows, invalid code is never written, Escape cancels', async () => {
  const source = 'render && (isWritten ? content : true)';
  const { root, writes } = await mount(source, { bindContext: BUTTON_CONTEXT });
  const part = () => rows()[1].querySelector('.conditional-code-condition');
  const editor = () => part().querySelector('.cm-content');
  const typeCode = async (text) => {
    const view = modules.EditorView.findFromDOM(part().querySelector('.cm-editor')) ?? undefined;
    assert.ok(view !== undefined, 'the code editor is open');
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
  };
  const press = (key) => act(async () => editor().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

  await click(part());
  assert.ok(part().classList.contains('is-editing'), 'a click opens the part in the code editor');
  await typeCode('isWritten ? content :');
  await press('Enter');
  assert.ok(part().classList.contains('is-editing'), 'code that does not parse stays open');
  assert.ok(part().querySelector('.expr-input.invalid'), 'and is marked');
  assert.deepEqual(writes, [], 'and is never written');
  await press('Escape');
  assert.ok(!part().classList.contains('is-editing'), 'Escape puts the part back');
  assert.deepEqual(writes, []);

  await click(part());
  await typeCode('isWritten ? content : label');
  await press('Enter');
  assert.deepEqual(writes, ['render && (isWritten ? content : label)'], 'only that part changes');
  await click(part());
  await typeCode('variant === "main"');
  await press('Enter');
  assert.equal(writes[writes.length - 1], 'render && variant === "main"');
  assert.deepEqual(rows().map(subjectOf), ['Render', 'Variant'], 'a part the rows can draw becomes a row');
  await act(async () => root.unmount());
});
