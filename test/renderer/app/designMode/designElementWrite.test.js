// Goal: a drag or resize in a Design mode frame writes an element's inline style, and is refused only where that
// style is shown to be lost now. A plain element takes the change on its own style, and so does an instance whose
// component combines the styles. So do the old Grid with default columns, Button, and a component that cannot be
// read, as before. On the old Grid with columns set (`style={columns} {...rest}`, its value rendering) and on a
// component that drops the style, nothing is written, the element goes back where it was, and a toast says why.
// Method: the real writeElementStyle (src/app/designMode/designFrameOps.ts), the design store holding the dragged
// element as the selection, over a stand-in editor that records writes and toasts. Component files are read
// through the same bridge the app uses, answered from memory, and the rendered style comes through the real canvas
// query, answered by a stand-in page. Fixtures only.
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
  ['/site/Button.astro', fs.readFileSync(repoPath('test/fixtures/lumos/components/Button.astro'), 'utf8')],
  ['/site/Sealed.astro', '---\nconst { title } = Astro.props;\n---\n<div>{title}</div>\n'],
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
      "export { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery';",
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

// The stand-in page: what the dragged element renders as its style.
let rendered;
model.setCanvasFrame({
  postMessage: (query) => {
    const attributes = rendered === undefined ? {} : { style: rendered };
    const identity = { tag: 'div', classes: [], attributes };
    setTimeout(() => model.receiveCanvasReply({ id: query.id, found: true, identity, matched: {}, computed: {}, computedProps: {} }), 0);
  },
});

// One drag's release over a stand-in editor, until it has written or refused.
async function drag(target, componentFile, shown) {
  rendered = shown;
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
  const done = await drag(instance('Grid', 'gap: 1rem'), '/site/Grid.astro', '--_cols-lg: 3; gap: 1rem');
  assert.deepEqual(done.writes, [['n1', 'style', 'gap: 1rem; width: 10rem']]);
  assert.deepEqual(done.toasts, []);
});

for (const [label, name, file, own, shown] of [
  ['the old Grid with default columns', 'OldGrid', '/site/OldGrid.astro', undefined, undefined],
  ['the old Grid whose own style renders', 'OldGrid', '/site/OldGrid.astro', 'gap: 1rem', 'gap: 1rem'],
  ['a Button on the old component code', 'Button', '/site/Button.astro', undefined, undefined],
  ['a component that cannot be read', 'Missing', '/site/Missing.astro', undefined, '--c: 1'],
  ['a component with no file', 'Packaged', undefined, undefined, undefined],
]) {
  test(`${label} takes the drag as before`, async () => {
    const done = await drag(instance(name, own), file, shown);
    assert.deepEqual(done.writes, [['n1', 'style', own === undefined ? 'width: 10rem' : `${own}; width: 10rem`]]);
    assert.deepEqual(done.toasts, []);
  });
}

for (const [label, name, file, own, shown] of [
  ['the old Grid with columns set', 'OldGrid', '/site/OldGrid.astro', undefined, '--_cols-lg: 3'],
  ['the old Grid with columns set over its own style', 'OldGrid', '/site/OldGrid.astro', 'gap: 1rem', '--_cols-lg: 3'],
  ['a component that drops the style', 'Sealed', '/site/Sealed.astro', undefined, undefined],
]) {
  test(`${label}: nothing is written, the element goes back, and a toast says why`, async () => {
    const done = await drag(instance(name, own), file, shown);
    assert.deepEqual(done.writes, []);
    assert.equal(done.refusals, 1);
    assert.equal(done.toasts.length, 1);
    assert.match(done.toasts[0][0], new RegExp(`^A style set on this ${name}\\.astro instance would be lost`));
    assert.equal(done.toasts[0][1], 'warning');
  });
}
