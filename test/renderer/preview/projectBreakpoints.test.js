// Goal: the preview bar draws one device per breakpoint (the wider ones, Desktop, the narrower ones, then the canvas) at the widths
// the project's breakpoints resolve to; Settings > Breakpoints shows a card per breakpoint with the bar's icon, edits their numbers,
// adds new ones (wider than `width >= X`, or narrower than `width < X`), removes any, and saves `.stacki/breakpoints.json` through the
// metadata transport; the bar follows; reading never writes; nothing invalid is ever written.
//
//   node test/renderer/preview/projectBreakpoints.test.js
//
// Method: bundle the real DeviceButtons, BreakpointsSettings, the store, the device model and the icon geometry with esbuild and mount
// them in jsdom over one in-memory file store (no real project: the file is a string and every write is logged). Steps: defaults show
// 64rem, 48rem and 30rem as `width < X` with canvas 1023, 767 and 479 and no reset button, and write nothing; the device model maps
// widths, shortcuts and icons by position (the first wider breakpoint, later ones, the narrower-than-phone one); editing writes version
// 3 once and the bar follows; Enter commits and Escape reverts; invalid and out-of-order entries write nothing and say why; adding a
// wider or narrower breakpoint inserts it by size with a default name and writes; invalid adds are refused; removing writes and the
// bar loses it, asks first only when synced queries are remembered, and records an undo step; the list may be emptied; a corrupt file
// shows the defaults and is never written over; versions 1 and 2 read at the same widths without a write.
const assert = require('node:assert/strict');
const { assertSameElement } = require('../../helpers/domIdentity.js');
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
export { DeviceButtons, DEVICES } from './src/features/preview/PreviewToolbar';
export { barDevices, deviceForShortcut, deviceForWidth, deviceWidth, iconFor } from './src/features/preview/breakpointDevices';
export { BreakpointsSettings } from './src/app/settings/BreakpointsSettings';
export { ConfirmHost } from './src/ui/ConfirmDialog';
export { breakpointsStore, forgetBreakpointStores } from './src/ipc/projectBreakpoints';
export { useProjectBreakpoints } from './src/ipc/useProjectBreakpoints';
export { baseCanvasTarget } from './src/features/style/model/baseWidth';
export { macbookAir, studioDisplayXdr, television, smartwatch1, studioDisplay, tablet, phone } from './src/ui/central/centralGeometry';
export { DesktopIcon, LaptopIcon, StudioDisplayXdrIcon, TelevisionIcon, SmartwatchIcon, TabletIcon } from './src/ui/Icons';
export { serializeBreakpoints, BREAKPOINT_DEFAULTS, BREAKPOINT_DEFAULT_LIST, BREAKPOINT_DEFAULT_CONFIG, resolveBreakpoints } from './shared/properties/projectBreakpoints';`,
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
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
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
  HTMLDialogElement: window.HTMLDialogElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
window.matchMedia = global.matchMedia;
window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { renderToStaticMarkup } = require('react-dom/server');
const api = require(output);

function setup() {
  document.body.innerHTML = '<div id="root"></div>';
  return createRoot(document.getElementById('root'));
}

const settle = (ms = 20) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const bar = () => [...document.querySelectorAll('.device-btns button')].map((button) => button.getAttribute('aria-label'));
const fieldFor = (label) => document.querySelector(`input[aria-label="${label} width in pixels"]`);
const desktopField = () => document.querySelector('input[aria-label="Desktop width in pixels"]');
const nameFor = (label) => document.querySelector(`input[aria-label="Name of ${label}"]`);
const card = (label) => fieldFor(label).closest('.breakpoints-card');
const cardIds = () => [...document.querySelectorAll('.breakpoints-card')].map((each) => each.getAttribute('data-breakpoint'));
const rowText = (label) => card(label).querySelector('.breakpoints-query').textContent;
const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const key = (input, name) => act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true })));
const setValue = (input, text) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
async function type(input, text, commit = 'blur') {
  await act(async () => {
    input.focus();
    setValue(input, text);
  });
  if (commit === 'Enter') {
    await key(input, 'Enter');
  } else if (commit === 'none') {
    return;
  } else {
    await act(async () => input.blur());
  }
  await settle();
}
const saved = (storage) => JSON.parse(storage.state.source).breakpoints;
const savedValue = (storage, id) => saved(storage).find((entry) => entry.id === id);

function Screen(projectPath, onRecordUndo) {
  return function Both() {
    const { resolved } = api.useProjectBreakpoints(projectPath);
    return React.createElement(
      React.Fragment,
      undefined,
      React.createElement(api.ConfirmHost),
      React.createElement(api.DeviceButtons, { activeDevice: 'desktop', onDevice: () => undefined, breakpoints: resolved }),
      React.createElement(api.BreakpointsSettings, { projectPath, onRecordUndo }),
    );
  };
}

async function mount(name, initial, onRecordUndo) {
  const root = setup();
  api.forgetBreakpointStores();
  const storage = memoryStorage(initial);
  api.breakpointsStore(name, storage);
  await act(() => root.render(React.createElement(Screen(name, onRecordUndo))));
  await settle();
  return { root, storage };
}

const versionFour = (breakpoints, desktop = { value: 90, unit: 'rem' }) => JSON.stringify({ version: 4, desktop, breakpoints });
const entryOf = (id, value, unit = 'rem', extra = {}) => ({ id, value, unit, ...extra });
const down = entryOf;
const up = entryOf;

test('defaults: 64rem, 48rem and 30rem as width < X, a bar of 1023, 767 and 479, no reset button, nothing written', async () => {
  const { root, storage } = await mount('fixture-defaults', undefined);
  assert.deepEqual(bar(), ['Desktop — 1', 'Laptop (1023px) — 2', 'Tablet (767px) — 3', 'Phone (479px) — 4', 'Canvas — all breakpoints — 5']);
  assert.deepEqual(cardIds(), ['desktop', 'laptop', 'tablet', 'phone']);
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['64rem', '48rem', '30rem']);
  assert.deepEqual(
    [rowText('Laptop'), rowText('Tablet'), rowText('Phone')],
    ['Matches width < 64rem · narrower than Desktop', 'Matches width < 48rem · narrower than Desktop', 'Matches width < 30rem · narrower than Desktop'],
  );
  assert.equal(desktopField().value, '90rem', 'Desktop has a number: 90rem by default');
  assert.equal(
    document.querySelector('[data-breakpoint="desktop"] .breakpoints-query').textContent,
    'Frame width in the side-by-side view. Never used as a media query.',
  );
  assert.equal(document.querySelector('[data-breakpoint="desktop"] .breakpoints-canvas').textContent, '1440px frame');
  assert.ok(document.querySelector('.breakpoints-reset') === null, 'there is no reset button');
  assert.ok(!/reset/i.test(document.body.textContent), 'nothing says reset');
  assert.equal(storage.state.writes.length, 0, 'reading and rendering never write');
  root.unmount();
});

test('the device model: widths to devices, shortcuts follow the bar, both directions', () => {
  const lumos = api.BREAKPOINT_DEFAULTS;
  const names = [1440, 1024, 1023, 768, 767, 480, 479, 320].map((px) => api.deviceForWidth(px, lumos));
  assert.deepEqual(names, ['desktop', 'desktop', 'laptop', 'laptop', 'tablet', 'tablet', 'phone', 'phone']);
  assert.equal(api.deviceWidth('desktop', lumos), undefined);
  assert.equal(api.deviceWidth('canvas', lumos), undefined);
  assert.deepEqual(
    ['laptop', 'tablet', 'phone'].map((id) => api.deviceWidth(id, lumos)),
    [1023, 767, 479],
  );
  const wide = api.resolveBreakpoints([
    { id: 'bp-2', name: undefined, direction: 'up', setting: { value: 120, unit: 'rem' } },
    { id: 'bp-1', name: undefined, direction: 'up', setting: { value: 100, unit: 'rem' } },
    ...api.BREAKPOINT_DEFAULT_LIST,
  ]);
  assert.deepEqual(
    [1599, 1600, 1919, 1920, 5000, 1023, 1024].map((px) => api.deviceForWidth(px, wide)),
    ['desktop', 'bp-1', 'bp-1', 'bp-2', 'bp-2', 'laptop', 'desktop'],
  );
  assert.deepEqual(
    api.barDevices(wide).map((device) => device.key),
    ['bp-2', 'bp-1', 'desktop', 'laptop', 'tablet', 'phone', 'canvas'],
  );
  assert.deepEqual(
    ['1', '2', '3', '4', '5', '6', '7', '8', '0', 'a'].map((digit) => api.deviceForShortcut(digit, wide)),
    ['bp-2', 'bp-1', 'desktop', 'laptop', 'tablet', 'phone', 'canvas', undefined, undefined, undefined],
  );
  assert.equal(api.deviceForShortcut('1', []), 'desktop');
  assert.deepEqual(api.baseCanvasTarget(['@media (width >= 30rem)', '@media (width >= 48rem)'], 16), { kind: 'width', widthPx: 479 });
});

test('icons are chosen by position: first wider is the studio display, later ones the television, below the phone the smartwatch', () => {
  const list = api.resolveBreakpoints(
    [
      { id: 'bp-2', name: undefined, direction: 'up', setting: { value: 120, unit: 'rem' } },
      { id: 'bp-1', name: undefined, direction: 'up', setting: { value: 100, unit: 'rem' } },
      { id: 'bp-3', name: undefined, direction: 'up', setting: { value: 140, unit: 'rem' } },
    ]
      .sort((first, second) => second.setting.value - first.setting.value)
      .concat(api.BREAKPOINT_DEFAULT_LIST, [
        { id: 'bp-4', name: 'Between', direction: 'down', setting: { value: 40, unit: 'rem' } },
        { id: 'bp-5', name: 'Watch', direction: 'down', setting: { value: 20, unit: 'rem' } },
      ]),
  );
  const sorted = api.resolveBreakpoints([...list].sort((first, second) => second.widthPx - first.widthPx || 0));
  const iconOf = (id) =>
    api.iconFor(
      sorted.find((breakpoint) => breakpoint.id === id),
      sorted,
    );
  assert.equal(iconOf('bp-1'), 'studioDisplayXdr', 'the one closest above Desktop');
  assert.equal(iconOf('bp-2'), 'television');
  assert.equal(iconOf('bp-3'), 'television');
  assert.equal(iconOf('laptop'), 'laptop');
  assert.equal(iconOf('tablet'), 'tablet');
  assert.equal(iconOf('phone'), 'phone');
  assert.equal(iconOf('bp-5'), 'smartwatch', 'narrower than the phone');
  assert.equal(iconOf('bp-4'), 'tablet', 'between the tablet and the phone it wears the nearest device');
});

test('each new icon exists in both variants, and all of them differ from one another and from the old ones', () => {
  const geometries = {
    macbookAir: api.macbookAir,
    studioDisplayXdr: api.studioDisplayXdr,
    television: api.television,
    smartwatch1: api.smartwatch1,
    studioDisplay: api.studioDisplay,
    tablet: api.tablet,
    phone: api.phone,
  };
  const marks = new Map();
  for (const [name, geometry] of Object.entries(geometries)) {
    assert.ok(geometry.compact && geometry.standard, `${name} has both variants`);
    for (const variant of ['compact', 'standard']) {
      const markup = renderToStaticMarkup(geometry[variant]);
      assert.ok(/ d="[^"]+"/.test(markup), `${name} ${variant} draws paths`);
      assert.ok(!marks.has(markup), `${name} ${variant} differs from ${marks.get(markup)}`);
      marks.set(markup, `${name} ${variant}`);
    }
  }
  const draw = (Icon) => renderToStaticMarkup(React.createElement(Icon, { size: 13 }));
  const drawn = [api.DesktopIcon, api.LaptopIcon, api.StudioDisplayXdrIcon, api.TelevisionIcon, api.SmartwatchIcon].map(draw);
  assert.equal(new Set(drawn).size, drawn.length, 'the bar draws five different icons');
});

test('editing a number saves version 4 once and the bar follows', async () => {
  const { root, storage } = await mount('fixture-edit', undefined);
  const tablet = fieldFor('Tablet');
  await act(async () => {
    tablet.focus();
    setValue(tablet, '800');
  });
  assert.equal(rowText('Tablet'), 'Matches width < 800px · narrower than Desktop', 'a bare number reads as px, live');
  await act(async () => tablet.blur());
  await settle();
  assert.equal(storage.state.writes.length, 1);
  assert.equal(JSON.parse(storage.state.source).version, 4);
  assert.deepEqual(JSON.parse(storage.state.source).desktop, { value: 90, unit: 'rem' }, 'Desktop is written with the list');
  assert.deepEqual(
    saved(storage).map((entry) => [entry.id, entry.value, entry.unit, 'direction' in entry]),
    [
      ['laptop', 64, 'rem', false],
      ['tablet', 800, 'px', false],
      ['phone', 30, 'rem', false],
    ],
    'no direction is written',
  );
  assert.equal(fieldFor('Tablet').value, '800px');
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1023px) — 2', 'Tablet (799px) — 3', 'Phone (479px) — 4']);
  await type(fieldFor('Tablet'), '800px');
  assert.equal(storage.state.writes.length, 1, 'the same value again is not an edit');
  root.unmount();
});

test('rem decimals and mixed units save, Enter commits and Escape reverts', async () => {
  const { root, storage } = await mount('fixture-keys', undefined);
  await type(fieldFor('Laptop'), '62.5rem', 'Enter');
  assert.equal(fieldFor('Laptop').value, '62.5rem');
  assert.equal(storage.state.writes.length, 1);
  assert.deepEqual(bar().slice(1, 2), ['Laptop (999px) — 2']);
  const phone = fieldFor('Phone');
  await act(async () => {
    phone.focus();
    setValue(phone, '400');
  });
  await key(phone, 'Escape');
  assert.equal(fieldFor('Phone').value, '30rem', 'Escape puts the saved value back');
  await act(async () => phone.blur());
  await settle();
  assert.equal(storage.state.writes.length, 1, 'Escape then blur writes nothing');
  await type(fieldFor('Phone'), '400', 'Enter');
  assert.equal(savedValue(storage, 'phone').unit, 'px', 'units may differ between rows');
  root.unmount();
});

test('a spaced entry for the same value normalizes and writes nothing', async () => {
  const { root, storage } = await mount('fixture-spaced', undefined);
  await type(fieldFor('Laptop'), '64 rem');
  assert.equal(fieldFor('Laptop').value, '64rem');
  await type(fieldFor('Phone'), '30rem');
  assert.equal(storage.state.writes.length, 0, 'no edit, no file: the defaults are never written unasked');
  assert.equal(storage.state.source, undefined);
  root.unmount();
});

test('invalid and out-of-order entries write nothing and the card says why under its field', async () => {
  const { root, storage } = await mount('fixture-invalid', undefined);
  const cases = [
    ['Tablet', 'abc', /Type a width like 64rem/],
    ['Tablet', '', /Type a width like 64rem/],
    ['Tablet', '1000.5px', /px widths are whole numbers/],
    ['Tablet', '0', /Use a width from 281px to 7681px/],
    ['Tablet', '99999px', /Use a width from 281px to 7681px/],
    ['Tablet', '64rem', /Tablet must be smaller than Laptop \(64rem\)/],
    ['Tablet', '1100px', /Tablet must be smaller than Laptop \(64rem\)/],
    ['Phone', '48rem', /Phone must be smaller than Tablet \(48rem\)/],
    ['Laptop', '40rem', /Laptop must be larger than Tablet \(48rem\)/],
  ];
  for (const [label, text, message] of cases) {
    await type(fieldFor(label), text);
    assert.equal(storage.state.writes.length, 0, `${label} ${JSON.stringify(text)} writes nothing`);
    const alert = card(label).querySelector('[role="alert"]');
    assert.ok(alert, `${label} ${JSON.stringify(text)} has an inline message`);
    assert.match(alert.textContent, message);
    assert.equal(card(label).hasAttribute('data-invalid'), true);
    assert.equal(fieldFor(label).value, text, 'what was typed stays to be fixed');
    await key(fieldFor(label), 'Escape');
    assert.equal(card(label).hasAttribute('data-invalid'), false);
  }
  assert.equal(storage.state.source, undefined);
  root.unmount();
});

test('each card leads with the bar icon for its device, in a tile, with its query and resolved canvas width', async () => {
  const list = versionFour([
    up('bp-2', 120, 'rem', { name: 'Huge' }),
    up('bp-1', 100, 'rem', { name: 'Large' }),
    down('laptop', 64),
    down('phone', 30),
    down('bp-3', 18, 'rem', { name: 'Watch' }),
  ]);
  const { root } = await mount('fixture-cards', list);
  assert.deepEqual(cardIds(), ['bp-2', 'bp-1', 'desktop', 'laptop', 'phone', 'bp-3']);
  assert.deepEqual(bar(), [
    'Huge (1920px) — 1',
    'Large (1600px) — 2',
    'Desktop — 3',
    'Laptop (1023px) — 4',
    'Phone (479px) — 5',
    'Watch (287px) — 6',
    'Canvas — all breakpoints — 7',
  ]);
  const barIcons = [...document.querySelectorAll('.device-btns button svg')].map((svg) => svg.innerHTML);
  const cards = [...document.querySelectorAll('.breakpoints-card')];
  cards.forEach((each, index) => {
    assert.equal(each.querySelector('.breakpoints-tile svg').innerHTML, barIcons[index], `${each.getAttribute('data-breakpoint')} wears the bar's icon`);
  });
  assert.equal(new Set(barIcons.slice(0, 6)).size, 6, 'six different icons for six devices');
  assert.equal(card('Huge').querySelector('.breakpoints-canvas').textContent, '1920px canvas');
  assert.equal(rowText('Huge'), 'Matches width >= 120rem · wider than Desktop');
  assert.equal(rowText('Laptop'), 'Matches width < 64rem · narrower than Desktop');
  assert.equal(card('Watch').querySelector('.breakpoints-canvas').textContent, '287px canvas');
  assert.ok(document.querySelector('[data-breakpoint="desktop"] input') !== null, 'Desktop has a number');
  assert.ok(document.querySelector('[data-breakpoint="desktop"] .breakpoints-remove') === null);
  root.unmount();
});

const addButton = () => document.querySelector('.breakpoints-add');
const addCard = () => document.querySelector('[data-breakpoint="new"]');
const addValue = () => addCard().querySelector('.breakpoints-input');
test('adding a breakpoint: no direction to choose, the side follows the number, it is inserted by size and saved without one', async () => {
  const { root, storage } = await mount('fixture-add-up', undefined);
  await click(addButton());
  assert.ok(addCard(), 'a card to fill in appears');
  assert.ok(addCard().querySelector('.breakpoints-direction') === null, 'there is no wider or narrower to choose');
  assert.ok(!/Wider than|Narrower than/.test(addCard().textContent));
  assert.equal(addButton().disabled, true, 'one card is added at a time');
  const nameInput = addCard().querySelector('.breakpoints-name-input');
  assert.equal(nameInput.value, '', 'the name reads as text, empty until typed');
  assert.equal(nameInput.getAttribute('placeholder'), 'Large', 'with the default name as its placeholder');
  assertSameElement(document.activeElement, addValue(), 'the value is focused as the card opens');
  assert.equal(storage.state.writes.length, 0, 'nothing is written until it is added');
  assert.equal(addCard().querySelector('.breakpoints-query').textContent, 'Matches width >= 100rem · wider than Desktop');
  await act(async () => {
    setValue(addValue(), '120rem');
  });
  assert.equal(addCard().querySelector('.breakpoints-query').textContent, 'Matches width >= 120rem · wider than Desktop', 'live as it is typed');
  assert.equal(addCard().querySelector('.breakpoints-canvas').textContent, '1920px canvas');
  await key(addValue(), 'Enter');
  await settle();
  assert.ok(addCard() === null, 'the card becomes a breakpoint');
  assert.deepEqual(cardIds(), ['bp-1', 'desktop', 'laptop', 'tablet', 'phone']);
  assert.equal(storage.state.writes.length, 1);
  assert.deepEqual(savedValue(storage, 'bp-1'), { id: 'bp-1', name: 'Large', value: 120, unit: 'rem' });
  assert.deepEqual(bar(), [
    'Large (1920px) — 1',
    'Desktop — 2',
    'Laptop (1023px) — 3',
    'Tablet (767px) — 4',
    'Phone (479px) — 5',
    'Canvas — all breakpoints — 6',
  ]);
  assert.equal(rowText('Large'), 'Matches width >= 120rem · wider than Desktop');
  // A second one, wider than Desktop but narrower than the first, goes under it and takes the next default name.
  await click(addButton());
  assert.equal(addCard().querySelector('.breakpoints-name-input').getAttribute('placeholder'), 'Extra large');
  await act(async () => setValue(addValue(), '100rem'));
  await click(addCard().querySelector('.breakpoints-add-confirm'));
  await settle();
  assert.deepEqual(cardIds(), ['bp-1', 'bp-2', 'desktop', 'laptop', 'tablet', 'phone']);
  assert.equal(bar()[1], 'Extra large (1600px) — 2');
  root.unmount();
});

test('a number narrower than Desktop is a width < X breakpoint among the narrower ones', async () => {
  const { root, storage } = await mount('fixture-add-down', undefined);
  await click(addButton());
  await act(async () => setValue(addValue(), '40rem'));
  assert.equal(addCard().querySelector('.breakpoints-query').textContent, 'Matches width < 40rem · narrower than Desktop');
  assert.equal(addCard().querySelector('.breakpoints-name-input').getAttribute('placeholder'), 'Small', 'the default name follows the side');
  assert.equal(addCard().querySelector('.breakpoints-canvas').textContent, '639px canvas');
  await key(addValue(), 'Enter');
  await settle();
  assert.deepEqual(cardIds(), ['desktop', 'laptop', 'tablet', 'bp-1', 'phone']);
  assert.deepEqual(savedValue(storage, 'bp-1'), { id: 'bp-1', name: 'Small', value: 40, unit: 'rem' });
  assert.equal(rowText('Small'), 'Matches width < 40rem · narrower than Desktop');
  assert.equal(bar()[3], 'Small (639px) — 4');
  root.unmount();
});

test('the add card shows the icon the new breakpoint will get, live', async () => {
  const { root } = await mount('fixture-add-icon', undefined);
  await click(addButton());
  const tileIcon = () => addCard().querySelector('.breakpoints-tile svg').innerHTML;
  const draw = (Icon) =>
    renderToStaticMarkup(React.createElement(Icon, { size: 16 }))
      .replace(/^<svg[^>]*>/, '')
      .replace(/<\/svg>$/, '');
  await act(async () => setValue(addValue(), '100rem'));
  assert.equal(tileIcon(), draw(api.StudioDisplayXdrIcon), 'the first wider one is the studio display');
  await act(async () => setValue(addValue(), '18rem'));
  assert.equal(tileIcon(), draw(api.SmartwatchIcon), 'narrower than the phone is the watch');
  await act(async () => setValue(addValue(), '40rem'));
  assert.equal(tileIcon(), draw(api.TabletIcon), 'between the others, the nearest device');
  root.unmount();
});

test('adds that do not fit write nothing and say why: syntax, the same as Desktop, the same value, the name, the count', async () => {
  const { root, storage } = await mount('fixture-add-bad', undefined);
  await click(addButton());
  const attempt = async (value) => {
    await act(async () => setValue(addValue(), value));
    return addCard().querySelector('[role="alert"]')?.textContent;
  };
  assert.match(await attempt('abc'), /Type a width like 64rem/);
  assert.match(await attempt('90rem'), /It must differ from Desktop \(90rem\)/);
  assert.match(await attempt('1440px'), /It must differ from Desktop \(90rem\)/);
  assert.match(await attempt('64rem'), /Laptop already uses 64rem/);
  assert.equal(addCard().querySelector('.breakpoints-add-confirm').disabled, true);
  await act(async () => setValue(addCard().querySelector('.breakpoints-name-input'), 'laptop'));
  await act(async () => setValue(addValue(), '100rem'));
  assert.match(addCard().querySelector('[role="alert"]').textContent, /A name is 1 to 24 characters, and each one is different/);
  await key(addValue(), 'Enter');
  await settle();
  assert.equal(storage.state.writes.length, 0, 'none of it was written');
  await key(addValue(), 'Escape');
  assert.ok(addCard() === null, 'Escape closes the card');
  root.unmount();
  const crowded = Array.from({ length: 11 }, (_, index) => down(`bp-${index + 1}`, 85 - index * 5, 'rem', { name: `N${index}` }));
  const full = await mount('fixture-add-full', versionFour(crowded));
  assert.equal(addButton().disabled, true, 'eleven is the most');
  assert.match(document.body.textContent, /up to 11 breakpoints/);
  full.root.unmount();
});

test('the add card is one deliberate layout: Cancel then Add, Add blue and disabled while the value is wrong', async () => {
  const { root } = await mount('fixture-add-actions', undefined);
  await click(addButton());
  const actions = [...addCard().querySelectorAll('.breakpoints-add-actions button')];
  assert.deepEqual(
    actions.map((button) => button.textContent),
    ['Cancel', 'Add'],
  );
  assert.ok(actions[1].classList.contains('primary'), 'Add is the shared primary variant');
  assert.equal(actions[1].disabled, true, 'nothing to add yet');
  await act(async () => setValue(addValue(), '100rem'));
  assert.equal(actions[1].disabled, false);
  await act(async () => setValue(addValue(), 'nope'));
  assert.equal(actions[1].disabled, true);
  const order = [...addCard().querySelectorAll('input, button')].map((element) => element.className.split(' ')[0]);
  assert.deepEqual(order, ['breakpoints-name-input', 'breakpoints-input', 'breakpoints-add-cancel', 'primary'.length ? 'primary' : '']);
  await click(actions[0]);
  assert.ok(addCard() === null, 'Cancel closes it');
  root.unmount();
});

test('Desktop has a number: its frame width, never a media query; moving it is limited by the breakpoints around it', async () => {
  const { root, storage } = await mount('fixture-desktop', undefined);
  assert.equal(desktopField().value, '90rem');
  await type(desktopField(), '1600px');
  assert.equal(storage.state.writes.length, 1);
  assert.deepEqual(JSON.parse(storage.state.source).desktop, { value: 1600, unit: 'px' });
  assert.equal(document.querySelector('[data-breakpoint="desktop"] .breakpoints-canvas').textContent, '1600px frame');
  assert.deepEqual(
    saved(storage).map((entry) => entry.id),
    ['laptop', 'tablet', 'phone'],
    'the breakpoints are untouched',
  );
  assert.deepEqual(bar().slice(0, 2), ['Desktop — 1', 'Laptop (1023px) — 2'], 'the bar does not change: Desktop is still full width');
  // Below the largest narrower breakpoint is refused, naming it.
  const writes = storage.state.writes.length;
  await type(desktopField(), '60rem');
  assert.equal(storage.state.writes.length, writes, 'nothing is written');
  assert.match(card('Desktop').querySelector('[role="alert"]').textContent, /Laptop \(64rem\) would end up on the other side of Desktop/);
  await key(desktopField(), 'Escape');
  await type(desktopField(), 'abc');
  assert.match(card('Desktop').querySelector('[role="alert"]').textContent, /Type a width like 64rem/);
  root.unmount();
  const wide = await mount('fixture-desktop-wide', versionFour([up('bp-1', 100, 'rem', { name: 'Large' }), down('laptop', 64)]));
  await type(desktopField(), '100rem');
  assert.match(card('Desktop').querySelector('[role="alert"]').textContent, /Large \(100rem\) would end up on the other side of Desktop/);
  await type(desktopField(), '70rem');
  assert.equal(wide.storage.state.writes.length, 1, 'between the two is allowed');
  wide.root.unmount();
});

test('a breakpoint cannot be typed across Desktop: the card says so', async () => {
  const { root, storage } = await mount('fixture-cross', undefined);
  await type(fieldFor('Laptop'), '95rem');
  assert.match(card('Laptop').querySelector('[role="alert"]').textContent, /Laptop must be smaller than Desktop \(90rem\)/);
  assert.equal(storage.state.writes.length, 0);
  await key(fieldFor('Laptop'), 'Escape');
  root.unmount();
  const wider = await mount('fixture-cross-up', versionFour([up('bp-1', 100, 'rem', { name: 'Large' })]));
  await type(fieldFor('Large'), '80rem');
  assert.match(card('Large').querySelector('[role="alert"]').textContent, /Large must be larger than Desktop \(90rem\)/);
  assert.equal(wider.storage.state.writes.length, 0);
  wider.root.unmount();
});

test('removing a breakpoint writes the list without it; the bar loses it; one undo step goes back', async () => {
  const undo = [];
  const { root, storage } = await mount('fixture-remove', undefined, (command) => undo.push(command));
  await click(card('Tablet').querySelector('.breakpoints-remove'));
  await settle();
  assert.deepEqual(
    saved(storage).map((entry) => entry.id),
    ['laptop', 'phone'],
  );
  assert.deepEqual(bar(), ['Desktop — 1', 'Laptop (1023px) — 2', 'Phone (479px) — 3', 'Canvas — all breakpoints — 4']);
  assert.match(document.body.textContent, /does not change your CSS/);
  assert.equal(undo.length, 1);
  assert.equal(undo[0].label, 'Tablet');
  await undo[0].undo();
  await settle();
  assert.deepEqual(
    saved(storage).map((entry) => entry.id),
    ['laptop', 'tablet', 'phone'],
  );
  await undo[0].redo();
  await settle();
  assert.deepEqual(
    saved(storage).map((entry) => entry.id),
    ['laptop', 'phone'],
  );
  root.unmount();
});

test('the list may be emptied: only Desktop and the canvas are left, and the file says so', async () => {
  const { root, storage } = await mount('fixture-empty', undefined);
  for (const label of ['Laptop', 'Tablet', 'Phone']) {
    await click(card(label).querySelector('.breakpoints-remove'));
    await settle();
  }
  assert.deepEqual(saved(storage), []);
  assert.deepEqual(bar(), ['Desktop — 1', 'Canvas — all breakpoints — 2']);
  assert.deepEqual(cardIds(), ['desktop']);
  root.unmount();
});

test('removing one whose synced queries are remembered asks first; cancelling keeps it', async () => {
  window.avb = {
    projectMetadata: async ({ kind }) => ({
      ok: true,
      value: kind === 'breakpointSync' ? { source: JSON.stringify({ version: 1, tablet: { linked: [{ file: 'src/a.css', locator: '00000001:0' }] } }) } : {},
    }),
  };
  const { root, storage } = await mount('fixture-remove-ask', undefined);
  await click(card('Tablet').querySelector('.breakpoints-remove'));
  await settle(80);
  const dialog = document.querySelector('.confirm-dialog');
  assert.ok(dialog, 'the app dialog asks');
  assert.match(dialog.textContent, /Remove Tablet\?/);
  assert.match(dialog.textContent, /1 media query was synced with this breakpoint\. It stays as it is\./);
  const cancel = [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Cancel');
  await click(cancel);
  await settle(300);
  assert.equal(storage.state.writes.length, 0);
  assert.ok(fieldFor('Tablet'), 'it is still there');
  await click(card('Tablet').querySelector('.breakpoints-remove'));
  await settle(80);
  await click([...document.querySelectorAll('.confirm-dialog button')].find((button) => button.textContent.trim() === 'Remove'));
  await settle(300);
  assert.deepEqual(
    saved(storage).map((entry) => entry.id),
    ['laptop', 'phone'],
  );
  window.avb = undefined;
  root.unmount();
});

test('renaming a breakpoint saves the name; a taken or empty name is refused', async () => {
  const { root, storage } = await mount('fixture-rename', undefined);
  await type(nameFor('Phone'), 'Mobile', 'Enter');
  assert.equal(savedValue(storage, 'phone').name, 'Mobile');
  assert.ok(fieldFor('Mobile'), 'the card and the bar take the new name');
  assert.equal(bar()[3], 'Mobile (479px) — 4');
  const writes = storage.state.writes.length;
  await type(nameFor('Tablet'), 'laptop', 'Enter');
  assert.equal(storage.state.writes.length, writes, 'a name another breakpoint has is refused');
  assert.match(card('Tablet').querySelector('[role="alert"]').textContent, /A name is 1 to 24 characters/);
  await type(nameFor('Tablet'), '   ', 'Enter');
  assert.equal(storage.state.writes.length, writes);
  root.unmount();
});

test('a corrupt file shows the defaults, explains itself, disables every field and is never written over', async () => {
  const { root, storage } = await mount('fixture-corrupt', '{ "version": 3, "breakpoints": [ { "id": 5 } ] }');
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1023px) — 2', 'Tablet (767px) — 3', 'Phone (479px) — 4']);
  assert.match(document.querySelector('[role="alert"]').textContent, /left as it is/);
  assert.equal(fieldFor('Tablet').disabled, true);
  assert.equal(addButton().disabled, true);
  assert.equal(card('Tablet').querySelector('.breakpoints-remove').disabled, true);
  assert.equal(storage.state.writes.length, 0);
  root.unmount();
});

test('versions 1 and 2 read at the same widths and reading does not rewrite them; an edit writes version 4', async () => {
  const versionOne = JSON.stringify({ version: 1, laptop: 1100, tablet: 800, phone: 500 });
  const first = await mount('fixture-versionOne', versionOne);
  assert.deepEqual(bar().slice(1, 4), ['Laptop (1100px) — 2', 'Tablet (800px) — 3', 'Phone (500px) — 4']);
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['1101px', '801px', '501px']);
  assert.equal(first.storage.state.writes.length, 0);
  assert.equal(first.storage.state.source, versionOne);
  await type(fieldFor('Phone'), '450px');
  assert.equal(JSON.parse(first.storage.state.source).version, 4);
  first.root.unmount();
  const defaults = await mount('fixture-versionOne-defaults', JSON.stringify({ version: 1, laptop: 1023, tablet: 767, phone: 479 }));
  assert.deepEqual([fieldFor('Laptop').value, fieldFor('Tablet').value, fieldFor('Phone').value], ['64rem', '48rem', '30rem']);
  assert.equal(defaults.storage.state.writes.length, 0);
  defaults.root.unmount();
  const versionTwo = JSON.stringify({ version: 2, laptop: { value: 70, unit: 'rem' }, tablet: { value: 48, unit: 'rem' }, phone: { value: 30, unit: 'rem' } });
  const second = await mount('fixture-versionTwo', versionTwo);
  assert.deepEqual(bar().slice(1, 2), ['Laptop (1119px) — 2']);
  assert.equal(second.storage.state.writes.length, 0);
  second.root.unmount();
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
