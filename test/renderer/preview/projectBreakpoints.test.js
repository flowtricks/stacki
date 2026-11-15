// Goal: the preview breakpoint bar draws Desktop, Laptop, Tablet, Phone and Canvas in that order at the widths the project's
// breakpoints resolve to (the Lumos defaults 64rem, 48rem and 30rem give 1023, 767 and 479); Settings → Breakpoints shows each as
// `width < 64rem`, takes rem or px, saves `.stacki/breakpoints.json` through the metadata transport, and the bar follows; reading
// never writes; nothing invalid is ever written.
//
//   node test/renderer/preview/projectBreakpoints.test.js
//
// Method: bundle the real DeviceButtons, BreakpointsSettings, the store and the Base-width reader with esbuild and mount them in
// jsdom over one in-memory file store (no real project: the file is a string and every write is logged). Steps: defaults show
// 64rem/48rem/30rem, `Matches width < 64rem`, 1023/767/479 in the bar and no reset button, and write nothing; deviceForWidth and
// deviceWidth agree; Base for a `width >= 30rem` project lands on the phone width; typing updates the query text live;
// committing 800px writes version 2 once with exact bytes and the bar says 799px; Enter commits, Escape reverts, a spaced
// "64 rem" normalizes without a write; syntax errors, decimal px, out-of-range and non-decreasing entries (naming the row) are
// refused with nothing written; retyping a default with no file writes nothing; a corrupt file shows defaults with a notice and
// is never written over; a version 1 file reads at the same widths and is not rewritten by reading.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/project-breakpoints');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'bundle.cjs');
buildSync({
  stdin: {
    contents: `
export { DeviceButtons, deviceForWidth, deviceWidth, DEVICES } from './src/features/preview/PreviewToolbar';
export { BreakpointsSettings } from './src/app/settings/BreakpointsSettings';
export { breakpointsStore, forgetBreakpointStores } from './src/ipc/projectBreakpoints';
export { useProjectBreakpoints } from './src/ipc/useProjectBreakpoints';
export { baseCanvasTarget } from './src/features/style/model/baseWidth';
export { serializeBreakpoints, BREAKPOINT_DEFAULTS, BREAKPOINT_DEFAULT_SETTINGS } from './shared/properties/projectBreakpoints';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  loader: { '.css': 'empty', '.svg': 'dataurl' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});

function memoryStorage(initial) {
  const state = { source: initial, writes: [] };
  return {
    state,
    read: async () => (state.source === undefined ? {} : { source: state.source }),
    write: async ({ source, base }) => {
      assert.equal(base, state.source, 'a write is witnessed by the bytes it read');
      state.writes.push(source);
      state.source = source;
      return { source };
    },
  };
}

// The DOM globals exist before React loads: React decides at load time whether the browser supports the input event.
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
const { window } = dom;
Object.assign(global, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
window.matchMedia = global.matchMedia;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

function setup() {
  document.body.innerHTML = '<div id="root"></div>';
  return createRoot(document.getElementById('root'));
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const bar = () => [...document.querySelectorAll('.device-btns button')].map((button) => button.getAttribute('aria-label'));
const fieldFor = (label) => document.querySelector(`input[aria-label="${label} width in pixels"]`);
async function type(input, text, commit = 'blur') {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  if (commit === 'Enter') {
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  } else {
    await act(async () => input.blur());
  }
  await settle();
}

function Screen(api, projectPath) {
  return function Both() {
    const { widths } = api.useProjectBreakpoints(projectPath);
    return React.createElement(
      React.Fragment,
      undefined,
      React.createElement(api.DeviceButtons, { activeDevice: 'desktop', onDevice: () => undefined, breakpoints: widths }),
      React.createElement(api.BreakpointsSettings, { projectPath }),
    );
  };
}

const card = (label) => fieldFor(label).closest('.breakpoints-card');
const rowText = (label) => card(label).querySelector('.breakpoints-query').textContent;
const key = (input, name) => act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true })));
async function mount(api, name, initial) {
  const root = setup();
  api.forgetBreakpointStores();
  const storage = memoryStorage(initial);
  api.breakpointsStore(name, storage);
  await act(() => root.render(React.createElement(Screen(api, name))));
  await settle();
  return { root, storage };
}

test('defaults: 64rem, 48rem and 30rem, a bar of 1023, 767 and 479, no reset button, nothing written', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-defaults', undefined);
  assert.deepEqual(bar(), ['Desktop — 1', 'Laptop (1023px) — 2', 'Tablet (767px) — 3', 'Phone (479px) — 4', 'Canvas — all breakpoints — 5']);
  assert.deepEqual(
    api.DEVICES.map((device) => device.key),
    ['desktop', 'laptop', 'tablet', 'phone', 'canvas'],
  );
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['64rem', '48rem', '30rem']);
  assert.deepEqual([rowText('Laptop'), rowText('Tablet'), rowText('Phone')], ['Matches width < 64rem', 'Matches width < 48rem', 'Matches width < 30rem']);
  assert.ok(document.querySelector('.breakpoints-reset') === null, 'there is no reset button');
  assert.ok(!/reset/i.test(document.body.textContent), 'nothing says reset');
  assert.equal(storage.state.writes.length, 0, 'reading and rendering never write');
  root.unmount();
});

test('widths map to devices and back, and Base for a 30rem query lands on the phone width', () => {
  const api = require(output);
  const widths = api.BREAKPOINT_DEFAULTS;
  const names = [1440, 1024, 1023, 768, 767, 480, 479, 320].map((px) => api.deviceForWidth(px, widths));
  assert.deepEqual(names, ['desktop', 'desktop', 'laptop', 'laptop', 'tablet', 'tablet', 'phone', 'phone']);
  assert.equal(api.deviceWidth('desktop', widths), undefined);
  assert.equal(api.deviceWidth('canvas', widths), undefined);
  assert.equal(api.deviceWidth('laptop', widths), 1023);
  assert.equal(api.deviceWidth('tablet', widths), 767);
  assert.equal(api.deviceWidth('phone', widths), 479);
  assert.deepEqual(api.baseCanvasTarget(['@media (width >= 30rem)', '@media (width >= 48rem)'], 16), { kind: 'width', widthPx: widths.phone });
});

test('typing shows the query live, committing px saves version 2 once and the bar follows', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-px', undefined);
  const tablet = fieldFor('Tablet');
  await act(async () => {
    tablet.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(tablet, '800');
    tablet.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(rowText('Tablet'), 'Matches width < 800px', 'a bare number reads as px, live');
  await act(async () => tablet.blur());
  await settle();
  assert.deepEqual(storage.state.writes, [api.serializeBreakpoints({ ...api.BREAKPOINT_DEFAULT_SETTINGS, tablet: { value: 800, unit: 'px' } })]);
  assert.equal(JSON.parse(storage.state.source).version, 2);
  assert.equal(fieldFor('Tablet').value, '800px');
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1023px) — 2', 'Tablet (799px) — 3', 'Phone (479px) — 4']);
  await type(fieldFor('Tablet'), '800px');
  assert.equal(storage.state.writes.length, 1, 'the same value again is not an edit');
  root.unmount();
});

test('rem decimals and mixed units save, Enter commits and Escape reverts', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-keys', undefined);
  await type(fieldFor('Laptop'), '62.5rem', 'Enter');
  assert.equal(fieldFor('Laptop').value, '62.5rem');
  assert.equal(storage.state.writes.length, 1);
  assert.deepEqual(bar().slice(1, 2), ['Laptop (999px) — 2']);
  const phone = fieldFor('Phone');
  await act(async () => {
    phone.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(phone, '400');
    phone.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await key(phone, 'Escape');
  assert.equal(fieldFor('Phone').value, '30rem', 'Escape puts the saved value back');
  await act(async () => phone.blur());
  await settle();
  assert.equal(storage.state.writes.length, 1, 'Escape then blur writes nothing');
  await type(fieldFor('Phone'), '400', 'Enter');
  assert.equal(JSON.parse(storage.state.source).phone.unit, 'px', 'units may differ between rows');
  root.unmount();
});

test('a spaced entry for the same value normalizes and writes nothing', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-spaced', undefined);
  await type(fieldFor('Laptop'), '64 rem');
  assert.equal(fieldFor('Laptop').value, '64rem');
  await type(fieldFor('Phone'), '30rem');
  assert.equal(storage.state.writes.length, 0, 'no edit, no file: the defaults are never written unasked');
  assert.equal(storage.state.source, undefined);
  root.unmount();
});

test('invalid entries write nothing and the card says why under its field, keeping what was typed', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-invalid', undefined);
  const cases = [
    ['Tablet', 'abc', /Type a width like 64rem/],
    ['Tablet', '', /Type a width like 64rem/],
    ['Tablet', '48em', /Type a width like 64rem/],
    ['Tablet', '-5px', /Type a width like 64rem/],
    ['Tablet', '1000.5px', /px widths are whole numbers/],
    ['Tablet', '0', /Use a width from 281px to 7681px/],
    ['Tablet', '99999px', /Use a width from 281px to 7681px/],
    ['Tablet', '64rem', /Tablet must be smaller than Laptop \(64rem\)/],
    ['Tablet', '1100px', /Tablet must be smaller than Laptop \(64rem\)/],
    ['Phone', '48rem', /Phone must be smaller than Tablet \(48rem\)/],
    ['Phone', '800', /Phone must be smaller than Tablet \(48rem\)/],
    ['Laptop', '40rem', /Tablet must be smaller than Laptop \(40rem\)/],
  ];
  for (const [label, text, message] of cases) {
    await type(fieldFor(label), text);
    assert.equal(storage.state.writes.length, 0, `${label} ${JSON.stringify(text)} writes nothing`);
    const alert = card(label).querySelector('[role="alert"]');
    assert.ok(alert, `${label} ${JSON.stringify(text)} has an inline message`);
    assert.match(alert.textContent, message);
    assert.equal(card(label).hasAttribute('data-invalid'), true, 'the card takes the error tint');
    assert.equal(fieldFor(label).getAttribute('aria-invalid'), 'true');
    assert.equal(fieldFor(label).value, text, 'what was typed stays to be fixed');
    // Escape puts the saved value back and clears the error.
    await key(fieldFor(label), 'Escape');
    assert.equal(card(label).hasAttribute('data-invalid'), false);
    assert.ok(card(label).querySelector('[role="alert"]') === null);
  }
  assert.equal(storage.state.source, undefined);
  root.unmount();
});

test('each card leads with the preview bar icon for its device, in a tile, with the resolved canvas width', async () => {
  const api = require(output);
  const { root } = await mount(api, 'fixture-cards', undefined);
  const cards = [...document.querySelectorAll('.breakpoints-card')];
  assert.deepEqual(
    cards.map((each) => each.getAttribute('data-breakpoint')),
    ['desktop', 'laptop', 'tablet', 'phone'],
  );
  const barIcons = [...document.querySelectorAll('.device-btns button svg')].map((svg) => svg.innerHTML);
  cards.forEach((each, index) => {
    const tile = each.querySelector('.breakpoints-tile');
    assert.ok(tile, `${each.getAttribute('data-breakpoint')} has an icon tile`);
    assert.equal(tile.querySelector('svg').innerHTML, barIcons[index], `${each.getAttribute('data-breakpoint')} wears the bar's icon`);
  });
  assert.equal(cards[0].querySelector('.breakpoints-pill').textContent, 'Full width');
  assert.ok(cards[0].querySelector('input') === null, 'Desktop has no number');
  assert.deepEqual(
    ['Laptop', 'Tablet', 'Phone'].map((label) => card(label).querySelector('.breakpoints-canvas').textContent),
    ['1023px canvas', '767px canvas', '479px canvas'],
  );
  // The subtitle and the canvas width follow typing.
  const tablet = fieldFor('Tablet');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(tablet, '1000px');
    tablet.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(rowText('Tablet'), 'Matches width < 1000px');
  root.unmount();
});

test('the cards and the first section have their spacing in the stylesheets', () => {
  const css = fs.readFileSync(repoPath('src/app/settings/breakpointsSettings.css'), 'utf8');
  assert.match(css, /\.breakpoints-cards \{[^}]*gap: 8px/);
  assert.match(css, /\.breakpoints-card \{[^}]*padding: 12px/);
  assert.match(css, /\.breakpoints-card \{[^}]*min-height: 64px/);
  assert.match(css, /\.breakpoints-card\[data-invalid\] \{[^}]*background:/);
  const borders = [...css.matchAll(/(?:^|[\s;{])border\s*:\s*([^;\s]+)/g)].map((match) => match[1]);
  assert.ok(
    borders.every((value) => value === '0' || value === 'none'),
    'no borders: fills only',
  );
  const settings = fs.readFileSync(repoPath('src/app/settings/settings.css'), 'utf8');
  assert.match(settings, /\.app-settings-scroll \{[^}]*padding: 20px var\(--settings-gutter\)/s, 'room above the first eyebrow');
});

test('a corrupt file shows the defaults, explains itself, disables the fields and is never written over', async () => {
  const api = require(output);
  const { root, storage } = await mount(api, 'fixture-corrupt', '{ "version": 2, "laptop": 500, "tablet": 800, "phone": 300 }');
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1023px) — 2', 'Tablet (767px) — 3', 'Phone (479px) — 4']);
  assert.match(document.querySelector('[role="alert"]').textContent, /left as it is/);
  assert.equal(fieldFor('Tablet').disabled, true);
  assert.equal(storage.state.writes.length, 0);
  root.unmount();
});

test('a version 1 file reads at the same widths and reading does not rewrite it', async () => {
  const api = require(output);
  const old = JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 });
  const { root, storage } = await mount(api, 'fixture-v1', old);
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1100px) — 2', 'Tablet (800px) — 3', 'Phone (500px) — 4']);
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['1101px', '801px', '501px']);
  assert.equal(storage.state.writes.length, 0);
  assert.equal(storage.state.source, old);
  // An edit rewrites it as version 2.
  await type(fieldFor('Phone'), '450px');
  assert.equal(JSON.parse(storage.state.source).version, 2);
  root.unmount();
  const defaults = await mount(api, 'fixture-v1-defaults', JSON.stringify({ version: 1, laptop: 1023, tablet: 767, phone: 479 }));
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['64rem', '48rem', '30rem']);
  assert.equal(defaults.storage.state.writes.length, 0);
  defaults.root.unmount();
});
