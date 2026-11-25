// The popups a code chip opens are the Style panel's compact editors, anchored under the chip, and a
// layered property's chip opens the panel's whole list.
//
//   node test/renderer/style/codeChipsLayout.test.js
//
// Goal: a gradient (or any chip's) popup is as narrow as the panel's own, starts at the chip and stays
// in the window; a create chip opens its editor and writes nothing until it is used; a transition's
// list chip opens the panel's Transitions rows and an added row is written into the declaration
// alone; the row props a chip hands the panel read and write that one declaration only; and the easing
// editor, opened from a popover, sits above it and is never taller than min(560px, the window less
// 24px) with only its presets scrolling.
// Keyword chips open the panel's own segmented bars (Display, Overflow, the typography bars…), read
// for their selection, their arrow and their menu, empty and set.
// Method: the real code window is bundled and mounted in jsdom through React with a fixed chip box
// (jsdom lays nothing out); chips are pressed with the browser's own event sequence and the popups are
// read from the document. The pure helpers are called directly. The layer order and the easing
// editor's bounds are read from the stylesheets that set them, since jsdom applies no CSS; a Chromium
// check of the same bounds is codeChipsEasingBounds in test/electron when a display is available.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      // The keyword chips read the panel's option tables, whose modules also import these.
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'accent', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--accent)', type: 'Size' });
        onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--brand)', type: 'Size' });
        onAdd({ name: 'ink', collection: 'Sizes', group: '', value: '#000', binding: 'var(--ink)', type: 'Color' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
  'Event',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });
global.IS_REACT_ACT_ENVIRONMENT = true;
// Layout, enough for placement: the page fills the window, a chip sits on its line near the top, and a
// fixed box is where its style says. jsdom lays nothing out, and every box would otherwise be empty.
const CHIP_BOX = { top: 40, bottom: 56, left: 20, right: 80, width: 60, height: 16, x: 20, y: 40 };
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this === document.body || this === document.documentElement) {
    const height = dom.window.innerHeight;
    return { top: 0, bottom: height, left: 0, right: dom.window.innerWidth, width: dom.window.innerWidth, height, x: 0, y: 0 };
  }
  if (this.dataset.codeChip !== undefined) {
    return CHIP_BOX;
  }
  if (this.style.position === 'fixed' && this.style.top.endsWith('px')) {
    const top = Number.parseFloat(this.style.top);
    const height = Number.parseFloat(this.style.height) || 0;
    const left = Number.parseFloat(this.style.left) || 0;
    const width = Number.parseFloat(this.style.width) || 0;
    return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top };
  }
  return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

let surfaces;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/code-chips-layout.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import CodeWindow from './src/features/code/CodeWindow';
        import { codeChipTextOf, useCodeChips } from './src/features/style/codeChips/CodeChips';
        export { chipPopoverSpan, chipDeclarationProps, ChipPopoverBoundary, CHIP_POPOVER_WIDTH_PX, CHIP_POPOVER_EDGE_PX } from './src/features/style/codeChips/CodeChips';
        export { KEYWORD_PROPERTIES, keywordChoices } from './src/features/style/codeChips/keywordOptions';
        export { keywordControlOf } from './src/features/style/codeChips/KeywordChipControl';
        export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';
        export { EditorView } from '@codemirror/view';
        export function CodeWindowSurface({ value, onChange }) {
          const chips = useCodeChips(codeChipTextOf('css'));
          return createElement(CodeWindow, { title: 'site.css', language: 'css', value, onChange, onClose: () => undefined, extensions: chips.extension, overlay: chips.overlay });
        }
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  surfaces = require(output);
});

const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const waitUntil = (what, until) =>
  waitFor({
    what,
    read: async () => {
      await settle();
      return until();
    },
    until: (held) => held,
  });
const press = async (element) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const escape = async () => {
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
};
const popover = () => document.querySelector('.embed-editor_layer-popover');

async function mount(value) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Owner() {
    const [text, setText] = React.useState(value);
    return React.createElement(surfaces.CodeWindowSurface, { value: text, onChange: setText });
  }
  await act(async () => {
    root.render(React.createElement(Owner));
  });
  await waitUntil('the editor draws its chips', () => host.querySelector('.cm-editor [data-code-chip]') !== null);
  const view = surfaces.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { view, host, done };
}

test('a chip’s popup is the panel’s width at most, starts at the chip and stays in the window', () => {
  const { chipPopoverSpan, CHIP_POPOVER_WIDTH_PX: width, CHIP_POPOVER_EDGE_PX: edge } = surfaces;
  assert.deepEqual(chipPopoverSpan({ left: 100 }, width, 1400), { left: 100, width });
  assert.deepEqual(chipPopoverSpan({ left: 1300 }, width, 1400), { left: 1400 - edge - width, width }, 'shifted in from the right edge');
  assert.deepEqual(chipPopoverSpan({ left: -40 }, width, 1400), { left: edge, width }, 'never past the left edge');
  assert.deepEqual(chipPopoverSpan({ left: 0 }, width, 300), { left: edge, width: 300 - edge * 2 }, 'a narrow window narrows it');
  assert.throws(() => chipPopoverSpan({ left: 0 }, 0, 300), /a popup has a width/);
});

test('the row props read and write the one declaration, and nothing else', () => {
  const writes = [];
  const props = surfaces.chipDeclarationProps({ property: 'transition', value: 'opacity 1s', original: 'opacity 1s' }, (value, phase) =>
    writes.push(`${phase}:${value}`),
  );
  assert.equal(props.read('transition').selectedValue.value, 'opacity 1s');
  assert.equal(props.read('transition').source, 'selected', 'the value reads as set, in blue');
  assert.equal(props.read('perspective'), undefined);
  props.liveSetProp('transition', 'opacity 2s', false);
  props.setProp('transition', 'opacity 3s', false);
  props.setProp('perspective', '10px', false);
  props.liveSetProp('transition', undefined, false);
  props.clearProp(['transition']);
  props.clearProp('transform-origin');
  assert.deepEqual(writes, ['live:opacity 2s', 'commit:opacity 3s', 'live:opacity 1s', 'commit:none']);
  const empty = surfaces.chipDeclarationProps({ property: 'box-shadow', value: '', original: '' }, (value) => writes.push(value));
  empty.liveSetProp('box-shadow', undefined, false);
  assert.equal(writes.length, 4, 'undoing a live write to a created value has nothing to put back');
});

test('a gradient chip opens the gradient editor compact, under the chip', async () => {
  dom.window.innerWidth = 1400;
  const { view, done } = await mount('.a {\n  background-image: linear-gradient(180deg, #e30e0e, #9ef4ff);\n}');
  const chip = view.contentDOM.querySelector('[data-code-chip="gradient"]');
  assert.ok(chip, 'the gradient has its chip');
  await press(chip);
  await waitUntil('the gradient popover is placed', () => popover()?.style.visibility === 'visible');
  const box = popover();
  assert.equal(box.style.width, `${surfaces.CHIP_POPOVER_WIDTH_PX}px`, 'the panel’s width, not the editor’s');
  assert.equal(box.style.left, `${CHIP_BOX.left}px`, 'it starts at the chip');
  await escape();
  await waitUntil('the popover closes', () => popover() === null);
  await done();
});

test('a create chip opens its editor and writes nothing until it is used', async () => {
  const { view, done } = await mount('.a {\n  background-image:\n}');
  // The code window keeps the file's own indentation; the text as mounted is the baseline.
  const source = view.state.doc.toString();
  const create = view.contentDOM.querySelector('.code-chip.is-create');
  assert.ok(create, 'an empty background image has its create chip');
  assert.equal(create.dataset.codeChip, 'layers', 'it opens the Image & gradient list');
  await press(create);
  await waitUntil('the gradient editor opens', () => popover() !== null);
  assert.equal(view.state.doc.toString(), source, 'opening writes nothing');
  await escape();
  await waitUntil('the popover closes', () => popover() === null);
  assert.equal(view.state.doc.toString(), source, 'closing without a change leaves the document as it was');
  await done();
});

test('a transition’s list chip opens the panel’s Transitions rows, and an added row is written in place', async () => {
  const { view, done } = await mount('.a {\n  transition: opacity 200ms ease, padding 577ms ease-in-out !important;\n  color: red;\n}');
  const source = view.state.doc.toString();
  const chip = view.contentDOM.querySelector('[data-code-chip="layers"]');
  assert.ok(chip, 'the transition has its list chip');
  await press(chip);
  await waitUntil('the Transitions rows are drawn', () => popover()?.querySelectorAll('.embed-editor_bg-layer-label').length === 2);
  const add = popover().querySelector('.embed-editor_bg-layers-head .embed-editor_icon-btn');
  assert.ok(add, 'the list has its add button');
  await press(add);
  await waitUntil('the added row is written', () => view.state.doc.toString() !== source);
  const text = view.state.doc.toString();
  assert.match(text, /transition: opacity 200ms ease, padding 577ms ease-in-out, [^;!]+ !important;/, 'one more layer, `!important` kept');
  assert.equal(text.slice(text.indexOf('!important')), source.slice(source.indexOf('!important')), 'nothing after the value changed');
  const labels = [...popover().querySelectorAll('.embed-editor_bg-layer-label')].map((label) => label.textContent);
  assert.equal(labels.length, 3, 'the list shows the added row');
  await escape();
  await done();
});

const popovers = () => [...document.querySelectorAll('.embed-editor_layer-popover')];
const pressChip = async (view, kind) => {
  const chip = view.contentDOM.querySelector(`[data-code-chip="${kind}"]`);
  assert.ok(chip, `the ${kind} chip is drawn`);
  await press(chip);
};
const closeAll = async () => {
  // Escape closes the topmost popover; a bounded number of presses closes them all.
  for (let count = 0; count < 4 && popovers().length > 0; count++) {
    await escape();
  }
  await waitUntil('every popover is closed', () => popovers().length === 0);
};

test('a one-layer value opens on that layer’s fields; several layers open as the list', async () => {
  const single = await mount('.a {\n  filter: blur(2px);\n}');
  await pressChip(single.view, 'layers');
  await waitUntil('the list and its one layer’s editor are open', () => popovers().length === 2);
  assert.equal(popovers()[0].querySelectorAll('.embed-editor_bg-layer-label').length, 1, 'the list shows its one row');
  assert.ok(popovers()[1].querySelector('.embed-editor_filter-editor'), 'the filter’s fields are open under it');
  await closeAll();
  await single.done();

  const several = await mount('.a {\n  transform: translateX(1px) scale(2) rotate(3deg);\n}');
  await pressChip(several.view, 'layers');
  await waitUntil('the list is drawn', () => popovers()[0]?.querySelectorAll('.embed-editor_bg-layer-label').length === 3);
  await settle();
  assert.equal(popovers().length, 1, 'with several layers, no layer is opened for the person');
  await closeAll();
  await several.done();
});

test('a created list opens its first layer’s fields as it is added', async () => {
  const { view, done } = await mount('.a {\n  box-shadow:\n}');
  const before = view.state.doc.toString();
  await press(view.contentDOM.querySelector('.code-chip.is-create'));
  await waitUntil('the empty list opens', () => popovers().length === 1);
  assert.equal(view.state.doc.toString(), before, 'opening writes nothing');
  await press(popovers()[0].querySelector('.embed-editor_bg-layers-head .embed-editor_icon-btn'));
  await waitUntil('the added shadow’s editor opens under the list', () => popovers().length === 2);
  assert.match(view.state.doc.toString(), /box-shadow: [^;\n]+;/, 'the first layer is written, with its `;`');
  await closeAll();
  await done();
});

test('a background image list opens its one layer’s editor, Type row first, inside the popover', async () => {
  const { view, done } = await mount('.a {\n  background-image: linear-gradient(180deg, #e30e0e, #9ef4ff);\n}');
  await pressChip(view, 'layers');
  await waitUntil('the layer editor is open', () => popovers()[0]?.querySelector('.embed-editor_bg-editor') !== null);
  const editor = popovers()[0].querySelector('.embed-editor_bg-editor');
  assert.ok(editor.querySelector('[role="radiogroup"]'), 'the Type row is there');
  assert.equal(popovers()[0].querySelectorAll('.embed-editor_bg-layer-label').length, 1);
  await closeAll();
  await done();
});

test('a gradient chip has the Type row, and a switch keeps the stops', async () => {
  const { view, done } = await mount('.a {\n  background: linear-gradient(90deg, #ff0000 10%, #0000ff 80%);\n}');
  await pressChip(view, 'gradient');
  await waitUntil('the gradient editor is open', () => popovers()[0]?.querySelector('[role="radiogroup"]') !== null);
  const radios = [...popovers()[0].querySelectorAll('[role="radiogroup"] [role="radio"]')];
  assert.ok(radios.length >= 2, 'linear and radial are offered');
  await press(radios[1]);
  await waitUntil('the gradient is written as radial', () => view.state.doc.toString().includes('radial-gradient('));
  assert.match(view.state.doc.toString(), /radial-gradient\([^)]*#ff0000 10%, #0000ff 80%\)/, 'the stops and their positions are kept');
  await closeAll();
  await done();
});

test('a keyword chip opens the panel’s own bar, the current value selected, and a pick writes only the keyword', async () => {
  const { view, done } = await mount('.a {\n  text-align: center !important;\n  display: inline-flex;\n}');
  const align = view.contentDOM.querySelector('[data-code-chip="keyword"]');
  const keywordChips = [...view.contentDOM.querySelectorAll('[data-code-chip="keyword"]')];
  assert.equal(keywordChips.length, 2);
  assert.notEqual(keywordChips[0].innerHTML, keywordChips[1].innerHTML, 'center shows its own icon, display the generic one');
  await press(align);
  await waitUntil('the panel’s text-align bar opens', () => popovers()[0]?.querySelector('.embed-editor_display') !== null);
  const radios = [...popovers()[0].querySelectorAll('.embed-editor_display [role="radio"]')];
  const checked = radios.filter((radio) => radio.getAttribute('aria-checked') === 'true');
  assert.equal(checked.length, 1, 'one value is selected');
  assert.equal(checked[0].getAttribute('aria-label'), 'Center', 'the current value');
  assert.ok(checked[0].classList.contains('is-selected'), 'drawn with the panel’s filled selection');
  assert.ok(popovers()[0].querySelector('.embed-editor_display-arrow'), 'the arrow for the rest, as in the panel');
  const right = radios.find((radio) => radio.getAttribute('aria-label') === 'Right');
  await press(right);
  await waitUntil('the popover closes after the pick', () => popovers().length === 0);
  assert.match(view.state.doc.toString(), /text-align: right !important;/, 'the keyword is replaced and `!important` kept');

  await press(view.contentDOM.querySelectorAll('[data-code-chip="keyword"]')[1]);
  await waitUntil('display opens the panel’s display bar', () => popovers()[0]?.querySelector('.embed-editor_display') !== null);
  const bar = popovers()[0].querySelector('.embed-editor_display');
  assert.deepEqual(
    [...bar.querySelectorAll('.embed-editor_display-seg')].map((segment) => segment.textContent),
    ['Block', 'Flex', 'Grid', 'In-flex'],
    'Block, Flex, Grid, and the fourth slot showing the current inline value',
  );
  assert.deepEqual(
    [...bar.querySelectorAll('.embed-editor_display-seg.is-selected')].map((segment) => segment.textContent),
    ['In-flex'],
    'the current value is the selected segment',
  );
  assert.ok(popovers()[0].querySelector('[role="listbox"]') === null, 'no list under the bar: the rest is behind the arrow');
  await press(bar.querySelector('.embed-editor_display-arrow'));
  await waitUntil('the arrow opens the panel’s menu', () => popovers()[0]?.querySelector('.embed-editor_display-menu') !== null);
  const menu = popovers()[0].querySelector('.embed-editor_display-menu');
  for (const label of ['Inline-block', 'Inline-flex', 'Inline-grid', 'Inline', 'None', 'Contents']) {
    assert.match(menu.textContent, new RegExp(label), `${label} is in the menu`);
  }
  await closeAll();
  await done();
});

test('an empty keyword property’s create chip opens the same bar with nothing selected', async () => {
  const { view, done } = await mount('.a {\n  display:\n}');
  const before = view.state.doc.toString();
  const create = view.contentDOM.querySelector('.code-chip.is-create');
  assert.equal(create.dataset.codeChip, 'keyword');
  await press(create);
  await waitUntil('the bar opens', () => popovers()[0]?.querySelector('.embed-editor_display') !== null);
  assert.equal(view.state.doc.toString(), before, 'opening writes nothing');
  const bar = popovers()[0].querySelector('.embed-editor_display');
  assert.equal(bar.classList.contains('is-custom'), false, 'the bar, not the custom field');
  assert.equal(bar.querySelectorAll('.is-selected').length, 0, 'nothing is selected yet');
  const flex = [...bar.querySelectorAll('.embed-editor_display-seg')].find((segment) => segment.textContent === 'Flex');
  await press(flex);
  await waitUntil('the popover closes', () => popovers().length === 0);
  assert.match(view.state.doc.toString(), /display: flex;/);
  await done();
});

test('a property the panel offers as a dropdown opens its list, and a pick inserts the value', async () => {
  const { view, done } = await mount('.a {\n  position:\n}');
  await press(view.contentDOM.querySelector('.code-chip.is-create'));
  await waitUntil('the list opens', () => popovers()[0]?.querySelector('[role="listbox"]') !== null);
  const relative = [...popovers()[0].querySelectorAll('[role="option"]')].find((row) => row.textContent === 'Relative');
  await press(relative);
  await waitUntil('the popover closes', () => popovers().length === 0);
  assert.match(view.state.doc.toString(), /position: relative;/);
  await done();
});

test('every property the panel edits with a bar opens that bar, empty with nothing selected and set with its value', async () => {
  const barred = Object.keys(surfaces.KEYWORD_PROPERTIES).filter((property) => surfaces.keywordControlOf(property) !== 'list');
  assert.ok(barred.length >= 10, 'the segmented properties are many');
  for (const property of barred) {
    const { segments, list } = surfaces.keywordChoices(property, surfaces.ENGLISH_TRANSLATE);
    const value = [...segments, ...list][0].value;
    const { view, done } = await mount(`.a {\n  ${property}:\n  --x: 1;\n}\n.b {\n  ${property}: ${value};\n}`);
    const [empty, set] = view.contentDOM.querySelectorAll('[data-code-chip="keyword"]');
    await press(empty);
    await waitUntil(`${property}: the bar opens`, () => popovers()[0]?.querySelector('.embed-editor_display') !== null);
    const emptyBar = popovers()[0].querySelector('.embed-editor_display');
    assert.equal(emptyBar.classList.contains('is-custom'), false, `${property}: an empty value is the bar, not the custom field`);
    assert.equal(emptyBar.querySelectorAll('.is-selected').length, 0, `${property}: nothing is selected`);
    assert.ok(emptyBar.querySelector('.embed-editor_display-arrow'), `${property}: the panel’s arrow`);
    await closeAll();
    await press(set);
    await waitUntil(`${property}: the set bar opens`, () => popovers()[0]?.querySelector('.embed-editor_display') !== null);
    assert.equal(popovers()[0].querySelectorAll('.embed-editor_display .is-selected').length, 1, `${property}: ${value} is selected`);
    await closeAll();
    await done();
  }
});

// Any popup a chip opens: a layer popover, the easing sheet, the colour picker.
const anyPopup = () => document.querySelector('.embed-editor_layer-popover, .embed-editor_ease-modal, .u-color-picker');
const closeEveryPopup = async (name) => {
  for (let count = 0; count < 4 && anyPopup() !== null; count++) {
    await escape();
  }
  await waitUntil(`every popup is closed${name === undefined ? '' : ` (${name})`}`, () => anyPopup() === null);
};

// Every keyword property empty and set, and every other create chip: one stylesheet, each chip pressed
// in turn. A press must open a popup, never reach the code view's error boundary, and never log a
// render error ("Objects are not valid as a React child" was the one that reached the user).
test('every chip of every kind opens its popup, and none throws', async () => {
  const declarations = [];
  for (const property of Object.keys(surfaces.KEYWORD_PROPERTIES)) {
    const { segments, list } = surfaces.keywordChoices(property, surfaces.ENGLISH_TRANSLATE);
    declarations.push(`${property}: ;`, `${property}: ${[...segments, ...list][0].value};`);
  }
  for (const property of [
    'transition',
    'transform',
    'filter',
    'backdrop-filter',
    'box-shadow',
    'text-shadow',
    'background-image',
    'clip-path',
    'animation-timing-function',
    'background',
    'color',
    'border-color',
    'outline-color',
  ]) {
    declarations.push(`${property}: ;`);
  }
  const errors = [];
  const consoleError = console.error;
  console.error = (...parts) => {
    errors.push(parts.map(String).join(' '));
  };
  try {
    // A few declarations per editor: jsdom draws only the lines it thinks are on screen.
    const CHUNK = 8;
    for (let start = 0; start < declarations.length; start += CHUNK) {
      const chunk = declarations.slice(start, start + CHUNK);
      const { view, host, done } = await mount(`.a {\n${chunk.map((line) => `  ${line}`).join('\n')}\n}`);
      const count = view.contentDOM.querySelectorAll('[data-code-chip]').length;
      assert.ok(count >= chunk.length, `every declaration has its chip (${count} for ${chunk.join(' ')})`);
      for (let index = 0; index < count; index++) {
        const chip = view.contentDOM.querySelectorAll('[data-code-chip]')[index];
        const name = `${chip.dataset.codeChip} chip (${chip.getAttribute('aria-label')}) in ${chunk.join(' ')}`;
        await press(chip);
        await waitUntil(`${name} opens a popup`, () => anyPopup() !== null);
        assert.ok(host.querySelector('.panel-boundary') === null, `${name}: the code view is still there`);
        await closeEveryPopup(name);
      }
      assert.ok(view.contentDOM.isConnected, 'the editor is still mounted');
      await done();
    }
  } finally {
    console.error = consoleError;
  }
  const renderErrors = errors.filter((line) => /not valid as a React child|chip’s popup failed|Assertion failed/.test(line));
  assert.deepEqual(renderErrors, [], 'no chip’s popup failed to render');
});

test('a popup that fails to render closes by itself and leaves the editor', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let closed = 0;
  function Broken() {
    throw new Error('a broken editor');
  }
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          { className: 'editor' },
          React.createElement('span', { className: 'still-here' }, 'code'),
          React.createElement(surfaces.ChipPopoverBoundary, { onFailure: () => (closed += 1) }, React.createElement(Broken)),
        ),
      );
    });
  } finally {
    console.error = consoleError;
  }
  assert.equal(closed, 1, 'the failed popup asks to close');
  assert.ok(container.querySelector('.still-here'), 'what is around it still renders');
  await act(async () => root.unmount());
  container.remove();
});
