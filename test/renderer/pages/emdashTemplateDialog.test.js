// Goal: the EmDash page template dialog offers exactly the content types EmDash defines, suggests the address
// from the first one, writes nothing until the plan says it can, shows a refusal in words, and creates a template
// whose source is the chosen content type and nothing else. The Pages menu offers the EmDash entry only for a
// project that uses EmDash.
// Method: bundle the real dialog and the menu builder with esbuild, mount in jsdom over a fake preload bridge that
// answers the project read and the plan, and read the DOM and the draft handed to the creator.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const emdash = require('#dist/shared/properties/emdash.js');

const output = repoPath('node_modules/.stacki-test/emdash-template-dialog.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: {
    contents: `export { EmDashTemplateDialog } from './src/features/pages/EmDashTemplateDialog';
    export { pageCreateMenuItems } from './src/features/pages/PagesPanel';`,
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
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
// A jsdom page has no <dialog> methods: the popup is a modal dialog.
dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};
const planned = [];
let project;
let plan = async () => ({
  ok: true,
  value: { route: '/posts/[slug]', changes: [{ path: 'src/pages/posts/[slug].astro', action: 'create', text: 'x' }], env: [] },
});
window.avb = {
  emDashProject: async () => project,
  planPageTemplate: async (input) => {
    planned.push(input);
    return plan(input);
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
  databaseFile: undefined,
  schemaSource: 'schema-json',
  collections: emdash.parseEmDashSchema(schema).value,
  problems: [],
};
const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
let root;
const created = [];
async function mount(layouts = []) {
  planned.length = 0;
  created.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(component.EmDashTemplateDialog, {
        projectPath: '/project',
        layouts,
        onClose: () => undefined,
        onCreate: async (draft) => {
          created.push(draft);
          return undefined;
        },
      }),
    ),
  );
  await wait();
}
test.afterEach(async () => {
  await act(async () => root.unmount());
});
const create = () => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create template');

test('the first content type is chosen, its address is suggested, and Create is on once the plan allows it', async () => {
  project = PRESENT;
  await mount();
  assert.equal(document.querySelector('input').value, '/posts/[slug]');
  assert.equal(planned.at(-1).draft.source.collection, 'posts');
  assert.equal(create().disabled, false);
  await act(async () => create().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(created, [{ route: '/posts/[slug]', layout: undefined, source: { kind: 'emdash', collection: 'posts' } }]);
});

test('a refusal from the plan shows in words and keeps Create off', async () => {
  project = PRESENT;
  plan = async () => ({ ok: false, message: 'A page already exists at src/pages/posts/[slug].astro.' });
  await mount();
  assert.match(document.querySelector('.page-template-problem').textContent, /already exists/);
  assert.equal(create().disabled, true);
  plan = async () => ({ ok: true, value: { route: '/posts/[slug]', changes: [{ path: 'a', action: 'create', text: 'x' }], env: [] } });
});

test('a project with no content types says so and offers nothing to create', async () => {
  project = { ...PRESENT, collections: [], problems: ['noSchema'] };
  await mount();
  assert.match(document.body.textContent, /No content types found\. Define them in EmDash first\./);
  assert.ok(document.querySelector('input') === null);
  assert.equal(create().disabled, true);
  assert.equal(planned.length, 0, 'nothing is planned without a content type');
});

test('the Pages menu offers the EmDash template only when the project uses EmDash', () => {
  const noop = () => undefined;
  const without = component.pageCreateMenuItems({ createPage: noop, createTemplate: noop });
  const withEmDash = component.pageCreateMenuItems({ createPage: noop, createTemplate: noop, createEmDashTemplate: noop });
  assert.equal(without.length, 2);
  assert.equal(withEmDash.length, 3);
  assert.equal(withEmDash[2].label, 'EmDash page template');
});
