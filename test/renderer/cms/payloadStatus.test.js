// Goal: a saved Payload connection's card says what is true and nothing more: it starts "not checked yet"
// (opening Settings must not log in anywhere), Test connection shows who the account is or why it fails in
// the server's own words, says which collections change live content, shows the snippet a site's pages use
// without the key, and Disconnect hands the connection back to the list.
// Method: bundle the real PayloadStatus with esbuild, mount it in jsdom over a fake preload bridge that
// answers Test connection from a queue, and click through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/payload-status.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: { contents: "export { PayloadStatus } from './src/features/cmsConnections/PayloadStatus';", resolveDir: repoPath('.'), loader: 'ts' },
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
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const asked = [];
const answers = [];
window.avb = {
  checkCmsConnection: async (input) => {
    asked.push(input);
    return answers.shift();
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

const CONNECTION = {
  kind: 'payload',
  id: '11111111-2222-3333-4444-555555555555',
  label: 'Payload',
  baseUrl: 'http://localhost:3101',
  collection: 'users',
  auth: 'apiKey',
  email: undefined,
  collections: [],
};
const SUMMARY = {
  user: 'admin@example.test',
  mode: 'apiKey',
  checkedAt: new Date().toISOString(),
  graphql: true,
  locales: ['en'],
  collections: [
    { slug: 'posts', drafts: true, upload: false },
    { slug: 'pages', drafts: false, upload: false },
    { slug: 'media', drafts: false, upload: true },
  ],
};
let root;
let disconnected = 0;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount(connection = CONNECTION) {
  asked.length = 0;
  disconnected = 0;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(component.PayloadStatus, { projectPath: '/project', connection, onDisconnect: () => (disconnected += 1) })),
  );
  await settle();
}
test.afterEach(async () => {
  await act(async () => root.unmount());
});
const press = async (text) => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
  assert.ok(button, `the ${text} button exists`);
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
};

test('a card starts unchecked and asks nothing of the server until Test connection is pressed', async () => {
  await mount();
  assert.match(document.querySelector('.cms-payload-chip').textContent, /Not checked yet/);
  assert.equal(asked.length, 0);
});

test('Test connection shows who the account is, when, and which collections change live', async () => {
  await mount();
  answers.push({ ok: true, summary: SUMMARY });
  await press('Test connection');
  assert.deepEqual(asked, [{ projectPath: '/project', request: { action: 'test', id: CONNECTION.id } }]);
  assert.match(document.querySelector('.cms-payload-chip').textContent, /Connected as admin@example\.test/);
  assert.match(document.querySelector('.cms-payload-time').textContent, /Checked/);
  assert.match(document.querySelector('.cms-payload-live').textContent, /Edits apply live in: pages$/);
});

test('an API key with no email says the key is valid', async () => {
  await mount();
  answers.push({ ok: true, summary: { ...SUMMARY, user: 'users' } });
  await press('Test connection');
  assert.match(document.querySelector('.cms-payload-chip').textContent, /API key valid/);
});

test('a failure shows the server’s reason, the chip says not connected, and the person can test again', async () => {
  await mount();
  answers.push({ ok: false, message: 'Too many attempts; try again in about 10 minutes.' });
  await press('Test connection');
  assert.match(document.querySelector('.cms-payload-chip').textContent, /Not connected/);
  assert.match(document.querySelector('.cms-payload-problem').textContent, /Too many attempts/);
  answers.push({ ok: true, summary: SUMMARY });
  await press('Test connection');
  assert.ok(!document.querySelector('.cms-payload-problem'));
});

test('the snippet shows the address and the variable names, never a key', async () => {
  await mount();
  await press('Use it in your site');
  const text = document.querySelector('.cms-payload-snippet').textContent;
  assert.match(text, /PAYLOAD_URL=http:\/\/localhost:3101/);
  assert.match(text, /PAYLOAD_API_KEY=<your API key>/);
  assert.match(text, /users API-Key \$\{import\.meta\.env\.PAYLOAD_API_KEY\}/);
});

test('Disconnect hands the connection back', async () => {
  await mount();
  await press('Disconnect');
  assert.equal(disconnected, 1);
});
