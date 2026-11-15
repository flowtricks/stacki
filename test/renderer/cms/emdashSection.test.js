// Goal: the EmDash card in Settings says what is true about the project and nothing more: a skeleton while it reads,
// the EmDash setup commands when the project has none, and for a project that uses it the content types and fields
// as EmDash defines them (labels, slugs, what each binds to), each missing piece in words, where the content types
// came from, and the commands for previewing a customer's real content; it never offers to edit a content type.
// A host that cannot read EmDash (Studio) shows nothing; a read that fails shows the card as absent, never an error.
// Method: bundle the real EmDashSection with esbuild, mount it in jsdom over a fake preload bridge that answers
// `emdash:project` from a queue (the answers built by the real parser from the fixture's schema file), and read the DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const emdash = require('#dist/shared/properties/emdash.js');

const output = repoPath('node_modules/.stacki-test/emdash-section.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: { contents: "export { EmDashSection } from './src/features/cmsConnections/EmDashSection';", resolveDir: repoPath('.'), loader: 'ts' },
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
let answer = async () => ({ kind: 'absent' });
window.avb = {
  emDashProject: async (input) => {
    asked.push(input);
    return answer();
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
async function mount() {
  asked.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(component.EmDashSection, { projectPath: '/project' })));
}
test.afterEach(async () => {
  await act(async () => root.unmount());
});

test('while the project is read the card shows skeleton rows, not words', async () => {
  answer = () => new Promise(() => undefined);
  await mount();
  assert.ok(document.querySelector('.ui-skeleton'));
  assert.equal(document.querySelector('.ui-skeleton-rows').getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelector('.ui-skeleton-rows').nextElementSibling === null, 'no placeholder words beside the skeleton');
});

test('a project without EmDash is told how to start one, and the question is asked once', async () => {
  answer = async () => ({ kind: 'absent' });
  await mount();
  await settle();
  assert.deepEqual(asked, [{ projectPath: '/project' }]);
  assert.match(document.body.textContent, /EmDash is not set up in this project/);
  assert.match(document.querySelector('.emdash-card pre').textContent, /npm create emdash@latest/);
});

test('a project that uses EmDash lists its content types and fields exactly as EmDash defines them', async () => {
  answer = async () => PRESENT;
  await mount();
  await settle();
  const names = [...document.querySelectorAll('.emdash-collection > summary')].map((node) => node.firstChild.textContent);
  assert.deepEqual(names, ['Posts', 'Case studies']);
  const rows = [...document.querySelectorAll('.emdash-collection')[0].querySelectorAll('.emdash-field')].map((row) => row.textContent);
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
  assert.match(document.querySelector('.emdash-facts').textContent, /data\.db/);
  assert.match(document.body.textContent, /Read from the local EmDash database/);
  assert.match(document.body.textContent, /when requested \(server\)/);
  assert.match(document.body.textContent, /uploads folder is not in \.gitignore/);
  assert.match(document.body.textContent, /defined only in EmDash/);
  assert.equal(document.querySelectorAll('input, textarea, select').length, 0, 'nothing here edits a content type');
});

test('the guide shows the EmDash commands for copying a customer site, and says the local copy is never deployed', async () => {
  answer = async () => PRESENT;
  await mount();
  await settle();
  const commands = [...document.querySelectorAll('.emdash-guide pre')].map((node) => node.textContent);
  assert.deepEqual(commands, [
    'npx emdash login --url https://customer-site.example',
    'npx emdash site export --url https://customer-site.example --output customer.emdash',
    'npx emdash site import customer.emdash --analyze',
    'npx emdash site import customer.emdash --plan <digest> --confirm',
  ]);
  assert.match(document.querySelector('.emdash-guide').textContent, /never deployed/);
});

test('a read that fails shows the card as not set up rather than an error', async () => {
  answer = async () => {
    throw new Error('bridge down');
  };
  await mount();
  await settle();
  assert.match(document.body.textContent, /EmDash is not set up in this project/);
});
