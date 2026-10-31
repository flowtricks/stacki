// Goal: collections are listed in the order the site's own Sanity Studio lists them, read from
// its structure code — the full sidebar, through helper calls, and not from query strings or a
// narrower editors' list. Method: a project folder with a structure file shaped like a real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sanityStructureOrder,
  inStructureOrder,
} = require('#dist/electron/content/sanityStructure.js');

const STRUCTURE = `import type { StructureBuilder } from "sanity/structure";
const QUERY = '*[_type == "sermon"]';
const course = () => S.listItem().child(S.list().items([orderable("series", "Courses")]));
export function structure(S) {
  if (admin) {
    return S.list().items([
      S.document().schemaType("settings"),
      S.documentTypeListItem("campus"),
      course(),
      orderable("booklet", "Booklets"),
    ]);
  }
  return S.list().items([
    S.documentTypeListItem("campus"),
    S.listItem().child(S.documentList().filter('_type == "sermon"')),
  ]);
}
`;

test('the full sidebar’s order, through a helper, ahead of unnamed types', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-structure-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'studio'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'studio', 'structure.ts'), STRUCTURE);
    const types = ['booklet', 'campus', 'logo', 'series', 'sermon', 'settings'];
    const order = sanityStructureOrder(root, types);
    // The sidebar's order; types it does not name (logo, sermon) after, as given.
    assert.deepEqual(inStructureOrder(types, order), [
      'settings',
      'campus',
      'series',
      'booklet',
      'logo',
      'sermon',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('a project without a Studio keeps the given order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-structure-'));
  try {
    assert.deepEqual(sanityStructureOrder(root, ['a', 'b']), []);
    assert.deepEqual(inStructureOrder(['b', 'a'], []), ['b', 'a']);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
