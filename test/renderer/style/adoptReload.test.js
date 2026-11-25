// An undo or redo of a stylesheet edit reaches the document the panel holds now.
//
//   node test/renderer/style/adoptReload.test.js
//
// Goal: an undo step keeps the document its write was made from, and a background read
// since then gives the panel a fresh document for the same file. Reloading only the step's
// copy left the panel showing the value from before the undo (resetUndo.test.js failed
// whenever the panel's poll landed between a pick and its undo). adoptReload brings every
// document the panel holds for that source to the text the undo wrote.
//
// Method: the real webflow model bundled with esbuild; documents are built from CSS text
// the way a read builds them. The negative space: another file's document, and a document
// that already holds the text, are left as they are, and a document listed twice is read once.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

let model;
async function webflowModel() {
  if (model !== undefined) {
    return model;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'adopt-reload.bundle.js');
  await esbuild.build({
    stdin: { contents: `export { adoptReload, documentFromCode } from './src/features/style/model/webflow'`, resolveDir: ROOT, loader: 'ts' },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  model = require(bundlePath);
  return model;
}

const sourceFor = (file) => ({
  key: `file:${file}`,
  label: path.basename(file),
  classNames: [],
  fromComponent: false,
  componentName: undefined,
  order: 0,
  element: undefined,
  origin: { kind: 'file', path: file },
});
const SITE = '/p/src/styles/site.css';
const BEFORE = '.heading { color: var(--accent); }\n';
const UNDONE = '.heading { color: var(--brand); }\n';

test("the panel's fresh copy of the file takes the text an undo wrote", async () => {
  const { adoptReload, documentFromCode } = await webflowModel();
  const held = documentFromCode(sourceFor(SITE), BEFORE);
  const other = documentFromCode(sourceFor('/p/src/styles/other.css'), BEFORE);
  const adopted = adoptReload([held, other, held], { key: `file:${SITE}`, code: UNDONE });
  assert.equal(adopted, 1, 'the document listed twice is read once');
  assert.equal(held.code, UNDONE);
  assert.match(held.regions.map((region) => String(region.root ?? '')).join(''), /var\(--brand\)/, 'its rules are parsed from the new text');
  assert.equal(other.code, BEFORE, "another file's document is left alone");
});

test('a document that already holds the text is not read again', async () => {
  const { adoptReload, documentFromCode } = await webflowModel();
  const held = documentFromCode(sourceFor(SITE), UNDONE);
  const regions = held.regions;
  assert.equal(adoptReload([held], { key: `file:${SITE}`, code: UNDONE }), 0);
  assert.equal(held.regions, regions, 'the parsed rules are the same objects');
  assert.equal(adoptReload([], { key: `file:${SITE}`, code: UNDONE }), 0, 'no documents, nothing read');
});
