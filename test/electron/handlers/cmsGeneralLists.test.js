// Goal: a settings file's lists of plain values are list fields of its single values (named after
// the file, never "General"), not collections
// of their own, and editing one rewrites only that list. Method: a file shaped like a site's
// src/consts.ts (`as const`, a type annotation, a record list beside them), read through
// readCmsSource and written back through writeGeneral; a page keeps its plain lists as collections.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCmsSource } = require('#dist/electron/handlers/cmsFiles.js');
const {
  writeGeneral,
  findCollections,
  readGeneral,
} = require('#dist/electron/content/jsCollections.js');

const CONSTS = `export const SITE_NAME = "The Church International";
export const SERMON_SERVICES = [
  "Sunday Service",
  "Real Men",
] as const;

/** Routes kept out of search results. */
export const NOINDEX_ROUTES: string[] = ["/404", "/search"];
`;

function read(source) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-consts-'));
  try {
    const file = path.join(folder, 'consts.ts');
    fs.writeFileSync(file, source);
    return readCmsSource(file, 'consts.ts', { page: false, includeGeneralOnly: true });
  } finally {
    fs.rmSync(folder, { recursive: true });
  }
}

test('plain lists are fields of the file’s single values, not collections', () => {
  const files = read(CONSTS);
  assert.deepEqual(
    files.map((file) => file.name),
    ['consts.ts'],
  );
  assert.deepEqual(files[0].data, {
    SITE_NAME: 'The Church International',
    SERMON_SERVICES: ['Sunday Service', 'Real Men'],
    NOINDEX_ROUTES: ['/404', '/search'],
  });
});

test('editing one list rewrites only it, keeping `as const`, the annotation and comments', () => {
  const general = readGeneral(CONSTS);
  const next = writeGeneral(CONSTS, {
    ...general,
    SERMON_SERVICES: ['Sunday Service', 'Real Men', 'Youth Night'],
  });
  assert.match(next, /"Youth Night",?\s*\] as const;/);
  assert.match(next, /export const NOINDEX_ROUTES: string\[\] = \["\/404", "\/search"\];/);
  assert.match(next, /\/\*\* Routes kept out of search results\. \*\//);
  assert.deepEqual(readGeneral(next).SERMON_SERVICES, [
    'Sunday Service',
    'Real Men',
    'Youth Night',
  ]);
});

test('a list of records stays a collection, and a page keeps plain lists as collections', () => {
  const source = `${CONSTS}export const CAMPUSES = [{ name: "Gonzales" }];\n`;
  const files = read(source);
  assert.deepEqual(
    files.map((file) => file.name),
    ['consts.ts', 'CAMPUSES'],
  );
  assert.equal('CAMPUSES' in files[0].data, false);
  const page = { requireExport: false, allowPlainLists: true };
  assert.deepEqual(
    findCollections('const words = ["found.", "loved."];', page).map((found) => found.name),
    ['words'],
  );
  assert.equal(readGeneral('const words = ["found."];', page), undefined);
});
