// Goal: opening or renaming a page never destroys Astro route syntax.
// Method: exercise unchanged and intentional edits for dynamic/rest routes,
// endpoints, MDX, Unicode, and invalid filesystem segments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeName, pageRenameBase } = require('../../helpers/rendererModule')('src/features/pages/routeName.ts');

test('unchanged route names never request a rename', () => {
  for (const name of ['[slug]', '[...path]', '[lang]-[slug]', 'feed.xml', '@preview', 'café']) {
    for (const extension of ['.astro', '.md', '.mdx']) {
      assert.equal(pageRenameBase(name + extension, name), undefined);
      assert.equal(pageRenameBase(name + extension, name + extension), undefined);
    }
    assert.equal(routeName(name), name);
  }
});

test('intentional edits preserve route punctuation and reject path traversal', () => {
  assert.equal(pageRenameBase('index.astro', '[...path]'), '[...path]');
  assert.equal(pageRenameBase('[slug].mdx', '[id].mdx'), '[id]');
  for (const name of ['', '.', '..', '../other', 'a/b', 'a\\b', 'a\0b', 'a?b']) {
    assert.equal(routeName(name), undefined);
  }
});
