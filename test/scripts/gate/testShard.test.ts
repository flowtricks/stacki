// Goal: `npm test -- --shard=k/n` splits the suites so that the n shards together are exactly the
// full gate: every suite in exactly one shard, the same shard on every run and platform, and the
// static checks in their own checks-only run, never in a shard. A shard that dropped or duplicated a suite would let CI go green
// without running it.
// Methodology: properties over the real suite list (discovered from test/) and over generated
// paths for every n from 1 to the limit: the union of the shards is the input, the shards are
// disjoint, and the assignment is stable under reordering and path separators. The parser and
// the gate plan get good and bad shards.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatePlanFor } from '#dist/scripts/gate/gatePlan.js';
import { discoverTestFiles, suitesFor, type Suite } from '#dist/scripts/gate/testDiscovery.js';
import { parseShard, SHARD_LIMITS, shardOf, stableHash, suitesInShard } from '#dist/scripts/gate/testShard.js';

const realSuites = suitesFor(discoverTestFiles(process.cwd()));
const generated: readonly Suite[] = Array.from({ length: 500 }, (_, index) => ({
  file: `test/area${index % 7}/suite${index}.test.ts`,
  name: `area/suite${index}`,
  options: {},
}));

function assertPartition(suites: readonly Suite[], count: number): void {
  const shards = Array.from({ length: count }, (_, index) => suitesInShard(suites, { index: index + 1, count }));
  const seen = new Map<string, number>();
  for (const shard of shards) {
    for (const suite of shard) {
      seen.set(suite.file, (seen.get(suite.file) ?? 0) + 1);
    }
  }
  assert.equal(seen.size, suites.length, `n=${count}: the union of the shards is every suite`);
  assert.ok(
    [...seen.values()].every((times) => times === 1),
    `n=${count}: no suite is in two shards`,
  );
}

test('the shards partition the real suite list and generated lists, for every shard count', () => {
  assert.ok(realSuites.length > 100, 'the real list was discovered');
  for (let count = 1; count <= SHARD_LIMITS.countMax; count += 1) {
    assertPartition(realSuites, count);
    assertPartition(generated, count);
  }
});

test('the assignment is stable: order, separators and other suites do not move a suite', () => {
  const forward = suitesInShard(realSuites, { index: 2, count: 4 }).map((suite) => suite.file);
  const reversed = suitesInShard([...realSuites].reverse(), { index: 2, count: 4 }).map((suite) => suite.file);
  assert.deepEqual([...reversed].sort(), [...forward].sort());
  assert.equal(shardOf('test\\a\\b.test.ts', 4), shardOf('test/a/b.test.ts', 4));
  const withNew = [...realSuites, { file: 'test/new/brandNew.test.ts', name: 'new/brandNew', options: {} }];
  for (const suite of realSuites) {
    assert.equal(shardOf(suite.file, 4), shardOf(suite.file, 4));
  }
  assert.equal(
    suitesInShard(withNew, { index: 1, count: 4 }).filter((suite) => suite.file !== 'test/new/brandNew.test.ts').length,
    suitesInShard(realSuites, { index: 1, count: 4 }).length,
  );
  assert.equal(stableHash('test/a.test.ts'), stableHash('test/a.test.ts'));
  assert.equal(stableHash(''), 0x811c9dc5);
});

test('every one of four shards on the real list holds suites (none is empty)', () => {
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(suitesInShard(realSuites, { index, count: 4 }).length > 0, `shard ${index}/4`);
  }
});

test('the parser accepts k/n within the limit and refuses the rest', () => {
  assert.deepEqual(parseShard('1/4'), { index: 1, count: 4 });
  assert.deepEqual(parseShard('4/4'), { index: 4, count: 4 });
  for (const bad of ['0/4', '5/4', '1/0', '1/17', 'a/b', '1-4', '', '1/4/2']) {
    assert.equal(typeof parseShard(bad), 'string', bad);
  }
  assert.throws(() => suitesInShard(realSuites, { index: 5, count: 4 }), /^Error: suitesInShard: shard 5\/4 does not exist$/);
  assert.throws(() => shardOf('x', 0), /^Error: shardOf: 0 shards is outside 1 to 16$/);
});

test('the checks-only run holds the static checks, no shard does, and neither names suites', () => {
  const [suite] = realSuites;
  assert.ok(suite !== undefined);
  assert.equal(gatePlanFor({ queries: [], selected: [suite] }).staticChecks, 'run');
  assert.equal(gatePlanFor({ queries: [], selected: [suite], part: 'checks-all' }).staticChecks, 'run');
  assert.equal(gatePlanFor({ queries: [], selected: [suite], part: 'checks-studio' }).kind, 'full');
  for (let index = 1; index <= 4; index += 1) {
    const plan = gatePlanFor({ queries: [], selected: [suite], shard: { index, count: 4 } });
    assert.equal(plan.kind, 'full', 'every shard cleans and builds like the full gate');
    assert.equal(plan.staticChecks, 'skip');
  }
  assert.equal(gatePlanFor({ queries: ['x'], selected: [suite] }).staticChecks, 'skip');
  assert.throws(() => gatePlanFor({ queries: ['x'], selected: [suite], shard: { index: 1, count: 4 } }), /cannot be combined with named suites/);
  assert.throws(() => gatePlanFor({ queries: [], selected: [suite], shard: { index: 1, count: 4 }, part: 'checks-desktop' }), /not both/);
  assert.throws(() => gatePlanFor({ queries: ['x'], selected: [suite], part: 'checks-all' }), /names no suites/);
});
