// Goal: the registry of .stacki/folders.json holds exactly what the app accepts: a document written the way the app writes it passes the registry and the app's own parser, and documents the app would ignore or refuse are refused by the registry.
// Method: one known-good document through checkValue and refusalOfSource, the empty document through both, then known-bad documents (unknown key, legacy key, wrong type, out of bounds, missing required) through the registry alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRecord } from '#dist/shared/core/record.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { FOLDERS_FILE } from '#dist/shared/properties/cli/files/foldersFile.js';

// JSON.parse answers any; bound to unknown so the checks below narrow it.
const parseText = (text: string): unknown => JSON.parse(text);

const schema = { kind: 'object', fields: FOLDERS_FILE.fields } as const;

const good = {
  version: 1,
  folders: {
    components: ['src/components', 'src/ui'],
    assets: ['public'],
    styles: ['src', 'styles'],
    variables: ['src', 'public', 'styles'],
  },
  cms: { files: ['src/consts.ts', 'src/data/site.json'], hiddenCollections: ['drafts'], pickerExcluded: ['src/consts.ts#SITE', 'blog', 'src/data/site.json'] },
};

test('a document written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(checkValue(schema, good, 'folders'), undefined);
  assert.equal(refusalOfSource(FOLDERS_FILE, serializeDocument(FOLDERS_FILE, good)), undefined);
  assert.equal(checkValue(schema, FOLDERS_FILE.empty, 'folders'), undefined);
  assert.equal(refusalOfSource(FOLDERS_FILE, serializeDocument(FOLDERS_FILE, { ...FOLDERS_FILE.empty })), undefined);
});

test('the canonical writer puts the kinds in tab order', () => {
  const text = serializeDocument(FOLDERS_FILE, { version: 1, folders: { assets: ['public'], components: ['src/components'] } });
  assert.deepEqual(Object.keys(toRecord(toRecord(parseText(text))?.['folders']) ?? {}), ['components', 'assets']);
});

test('documents the app would ignore or refuse are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown key', { ...good, panels: [] }],
    ['an unknown panel', { version: 1, folders: { pages: ['src/pages'] } }],
    ['an unknown cms key', { version: 1, cms: { hidden: [] } }],
    ['a wrong type', { version: 1, folders: { components: 'src/components' } }],
    ['a folder outside the roots', { version: 1, folders: { components: ['lib/components'] } }],
    ['components at src itself', { version: 1, folders: { components: ['src'] } }],
    ['an absolute folder', { version: 1, folders: { assets: ['/public'] } }],
    ['a folder that steps out', { version: 1, folders: { assets: ['public/../x'] } }],
    ['a hidden folder', { version: 1, folders: { assets: ['public/.cache'] } }],
    ['a folder nested too deep', { version: 1, folders: { assets: ['public/a/b/c/d/e/f/g/h'] } }],
    ['too many folders', { version: 1, folders: { assets: Array.from({ length: 17 }, (_, index) => `public/f${index}`) } }],
    ['a duplicate folder', { version: 1, folders: { assets: ['public', 'public'] } }],
    ['a cms file outside src', { version: 1, cms: { files: ['public/x.json'] } }],
    ['a cms file with a bad extension', { version: 1, cms: { files: ['src/x.css'] } }],
    ['a collection name with a slash', { version: 1, cms: { hiddenCollections: ['a/b'] } }],
    ['a picker export that is not an identifier', { version: 1, cms: { pickerExcluded: ['src/consts.ts#1x'] } }],
    ['a missing version', { folders: {} }],
    ['a wrong version', { version: 2 }],
  ];
  for (const [label, document] of bad) {
    assert.notEqual(checkValue(schema, document, 'folders'), undefined, label);
  }
});
