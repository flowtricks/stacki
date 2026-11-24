// Goal: a glob collection lists the files Astro would load. Astro's usual way to leave drafts out is a pattern such as
// `**/[^_]*.{md,mdx}` or a `!**/_*` entry beside the pattern; a set must read as a set and a `!` pattern must exclude, while a
// plain pattern keeps matching what it always has.
// Method: write a temporary collection folder and list, count and cover it through the real entry functions for each pattern.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listEntries, countEntries, coveredPaths } = require('#dist/electron/content/contentEntries.js');

const FILES = ['first.md', 'second.mdx', '_draft.md', 'nested/third.md', 'nested/_hidden.md', 'notes.txt'];

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-content-glob-'));
  for (const rel of FILES) {
    const file = path.join(root, 'src/data/blog', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\ntitle: x\n---\n');
  }
  return root;
}

const cases = [
  ['**/*.md', ['_draft', 'first', 'nested/_hidden', 'nested/third']],
  ['**/[^_]*.{md,mdx}', ['first', 'nested/third', 'second']],
  ['**/[!_]*.md', ['first', 'nested/third']],
  ['[a-f]*.md', ['first']],
  [
    ['**/*.{md,mdx}', '!**/_*'],
    ['first', 'nested/third', 'second'],
  ],
  [['!**/_*'], []],
];

test('sets and exclusions in a collection pattern are read as Astro reads them', () => {
  const root = project();
  try {
    for (const [pattern, ids] of cases) {
      const collection = { name: 'blog', loader: { kind: 'glob', base: 'src/data/blog', pattern } };
      const listed = listEntries(root, collection).entries.map((entry) => entry.id);
      assert.deepEqual(listed.sort(), ids, JSON.stringify(pattern));
      assert.equal(countEntries(root, collection), ids.length, `count of ${JSON.stringify(pattern)}`);
      assert.equal(coveredPaths(root, [collection]).files.length, ids.length, `covered by ${JSON.stringify(pattern)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
