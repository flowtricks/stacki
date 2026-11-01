import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeChanges } from '../src/features/github/treeChanges';
const entry = (path: string, sha = 'a'.repeat(40)) => ({ path, sha, mode: '100644', type: 'blob' });
const tree = (entries: ReturnType<typeof entry>[]) => ({ truncated: false, tree: entries });
test('large Studio updates do not hide site edits after the 300-file compare boundary', () => {
  const studio = Array.from({ length: 400 }, (_, index) => entry(`studio/vendor/${index}.ts`));
  const before = tree([entry('src/pages/index.astro'), entry('src/pages/old.astro')]);
  const after = tree([...studio, entry('src/pages/index.astro', 'b'.repeat(40)), entry('src/pages/new.astro')]);
  assert.deepEqual(treeChanges(before, after), [
    { filename: 'src/pages/index.astro', status: 'modified' },
    { filename: 'src/pages/new.astro', status: 'added' },
    { filename: 'src/pages/old.astro', status: 'removed' },
  ]);
  assert.deepEqual(treeChanges(tree([]), tree(studio)), []);
});
test('site changes are not capped at 300 and incomplete responses cannot erase unseen files', () => {
  const files = Array.from({ length: 450 }, (_, index) => entry(`src/pages/${index}.astro`));
  assert.equal(treeChanges(tree([]), tree(files)).length, 450);
  assert.throws(() => treeChanges(tree(files), { truncated: true, tree: [] }), /incomplete/);
  assert.throws(() => treeChanges(tree(files), { tree: [] }), /incomplete/);
});
test('non-Studio config and binary changes remain visible to the runtime safety check', () => {
  assert.deepEqual(treeChanges(tree([]), tree([entry('package.json'), entry('public/photo.png')])), [
    { filename: 'package.json', status: 'added' },
    { filename: 'public/photo.png', status: 'added' },
  ]);
});
