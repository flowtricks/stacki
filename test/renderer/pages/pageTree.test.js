// Goal: the pages panel tree and drag boundary stay bounded and structurally typed.
// Methodology: build nested pages/folders, count them iteratively, then reject
// malformed JSON, invalid paths, excessive depth, and oversized live trees.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../helpers/rendererModule')('src/features/pages/pageTree.ts');

const page = (name) => ({ path: `/project/src/pages/${name}`, name, route: `/${name}` });

test('page tree builds implicit folders and preserves page basenames', () => {
  const tree = model.buildPageTree([page('index.astro'), page('blog/post.mdx')], ['empty', 'blog']);
  assert.equal(tree.pages[0].base, 'index.astro');
  assert.equal(tree.directories.get('blog').pages[0].base, 'post.mdx');
  assert.equal(tree.directories.has('empty'), true);
  assert.equal(model.countTreePages(tree), 2);
  assert.deepEqual([...model.collectPageTreeDirectories(tree)].sort(), ['blog', 'empty']);
});

test('page drag parser accepts its wire shape and rejects malformed boundaries', () => {
  assert.deepEqual(model.parsePageDragText(JSON.stringify({ path: '/project/src/pages/index.astro', name: 'index.astro' })), {
    path: '/project/src/pages/index.astro',
    name: 'index.astro',
  });
  for (const value of [
    '',
    '{',
    'null',
    '{}',
    JSON.stringify({ path: '/project/index.astro', name: '../index.astro' }),
    JSON.stringify({ path: '/project/index.astro', name: 'a/'.repeat(128) + 'index.astro' }),
  ]) {
    assert.equal(model.parsePageDragText(value), undefined);
  }
});

test('page tree rejects invalid and excessively deep source paths', () => {
  assert.throws(() => model.buildPageTree([page('../index.astro')], []));
  assert.throws(() => model.buildPageTree([], ['a/'.repeat(128) + 'deep']));
  const cyclic = { directories: new Map(), pages: [] };
  cyclic.directories.set('again', cyclic);
  assert.throws(() => model.countTreePages(cyclic), /directory count exceeds limit/);
});
