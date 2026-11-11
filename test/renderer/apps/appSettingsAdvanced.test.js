// Goal: a manifest setting marked `advanced` sits under the details popup's
// "Advanced" disclosure at the end of the App settings section. The disclosure
// is a button with aria-expanded, closed by default, and opens on click; it
// opens by itself while an advanced setting is required and empty, so a field
// the app cannot start without is never hidden. When every setting is advanced,
// the section still shows its heading and the disclosure.
// Method: the real AppSettingsSection mounted in JSDOM with a stubbed
// `window.avb.readAppSettings`, the manifests parsed by the real parser, reading
// the DOM after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MouseEvent = dom.window.MouseEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

function bundle(entry, name) {
  const directory = repoPath('node_modules/.stacki-test/app-settings-advanced');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { AppSettingsSection } = bundle('src/features/apps/AppSettings.tsx', 'settings');
const { parseAppSettingDeclarations } = bundle('shared/properties/appSettings.ts', 'parser');

const KEY = { id: 'api-key', label: 'API key', kind: 'secret', required: true };
const ENDPOINT = { id: 'endpoint', label: 'Endpoint', kind: 'url', advanced: true };
const REGION = { id: 'region', label: 'Region', kind: 'text', required: true, advanced: true };

const app = (settings) => ({
  manifest: {
    manifestVersion: 1,
    id: 'heat-map',
    name: 'Heat map',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: [],
    window: { mode: 'popup', widthPx: 300, heightPx: 300 },
    settings: parseAppSettingDeclarations(settings),
    secretsAllowlist: [],
  },
  lock: {
    id: 'heat-map',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'file', fileName: 'heat-map.zip' },
  },
});

async function mount(settings, values) {
  window.avb = { readAppSettings: async () => ({ ok: true, value: values }) };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(AppSettingsSection, { projectPath: '/p', app: app(settings) })));
  // Let the settings read resolve and the form render.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { container, unmount: () => act(async () => root.unmount()).then(() => container.remove()) };
}

const toggle = (container) => container.querySelector('.apps-settings-advanced-toggle');
const labels = (container) => [...container.querySelectorAll('.apps-setting-label')].map((label) => label.firstChild.textContent);

test('advanced settings sit under a closed disclosure that opens on click', async () => {
  const { container, unmount } = await mount([KEY, ENDPOINT], {});
  const button = toggle(container);
  assert.ok(button, 'the disclosure is shown');
  assert.equal(button.tagName, 'BUTTON', 'a native button, so the keyboard reaches it');
  assert.equal(button.getAttribute('type'), 'button', 'it never submits the form');
  assert.equal(button.textContent, 'Advanced');
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'closed by default');
  assert.deepEqual(labels(container), ['API key'], 'only the main setting shows');
  const body = document.getElementById(button.getAttribute('aria-controls'));
  assert.ok(body, 'aria-controls names the body');
  assert.equal(body.hidden, true);
  // The disclosure comes after the main rows and before the Save footer.
  const form = container.querySelector('.apps-settings-form');
  const children = [...form.children];
  assert.ok(children.indexOf(button.parentElement) < children.indexOf(form.querySelector('.apps-details-section-footer')));
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'opens on click');
  assert.equal(body.hidden, false);
  assert.deepEqual(labels(container), ['API key', 'Endpoint']);
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'closes again');
  await unmount();
});

test('a required advanced setting that is empty opens the disclosure by default', async () => {
  const empty = await mount([KEY, REGION], { 'api-key': 'k' });
  assert.equal(toggle(empty.container).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(labels(empty.container), ['API key', 'Region']);
  await empty.unmount();
  const filled = await mount([KEY, REGION], { 'api-key': 'k', region: 'eu' });
  assert.equal(toggle(filled.container).getAttribute('aria-expanded'), 'false', 'filled, it stays closed');
  await filled.unmount();
});

test('when every setting is advanced, the section keeps its heading and the disclosure', async () => {
  const { container, unmount } = await mount([ENDPOINT], {});
  assert.equal(container.querySelector('.apps-details-section h4').textContent, 'App settings');
  assert.equal(toggle(container).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(labels(container), []);
  await unmount();
});

test('a manifest with no advanced settings shows no disclosure', async () => {
  const { container, unmount } = await mount([KEY], {});
  assert.equal(toggle(container) ?? undefined, undefined);
  await unmount();
});
