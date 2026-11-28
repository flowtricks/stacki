// Goal: a drag or resize in a Design mode frame writes an element's inline style only where it takes effect. On a
// plain element, and on an instance whose component keeps its style (it combines it with its own, as the fixture
// Grid does), the change is written to that node, onto the style it already has. On an instance whose component
// would lose it (the Grid as it was, `style={columns} {...rest}`) or cannot be read, nothing is written, the
// element goes back where it was, and a toast says why.
// Method: the real writeElementStyle (src/app/designMode/designFrameOps.ts), the design store holding the dragged
// element as the selection, over a stand-in editor that records writes and toasts; component files are read
// through the same bridge the app uses, answered from memory. Fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const GRID = fs.readFileSync(repoPath('test/fixtures/lumos/components/wrapper/Grid.astro'), 'utf8');
const FILES = new Map([
  ['/site/Grid.astro', GRID],
  ['/site/OldGrid.astro', GRID.replace(/style=\{\[columns, style\].*\}/, 'style={columns}').replace(/\n +style,(?=\n +\.\.\.rest)/, '')],
]);
dom.window.avb = {
  readStyleFile: async (payload) => {
    const asked = typeof payload === 'string' ? payload : (payload?.path ?? payload?.filePath);
    if (!FILES.has(asked)) {
      throw new Error('no such file');
    }
    return { css: FILES.get(asked) };
  },
};

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'design-element-write.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { writeElementStyle } from './src/app/designMode/designFrameOps';",
      "export { updateDesignView } from './src/app/designMode/designStore';",
      "export { designWord } from './src/app/designMode/i18n/designWords';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.svg': 'text' },
  logLevel: 'silent',
});
const model = require(bundle);

const WAIT_ROUNDS_MAX = 400;

// One drag's release over a stand-in editor, until it has written or refused.
async function drag(target, componentFile) {
  const node = { path: 'n1', copy: 0 };
  model.updateDesignView((view) => ({ ...view, selection: { kind: 'element', frame: 'f1', ...node } }));
  const writes = [];
  const toasts = [];
  let refusals = 0;
  const app = {
    selectedId: 'n1',
    pathFor: (id) => id,
    selectedNode: target,
    selectedComponentFile: componentFile,
    setProp: (id, name, value) => writes.push([id, name, value.value]),
    showToast: (message, kind) => toasts.push([message, kind]),
  };
  const context = { app: () => app, words: () => (key, values) => model.designWord('en', key, values) };
  model.writeElementStyle(context, 'f1', node, [['width', '10rem']], () => {
    refusals += 1;
  });
  for (let round = 0; round < WAIT_ROUNDS_MAX && writes.length === 0 && refusals === 0; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { writes, toasts, refusals };
}

const instance = (name, style) => ({ id: 'n1', kind: 'component', name, props: style === undefined ? {} : { style: { type: 'string', value: style } } });

test('a plain element takes the drag on its own style', async () => {
  const done = await drag({ id: 'n1', kind: 'element', name: 'div', props: {} }, undefined);
  assert.deepEqual(done.writes, [['n1', 'style', 'width: 10rem']]);
  assert.deepEqual(done.toasts, []);
});

test('a combining Grid takes the drag on the instance, beside the style it has', async () => {
  const done = await drag(instance('Grid', 'gap: 1rem'), '/site/Grid.astro');
  assert.deepEqual(done.writes, [['n1', 'style', 'gap: 1rem; width: 10rem']]);
  assert.deepEqual(done.toasts, []);
});

for (const [name, file] of [
  ['OldGrid', '/site/OldGrid.astro'],
  ['Missing', '/site/Missing.astro'],
  ['Packaged', undefined],
]) {
  test(`${name}: nothing is written, the element goes back, and a toast says why`, async () => {
    const done = await drag(instance(name), file);
    assert.deepEqual(done.writes, []);
    assert.equal(done.refusals, 1);
    assert.equal(done.toasts.length, 1);
    assert.match(done.toasts[0][0], new RegExp(`^Stacki can’t confirm that ${name}(\\.astro)? keeps a style`));
    assert.equal(done.toasts[0][1], 'warning');
  });
}
