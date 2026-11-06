// Goal: an existing prop's settings can be reached from the data picker. A prop
// row gets a gear (and no other row does), the gear never picks the row, it
// opens the Property settings form loaded with every option the prop has, each
// change saves itself through the Properties panel's transaction (typing after a
// pause, a pick at once, a rename on blur or Enter, what is invalid never, what
// is pending on closing, and a file changed on disk without losing the edit), a
// prop in use keeps working after a rename, and a host that offers no settings
// shows no gear.
//
// Method: the real pickers and the real form, bundled as the app bundles them
// and rendered in jsdom with React, over a temporary project on disk. The
// renderer's bridge is real too: `window.avb` hands each request straight to
// main's loadComponentProperties and updateComponentProperties, so what a test
// reads back is the bytes those wrote, across the component and the page that
// uses it. Clicks and typing are dispatched as a person makes them.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { loadComponentProperties, updateComponentProperties } = require('#dist/electron/properties/componentProperties.js');
const { documentHost } = require('#dist/electron/documents/documentWrites.js');

const directory = repoPath('node_modules/.stacki-test/picker-prop-settings');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'picker-prop-settings.cjs');
buildSync({
  stdin: {
    contents: [
      "export { FieldDataPicker } from './src/features/props/BindingEditors';",
      "export { default as DataPicker } from './src/features/props/DataPicker';",
      "export { SourcePicker } from './src/features/props/LoopSourcePicker';",
      "export { FieldPicker } from './src/features/props/LoopFieldPicker';",
      "export { default as PropertySettingsDialog } from './src/features/componentProperties/PropertySettingsDialog';",
      "export { propKeysByLocal } from './src/features/props/newPropModel';",
      "export { settingsKeyOf } from './src/features/props/dataPickerModel';",
      "export { mergedProperty, savePhaseOf } from './src/features/componentProperties/propertyAutosave';",
      "export { EditorView } from '@codemirror/view';",
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

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'FocusEvent']) {
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
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

// The Astro compiler main loads takes a global `document` as a browser and
// fails, so main's work runs with it out of the way, as it does in the app.
function asMain(run) {
  const held = global.document;
  Reflect.deleteProperty(global, 'document');
  try {
    return run();
  } finally {
    global.document = held;
  }
}

const COMPONENT = `---
interface Props {
  /** The plan's features. */
  features?: readonly { title: string; text: string }[];
  heading: string;
  size?: "small" | "medium" | "large";
}
const { features = [{ title: "One", text: "Two" }], heading } = Astro.props;
const extra = Astro.props.features;
const local = [1, 2];
---
<h2>{heading}</h2>
<ul>{features.map((feature) => <li>{feature.title}</li>)}</ul>
`;
const PAGE = `---
import PricingCard from '../components/PricingCard.astro';
---
<PricingCard heading="Plans" features={[]} />
`;

const writer = { documents: documentHost().documents, noteWrite: () => {} };

// A project on disk, and a bridge to it. `edits` counts what reached main.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-picker-settings-'));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const component = path.join(root, 'src/components/PricingCard.astro');
  const page = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(component, COMPONENT);
  fs.writeFileSync(page, PAGE);
  const log = { edits: 0, undo: [], completed: 0, phases: [], flushed: 0 };
  dom.window.avb = {
    componentProperties: async (location) => asMain(() => loadComponentProperties(location)),
    editComponentProperties: async (request) => {
      log.edits += 1;
      const result = asMain(() => updateComponentProperties(request, writer));
      return result.ok ? { ok: true, value: { ...result.value, undo: '00000000-0000-4000-8000-000000000000' } } : result;
    },
  };
  const saver = {
    projectPath: root,
    file: component,
    flushSave: async () => {
      log.flushed += 1;
    },
    changePhase: (phase) => log.phases.push(phase),
    recordUndo: (token) => log.undo.push(token),
    completeSave: async () => {
      log.completed += 1;
    },
  };
  return { root, component, page, saver, log, source: () => fs.readFileSync(component, 'utf8'), pageSource: () => fs.readFileSync(page, 'utf8') };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
// Long enough for typing to count as paused.
const pause = () => act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
// What a drag sends a row: the browser's position, which jsdom has no layout to give.
const drag = (element, name, clientY) =>
  act(async () => {
    const event = new dom.window.MouseEvent(name, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, getData: () => '0', effectAllowed: '', dropEffect: '' } });
    element.dispatchEvent(event);
  });
const byText = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
const rowOf = (name) => [...document.querySelectorAll('.dp-row')].find((row) => row.querySelector('.dp-key')?.textContent === name);
const gears = () => [...document.querySelectorAll('.dp-settings')].map((gear) => gear.getAttribute('aria-label'));
const form = () => document.querySelector('[role="dialog"][aria-label="Property settings"]') ?? undefined;
const labelled = (text) => [...form().querySelectorAll('label')].find((label) => label.textContent.trim().startsWith(text));

let root;
async function draw(element) {
  root ??= createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
}
async function clear() {
  if (root !== undefined) {
    await act(async () => root.unmount());
    root = undefined;
  }
}

const propNode = (name, kind) => ({ path: name, key: name, kind, preview: '', children: undefined, section: 'props' });
const TREE = [
  { ...propNode('features', 'list'), preview: '[]', children: [{ path: 'features.title', key: 'title', kind: 'text', preview: '', children: undefined }] },
  propNode('heading', 'string'),
  { path: 'local', key: 'local', kind: 'list', preview: '[]', children: undefined, section: 'frontmatter' },
  {
    path: 'astro:plans',
    key: 'plans',
    kind: 'collection',
    preview: '3 items',
    children: undefined,
    section: 'collections',
    query: { collection: 'plans', name: 'plans' },
  },
];
const KEYS = new Map([
  ['features', 'features'],
  ['heading', 'heading'],
]);

// The offer the app makes (App.tsx propSettingsOf), over a test's project.
const offerFor = (saver) => ({
  keyOf: (key) => KEYS.get(key),
  render: (key, onClose) => React.createElement(modules.PropertySettingsDialog, { propertyKey: key, saver, onClose }),
});

async function drawPicker(saver, overrides = {}) {
  const picks = [];
  await draw(
    React.createElement(modules.DataPicker, {
      tree: TREE,
      footer: false,
      origin: { file: 'src/components/PricingCard.astro', page: undefined },
      propSettings: offerFor(saver),
      onPick: (next) => picks.push(next),
      ...overrides,
    }),
  );
  return picks;
}

async function openFeatures() {
  await click(rowOf('features').querySelector('.dp-settings'));
  await flush();
  assert.ok(form(), 'the settings form is open');
}

test('a gear is on the component’s own prop rows, and nowhere else', async () => {
  const { saver } = project();
  await drawPicker(saver);
  assert.deepEqual(gears(), ['Edit features settings', 'Edit heading settings']);
  assert.ok(rowOf('title'), 'the first prop opens to its item fields, and a field inside a prop has no gear');
  // Every row keeps the slot, so showing the gear moves no value out of line.
  const rows = [...document.querySelectorAll('.dp-row')];
  assert.equal(rows.filter((row) => row.querySelector('.dp-settings-slot')).length, rows.length);
  await clear();
});

test('the gear is a focusable, named button, kept in the tab order', async () => {
  const { saver } = project();
  await drawPicker(saver);
  const gear = rowOf('features').querySelector('.dp-settings');
  assert.equal(gear.tagName, 'BUTTON');
  assert.equal(gear.getAttribute('type'), 'button');
  assert.notEqual(gear.tabIndex, -1);
  assert.equal(gear.getAttribute('aria-label'), 'Edit features settings');
  gear.focus();
  assert.equal(document.activeElement, gear);
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rest = css.match(/\n\.dp-settings \{[^}]*\}/)?.[0] ?? '';
  assert.match(rest, /color: var\(--text-faint\)/, 'muted at rest');
  assert.doesNotMatch(rest, /opacity|display: none|visibility: hidden/, 'and always there, not only on hover');
  assert.doesNotMatch(css, /\.dp-settings[^{]*\{[^}]*opacity/, 'no state hides or fades it');
  assert.match(css, /\.dp-row:hover \.dp-settings,\s*\.dp-settings:focus-visible \{\s*color: var\(--text-dim\)/, 'brighter when the row is reached for');
  assert.match(css, /\.dp-row \.dp-settings:hover:not\(:disabled\) \{[^}]*color: var\(--text\)/, 'and brightest on the gear itself');
  await clear();
});

test('clicking the gear does not pick the row, and pressing it keeps the caret', async () => {
  const { saver } = project();
  const picks = await drawPicker(saver);
  const gear = rowOf('features').querySelector('.dp-settings');
  const press = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await act(async () => gear.dispatchEvent(press));
  assert.equal(press.defaultPrevented, true, 'the field keeps its caret');
  await click(gear);
  await flush();
  assert.deepEqual(picks, [], 'nothing was picked');
  assert.ok(form());
  await clear();
});

test('the form loads every option a list prop has', async () => {
  const { saver } = project();
  await drawPicker(saver);
  await openFeatures();
  assert.equal(labelled('Name').querySelector('input').value, 'features');
  assert.match(form().querySelector('.property-type .dd-trigger').textContent, /List/);
  assert.equal(form().querySelector('input[aria-label="Required"]').checked, false);
  assert.equal(form().querySelector('input[aria-label="Readonly"]').checked, false);
  assert.equal(labelled('Tooltip').querySelector('textarea').value, 'The plan’s features.'.replace('’', "'"));
  assert.deepEqual(
    [...form().querySelectorAll('[aria-label="Item fields"] input[aria-label="Field name"]')].map((input) => input.value),
    ['title', 'text'],
  );
  const items = form().querySelector('[aria-label="Default items"]');
  assert.deepEqual(
    [...items.querySelectorAll('.list-field-items > *')].map((row) => row.textContent.trim()),
    ['One'],
  );
  assert.ok(items.querySelector('.prop-expr-toggle'), 'the default items have their {} toggle');
  await click(form().querySelector('.property-code-toggle'));
  assert.equal(form().querySelector('[aria-label="Code type"]').textContent, 'readonly { title: string; text: string }[]');
  await clear();
});

test('a tooltip saves itself after a pause, as one undo step for the whole burst', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  const box = () => labelled('Tooltip').querySelector('textarea');
  for (const text of ['W', 'Wh', 'What the plan includes.']) {
    await type(box(), text);
  }
  assert.equal(log.edits, 0, 'nothing is written while the typing goes on');
  await pause();
  assert.equal(source(), COMPONENT.replace("/** The plan's features. */", '/** What the plan includes. */'));
  assert.equal(log.edits, 1);
  assert.equal(log.undo.length, 1, 'one undo step');
  assert.equal(log.completed, 1, 'the app reloads what was written');
  assert.deepEqual(log.phases, ['autosaving', 'idle'], 'an edit to this file does not stop the app');
  assert.ok(form(), 'the form stays open');
  await clear();
});

test('a toggle saves at once', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await click(form().querySelector('input[aria-label="Readonly"]'));
  await flush();
  assert.equal(log.edits, 1);
  assert.match(source(), /readonly features\?: readonly/);
  await clear();
});

test('an item field saves its type and the default items together', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await type(form().querySelector('input[aria-label="Field name"]'), 'label');
  await pause();
  assert.equal(log.edits, 1);
  assert.match(source(), /features\?: readonly \{ label: string; text: string \}\[\];/);
  assert.match(source(), /features = \[\{ label: "One", text: "Two" \}\]/);
  await clear();
});

test('an item field with no name yet is not written, and writes once it has one', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await type(form().querySelector('input[aria-label="Field name"]'), '');
  await pause();
  assert.equal(log.edits, 0, 'a default with a nameless key would not parse');
  assert.equal(source(), COMPONENT);
  assert.equal(form().querySelector('input[aria-label="Field name"]').value, '', 'and the box keeps what was typed');
  await type(form().querySelector('input[aria-label="Field name"]'), 'label');
  await pause();
  assert.match(source(), /features = \[\{ label: "One", text: "Two" \}\]/, 'the items followed the name through');
  await clear();
});

test('the type dropdown writes what the select wrote', async () => {
  const { saver, source } = project();
  await drawPicker(saver);
  await openFeatures();
  assert.ok(!form().querySelector('select'), 'no native select is left in the form');
  const trigger = form().querySelectorAll('.dd-trigger[aria-label="Field type"]')[1];
  await click(trigger);
  const number = [...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('Number'));
  assert.ok(number, 'the app’s menu lists the kinds');
  await click(number);
  // The menu commits a frame after the press, so the save is a turn behind it.
  await pause();
  assert.match(source(), /features\?: readonly \{ title: string; text: number \}\[\];/);
  await clear();
});

test('a rename commits on blur, never per keystroke, and keeps the binding working', async () => {
  const { saver, source, pageSource, log } = project();
  await drawPicker(saver);
  await openFeatures();
  const name = () => labelled('Name').querySelector('input');
  await type(name(), 'p');
  await type(name(), 'perks');
  await pause();
  assert.equal(log.edits, 0, 'typing a name writes nothing');
  assert.deepEqual(log.phases, []);
  await act(async () => name().dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  await flush();
  assert.equal(log.edits, 1);
  assert.deepEqual(log.phases, ['saving', 'idle'], 'a rename holds the whole app until the page is replaced');
  const written = source();
  assert.match(written, /perks\?: readonly/, 'the declaration is renamed');
  assert.match(written, /perks: features = \[/, 'the local a binding reads is kept, as the Properties panel keeps it');
  assert.match(written, /Astro\.props\.perks/, 'a direct read follows the new name');
  assert.match(written, /\{features\.map\(/, 'the bound markup still reads a name in scope');
  assert.match(pageSource(), /<PricingCard heading="Plans" perks=\{\[\]\} \/>/, 'the instance passes the new name');

  // The next edit saves under the name the file now holds.
  await type(labelled('Tooltip').querySelector('textarea'), 'Renamed.');
  await pause();
  assert.equal(log.edits, 2);
  assert.match(source(), /\/\*\* Renamed\. \*\/\n {2}perks\?:/);
  await clear();
});

test('Enter commits a rename too', async () => {
  const { saver, source } = project();
  await drawPicker(saver);
  await openFeatures();
  const name = labelled('Name').querySelector('input');
  await type(name, 'perks');
  await act(async () => name.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush();
  assert.match(source(), /perks\?: readonly/);
  await clear();
});

test('an invalid name is not written: the text stays, and the reason shows beside it', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  const name = labelled('Name').querySelector('input');
  await type(name, '9 lives');
  await act(async () => name.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  await flush();
  assert.equal(log.edits, 0);
  assert.equal(source(), COMPONENT);
  assert.equal(labelled('Name').querySelector('input').value, '9 lives');
  assert.match(form().querySelector('[role="alert"]').textContent, /Use a name/);

  // The rest of the form still saves, under the name the file holds.
  await type(labelled('Tooltip').querySelector('textarea'), 'Still saved.');
  await pause();
  assert.equal(log.edits, 1);
  assert.match(source(), /Still saved\./);
  await clear();
});

test('closing the form saves what is pending', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await type(labelled('Tooltip').querySelector('textarea'), 'Saved on the way out.');
  assert.equal(log.edits, 0);
  await click(form().querySelector('[aria-label="Close property settings"]'));
  await flush();
  assert.equal(log.edits, 1);
  assert.match(source(), /Saved on the way out\./);
  assert.equal(form(), undefined);
  assert.equal(document.querySelector('.data-picker').className, 'data-picker', 'the picker is back');
  await clear();
});

test('closing the form commits a name still being typed', async () => {
  const { saver, source } = project();
  await drawPicker(saver);
  await openFeatures();
  await type(labelled('Name').querySelector('input'), 'perks');
  await clear();
  await flush();
  assert.match(source(), /perks\?: readonly/, 'the whole picker going away is a close too');
});

test('the row of a renamed prop opens the prop by its new name', () => {
  // `{ perks: features }` lists `features`, whose prop is now `perks`.
  const keys = modules.propKeysByLocal([{ key: 'perks', local: 'features' }], ['perks', 'heading'], undefined);
  assert.equal(keys.get('features'), 'perks');
  assert.equal(keys.get('heading'), 'heading');
  assert.equal(keys.has('perks'), false, 'nothing reads it by that name');
});

test('the rest binding has no settings row', () => {
  const keys = modules.propKeysByLocal([{ key: 'title', local: 'title' }], ['title'], 'rest');
  assert.deepEqual([...keys.keys()], ['title']);
  assert.deepEqual([...modules.propKeysByLocal([{ key: 'rest', local: 'rest' }], [], 'rest').keys()], []);
});

test('only a prop in a component’s own group qualifies', () => {
  const keyOf = (name) => (name === 'features' ? 'features' : undefined);
  assert.equal(modules.settingsKeyOf({ path: 'features', section: 'props' }, keyOf), 'features');
  assert.equal(modules.settingsKeyOf({ path: 'features', section: 'loop-component' }, keyOf), 'features');
  assert.equal(modules.settingsKeyOf({ path: 'features', section: 'loop' }, keyOf), undefined, 'a loop item sharing the name');
  assert.equal(modules.settingsKeyOf({ path: 'features', section: 'collections' }, keyOf), undefined);
  assert.equal(modules.settingsKeyOf({ path: 'features' }, keyOf), undefined, 'a nested row has no section');
  assert.equal(modules.settingsKeyOf({ path: 'local', section: 'loop-component' }, keyOf), undefined, 'a frontmatter list in the same group');
  assert.equal(modules.settingsKeyOf({ path: 'features', section: 'props' }, undefined), undefined);
});

test('opening and closing the form writes nothing, and the picker is as it was left', async () => {
  const { saver, source, log } = project();
  const picks = await drawPicker(saver, { current: 'heading' });
  await type(document.querySelector('.dp-search input'), 'fea');
  await click(document.querySelector('.dp-settings'));
  await flush();
  assert.ok(form());
  assert.equal(byText('Save'), undefined, 'an existing prop has no Save');
  assert.equal(byText('Cancel'), undefined, 'and nothing to cancel');
  await click(form().querySelector('[aria-label="Close property settings"]'));
  await flush();
  assert.equal(source(), COMPONENT);
  assert.equal(log.edits, 0);
  assert.equal(log.undo.length, 0);
  assert.equal(form(), undefined);
  assert.deepEqual(picks, []);
  assert.equal(document.querySelector('.data-picker').className, 'data-picker', 'the picker is back');
  assert.equal(document.querySelector('.dp-search input').value, 'fea', 'with its search');
  assert.equal(document.activeElement, document.querySelector('.dp-search input'), 'and the keyboard on it');
  await clear();
});

test('reordering options saves at once, as one edit', async () => {
  const { saver, source, log } = project();
  await draw(React.createElement(modules.PropertySettingsDialog, { propertyKey: 'size', saver, onClose() {} }));
  await flush();
  const rows = [...form().querySelectorAll('.property-options .list-field-row')];
  assert.equal(rows.length, 3, 'the three options are listed');
  await drag(rows[0], 'dragstart', 0);
  await drag(rows[2], 'dragover', 119);
  await drag(rows[2], 'drop', 119);
  await flush();
  assert.equal(log.edits, 1);
  assert.match(source(), /size\?: "medium" \| "large" \| "small";/);
  await clear();
});

test('a file changed on disk reloads under the form, and the edit is kept and saved', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  // Someone else's edit lands while the form is open: its source is stale.
  const newer = source().replace('heading: string;', 'heading: string;\n  extra?: string;').replace("/** The plan's features. */", '/** From elsewhere. */');
  fs.writeFileSync(saver.file, newer);
  await click(form().querySelector('input[aria-label="Readonly"]'));
  await flush();
  assert.equal(log.edits, 2, 'refused once, then saved against the file as it is');
  assert.match(source(), /extra\?: string;/, 'the other edit is kept');
  assert.match(source(), /readonly features\?: readonly/, 'and so is this one');
  assert.match(source(), /\/\*\* From elsewhere\. \*\//, 'a field this form did not touch takes the file’s value');
  assert.equal(labelled('Tooltip').querySelector('textarea').value, 'From elsewhere.', 'the form shows it');
  assert.match(form().querySelector('[role="status"]').textContent, /changed on disk/);
  await clear();
});

test('a save the file refuses keeps the text, says why, and is not repeated', async () => {
  const { saver, source, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await click(form().querySelector('.property-code-toggle'));
  const view = modules.EditorView.findFromDOM(form().querySelector('.property-code .cm-editor'));
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'string; }' } }));
  await pause();
  assert.equal(source(), COMPONENT);
  assert.equal(log.edits, 1);
  assert.equal(form().querySelector('[aria-label="Code type"]').textContent, 'string; }', 'the text stays');
  assert.ok(form().querySelector('[role="alert"]'), 'the reason shows beside it');
  await click(form().querySelector('[aria-label="Close property settings"]'));
  await flush();
  assert.equal(log.edits, 1, 'closing does not send the same refusal again');
  await clear();
});

test('a form closed on a refused save says why as a toast', async () => {
  const { saver, log } = project();
  await drawPicker(saver);
  await openFeatures();
  await click(form().querySelector('.property-code-toggle'));
  const view = modules.EditorView.findFromDOM(form().querySelector('.property-code .cm-editor'));
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'string; }' } }));
  await click(form().querySelector('[aria-label="Close property settings"]'));
  await flush();
  assert.equal(log.edits, 1);
  assert.notEqual(toastMessages(), '', 'nothing is lost silently');
  await clear();
});

test('a conflict merges field by field', () => {
  const base = { name: 'a', type: 'string', required: false, readonly: false, defaultValue: '', description: 'old' };
  const draft = { ...base, required: true };
  const fresh = { ...base, description: 'new', editing: { kind: 'editable' } };
  assert.deepEqual(modules.mergedProperty(base, draft, fresh), { ...fresh, required: true });
  assert.deepEqual(
    modules.mergedProperty(base, { ...base, description: 'mine' }, fresh),
    { ...fresh, description: 'mine' },
    'where both changed, the form’s edit stands',
  );
});

test('a whole-site save stops the app, and an edit to this file does not', () => {
  const property = { name: 'b', type: 'string', required: false, readonly: false, defaultValue: '', description: '' };
  assert.equal(modules.savePhaseOf({ kind: 'save', originalName: 'a', property }), 'saving');
  assert.equal(modules.savePhaseOf({ kind: 'save', originalName: 'b', property }), 'autosaving');
});

test('a prop gone from the file says so', async () => {
  const { saver } = project();
  await draw(React.createElement(modules.PropertySettingsDialog, { propertyKey: 'missing', saver, onClose() {} }));
  await flush();
  assert.match(form().textContent, /no longer has a missing property/);
  await clear();
});

test('the field picker and a host without the callback show no gear', async () => {
  const { saver } = project();
  await drawPicker(saver, { propSettings: undefined });
  assert.ok(rowOf('heading'), 'its rows are drawn');
  assert.deepEqual(gears(), []);
  assert.equal(document.querySelectorAll('.dp-settings-slot').length, 0, 'nor room held for one');
  await clear();

  // The bind dot's picker, on a component whose host offers no settings.
  const host = { componentName: 'PricingCard.astro', propKeys: ['features', 'heading'], restLocal: undefined, create: () => ({ ok: true, value: 'x' }) };
  await draw(
    React.createElement(modules.FieldDataPicker, {
      pos: { left: 0, top: 0, width: 300 },
      tree: TREE,
      bindContext: { newProp: host },
      onPick() {},
      onClose() {},
    }),
  );
  await flush();
  assert.ok(rowOf('heading'), 'its rows are drawn');
  assert.deepEqual(gears(), []);
  await clear();
});

test('the bind dot’s picker offers the gear, and still fits rows to the field', async () => {
  const { saver } = project();
  const host = {
    componentName: 'PricingCard.astro',
    propKeys: ['features', 'heading'],
    restLocal: undefined,
    create: () => ({ ok: true, value: 'x' }),
    propSettings: offerFor(saver),
  };
  await draw(
    React.createElement(modules.FieldDataPicker, {
      pos: { left: 0, top: 0, width: 300 },
      tree: TREE,
      bindContext: { newProp: host },
      seed: { fit: 'text', label: 'Title', value: '' },
      onPick() {},
      onClose() {},
    }),
  );
  await flush();
  assert.ok(gears().includes('Edit heading settings'));
  await click(rowOf('heading').querySelector('.dp-settings'));
  await flush();
  assert.equal(labelled('Name').querySelector('input').value, 'heading');
  await clear();
});

test('the Source menu offers the gear on a List prop, never on a frontmatter list', async () => {
  const { saver } = project();
  const host = {
    componentName: 'PricingCard.astro',
    propKeys: ['features'],
    restLocal: undefined,
    create: () => ({ ok: true, value: 'x' }),
    propSettings: offerFor(saver),
  };
  await draw(
    React.createElement(modules.SourcePicker, {
      label: 'Source',
      icon: undefined,
      current: undefined,
      catalog: undefined,
      data: { tree: TREE, samples: {}, frontmatter: '', file: 'src/components/PricingCard.astro' },
      newList: { host, seed: { fit: 'list', label: 'items', value: '' } },
      onPick() {},
    }),
  );
  await click(document.querySelector('.loop-source-trigger'));
  await flush();
  assert.ok(rowOf('features'), 'the List prop is listed');
  assert.ok(rowOf('local'), 'and the frontmatter list beside it');
  assert.deepEqual(gears(), ['Edit features settings']);
  await clear();
});

test('a filter’s Field picker lists an item’s fields, and has no gear', async () => {
  await draw(
    React.createElement(modules.FieldPicker, {
      value: 'title',
      fields: [{ path: 'title', title: 'Title', kind: 'text' }],
      usable: () => true,
      sample: { title: 'One' },
      extras: [],
      onChange() {},
    }),
  );
  await click(document.querySelector('.loop-source-trigger'));
  await flush();
  assert.ok(rowOf('Title'), 'the field is listed');
  assert.deepEqual(gears(), []);
  await clear();
});
