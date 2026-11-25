// Goal: the binding picker finds what a loop goes through from the loop's head alone — the
// list's name, or a path inside a value, with narrowing calls (`filter`, `slice`, `sort`),
// optional chaining, empty fallbacks and `Object.values(…)` peeled off — and says "not a
// value" (undefined) for a source it cannot follow, rather than guessing or throwing.
// Method: parseLoopHead and loopSourcePath are fed the heads and sources pages write, then
// heads that are not loops, sources that compute something, and inputs past their bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { parseLoopHead, loopSourcePath, LOOP_SOURCE_LIMITS } = loadRenderer('src/editor/loopSource.ts');

test('a map head names its source, its item and its index', () => {
  assert.deepEqual(parseLoopHead('statsEntries.map((item) => ('), { source: 'statsEntries', item: 'item', index: undefined });
  assert.deepEqual(parseLoopHead('  data.items.map((entry, i) => (  '), { source: 'data.items', item: 'entry', index: 'i' });
  assert.deepEqual(parseLoopHead('posts?.map(post => ('), { source: 'posts', item: 'post', index: undefined });
  assert.deepEqual(parseLoopHead('item.pastors.map((pastor) =>'), { source: 'item.pastors', item: 'pastor', index: undefined });
  assert.deepEqual(parseLoopHead('posts.filter((p) => p.ok).map((post) => ('), { source: 'posts.filter((p) => p.ok)', item: 'post', index: undefined });
});

test('a head that is not a loop is none', () => {
  assert.equal(parseLoopHead(''), undefined);
  assert.equal(parseLoopHead('posts.forEach((post) => ('), undefined);
  assert.equal(parseLoopHead('.map((post) => ('), undefined, 'a loop needs a source');
  assert.equal(parseLoopHead('posts.map(({ title }) => ('), undefined, 'a destructured item has no one name');
  assert.equal(parseLoopHead(`${'a'.repeat(LOOP_SOURCE_LIMITS.headCharsMax)}.map((x) => (`), undefined, 'past the length bound');
});

test('a source is the value it names, narrowed or wrapped', () => {
  assert.deepEqual(loopSourcePath('statsEntries'), { kind: 'list', path: 'statsEntries' });
  assert.deepEqual(loopSourcePath('data.items'), { kind: 'list', path: 'data.items' });
  assert.deepEqual(loopSourcePath('data?.items'), { kind: 'list', path: 'data.items' });
  assert.deepEqual(loopSourcePath('post.data["campus-list"]'), { kind: 'list', path: 'post.data["campus-list"]' });
  assert.deepEqual(loopSourcePath('posts.slice(0, 3)'), { kind: 'list', path: 'posts' });
  assert.deepEqual(loopSourcePath('posts.filter((post) => post.data.title !== ")").sort((a, b) => a.id - b.id)'), { kind: 'list', path: 'posts' });
  assert.deepEqual(loopSourcePath('(data.items ?? [])'), { kind: 'list', path: 'data.items' });
  assert.deepEqual(loopSourcePath('data.items || []'), { kind: 'list', path: 'data.items' });
  assert.deepEqual(loopSourcePath('Object.values(modules)'), { kind: 'values', path: 'modules' });
  assert.deepEqual(loopSourcePath('Object.values(modules).slice(0, 4)'), { kind: 'values', path: 'modules' });
});

test('a source that computes something is not a value the picker can follow', () => {
  assert.equal(loopSourcePath('await getPosts()'), undefined, 'a call written inline');
  assert.equal(loopSourcePath('(await fetch(url).then((r) => r.json())).items'), undefined);
  assert.equal(loopSourcePath('posts.map((post) => post.data)'), undefined, 'a map changes the element');
  assert.equal(loopSourcePath('[1, 2, 3]'), undefined);
  assert.equal(loopSourcePath('a + b'), undefined);
  assert.equal(loopSourcePath('posts.slice(0'), undefined, 'unbalanced brackets');
  assert.equal(loopSourcePath(''), undefined);
  // Wrappers past the step bound are not peeled forever.
  const wrapped = `${'('.repeat(LOOP_SOURCE_LIMITS.stepsMax + 2)}posts${')'.repeat(LOOP_SOURCE_LIMITS.stepsMax + 2)}`;
  assert.equal(loopSourcePath(wrapped), undefined);
});
