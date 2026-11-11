// Goal: saving an app's settings tells the running app (`settings.change`),
// whether they were saved from its details popup (where `app.openSettings`
// leads) or its setup prompt. The event names the ids whose saved values
// changed, never their values (the app reads them with `settings.get`), and a
// save that changed nothing sends nothing.
// Method: the real AppSettingsSection and apps runtime, bundled together so they
// share one runtime, mounted in JSDOM with a stubbed `window.avb` that reads
// and writes settings; a fake app frame window records what Stacki posts it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, ROOT } = require('../../helpers/sources');

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

const directory = repoPath('node_modules/.stacki-test/app-settings-change');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'entry.cjs');
esbuild.buildSync({
  stdin: {
    contents: `
      export { AppSettingsSection } from './src/features/apps/AppSettings.tsx';
      export { attachAppFrame, configureAppsRuntime, subscribeAppFrameForTests, resetAppsRuntime } from './src/features/apps/appsRuntime.ts';
      export { parseAppSettingDeclarations } from './shared/properties/appSettings.ts';
      export { ADMIN_VIEW } from './shared/properties/projectRoles.ts';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
  logLevel: 'silent',
});
const kit = require(outfile);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');

const app = {
  manifest: {
    manifestVersion: 1,
    id: 'pins',
    name: 'Pins',
    version: '1.0.0',
    entry: 'index.html',
    window: { mode: 'panel', widthPx: undefined, heightPx: undefined },
    shortcutClaims: [],
    settings: kit.parseAppSettingDeclarations([
      { id: 'channel', label: 'Channel', kind: 'text' },
      { id: 'endpoint', label: 'Endpoint', kind: 'url' },
    ]),
    secretsAllowlist: [],
    permissions: [],
  },
  lock: { source: { kind: 'file', fileName: 'pins.zip' } },
};

test('saving settings sends settings.change with the changed ids, and nothing when nothing changed', async () => {
  let stored = { channel: 'general' };
  window.avb = {
    readAppSettings: async () => ({ ok: true, value: stored }),
    writeAppSettings: async (input) => {
      stored = input.values;
      return { ok: true, value: stored };
    },
  };
  kit.resetAppsRuntime();
  kit.configureAppsRuntime({}, () => kit.ADMIN_VIEW);
  const posted = [];
  const frame = { postMessage: (message) => posted.push(message) };
  const detach = kit.attachAppFrame(frame, app);
  kit.subscribeAppFrameForTests(frame, 'settings.change');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(kit.AppSettingsSection, { projectPath: '/p', app })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const form = container.querySelector('.apps-settings-form');
  assert.ok(form, 'the settings form shows');

  // Nothing changed: a save tells the app nothing.
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(posted.length, 0);

  const input = container.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, 'launches');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('.apps-settings-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(posted, [{ stacki: 'host', v: 1, event: 'settings.change', data: { ids: ['channel'] } }]);
  assert.equal(stored.channel, 'launches', 'the value was saved first');

  await act(async () => root.unmount());
  container.remove();
  detach();
});
