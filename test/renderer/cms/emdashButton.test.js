// Goal: EmDash in Settings > CMS connections is a button in the CMS row, the same button as Payload and Custom CMS (same
// element, no class of its own, so the same size, radius, type and states), placed after Payload and before Custom CMS,
// wearing the EmDash mark. It opens a popup (the shared popover, role dialog) that says what is true about the project
// and nothing more: skeleton rows while the first read is out, the EmDash starter command when the project has none, and
// for a project that uses EmDash the content types and fields as EmDash defines them, each missing piece in words, where
// the content types came from, and the commands for previewing a customer's real content; it never offers to edit a
// content type. The big inline EmDash card is gone from the page. A project that has EmDash gets a connected mark on the
// button. The popup closes by an outside press, Escape or a second press on the button, every time, and focus returns to
// the button on Escape; Enter and Space (a native button's click) open it. The logo markup is the supplied mark, only
// path and group shapes, filled with currentColor, with no script, foreignObject or external reference. A read that
// fails shows the project as not set up, never an error. The new i18n key exists in all five locales.
// Method: bundle the real CmsConnections and EmDashButton with esbuild, mount them in jsdom over a fake preload bridge
// that answers `cmsConnections` and `emdash:project` from a queue (the answers built by the real parser from the
// fixture's schema file), drive the button with dispatched events, and read the DOM. Waits go through test/helpers/waitFor.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { waitFor } = require('../../helpers/waitFor.js');
const emdash = require('#dist/shared/properties/emdash.js');

const output = repoPath('node_modules/.stacki-test/emdash-button.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: {
    contents: `export { CmsConnections } from './src/features/cmsConnections/CmsConnections';
export { EmDashButton } from './src/features/cmsConnections/EmDashButton';
export { EmDashIcon } from './src/ui/Icons';`,
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const asked = [];
let answer = async () => ({ kind: 'absent' });
window.avb = {
  emDashProject: async (input) => {
    asked.push(input);
    return answer();
  },
  cmsConnections: async () => ({ encryption: 'available', connections: [] }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

const schema = JSON.parse(fs.readFileSync(repoPath('test/fixtures/emdash/site/.emdash/schema.json'), 'utf8'));
const PRESENT = {
  kind: 'present',
  configFile: 'astro.config.mjs',
  output: 'server',
  databaseFile: 'data.db',
  schemaSource: 'database',
  collections: emdash.parseEmDashSchema(schema).value,
  problems: ['uploadsTracked'],
};

let root;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = () => document.querySelector('button[data-cms="emdash"]');
const popup = () => document.querySelector('.emdash-popup');
const event = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const key = (target, name) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const click = () => act(async () => button().dispatchEvent(event('click')));
const pressOutside = () =>
  act(async () => {
    document.body.dispatchEvent(event('pointerdown'));
    document.body.dispatchEvent(event('mousedown'));
  });
const popupGone = (what) => waitFor({ what, read: () => popup() === null, until: Boolean });
const popupShown = (what) => waitFor({ what, read: () => popup() !== null, until: Boolean });

async function mount(element) {
  asked.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  await settle();
}
const mountRow = () => mount(React.createElement(component.CmsConnections, { projectPath: '/project' }));
test.afterEach(async () => {
  await act(async () => root.unmount());
});

test('EmDash is a button in the CMS row, after Payload and before Custom CMS, with the same markup as them', async () => {
  answer = async () => ({ kind: 'absent' });
  await mountRow();
  const row = [...document.querySelectorAll('.cms-connection-actions > button, .cms-connection-actions > * > button')];
  const labels = row.map((item) => item.textContent.trim());
  assert.deepEqual(labels.slice(-3), ['Payload', 'EmDash', 'Custom CMS']);
  const payload = row.find((item) => item.textContent.trim() === 'Payload');
  assert.equal(button().tagName, payload.tagName);
  assert.equal(button().parentElement, payload.parentElement, 'a direct child of the same row');
  assert.equal(button().getAttribute('class'), payload.getAttribute('class'), 'no class of its own: the shared button styling');
  assert.equal(button().getAttribute('type'), 'button');
  assert.equal(button().querySelector('svg').getAttribute('width'), payload.querySelector('svg').getAttribute('width'), 'the same icon size');
  assert.equal(button().getAttribute('aria-haspopup'), 'dialog');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('the inline EmDash card is gone from the page, and nothing shows until the button is pressed', async () => {
  answer = async () => PRESENT;
  await mountRow();
  assert.ok(document.querySelector('.emdash-card') === null);
  assert.ok(document.querySelector('[aria-label="EmDash"][data-cms]') === null);
  assert.ok(popup() === null);
  assert.doesNotMatch(document.body.textContent, /EmDash is not set up/);
});

test('the logo is the supplied mark: path and group shapes in currentColor, nothing that runs or loads', async () => {
  answer = async () => ({ kind: 'absent' });
  await mountRow();
  const svg = button().querySelector('svg');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const allowed = new Set(['svg', 'g', 'path']);
  const elements = [...svg.querySelectorAll('*')];
  for (const element of [svg, ...elements]) {
    assert.ok(allowed.has(element.tagName.toLowerCase()), `only shapes: found <${element.tagName}>`);
    for (const attribute of element.getAttributeNames()) {
      assert.doesNotMatch(attribute, /^(on|href|xlink)/i, `no handler or reference: ${attribute}`);
      assert.doesNotMatch(element.getAttribute(attribute), /url\(|javascript:|https?:/i, `no external reference in ${attribute}`);
    }
  }
  assert.equal(svg.querySelectorAll('path').length, 2, 'the frame and the dash');
  assert.equal(svg.querySelector('g').getAttribute('fill'), 'currentColor');
  assert.equal(svg.querySelectorAll('[fill="white"], [fill="#fff"], [fill="#ffffff"]').length, 0, 'no fixed colour');
  assert.match(svg.querySelectorAll('path')[1].getAttribute('d'), /^M28\.2598 53\.3799H90\.0645V63\.6807H28\.2598V53\.3799Z$/);
});

test('the popup opens on a press, toggles shut on a second press, and the button says so', async () => {
  answer = async () => ({ kind: 'absent' });
  await mountRow();
  await click();
  await popupShown('the popup opens');
  assert.equal(popup().getAttribute('role'), 'dialog');
  assert.equal(popup().getAttribute('aria-label'), 'EmDash');
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.cms-connections').contains(popup()), false, 'the popup is not clipped by the page card');
  await pressOutside();
  await popupGone('an outside press closes it');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('Enter and Space open it as a native button does (a click), and Escape closes it and returns focus to the button', async () => {
  answer = async () => ({ kind: 'absent' });
  await mountRow();
  assert.equal(button().tagName, 'BUTTON', 'a native button: Enter and Space click it');
  assert.equal(button().disabled, false);
  button().focus();
  await click();
  await popupShown('the popup opens');
  await act(async () => key(popup(), 'Escape'));
  await popupGone('Escape closes it');
  assert.equal(document.activeElement, button(), 'focus is back on the button');
  // Every time: open again and close by an outside press, then once more by Escape.
  await click();
  await popupShown('the popup opens again');
  await pressOutside();
  await popupGone('an outside press closes it again');
  await click();
  await popupShown('the popup opens a third time');
  await act(async () => key(popup(), 'Escape'));
  await popupGone('Escape closes it again');
});

test('while the project is read the popup shows skeleton rows, not words', async () => {
  answer = () => new Promise(() => undefined);
  await mountRow();
  await click();
  await popupShown('the popup opens');
  assert.ok(popup().querySelector('.ui-skeleton'));
  assert.equal(popup().querySelector('.ui-skeleton-rows').getAttribute('aria-busy'), 'true');
  assert.ok(popup().querySelector('.ui-skeleton-rows').nextElementSibling === null, 'no placeholder words beside the skeleton');
  assert.ok(button().querySelector('.cms-connect-status') === null, 'no connected mark before it is known');
});

test('a project without EmDash is told how to start one, and the question is asked once, when the row mounts', async () => {
  answer = async () => ({ kind: 'absent' });
  await mountRow();
  assert.deepEqual(asked, [{ projectPath: '/project' }]);
  assert.ok(button().querySelector('.cms-connect-status') === null, 'not connected: no mark');
  await click();
  await popupShown('the popup opens');
  assert.deepEqual(asked, [{ projectPath: '/project' }], 'opening asks nothing again');
  assert.match(popup().textContent, /EmDash is not set up in this project/);
  assert.match(popup().textContent, /Stacki finds EmDash from the project itself/);
  assert.match(popup().querySelector('pre').textContent, /npm create emdash@latest/);
});

test('a project that uses EmDash shows the connected mark on the button and lists its content types exactly as EmDash defines them', async () => {
  answer = async () => PRESENT;
  await mountRow();
  const mark = button().querySelector('.cms-connect-status');
  assert.ok(mark, 'the connected mark shows before the popup is opened');
  assert.equal(mark.getAttribute('aria-label'), 'Set up');
  await click();
  await popupShown('the popup opens');
  const names = [...popup().querySelectorAll('.emdash-collection > summary')].map((node) => node.firstChild.textContent);
  assert.deepEqual(names, ['Posts', 'Case studies']);
  const rows = [...popup().querySelectorAll('.emdash-collection')[0].querySelectorAll('.emdash-field')].map((row) => row.textContent);
  assert.ok(
    rows.some((row) => /Title.*title.*required.*Text/.test(row)),
    'a required text field',
  );
  assert.ok(
    rows.some((row) => /Featured Image.*featured_image.*Image/.test(row)),
    'an image field',
  );
  assert.ok(
    rows.some((row) => /Content.*content.*Rich text/.test(row)),
    'a rich text field',
  );
  assert.ok(
    rows.some((row) => /Layout hint.*Unknown type/.test(row)),
    'a type this version does not know',
  );
  assert.match(popup().querySelector('.emdash-facts').textContent, /data\.db/);
  assert.match(popup().textContent, /Read from the local EmDash database/);
  assert.match(popup().textContent, /when requested \(server\)/);
  assert.match(popup().textContent, /uploads folder is not in \.gitignore/);
  assert.match(popup().textContent, /defined only in EmDash/);
  assert.equal(popup().querySelectorAll('input, textarea, select').length, 0, 'nothing here edits a content type');
});

test('the guide shows the EmDash commands for copying a customer site, and says the local copy is never deployed', async () => {
  answer = async () => PRESENT;
  await mountRow();
  await click();
  await popupShown('the popup opens');
  const commands = [...popup().querySelectorAll('.emdash-guide pre')].map((node) => node.textContent);
  assert.deepEqual(commands, [
    'npx emdash login --url https://customer-site.example',
    'npx emdash site export --url https://customer-site.example --output customer.emdash',
    'npx emdash site import customer.emdash --analyze',
    'npx emdash site import customer.emdash --plan <digest> --confirm',
  ]);
  assert.match(popup().querySelector('.emdash-guide').textContent, /never deployed/);
});

test('a read that fails shows the project as not set up rather than an error', async () => {
  answer = async () => {
    throw new Error('bridge down');
  };
  await mountRow();
  await click();
  await popupShown('the popup opens');
  assert.match(popup().textContent, /EmDash is not set up in this project/);
});

test('the connected label exists in all five locales', () => {
  for (const locale of ['en', 'es', 'fr', 'de', 'ptBR']) {
    const source = fs.readFileSync(repoPath(`shared/properties/i18n/messages/${locale}/emdash.ts`), 'utf8');
    assert.match(source, /'emdash\.button\.connected': '[^']+',/, `${locale} has emdash.button.connected`);
  }
});
