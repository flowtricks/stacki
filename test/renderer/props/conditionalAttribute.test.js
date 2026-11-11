// Goal: in a component, an attribute's value can be made conditional on the
// component's props through the bind dot's "Create conditional", edited as
// groups of conditions tried in order (reordered by drag or Alt+arrows),
// written as one undo step of plain Astro in the file's own quotes, and shown
// afterwards as a full-width Conditional chip with a summary that reopens the
// editor; a style set only when a prop is reads as one, highlighted as
// declarations; a `class:list` reads as its classes, each given always or
// only when; code the editors cannot draw stays code. A spread attribute is a
// row of its own, opened, renamed and removed as one undo step and never moved
// by an edit beside it. Going back from code to a plain value converts what
// it can and clears what it cannot, with a notice. Pop-ups opened from the
// attribute editor stack above it.
//
// Method: the real Attributes section and prop field, bundled as the app
// bundles them and rendered in jsdom with React, over components read by
// main's real page parser in the windowless harness. Clicks, typing, pointer
// drags and keys are dispatched as a person makes them. What the section
// writes goes through the gestures the app sends (a prop edit for a value, a
// node rewrite for a spread) and sendGesture to main; the file is then checked
// as text, and the step's inverses are sent as undo sends them, after which
// the file must be back byte for byte. Layout rules jsdom cannot measure are
// read from the stylesheets.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { toastNotices } = require('../../helpers/toastCapture');

const directory = repoPath('node_modules/.stacki-test/conditional-attribute');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'conditional-attribute.cjs');
buildSync({
  stdin: {
    contents: [
      "export { AttributesSection } from './src/features/props/propAttributes';",
      "export { default as PropField } from './src/features/props/PropField';",
      "export { nodeGesture, propsGesture } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { withAttributes } from './src/editor/attributesBinding';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The DOM is installed after main's harness has read the file: the Astro
// compiler main loads takes a global `document` as a browser and fails.
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
  // CodeMirror measures text ranges, which jsdom has no layout for.
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.Range.prototype.getClientRects = () => [];
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');

const COMPONENT = `---
interface Props {
  theme?: "dark" | "light";
  paddingTop?: "small" | "large";
  title?: string;
}
const { theme = "dark", paddingTop = "small", title = "Hello" } = Astro.props;
---
<a class="button" data-label="Click me">{title}</a>
`;

const SCHEMA = [
  { name: 'theme', type: 'enum', options: ['dark', 'light'] },
  { name: 'paddingTop', type: 'enum', options: ['small', 'large'] },
  { name: 'title', type: 'string' },
];

async function project(context, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-conditional-'));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, source);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  return { harness, file, read };
}

const elementOf = (nodes, tag) => nodes.find((node) => node.kind === 'element' && node.name === tag);
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const pressEscape = () => act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
// Escape as a person presses it to leave: once for each values menu still open
// (the top pop-up takes it first), then once for the editor.
const escape = async () => {
  for (let round = 0; round < 4 && document.querySelector('.multi-select-menu') !== null; round += 1) {
    await pressEscape();
  }
  await pressEscape();
};
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
// The chips field is a contenteditable: typing is its text and an input event.
const typeBox = (box, text) =>
  act(async () => {
    box.textContent = text;
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const byText = (text) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text) ??
  [...document.querySelectorAll('div, span')].find((element) => element.textContent.trim() === text);
const editor = () => document.querySelector('.conditional-editor');
// A value picked from a values field's menu, opened by its chevron, as a person picks one.
async function pickValue(field, name) {
  if (field.getAttribute('aria-expanded') !== 'true') {
    await click(field.querySelector('.multi-select-chevron'));
  }
  // The field's own menu, by the id it names.
  const menu = document.getElementById(field.getAttribute('aria-controls'));
  assert.ok(menu, 'the values menu is open');
  const option = [...menu.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === name);
  assert.ok(option, `Expected ${name} in the values menu`);
  await click(option);
}
async function choose(trigger, name) {
  await click(trigger);
  const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === name);
  assert.ok(option, `Expected ${name} in the menu`);
  await click(option);
}

const HOST = {
  componentName: 'Card.astro',
  propKeys: ['theme', 'paddingTop', 'title'],
  restLocal: undefined,
  create: () => ({ ok: false, error: 'not here' }),
};

async function renderSection(container, root, node, props) {
  const context = {
    frontmatter: props.frontmatter,
    propsSchema: SCHEMA,
    origin: { file: 'src/components/Card.astro', page: undefined },
    ...(props.host === undefined ? {} : { newProp: props.host }),
  };
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node,
        names: props.names,
        bindContext: context,
        tag: node.name,
        onSetProp: props.onSetProp ?? (() => {}),
        onRenameProp() {},
        ...(props.onReplaceAttributes === undefined ? {} : { onReplaceAttributes: props.onReplaceAttributes }),
      }),
    ),
  );
}

async function undo(harness, file, record) {
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  for (const step of [...record.outcome.applied].reverse()) {
    if (step.inverse.length > 0) {
      const answer = await send({ pagePath: file, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
      assert.ok(answer.ok, 'main reverted the write');
    }
  }
}

async function sent(harness, file, read, gesture) {
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const origin = { checksum: read.checksum, source: read.source, model: read.model };
  const outcome = await modules.sendGesture({ path: file, origin, gesture, record, send });
  assert.equal(outcome.tag, 'applied');
  return record;
}

test('Create conditional: the editor builds the conditions, closing writes them once, and one undo takes them back', async (context) => {
  const { harness, file, read } = await project(context, COMPONENT);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await renderSection(container, root, anchor, {
    frontmatter: read.model.extraFrontmatter,
    host: HOST,
    names: ['data-label'],
    onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
  });
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-value-field .bind-handle'));
  const menuRows = [...document.querySelectorAll('.bind-menu .dp-new-prop')].map((row) => row.textContent.trim());
  assert.deepEqual(menuRows, ['New Plain Text property', 'Create conditional'], 'the new item sits under the new property');

  await click(byText('Create conditional'));
  assert.ok(editor(), 'the Value conditions editor opens');
  assert.equal(document.querySelector('.bind-menu') ?? undefined, undefined, 'and the menu closes');
  assert.equal(editor().querySelectorAll('.conditional-group[role="group"]').length, 1, 'it starts with one group');
  assert.equal(editor().querySelector('[aria-label="Property"]').textContent.trim(), 'Theme', 'on the first prop');
  assert.equal(editor().querySelector('[aria-label="Operator"]').textContent.trim(), 'is any');
  assert.equal(editor().querySelector('[aria-label="Else value"] .bind-input').textContent, 'Click me', 'the Else is what the field held');

  await pickValue(editor().querySelector('[aria-label="Values"]'), 'Dark');
  assert.deepEqual(
    [...editor().querySelectorAll('.multi-select-chip')].map((chip) => chip.textContent.trim()),
    ['Dark'],
  );
  await typeBox(editor().querySelector('[aria-label="Value"] .bind-input'), 'night');

  // A second condition, made and taken away again.
  await click(byText('New condition'));
  assert.equal(editor().querySelectorAll('.conditional-condition').length, 2);
  await choose(editor().querySelectorAll('[aria-label="Property"]')[1], 'Padding Top');
  await pickValue(editor().querySelectorAll('[aria-label="Values"]')[1], 'Small');
  await click(editor().querySelectorAll('[aria-label="Remove condition"]')[1]);
  assert.equal(editor().querySelectorAll('.conditional-condition').length, 1, 'removing a condition leaves the other');

  // A second group, joined by "or", made and taken away again.
  await click(byText('New group'));
  assert.equal(editor().querySelectorAll('.conditional-group[role="group"]').length, 2);
  assert.equal(editor().querySelector('.conditional-or').textContent, 'or');
  await click(editor().querySelectorAll('[aria-label="Remove group"]')[1]);
  assert.equal(editor().querySelectorAll('.conditional-group[role="group"]').length, 1);
  assert.deepEqual(writes, [], 'nothing is written while the editor is open');

  await escape();
  assert.equal(editor() ?? undefined, undefined, 'Escape closes the editor');
  // Written in the quote the file already uses (its frontmatter's double quotes).
  const code = 'theme === "dark" ? "night" : "Click me"';
  assert.deepEqual(writes, [{ name: 'data-label', value: { type: 'expr', value: code }, immediate: true }], 'one write, at once: one undo step');

  // Written as the app writes it, then undone as undo sends it.
  const record = await sent(harness, file, read, modules.propsGesture(anchor.id, { 'data-label': writes[0].value }, { coalesceKey: undefined, urgency: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), COMPONENT.replace('data-label="Click me"', `data-label={${code}}`), 'plain Astro; nothing else moved');
  const reread = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.deepEqual(elementOf(reread.model.nodes, 'a').props['data-label'], { type: 'expr', value: code }, 'and it parses back');
  await undo(harness, file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), COMPONENT, 'one undo takes it back, byte for byte');
  await act(async () => root.unmount());
});

test('a conditional value shows as its chip and summary, and either reopens the editor on it', async (context) => {
  const code = "theme === 'dark' && paddingTop !== 'small' ? 'value1' : theme === 'light' ? title : 'value3'";
  const source = COMPONENT.replace('data-label="Click me"', `data-label={${code}}`);
  const { read } = await project(context, source);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await renderSection(container, root, anchor, {
    frontmatter: read.model.extraFrontmatter,
    host: HOST,
    names: ['data-label'],
    onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
  });
  assert.equal(container.querySelector('.attr-row .conditional-badge').textContent.trim(), 'Conditional', 'the row previews it as a chip');
  await click(container.querySelector('.attr-row'));
  assert.equal(document.querySelector('.attr-editor .conditional-chip').textContent.trim(), 'Conditional');
  const lines = [...document.querySelectorAll('.conditional-summary .conditional-line')].map((line) => line.textContent);
  assert.deepEqual(lines, ['If all are trueTheme = DarkPadding Top ≠ Smallvalue1', 'If Theme = Lighttitle', 'Elsevalue3']);
  assert.equal(document.querySelector('.attr-editor .cm-editor') ?? undefined, undefined, 'no code editor for a conditional the UI draws');

  await click(document.querySelector('.conditional-summary'));
  assert.ok(editor(), 'the summary reopens the editor');
  assert.equal(editor().querySelectorAll('.conditional-group[role="group"]').length, 2, 'on the conditional as it is');
  assert.equal(editor().querySelectorAll('.conditional-group[role="group"]')[1].querySelector('.expr-chip').textContent, 'title', 'a bound value is its chip');
  await escape();
  assert.deepEqual(writes, [], 'closing it unchanged writes nothing');

  await click(document.querySelector('.conditional-chip'));
  assert.ok(editor(), 'the chip reopens it too');
  await click(editor().querySelector('[aria-label="Remove conditional"]'));
  assert.equal(editor() ?? undefined, undefined, 'unlinking closes the editor');
  assert.deepEqual(writes, [{ name: 'data-label', value: undefined, immediate: true }], 'and clears the value, as the {} toggle does: one write');
  const [notice] = toastNotices();
  assert.equal(notice.message, 'Code cleared. Undo to restore.');
  await act(async () => notice.recovery[0].run());
  assert.deepEqual(writes[1], { name: 'data-label', value: { type: 'expr', value: code }, immediate: true }, 'the notice can put the code back');
  await act(async () => root.unmount());
});

test('code the editor cannot draw stays code, and a page offers no conditional', async (context) => {
  // An escape in a template is code the model does not write, so it stays code.
  const code = "theme === 'dark' ? `night\\t${title}` : 'day'";
  const source = COMPONENT.replace('data-label="Click me"', `data-label={${code}}`);
  const { read } = await project(context, source);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await renderSection(container, root, anchor, { frontmatter: read.model.extraFrontmatter, host: HOST, names: ['data-label'] });
  assert.equal(container.querySelector('.conditional-badge') ?? undefined, undefined, 'no chip for code');
  assert.match(container.querySelector('.attr-row .attr-value').textContent, /night/, 'the row shows the code as written');
  await click(container.querySelector('.attr-row'));
  assert.equal(document.querySelector('.attr-editor .conditional-chip') ?? undefined, undefined);
  assert.ok(document.querySelector('.attr-editor .cm-editor'), 'the highlighted code editor holds it');
  await click(document.querySelector('.attr-value-field .bind-handle'));
  assert.equal(byText('Create conditional'), undefined, 'a value a branch cannot hold is not offered a conditional');
  await act(async () => root.unmount());

  const page = createRoot(container);
  const plain = { ...anchor, props: { ...anchor.props, 'data-label': { type: 'string', value: 'x' } } };
  await renderSection(container, page, plain, { frontmatter: read.model.extraFrontmatter, host: undefined, names: ['data-label'] });
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-value-field .bind-handle'));
  assert.ok(document.querySelector('.bind-menu'));
  assert.equal(byText('Create conditional'), undefined, 'a page has no props to test');
  await act(async () => page.unmount());
});

test('a schema-driven prop field offers the conditional too, and shows one as its chip', async (context) => {
  const { read } = await project(context, COMPONENT);
  installDom();
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  const bindContext = {
    frontmatter: read.model.extraFrontmatter,
    propsSchema: SCHEMA,
    origin: { file: 'src/components/Card.astro', page: undefined },
    newProp: HOST,
  };
  const draw = (value) =>
    act(async () =>
      root.render(
        React.createElement(modules.PropField, {
          field: { name: 'label', type: 'string' },
          value,
          bindContext,
          onChange: (next, immediate) => writes.push({ next, immediate }),
        }),
      ),
    );
  await draw({ type: 'string', value: 'Read more' });
  await click(container.querySelector('.bind-handle'));
  await click(byText('Create conditional'));
  assert.ok(editor(), 'the editor opens from a prop field');
  assert.ok(document.querySelector('.loop-settings-popup .conditional-editor'), 'placed in its pop-up');
  assert.equal(editor().querySelector('[aria-label="Else value"] .bind-input').textContent, 'Read more');
  await pickValue(editor().querySelector('[aria-label="Values"]'), 'Light');
  await escape();
  assert.deepEqual(writes, [{ next: { type: 'expr', value: 'theme === "light" ? undefined : "Read more"' }, immediate: true }]);

  await draw(writes[0].next);
  assert.equal(container.querySelector('.conditional-chip').textContent.trim(), 'Conditional', 'the field shows its chip');
  assert.match(container.querySelector('.conditional-summary').textContent, /If Theme = Light/);
  await act(async () => root.unmount());
});

const SPREADS = `---
const { shown = true, ...rest } = Astro.props;
---
<div {...rest} class:list={["card", { shown }]} id="x" {...Astro.props} data-y="1">Hi</div>
`;

test('a spread is a row of code in source order, removed alone as one undo step, and never moved by an edit beside it', async (context) => {
  const { harness, file, read } = await project(context, SPREADS);
  installDom();
  const element = elementOf(read.model.nodes, 'div');
  const keys = Object.keys(element.props);
  assert.deepEqual(
    keys.filter((key) => key !== 'class:list'),
    ['...rest', 'id', '...Astro.props', 'data-y'],
    'both spreads parse in source order',
  );
  const container = document.getElementById('root');
  const root = createRoot(container);
  const replaced = [];
  await renderSection(container, root, element, {
    frontmatter: read.model.extraFrontmatter,
    host: undefined,
    names: keys.filter((key) => key !== 'class:list'),
    onReplaceAttributes: (props) => replaced.push(props),
  });
  const rows = [...container.querySelectorAll('.attr-row')].map((row) => [
    row.classList.contains('spread') ? 'spread' : 'pair',
    row.querySelector('.attr-name').textContent,
  ]);
  assert.deepEqual(rows, [
    ['spread', '{...rest}'],
    ['pair', 'id'],
    ['spread', '{...Astro.props}'],
    ['pair', 'data-y'],
  ]);
  assert.ok(container.querySelector('.attr-row.spread .attr-name code.code-inline'), 'a spread is drawn as highlighted code');
  assert.equal(container.querySelector('.attr-row.spread .attr-eq') ?? undefined, undefined, 'with no value');
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS, 'reading changes nothing');

  // Its row opens the editor like any other: the spread as its Name, no value, what it does.
  await click(container.querySelector('.attr-row.spread'));
  const nameInput = document.querySelector('.attr-editor .attr-name-field input');
  assert.equal(nameInput.value, '{...rest}');
  assert.doesNotMatch(document.querySelector('.attr-editor').textContent, /Value/, 'a spread has no value');
  assert.match(document.querySelector('.attr-editor').textContent, /Spread: passes every property of rest/);
  assert.ok(document.querySelector('.attr-editor .attr-name-field .bind-handle'), 'with the dot to pick what it spreads');
  await type(nameInput, 'title');
  assert.match(document.querySelector('.attr-editor').textContent, /A spread’s Name is its code/, 'a spread stays a spread');
  await type(nameInput, '{...attrs}');
  await act(async () => nameInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(replaced.length, 1, 'renaming it is one write');
  assert.deepEqual(Object.keys(replaced[0]), ['...attrs', 'class:list', 'id', '...Astro.props', 'data-y'], 'in its place');
  const renamed = await sent(
    harness,
    file,
    read,
    modules.nodeGesture(element.id, modules.withAttributes(element, replaced[0]), { coalesceKey: undefined, urgency: true }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS.replace('{...rest} ', '{...attrs} '), 'only what it spreads changed');
  await undo(harness, file, renamed);
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS, 'one undo puts it back');
  replaced.length = 0;
  await escape();
  assert.equal(document.querySelector('.attr-editor') ?? undefined, undefined, 'Escape closes it');

  await click(container.querySelector('.attr-row.spread .row-action'));
  assert.equal(replaced.length, 1);
  assert.deepEqual(Object.keys(replaced[0]), ['class:list', 'id', '...Astro.props', 'data-y'], 'only that spread is gone, the rest in order');
  const record = await sent(
    harness,
    file,
    read,
    modules.nodeGesture(element.id, modules.withAttributes(element, replaced[0]), { coalesceKey: undefined, urgency: true }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS.replace('<div {...rest} ', '<div '), 'the spread alone left the markup');
  await undo(harness, file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS, 'one undo puts it back, byte for byte');

  // An edit beside the spreads leaves them where they are.
  const again = parsePageDiskRead(await harness.invoke('page:read', file));
  const target = elementOf(again.model.nodes, 'div');
  await sent(harness, file, again, modules.propsGesture(target.id, { id: { type: 'string', value: 'y' } }, { coalesceKey: undefined, urgency: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), SPREADS.replace('id="x"', 'id="y"'), 'the spreads keep their places');
  await act(async () => root.unmount());
});

const PLAIN = `---
const { ...rest } = Astro.props;
---
<div class:list={["card"]} id="x">Hi</div>
`;

test('a spread typed into Add attribute is checked as it is typed and added in place as one undo step', async (context) => {
  const { harness, file, read } = await project(context, PLAIN);
  installDom();
  const element = elementOf(read.model.nodes, 'div');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const replaced = [];
  await renderSection(container, root, element, {
    frontmatter: read.model.extraFrontmatter,
    host: undefined,
    names: ['class:list', 'id'],
    onReplaceAttributes: (props) => replaced.push(props),
  });
  const nameInput = () => document.querySelector('.attr-editor .attr-editor-row input');
  const valueRow = () => [...document.querySelectorAll('.attr-editor .attr-editor-row')].find((row) => row.textContent.startsWith('Value'));
  const note = () => document.querySelector('.attr-editor .attr-name-note')?.textContent;

  // The existing class:list is what the file says: no note on it.
  await click(container.querySelector('.attr-row'));
  assert.equal(nameInput().value, 'class:list');
  assert.equal(note(), undefined, 'an existing directive is never flagged');
  await click(container.querySelector('.attr-row'));

  await click(container.querySelector('button[title="Add attribute"]'));
  await type(nameInput(), 'class:list');
  assert.equal(note(), 'Classes are edited in the Style panel.', 'adding one gets a calm hint');
  await type(nameInput(), 'id');
  assert.equal(note(), 'id is already on this element.');

  for (const [typed, shown] of [
    ['{...rest}', '{...rest}'],
    ['...rest', '{...rest}'],
    ['{...Astro.props}', '{...Astro.props}'],
  ]) {
    await type(nameInput(), typed);
    assert.equal(document.querySelector('.attr-spread-note code').textContent, shown, `${typed} reads as ${shown}`);
    assert.match(note(), /Spread: passes every property of/);
    assert.equal(valueRow(), undefined, 'a spread has no value');
  }
  await type(nameInput(), '{... rest}');
  assert.equal(nameInput().value, '{...rest}', 'a space is not part of a name');
  await type(nameInput(), '{...}');
  assert.match(note(), /Type the value to spread/);
  await type(nameInput(), '{...1x}');
  assert.match(note(), /one name in scope/);
  await act(async () => nameInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(replaced.length, 0, 'an invalid spread writes nothing');

  await type(nameInput(), '...rest');
  await act(async () => nameInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(replaced.length, 1, 'Enter adds it');
  assert.deepEqual(Object.keys(replaced[0]), ['class:list', 'id', '...rest'], 'last, where a new attribute goes');
  assert.deepEqual(replaced[0]['...rest'], { type: 'spread', value: 'rest' });
  assert.equal(document.querySelector('.attr-editor') ?? undefined, undefined, 'and the editor closes: a spread has nothing more to edit');

  const record = await sent(
    harness,
    file,
    read,
    modules.nodeGesture(element.id, modules.withAttributes(element, replaced[0]), { coalesceKey: undefined, urgency: true }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), PLAIN.replace('id="x">', 'id="x" {...rest}>'), 'written as a spread, nothing else moved');
  await undo(harness, file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), PLAIN, 'one undo takes it back');
  await act(async () => root.unmount());
});

const STYLED = `---
interface Props {
  maxWidth?: number;
  gap?: number;
}
const { maxWidth, gap } = Astro.props;
---
<div style={maxWidth ? \`--_mw: \${maxWidth}ch;\` : undefined}>Hi</div>
`;

test('a style that is set only when a prop is reads as a conditional, highlighted as declarations', async (context) => {
  const { read } = await project(context, STYLED);
  installDom();
  const element = elementOf(read.model.nodes, 'div');
  assert.deepEqual(element.props.style, { type: 'expr', value: 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined' });
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: element,
        names: ['style'],
        bindContext: {
          frontmatter: read.model.extraFrontmatter,
          propsSchema: [
            { name: 'maxWidth', type: 'number' },
            { name: 'gap', type: 'number' },
          ],
          newProp: HOST,
        },
        tag: 'div',
        onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
        onRenameProp() {},
      }),
    ),
  );
  assert.ok(container.querySelector('.attr-row .conditional-badge'), 'the row previews it as a conditional');
  await click(container.querySelector('.attr-row'));
  const lines = [...document.querySelectorAll('.conditional-summary .conditional-line')].map((line) => line.textContent);
  assert.deepEqual(lines, ['If Max Width is set--_mw: maxWidthch;', 'Else(left out)']);
  const css = document.querySelector('.conditional-summary .conditional-css');
  assert.ok(css, 'the value is highlighted as the style attribute’s declarations');
  assert.equal(css.querySelector('.loop-bind-chip').textContent, 'maxWidth', 'with the prop as a purple chip');
  const property = [...css.querySelectorAll('.code-token')].find((token) => token.textContent === '--_mw');
  assert.equal(property?.style.color, 'rgb(128, 203, 196)', 'the custom property in the property colour');
  const unit = [...css.querySelectorAll('.code-token')].find((token) => token.textContent === 'ch');
  assert.equal(unit?.style.color, 'rgb(247, 140, 108)', 'the unit after the value in the number colour');
  assert.equal(document.querySelector('.attr-editor .style-editor') ?? undefined, undefined, 'the conditional takes the place of the CSS editor');

  await click(document.querySelector('.conditional-summary'));
  assert.ok(editor());
  const field = editor().querySelector('.conditional-css-input');
  assert.ok(field, 'the branch value is the CSS-highlighted field');
  assert.equal(field.querySelector('.cm-content').textContent, '--_mw: maxWidthch;', 'the words, with the hole drawn by its name');
  assert.equal(field.querySelector('.expr-chip')?.textContent, 'maxWidth', 'its prop drawn as a chip');
  const head = editor().querySelector('.conditional-group-head');
  assert.ok(head.querySelector('.dd-trigger.conditional-match'), 'the all or any picker shows even for one condition');
  assert.match(head.textContent, /^If\s*all.*conditions in this group are true$/);
  assert.equal(
    editor().querySelector('.conditional-else .cm-placeholder, .conditional-else [aria-label="Else value"]') !== null,
    true,
    'the Else is an empty field',
  );

  // Pressing the chip opens the picker on it, the current value checked; a
  // pick swaps that value and leaves the words around it.
  const chip = field.querySelector('.expr-chip');
  await act(async () => chip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  const menu = document.querySelector('.bind-menu');
  assert.ok(menu, 'the chip opens the data picker');
  assert.equal(menu.querySelector('.dp-row.selected .dp-key')?.textContent, 'maxWidth', 'on the value it holds, checked');
  const gap = [...menu.querySelectorAll('.dp-row')].find((row) => row.querySelector('.dp-key')?.textContent === 'gap');
  assert.ok(gap, 'the other prop is offered');
  await click(gap);
  assert.equal(document.querySelector('.bind-menu') ?? undefined, undefined);
  assert.equal(editor().querySelector('.conditional-css-input .expr-chip')?.textContent, 'gap', 'the chip now names the new value');
  await escape();
  assert.deepEqual(
    writes,
    [{ name: 'style', value: { type: 'expr', value: 'maxWidth ? `--_mw: ${gap}ch;` : undefined' }, immediate: true }],
    'one write, the words kept',
  );
  await act(async () => root.unmount());
});

const GROUPS = 'theme === "dark" ? "one" : paddingTop === "small" ? "two" : "else"';

test('groups are tried in order, and are reordered by drag or Alt+arrows; the editor is laid out as designed', async (context) => {
  const source = COMPONENT.replace('data-label="Click me"', `data-label={${GROUPS}}`);
  const { read } = await project(context, source);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await renderSection(container, root, anchor, {
    frontmatter: read.model.extraFrontmatter,
    host: HOST,
    names: ['data-label'],
    onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
  });
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.conditional-summary'));
  const groups = () => [...editor().querySelectorAll('.conditional-group[role="group"]')];

  // The layout: "If [all ▾] conditions in this group are true" on every group,
  // a compact picker, "+ New condition" as a ghost row, a divider before the
  // value, "or" between groups, "+ New group" on a line, the per-type icon.
  for (const group of groups()) {
    assert.match(group.querySelector('.conditional-group-head').textContent, /^If\s*all.*conditions in this group are true$/);
    assert.ok(group.querySelector('.dd-trigger.conditional-match'));
    assert.ok(group.querySelector('.conditional-grip[data-drag-through]'), 'each group has its grip');
    assert.ok(group.querySelector('button.conditional-add'));
    assert.ok(group.querySelector('.conditional-divider'));
  }
  assert.equal(editor().querySelector('.conditional-or').textContent, 'or');
  assert.ok(editor().querySelector('.conditional-add-group-row > .conditional-add-group'));
  assert.ok(groups()[0].querySelector('[aria-label="Property"] .dd-icon .is-enum'), 'an option prop wears the options icon');
  assert.ok(editor().querySelector('.conditional-editor [aria-label="Else value"]'));

  // Alt+↓ on the first group moves it below the second.
  await act(async () => groups()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })));
  assert.match(groups()[0].textContent, /Padding Top/, 'the second group is now first');

  // A drag by the grip moves it back: rows measured as stacked 100px apart.
  groups().forEach((group, index) => {
    group.getBoundingClientRect = () => new dom.window.DOMRect(0, index * 100, 300, 90);
  });
  const grip = groups()[1].querySelector('.conditional-grip');
  await act(async () => grip.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 150 })));
  await act(async () => dom.window.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, clientY: 20 })));
  assert.ok(editor().querySelector('.conditional-gap .drop-indicator'), 'the shared drop line shows where it lands');
  await act(async () => dom.window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, clientY: 20 })));
  assert.match(groups()[0].textContent, /Theme/, 'dragged back to first');
  await act(async () => groups()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })));
  assert.deepEqual(writes, [], 'nothing is written while the editor is open');
  await escape();
  assert.deepEqual(
    writes,
    [{ name: 'data-label', value: { type: 'expr', value: 'paddingTop === "small" ? "two" : theme === "dark" ? "one" : "else"' }, immediate: true }],
    'the order written is the order tried: one write',
  );
  await act(async () => root.unmount());
});

test('the Conditional chip is the field it replaces: full width in the input’s own box', () => {
  const css = fs.readFileSync(repoPath('src/features/props/conditionalValue.css'), 'utf8');
  const controls = fs.readFileSync(repoPath('src/ui/controls.css'), 'utf8');
  // The last rule for a selector is the one that sizes it.
  const rule = (text, selector) => text.slice(text.lastIndexOf(`${selector} {`), text.indexOf('}', text.lastIndexOf(`${selector} {`)));
  const chip = rule(css, '.conditional-chip');
  const input = rule(controls, 'input,\ntextarea');
  for (const declaration of ['padding: 6px 8px;', 'border-radius: 6px;', 'font-size: 12px;', 'border: 1px solid transparent;']) {
    assert.ok(input.includes(declaration), `the input has ${declaration}`);
    assert.ok(chip.includes(declaration), `and so does the chip`);
  }
  assert.ok(chip.includes('width: 100%;'));
  assert.match(css, /\.conditional-chip:hover:not\(:disabled\)[^{]*\{[^}]*rgba\(146, 116, 255/, 'its hover stays purple over the base button hover');
  assert.match(css, /\.dd-trigger\.conditional-match \{[^}]*width: auto;/, 'the all or any picker is as wide as its word');
});

const CLASSES = `---
interface Props {
  variant?: "inherit" | "large";
  className?: string;
}
const { variant = "inherit", className } = Astro.props;
---
<h2 class:list={["heading", variant !== "inherit" && \`text-style-\${variant}\`, className]}>Hi</h2>
`;

test('a class list reads as its classes, each given always or only when, edited and reordered, written back as Prettier leaves it', async (context) => {
  const { harness, file, read } = await project(context, CLASSES);
  installDom();
  const heading = elementOf(read.model.nodes, 'h2');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: heading,
        names: ['class:list'],
        bindContext: {
          frontmatter: read.model.extraFrontmatter,
          propsSchema: [
            { name: 'variant', type: 'enum', options: ['inherit', 'large'] },
            { name: 'className', type: 'string' },
          ],
          newProp: HOST,
        },
        tag: 'h2',
        onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
        onRenameProp() {},
      }),
    ),
  );
  assert.equal(container.querySelector('.attr-row .conditional-badge').textContent.trim(), 'Class list');
  await click(container.querySelector('.attr-row'));
  const lines = [...document.querySelectorAll('.class-list-summary .class-list-line')].map((line) => line.textContent);
  assert.deepEqual(lines, ['heading', 'text-style-variantonly when Variant ≠ Inherit', 'className']);

  await click(document.querySelector('.class-list-summary'));
  const rows = () => [...document.querySelectorAll('.class-list-entry')];
  assert.equal(rows().length, 3);
  assert.equal(rows()[1].querySelectorAll('.conditional-condition').length, 1, 'the second is given only when');
  assert.equal(rows()[0].querySelectorAll('.conditional-condition').length, 0, 'the first always');

  await click(byText('Add class'));
  await typeBox(rows()[3].querySelector('.bind-input'), 'wide');
  await click(rows()[3].querySelector('[aria-label="Remove class"]'));
  assert.equal(rows().length, 3, 'added and removed');
  await act(async () => rows()[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })));
  await click(document.querySelector('[aria-label="Close class list"]'));

  const code = '["heading", className, variant !== "inherit" && `text-style-${variant}`]';
  assert.deepEqual(writes, [{ name: 'class:list', value: { type: 'expr', value: code }, immediate: true }], 'one write, in the file’s quotes');
  const prettier = require('prettier');
  assert.equal(await prettier.format(`(${code});\n`, { parser: 'babel', printWidth: 160 }), `${code};\n`, 'Prettier changes nothing');
  const record = await sent(
    harness,
    file,
    read,
    modules.propsGesture(heading.id, { 'class:list': writes[0].value }, { coalesceKey: undefined, urgency: true }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), CLASSES.replace(/class:list=\{\[[^\n]*\]\}/, `class:list={${code}}`), 'only the list changed');
  await undo(harness, file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), CLASSES, 'one undo');
  await act(async () => root.unmount());
});

test('a pop-up opened from the attribute editor stacks above it, and a menu in the pop-up above that', async (context) => {
  const { read } = await project(context, CLASSES);
  installDom();
  // The layers as the stylesheets give them (styles.css, loopSettings.css, dropdown.css).
  const sheet = document.createElement('style');
  sheet.textContent =
    '.attr-editor { position: fixed; z-index: 450; } .loop-settings-popup { position: fixed; z-index: 390; } .dd-popup { position: fixed; z-index: 400; }';
  document.head.append(sheet);
  const heading = elementOf(read.model.nodes, 'h2');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: heading,
        names: ['class:list'],
        bindContext: {
          frontmatter: read.model.extraFrontmatter,
          propsSchema: [{ name: 'variant', type: 'enum', options: ['inherit', 'large'] }],
          newProp: HOST,
        },
        tag: 'h2',
        onSetProp() {},
        onRenameProp() {},
      }),
    ),
  );
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.class-list-summary'));
  const popup = document.querySelector('.loop-settings-popup');
  assert.equal(popup.style.zIndex, '451', 'the Class list sits one above the attribute editor it came from');
  assert.match(popup.textContent, /Only when\s*all\s*conditions are true/, 'a row’s conditions read as a group’s do');
  await click(popup.querySelector('.class-list-entry [aria-label="Match"]'));
  assert.equal(document.querySelector('.dd-popup').style.zIndex, '452', 'and its menu one above that');
  sheet.remove();
  await act(async () => root.unmount());
});

const CODED = `---
const styles = ["color: red", "margin: 0"];
---
<p style={styles.join("; ")}>Hi</p>
`;

test('back to a plain value: code it can hold converts, code it cannot is cleared as one undo step with a notice', async (context) => {
  const { harness, file, read } = await project(context, CODED);
  installDom();
  const paragraph = elementOf(read.model.nodes, 'p');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  const draw = (value) =>
    act(async () =>
      root.render(
        React.createElement(modules.PropField, {
          field: { name: 'style', type: 'style' },
          value,
          bindContext: { frontmatter: read.model.extraFrontmatter },
          onChange: (next, immediate) => writes.push({ next, immediate }),
        }),
      ),
    );
  const notices = () => toastNotices().filter((notice) => notice.message === 'Code cleared. Undo to restore.').length;
  const before = notices();

  await draw({ type: 'expr', value: '"color: red"' });
  await click(container.querySelector('.prop-expr-toggle'));
  assert.deepEqual(writes, [{ next: { type: 'string', value: 'color: red' }, immediate: true }], 'code the CSS editor can hold converts');
  assert.equal(notices(), before, 'silently');

  writes.length = 0;
  await draw(paragraph.props.style);
  await click(container.querySelector('.prop-expr-toggle'));
  assert.deepEqual(writes, [{ next: undefined, immediate: true }], 'code it cannot hold is cleared: one write');
  assert.equal(notices(), before + 1, 'and a notice says so');
  assert.equal(container.querySelector('.prop-field-note.problem') ?? undefined, undefined, 'never a blocking error');
  await draw(undefined);
  assert.equal(container.querySelector('.prop-expr-toggle')?.getAttribute('aria-pressed'), 'false', 'the plain editor shows, empty');

  // The clearing write and its undo, as the app sends them.
  const record = await sent(harness, file, read, modules.propsGesture(paragraph.id, { style: undefined }, { coalesceKey: undefined, urgency: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), CODED.replace(' style={styles.join("; ")}', ''));
  await undo(harness, file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), CODED, 'one undo brings the code back');
  await act(async () => root.unmount());
});

test('a class row’s condition is removed without the class, by its header or its last row', async (context) => {
  const { read } = await project(context, CLASSES);
  installDom();
  const heading = elementOf(read.model.nodes, 'h2');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const writes = [];
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: heading,
        names: ['class:list'],
        bindContext: {
          frontmatter: read.model.extraFrontmatter,
          propsSchema: [
            { name: 'variant', type: 'enum', options: ['inherit', 'large'] },
            { name: 'className', type: 'string' },
          ],
          newProp: HOST,
        },
        tag: 'h2',
        onSetProp: (name, value, immediate) => writes.push({ name, value, immediate }),
        onRenameProp() {},
      }),
    ),
  );
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.class-list-summary'));
  const rows = () => [...document.querySelectorAll('.class-list-entry')];
  assert.ok(
    rows().every((row) => row.querySelector('.class-list-entry-head > .conditional-grip')),
    'every row, the first too, leads with its grip',
  );
  const condition = rows()[1].querySelector('.conditional-condition');
  assert.ok(condition.querySelector('[aria-label="Property"] .dd-icon .is-enum'), 'an option prop wears the options icon');
  const parts = [...condition.children].map((child) => child.getAttribute('aria-label') ?? child.className);
  assert.deepEqual(parts, ['Property', 'Operator', 'Values', 'Remove condition'], 'prop, operator, values and one remove, in a row');
  assert.equal(condition.querySelectorAll('[aria-label="Remove condition"], [aria-label="Clear values"]').length, 1, 'no second remove');

  // The header's remove takes the condition away and leaves the class.
  await click(rows()[1].querySelector('.conditional-group-head [aria-label="Remove condition"]'));
  assert.equal(rows().length, 3, 'the class stays');
  assert.equal(rows()[1].querySelectorAll('.conditional-condition').length, 0);
  assert.equal(rows()[1].querySelector('button.conditional-add').textContent.trim(), 'Only when', 'and offers its condition again');

  // So does removing the last condition row.
  await click(rows()[0].querySelector('button.conditional-add'));
  assert.equal(rows()[0].querySelectorAll('.conditional-condition').length, 1);
  await click(rows()[0].querySelector('.conditional-condition [aria-label="Remove condition"]'));
  assert.equal(rows()[0].querySelector('button.conditional-add').textContent.trim(), 'Only when');

  await click(document.querySelector('[aria-label="Close class list"]'));
  assert.deepEqual(writes, [{ name: 'class:list', value: { type: 'expr', value: '["heading", `text-style-${variant}`, className]' }, immediate: true }]);
  await act(async () => root.unmount());
});

test('a values field is one multi-select: several picked, unpicked by menu or chip, cleared, Backspace, filtered by typing', async (context) => {
  const { read } = await project(context, COMPONENT);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await renderSection(container, root, anchor, { frontmatter: read.model.extraFrontmatter, host: HOST, names: ['data-label'] });
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-value-field .bind-handle'));
  await click(byText('Create conditional'));
  const field = () => editor().querySelector('[aria-label="Values"]');
  const chips = () => [...field().querySelectorAll('.multi-select-chip')].map((chip) => chip.firstChild.textContent);
  assert.equal(field().getAttribute('role'), 'combobox', 'one field, not a separate add control');
  assert.equal(editor().querySelector('[aria-label="Add value"]') ?? undefined, undefined);

  await pickValue(field(), 'Dark');
  await pickValue(field(), 'Light');
  assert.deepEqual(chips(), ['Dark', 'Light'], 'several stay picked');
  const checked = [...document.querySelectorAll('.multi-select-menu .dd-option')].filter((option) => option.querySelector('.dd-check'));
  assert.equal(checked.length, 2, 'each checked at the end of its row');
  await pickValue(field(), 'Dark');
  assert.deepEqual(chips(), ['Light'], 'picking a checked one unpicks it');
  await click(field().querySelector('[aria-label="Remove Light"]'));
  assert.deepEqual(chips(), [], 'a chip’s × unpicks it');

  await pickValue(field(), 'Dark');
  await pickValue(field(), 'Light');
  await click(field().querySelector('[aria-label="Clear all"]'));
  assert.deepEqual(chips(), [], 'clear all');

  const input = field().querySelector('.multi-select-input');
  await pickValue(field(), 'Dark');
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
  assert.deepEqual(chips(), [], 'Backspace in the empty box takes the last chip');
  await type(input, 'li');
  const shown = [...document.querySelectorAll('.multi-select-menu .dd-option-label')].map((label) => label.textContent);
  assert.deepEqual(shown, ['Light'], 'typing filters the menu');
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.deepEqual(chips(), ['Light'], 'Enter picks what is highlighted');
  await act(async () => root.unmount());
});

test('a menu is never narrower than its trigger and grows to its longest option', async (context) => {
  const { read } = await project(context, COMPONENT);
  installDom();
  const anchor = elementOf(read.model.nodes, 'a');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await renderSection(container, root, anchor, { frontmatter: read.model.extraFrontmatter, host: HOST, names: ['data-label'] });
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-value-field .bind-handle'));
  await click(byText('Create conditional'));
  const trigger = editor().querySelector('[aria-label="Match"]');
  trigger.getBoundingClientRect = () => new dom.window.DOMRect(100, 100, 40, 24);
  await click(trigger);
  const menu = document.querySelector('.dd-popup:not(.multi-select-menu)');
  assert.equal(menu.style.width, 'max-content', 'as wide as its options');
  assert.ok(Number.parseFloat(menu.style.minWidth) >= 40, 'and never narrower than the trigger');
  await escape();
  await act(async () => root.unmount());
});
