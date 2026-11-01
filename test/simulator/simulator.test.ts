// Goal: the simulator runs seeded scenarios over the hostile corpus (its
// Markdown shapes included since step 10) and a slice of the .astro and
// Markdown round-trip corpora, every invariant holds after every event, and
// a seed reproduces its run exactly (plan §10, invariant 9). From step 3 the
// actor plans set-attribute with the shipping planner, so stale intents are
// remapped through the diff, and every remap is judged against the byte
// origins the simulator recorded: a wrong-site plan fails the run at the event.
// Method: the entry points are the only files under test/simulator/ that touch
// the filesystem — fixtures.entry.ts loads the fixture texts and hands them to
// runSimulation, which is pure. Each gate seed runs twice and the trace digests
// must match; the seeds together must reach every outcome class the simulator
// can produce, remap judgements included, so a thin run fails instead of
// passing quietly. Nightly: STACKI_SIMULATOR_SEEDS raises the seed count (up to
// SEEDS_MAX) without changing the gate; spike.bench.ts reports the judgements.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSimulationFixtures } from './fixtures.entry.ts';
import { Prng } from './prng.ts';
import { runSimulation, type SimulationReport } from './world.ts';

const GATE_SEEDS = 24;
const SEEDS_MAX = 100_000;
const STEPS = 400;

function seedCount(): number {
  const raw = process.env['STACKI_SIMULATOR_SEEDS'];
  if (raw === undefined) {
    return GATE_SEEDS;
  }
  const seeds = Number(raw);
  assert.ok(Number.isSafeInteger(seeds), 'STACKI_SIMULATOR_SEEDS is an integer');
  assert.ok(seeds > 0, 'STACKI_SIMULATOR_SEEDS is positive');
  assert.ok(seeds <= SEEDS_MAX, `STACKI_SIMULATOR_SEEDS is at most ${SEEDS_MAX}`);
  return seeds;
}

const fixtures = loadSimulationFixtures();
const run = (seed: number): SimulationReport => runSimulation({ seed, steps: STEPS, wrongSite: 'fail', ...fixtures });

test('the PRNG is pinned: the same seed yields the same stream on every machine', () => {
  const stream = (seed: number) => {
    const prng = new Prng(seed);
    return Array.from({ length: 4 }, () => prng.nextUint32());
  };
  assert.deepEqual(stream(1), stream(1));
  assert.notDeepEqual(stream(1), stream(2));
  assert.deepEqual(stream(1), [PINNED_SEED_1[0], PINNED_SEED_1[1], PINNED_SEED_1[2], PINNED_SEED_1[3]]);
  const prng = new Prng(7);
  const buckets = [0, 0, 0, 0];
  for (let draw = 0; draw < 4_000; draw++) {
    const bucket = prng.below(4);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  for (const size of buckets) {
    assert.ok(size > 850 && size < 1_150, `below(4) is roughly uniform: ${buckets.join(', ')}`);
  }
  assert.throws(() => prng.below(0), /Bound is positive/);
  assert.throws(() => new Prng(-1), /Seed is nonnegative/);
});

test('every seeded run holds the invariants and reproduces per seed (invariant 9)', () => {
  const tally: Record<string, number> = {};
  const digests = new Set<string>();
  for (let seed = 1; seed <= seedCount(); seed++) {
    const first = run(seed);
    const second = run(seed);
    assert.equal(second.digest, first.digest, `seed ${seed} reproduces`);
    assert.deepEqual(second.trace, first.trace);
    digests.add(first.digest);
    for (const [key, value] of Object.entries(first.tally)) {
      tally[key] = (tally[key] ?? 0) + value;
    }
  }
  assert.equal(digests.size, seedCount(), 'different seeds drive different runs');
  // Corpus diversity is a gate (tracker step 1): the seeds must reach every
  // outcome class the skeleton can produce, or the run proves little.
  for (const reached of REQUIRED_TALLIES) {
    assert.ok((tally[reached] ?? 0) > 0, `the gate seeds reach ${reached}: ${JSON.stringify(tally)}`);
  }
});

const REQUIRED_TALLIES = [
  'outcome:applied',
  'outcome:rejected anchor-moved',
  'outcome:rejected anchor-ambiguous',
  'outcome:rejected region-externally-modified',
  'outcome:rejected source-invalid',
  'outcome:rejected unsupported-operation',
  'outcome:rejected write-failed',
  'outcome:rejected write-race',
  'outcome:uncertain',
  // Step 5: the shipped actor's lock and its two replace failures.
  'lock-contended',
  'replace:failed',
  'replace:not-durable',
  'submit:backpressured',
  'gesture:completed',
  'gesture:cancelled',
  // Step 3: stale set-attribute intents mapped through the diff and judged.
  'mapping:identity',
  'remap:applied-correct',
  'remap:conservative anchor-ambiguous',
  'remap:conservative anchor-moved',
  'remap:rejected-conflict anchor-moved',
  'reference:agreed',
  // Step 6: undo on the engine, fresh and after other writes, and refused.
  'undo:planned',
  'undo:mapped',
  'undo:rejected region-externally-modified',
  // Step 8: code-editor saves as patches — malformed intermediates written,
  // stale patches merged through other writes, and overlaps refused.
  'code:planned',
  'code:invalid',
  'code:mapped',
  'code:rejected merge-conflict',
  'outcome:rejected merge-conflict',
  // Step 9: the renames that replaced whole-model saves, submitted and judged
  // stale by their element's survival like set-attribute.
  'visual:rename-tag',
  'visual:rename-attribute',
  // Step 10: Markdown block intents on the Markdown corpus — text typed, blocks
  // and items removed, inserted and moved — fresh and from stale previews,
  // judged by their node's survival; oracle gestures on Markdown shapes judged
  // the same way. Markdown removals delete nodes, so `rejected-gone` (a stale
  // intent whose node someone removed) is reached at last.
  'markdown:rewrite-node',
  'markdown:remove-node',
  'markdown:insert-node',
  'markdown:move-node',
  'markdown-mapping:identity',
  'remap-markdown:applied-correct',
  'remap-markdown:conservative',
  'remap-markdown:rejected-conflict',
  'remap-markdown:rejected-gone',
  'remap-markdown-oracle:insert-node',
  'remap:rejected-gone anchor-moved',
] as const;

const PINNED_SEED_1 = [2442144158, 3238099751, 3819917871, 2104621829] as const;
