// Goal: a Style Block inserted from the palette into a component's own markup
// (or a layout's) is written `<style is:global>`, bare, and one inserted on a
// page, a page's markup inside a component instance's slot included, is a
// plain `<style>`. A scoped block in a component reaches only that component's
// own elements; the user expects component styles to apply the way a
// builder's do (src/app/model/styleBlockScope.ts says why at length).
// Method: the pure rule first, styleBlockGlobal over every file kind and
// editedFileKind over every open entry the app holds, an assertion pinned by
// its message. Then the real insertion: insertedNode builds the node the
// palette's insertItem builds, insertGesture states it as edit requests, and
// main's translator and the shipping planner splice them into the file's
// bytes, as the host does. The written file is compared whole, then parsed
// back so the attribute is checked as the parser reads it, bare, on both sides
// of the write.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toDigest, toFilePath, toIntentId } = require('#dist/shared/core/brand.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { createSnapshot } = require('#dist/shared/page/snapshot.js');
const { projectPage } = require('#dist/shared/page/sourceProjection.js');
const { decodeUtf8, encodeUtf8 } = require('#dist/shared/core/span.js');
const { applySplices } = require('#dist/shared/engine/splice.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/style-block-scope');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'style-block-scope.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { STYLE_GLOBAL_ATTRIBUTE, editedFileKind, styleBlockGlobal } from './src/app/model/styleBlockScope';",
      "export { insertedNode } from './src/app/model/pageGestures';",
      "export { newId } from './src/app/model/nodeFactory';",
      "export { insertGesture } from './src/editor/editGestures';",
      "export { nodeRefIn } from './src/editor/pageEdits';",
      "export { OTHER_ITEMS } from './src/features/palette/InsertSearch';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  logLevel: 'silent',
});
const modules = require(bundle);

const PROJECT = '/site';
const STYLE_ITEM = modules.OTHER_ITEMS.find((item) => item.type === 'style');
const SCRIPT_ITEM = modules.OTHER_ITEMS.find((item) => item.type === 'script');
assert.ok(STYLE_ITEM, 'the palette offers a Style Block');
assert.ok(SCRIPT_ITEM, 'the palette offers a Script Block');

test('styleBlockGlobal: global in a component or a layout, scoped on a page', () => {
  assert.equal(modules.styleBlockGlobal({ fileKind: 'component' }), true);
  assert.equal(modules.styleBlockGlobal({ fileKind: 'layout' }), true);
  assert.equal(modules.styleBlockGlobal({ fileKind: 'page' }), false);
  assert.equal(modules.STYLE_GLOBAL_ATTRIBUTE, 'is:global');
});

test('editedFileKind: the open entry and where it lives name the file written', () => {
  const kind = (open, projectPath = PROJECT, platform = 'darwin') => modules.editedFileKind(open, projectPath, platform);
  const component = (file) => ({ kind: 'component', name: path.basename(file, '.astro'), path: file });
  assert.equal(kind(component('/site/src/components/ButtonMain.astro')), 'component');
  // Any .astro outside pages and layouts is a component's file.
  assert.equal(kind(component('/site/src/blocks/Hero.astro')), 'component');
  assert.equal(kind(component('/site/src/layouts/Base.astro')), 'layout');
  assert.equal(kind(component('/site/src/layouts/marketing/Wide.astro')), 'layout');
  assert.equal(kind(component('C:\\Site\\src\\layouts\\Base.astro'), 'c:\\site', 'win32'), 'layout');
  // A folder named like layouts elsewhere is not the layouts folder.
  assert.equal(kind(component('/site/src/components/layouts/Card.astro')), 'component');
  // Without a project root the folder cannot be read; it is still a component.
  assert.equal(modules.editedFileKind(component('/site/src/layouts/Base.astro'), undefined, 'darwin'), 'component');
  assert.equal(kind({ kind: 'page', name: 'index.astro', path: '/site/src/pages/index.astro', route: '/' }), 'page');
  // The defaults canvas is a page entry wherever it lives.
  assert.equal(kind({ kind: 'page', name: 'Button', path: '/site/.stacki/canvas/Button.astro' }), 'page');
  assert.equal(kind({ kind: 'route', name: '/blog', route: '/blog', from: undefined }), 'page');
  assert.equal(kind(undefined), 'page');
  assert.throws(() => kind(component('')), /Assertion failed: editedFileKind: an open component has a path/);
  assert.throws(() => kind(component('/site/src/components/A.astro'), ''), /Assertion failed: editedFileKind: a project path is not empty/);
});

const hash = (bytes) => toDigest(crypto.createHash('sha256').update(bytes).digest('hex'));

function snapshotOf(file, text) {
  const projection = projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  return createSnapshot({ path: toFilePath(file), bytes: encodeUtf8(text), projection }, hash);
}

// Insert a palette item into `text` at `place`, as insertItem does, and return
// the file the host writes.
function written(file, text, item, fileKind, placeOf) {
  const parsed = parsePage(text, { locs: true });
  assert.ok(parsed.editable, `${file} parses`);
  const model = parsed.model;
  const snapshot = snapshotOf(file, text);
  const node = modules.insertedNode(item, modules.newId(), { fileKind });
  assert.ok(node, 'the item is inserted as a node');
  const gesture = modules.insertGesture(model, node, placeOf(model), { urgency: true });
  const requests = gesture.request((id) => modules.nodeRefIn({ checksum: snapshot.checksum, model }, id));
  assert.ok(requests, 'the insertion can be stated');
  assert.equal(requests.length, 1, 'one request inserts one node');
  const [edit] = requests;
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `main states the request: ${draft.ok ? '' : draft.error}`);
  const intent = toIntent({ id: toIntentId('style-block'), file: snapshot.path, authoredChecksum: snapshot.checksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `the planner places it: ${planned.ok ? '' : planned.error}`);
  const decoded = decodeUtf8(applySplices(snapshot.bytes, planned.value.splices));
  assert.ok(decoded.ok);
  return decoded.value;
}

// The `<style>` blocks of a written file, as the parser reads them back.
function stylesOf(text) {
  const parsed = parsePage(text, { locs: false });
  assert.ok(parsed.editable, 'the written file parses');
  const found = [];
  const pending = [...parsed.model.nodes];
  for (let at = 0; at < pending.length; at++) {
    assert.ok(at < 10_000, 'stylesOf: node limit');
    const node = pending[at];
    if (node.kind === 'raw' && node.name === 'style') {
      found.push(node);
    }
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return found;
}

const atEnd = (model) => ({ parentId: undefined, index: model.nodes.length });

test('insert: a Style Block in a component file is written bare `<style is:global>`', () => {
  const text = '<a class="button"><span>Go</span></a>\n';
  const result = written('/site/src/components/ButtonMain.astro', text, STYLE_ITEM, 'component', atEnd);
  assert.equal(result, '<a class="button"><span>Go</span></a>\n<style is:global></style>\n');
  assert.doesNotMatch(result, /is:global=/);
  const [style] = stylesOf(result);
  assert.ok(style, 'the block is read back');
  assert.deepEqual(style.props, { 'is:global': { type: 'bare' } });
});

test('insert: a Style Block in a layout file is global too', () => {
  const text = '<html>\n  <body>\n    <slot />\n  </body>\n</html>\n';
  const html = (model) => model.nodes.find((node) => node.kind === 'element' && node.name === 'html');
  const result = written('/site/src/layouts/Base.astro', text, STYLE_ITEM, 'layout', (model) => {
    const body = html(model).children.find((node) => node.kind === 'element' && node.name === 'body');
    return { parentId: body.id, index: body.children.length };
  });
  assert.equal(result, '<html>\n  <body>\n    <slot />\n    <style is:global></style>\n  </body>\n</html>\n');
  assert.deepEqual(stylesOf(result)[0].props, { 'is:global': { type: 'bare' } });
});

test('insert: a Style Block on a page is a plain `<style>`', () => {
  const text = '<main>\n  <h1>Hello</h1>\n</main>\n';
  const result = written('/site/src/pages/index.astro', text, STYLE_ITEM, 'page', atEnd);
  assert.equal(result, '<main>\n  <h1>Hello</h1>\n</main>\n<style></style>\n');
  assert.deepEqual(stylesOf(result)[0].props, {});
});

test("insert: a Style Block in an instance's slot on a page stays scoped to the page", () => {
  const text = '---\nimport Card from "../components/Card.astro";\n---\n<Card>\n  <p>Inside</p>\n</Card>\n';
  const result = written('/site/src/pages/index.astro', text, STYLE_ITEM, 'page', (model) => {
    const card = model.nodes.find((node) => node.kind === 'component' && node.name === 'Card');
    assert.ok(card, 'the page renders a Card');
    return { parentId: card.id, index: card.children.length };
  });
  assert.equal(result, '---\nimport Card from "../components/Card.astro";\n---\n<Card>\n  <p>Inside</p>\n  <style></style>\n</Card>\n');
  assert.deepEqual(stylesOf(result)[0].props, {});
});

test('insert: a Script Block takes no attribute, in a component or on a page', () => {
  for (const fileKind of ['component', 'layout', 'page']) {
    const node = modules.insertedNode(SCRIPT_ITEM, modules.newId(), { fileKind });
    assert.ok(node, fileKind);
    assert.deepEqual({ ...node, id: undefined }, { id: undefined, kind: 'raw', name: 'script', props: {}, inner: '' }, fileKind);
  }
});
