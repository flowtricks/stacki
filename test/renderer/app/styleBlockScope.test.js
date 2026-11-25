// Goal: every Style Block inserted from the palette is written
// `<style is:global>`, bare, in a page, a layout, a component, and a page's
// markup inside a component instance's slot alike. A scoped block stops at the
// file it is written in, and styles are expected to reach every element their
// selectors match (src/app/model/styleBlockScope.ts says why).
// Method: the real insertion. insertedNode builds the node the palette's
// insertItem builds, insertGesture states it as edit requests, and main's
// translator and the shipping planner splice them into the file's bytes, as
// the host does. The written file is compared whole, then parsed back so the
// attribute is checked as the parser reads it, bare, on both sides of the
// write. The negative space: a Script Block takes no attribute.
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
      "export { STYLE_GLOBAL_ATTRIBUTE } from './src/app/model/styleBlockScope';",
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

const STYLE_ITEM = modules.OTHER_ITEMS.find((item) => item.type === 'style');
const SCRIPT_ITEM = modules.OTHER_ITEMS.find((item) => item.type === 'script');
assert.ok(STYLE_ITEM, 'the palette offers a Style Block');
assert.ok(SCRIPT_ITEM, 'the palette offers a Script Block');

test('the global attribute is written bare', () => {
  assert.equal(modules.STYLE_GLOBAL_ATTRIBUTE, 'is:global');
});

const hash = (bytes) => toDigest(crypto.createHash('sha256').update(bytes).digest('hex'));

function snapshotOf(file, text) {
  const projection = projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  return createSnapshot({ path: toFilePath(file), bytes: encodeUtf8(text), projection }, hash);
}

// Insert a palette item into `text` at `place`, as insertItem does, and return
// the file the host writes.
function written(file, text, item, placeOf) {
  const parsed = parsePage(text, { locs: true });
  assert.ok(parsed.editable, `${file} parses`);
  const model = parsed.model;
  const snapshot = snapshotOf(file, text);
  const node = modules.insertedNode(item, modules.newId());
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
  const result = written('/site/src/components/ButtonMain.astro', text, STYLE_ITEM, atEnd);
  assert.equal(result, '<a class="button"><span>Go</span></a>\n<style is:global></style>\n');
  assert.doesNotMatch(result, /is:global=/);
  const [style] = stylesOf(result);
  assert.ok(style, 'the block is read back');
  assert.deepEqual(style.props, { 'is:global': { type: 'bare' } });
});

test('insert: a Style Block in a layout file is global too', () => {
  const text = '<html>\n  <body>\n    <slot />\n  </body>\n</html>\n';
  const html = (model) => model.nodes.find((node) => node.kind === 'element' && node.name === 'html');
  const result = written('/site/src/layouts/Base.astro', text, STYLE_ITEM, (model) => {
    const body = html(model).children.find((node) => node.kind === 'element' && node.name === 'body');
    return { parentId: body.id, index: body.children.length };
  });
  assert.equal(result, '<html>\n  <body>\n    <slot />\n    <style is:global></style>\n  </body>\n</html>\n');
  assert.deepEqual(stylesOf(result)[0].props, { 'is:global': { type: 'bare' } });
});

test('insert: a Style Block on a page is global too', () => {
  const text = '<main>\n  <h1>Hello</h1>\n</main>\n';
  const result = written('/site/src/pages/index.astro', text, STYLE_ITEM, atEnd);
  assert.equal(result, '<main>\n  <h1>Hello</h1>\n</main>\n<style is:global></style>\n');
  assert.deepEqual(stylesOf(result)[0].props, { 'is:global': { type: 'bare' } });
});

test("insert: a Style Block in an instance's slot on a page is global", () => {
  const text = '---\nimport Card from "../components/Card.astro";\n---\n<Card>\n  <p>Inside</p>\n</Card>\n';
  const result = written('/site/src/pages/index.astro', text, STYLE_ITEM, (model) => {
    const card = model.nodes.find((node) => node.kind === 'component' && node.name === 'Card');
    assert.ok(card, 'the page renders a Card');
    return { parentId: card.id, index: card.children.length };
  });
  assert.equal(result, '---\nimport Card from "../components/Card.astro";\n---\n<Card>\n  <p>Inside</p>\n  <style is:global></style>\n</Card>\n');
  assert.deepEqual(stylesOf(result)[0].props, { 'is:global': { type: 'bare' } });
});

test('insert: a Script Block takes no attribute', () => {
  const node = modules.insertedNode(SCRIPT_ITEM, modules.newId());
  assert.ok(node, 'the script is inserted as a node');
  assert.deepEqual({ ...node, id: undefined }, { id: undefined, kind: 'raw', name: 'script', props: {}, inner: '' });
});
