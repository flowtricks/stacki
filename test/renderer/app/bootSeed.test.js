// Goal: the renderer's seed (src/lib/bootSeed.ts) trusts nothing it is handed: the project and snapshots from
// the preload are parsed, bad ones dropped, and a missing bridge (Studio, tests) is simply "no seed".
// Method: parseBootSeed, the pure part, is driven with a good seed and each bad shape.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { parseBootSeed } = loadRenderer('src/lib/bootSeed.ts');
const snapshot = { version: 1, projectPath: '/work/site', pageName: 'index.astro' };

test('a good seed names the project and keeps its snapshots', () => {
  const seed = parseBootSeed({ version: 1, pendingProject: '/work/site', snapshots: [snapshot] });
  assert.deepEqual(seed.project, { path: '/work/site', name: 'site' });
  assert.equal(seed.snapshots.length, 1);
});

test('nothing owed means no project, and an invalid snapshot is dropped without hiding the good ones', () => {
  assert.equal(parseBootSeed({ version: 1, snapshots: [snapshot] }).project, undefined);
  const mixed = parseBootSeed({ pendingProject: '/work/site', snapshots: [{ version: 3 }, 'x', snapshot, JSON.parse('null')] });
  assert.equal(mixed.snapshots.length, 1);
});

test('every unusable seed is an empty one', () => {
  for (const input of [
    undefined,
    JSON.parse('null'),
    'x',
    4,
    [],
    {},
    { pendingProject: 7, snapshots: 'no' },
    { pendingProject: '', snapshots: {} },
    { pendingProject: 'p'.repeat(5000) },
  ]) {
    const seed = parseBootSeed(input);
    assert.equal(seed.project, undefined);
    assert.deepEqual(seed.snapshots, []);
  }
});
