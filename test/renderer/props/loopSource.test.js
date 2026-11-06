// The loop's head: one Code field, renames carried into the loop.
//
//   node test/renderer/props/loopSource.test.js
//
// A loop used to be edited through four fields — Data, Item name, Index name
// and Code — each restating part of one line. What the loop goes over is now
// chosen in the list settings above (LoopSettings.tsx), so the head is one
// Code field: `campusPastors.map((pastor) => (`. The separate Item name field
// was the one place a rename carried into the bindings inside the loop, so the
// Code field has to do it instead: renaming the item there renames every
// `pastor.…` inside, and editing anything else renames nothing.
//
// The head parser is checked first, then the renames a new head makes, then
// that the panel is the one field it says it is.

const assert = require('node:assert/strict');
const { parseMapHead, headRenames } = require('../../helpers/rendererModule')('src/features/props/propNodeEditors.tsx');
const { readSourceGroup } = require('../../helpers/sourceText.js');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

// Reading a head.
assert.deepEqual(parseMapHead('posts.map((post, index) => ('), { data: 'posts', item: 'post', index: 'index' });
assert.deepEqual(parseMapHead('posts.filter(p => p.live).map(post => ('), { data: 'posts.filter(p => p.live)', item: 'post', index: '' });
assert.equal(parseMapHead('posts.map(({title}) => ('), undefined, 'a destructured item is code');
assert.equal(parseMapHead(''), undefined);
assert.throws(() => parseMapHead('x'.repeat(1_000_001)), /head limit exceeded/);

// Renames a new head carries into the loop.
assert.deepEqual(headRenames('campusPastors.map((pastor) => (', 'campusPastors.map((leader) => ('), [{ from: 'pastor', to: 'leader' }]);
assert.deepEqual(headRenames('posts.map((post, i) => (', 'posts.map((entry, index) => ('), [
  { from: 'post', to: 'entry' },
  { from: 'i', to: 'index' },
]);
assert.deepEqual(headRenames('posts.map((post) => (', 'posts.slice(0, 3).map((post) => ('), [], 'changing the list renames nothing');
assert.deepEqual(headRenames('posts.map((post) => (', 'posts.map((post, index) => ('), [], 'adding an index renames nothing');
assert.deepEqual(headRenames('posts.map((post, index) => (', 'posts.map((post) => ('), [], 'removing one renames nothing');
assert.deepEqual(headRenames('posts.map(({ a }) => (', 'posts.map((post) => ('), [], 'from code the editor does not split, nothing');
assert.throws(() => headRenames('x'.repeat(1_000_001), 'posts.map((post) => ('), /head limit exceeded/);

// The panel: one Code field, with no binding handle and no field restating the head.
const source = readSourceGroup(['src/features/props/propNodeEditors.tsx']);
assert.ok(/const renames = node\.bodyParts === undefined \? headRenames\(node\.head, value\) : \[\];/.test(source), 'the Code field carries renames');
assert.equal((source.match(/<BindHandle /g) ?? []).length, 0, 'the Code field takes no binding: it is the loop itself');
for (const gone of ['Item name', 'Index name', '>Data<', 'sourceChip', 'withSource']) {
  assert.ok(!source.includes(gone), `${gone} is gone from the loop panel`);
}

// The chip an expression field draws is a mark over text, so a value never
// holds anything but the expression itself.
const expr = fs.readFileSync(repoPath('src/ui/ExprInput.tsx'), 'utf8');
assert.ok(/Decoration\.mark\(\{ class: 'cm-chip' \}\)/.test(expr), 'the chip is a mark, not a widget');
assert.ok(/stops being a chip/.test(expr), 'a chip whose text is edited away stops being one');

console.log('loop-source: ok');
