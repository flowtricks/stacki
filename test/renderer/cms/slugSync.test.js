// A document's slug kept in step with its name.
//
// The rules first: which field is the slug and which it follows (a title,
// else a name, and nothing without both); the slug a name makes, including
// accents, symbols and a name past the length bound; and when a slug counts
// as already in step, so a hand-written one is never taken over.
//
// Then the fields themselves, mounted in JSDOM and typed into: the slug
// follows the name while the sync button is pressed, and once the pause has
// passed both are saved; unpressed, the slug stays as it is; pressed again, it
// comes back in step. Opening a document writes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/slug-sync.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export {RemoteFieldList} from './src/features/cms/RemoteFieldList';
      export * from './src/features/cms/slugSync';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
window.avb = { listAssets: async () => ({ entries: [] }), onAssetsChanged: () => () => {} };
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const sync = require(output);

const text = (name) => ({
  name,
  title: name,
  description: '',
  required: true,
  rules: [],
  type: { kind: 'string', options: [] },
});
const slugField = { ...text('slug'), type: { kind: 'slug', options: [] } };

test('a slug follows the title, else the name, and needs both fields', () => {
  assert.deepEqual(sync.slugPairOf([text('name'), slugField]), { source: 'name', slug: 'slug' });
  assert.deepEqual(sync.slugPairOf([text('name'), text('title'), slugField]), {
    source: 'title',
    slug: 'slug',
  });
  assert.equal(sync.slugPairOf([text('name')]), undefined);
  assert.equal(sync.slugPairOf([text('heading'), slugField]), undefined);
  const numberName = { ...text('name'), type: { kind: 'number', options: [] } };
  assert.equal(sync.slugPairOf([numberName, slugField]), undefined, 'only text makes a slug');
});

test('a name makes a lower-case, dashed slug without accents or symbols', () => {
  assert.equal(sync.slugify('Mncedisi Hlatshwayo'), 'mncedisi-hlatshwayo');
  assert.equal(sync.slugify('  Señor Café — Q&A!  '), 'senor-cafe-q-and-a');
  assert.equal(sync.slugify('---'), '');
  assert.equal(sync.slugify(''), '');
  const long = sync.slugify('word '.repeat(40));
  assert.ok(long.length <= sync.SLUG_SYNC_LIMITS.slugCharsMax);
  assert.ok(!long.endsWith('-'));
  assert.ok(
    long.split('-').every((word) => word === 'word'),
    'a long name loses whole words',
  );
  assert.equal(sync.slugify('x'.repeat(200)).length, 96, 'one long word is cut at the bound');
});

test('a slug is in step when empty or made from the name, never when written by hand', () => {
  const slug = (current) => ({ _type: 'slug', current });
  assert.equal(sync.slugInStep('Mncedisi Hlatshwayo', slug('mncedisi-hlatshwayo')), true);
  assert.equal(sync.slugInStep('Mncedisi Hlatshwayo', undefined), true);
  assert.equal(sync.slugInStep('Mncedisi Hlatshwayo', slug('pastor-m')), false);
  assert.equal(sync.slugText({ current: 4 }), '');
  assert.equal(sync.slugValue(''), undefined);
  assert.deepEqual(sync.slugValue('a-b'), { _type: 'slug', current: 'a-b' });
});

async function mount(slugCurrent) {
  const saves = [];
  const root = createRoot(document.getElementById('root'));
  const loaded = {
    id: 'speaker-1',
    type: 'speaker',
    status: 'published',
    assets: [],
    editedAt: undefined,
    publishedAt: undefined,
    editURL: undefined,
    fields: [
      { ...text('name'), value: 'Mncedisi Hlatshwayo' },
      { ...slugField, value: { _type: 'slug', current: slugCurrent } },
    ],
  };
  const context = {
    projectPath: '/project',
    connectionId: 'c',
    assets: new Map(),
    addAsset() {},
    depth: 0,
  };
  await act(async () =>
    root.render(
      React.createElement(sync.RemoteFieldList, {
        document: loaded,
        context,
        onSave: (field, value) => saves.push([field.name, value]),
      }),
    ),
  );
  return { root, saves };
}

const inputs = () => [...document.querySelectorAll('.remote-cms-field input')];
const button = () => document.querySelector('.remote-cms-sync');
async function type(input, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    setter.set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 900)));

test('typing the name writes the slug while sync is pressed, and not after', async () => {
  const { root, saves } = await mount('mncedisi-hlatshwayo');
  try {
    assert.equal(button().getAttribute('aria-pressed'), 'true', 'a slug in step starts synced');
    await settle();
    assert.deepEqual(saves, [], 'opening writes nothing');
    await type(inputs()[0], 'Pastor Mncedisi');
    assert.equal(inputs()[1].value, 'pastor-mncedisi');
    await settle();
    assert.deepEqual(saves.sort(), [
      ['name', 'Pastor Mncedisi'],
      ['slug', { _type: 'slug', current: 'pastor-mncedisi' }],
    ]);
    await act(async () => button().click());
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    await type(inputs()[0], 'Mncedisi');
    assert.equal(inputs()[1].value, 'pastor-mncedisi', 'unsynced, the slug stays');
    await act(async () => button().click());
    assert.equal(inputs()[1].value, 'mncedisi', 'synced again, it comes back in step');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a slug written by hand starts unsynced and keeps its text', async () => {
  const { root } = await mount('pastor-m');
  try {
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    await type(inputs()[0], 'Someone Else');
    assert.equal(inputs()[1].value, 'pastor-m');
  } finally {
    await act(async () => root.unmount());
  }
});
