// Goal: the gate builds and checks exactly what its run asks for. `npm test`
// with no suite named is the full gate CI runs and must never lose a stage or
// a check; naming suites skips the clean and the whole-tree checks, and builds
// the renderer bundle only for a suite that reads it.
// Method: call the pure plan with hand-made suites (the runner's own input
// shape) and pin each stage list, the notice a targeted run prints, and the
// errors for the states that must not happen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatePlanFor, targetedNotice } from '#dist/scripts/gate/gatePlan.js';
import type { Suite } from '#dist/scripts/gate/testDiscovery.js';

const plain: Suite = { file: 'test/shared/core/x.test.ts', name: 'shared/core/x', options: {} };
const renderer: Suite = {
  file: 'test/scripts/build/buildLayout.test.ts',
  name: 'scripts/build/buildLayout',
  options: { build: 'renderer' },
};
const TYPESCRIPT_BUILDS = ['build:contracts', 'build:electron', 'build:scripts', 'build:morph', 'build:preload'];

test('no suite named is the full gate: every build, the bundle beside the chain', () => {
  const plan = gatePlanFor({ queries: [], selected: [plain, renderer] });
  assert.equal(plan.kind, 'full');
  assert.deepEqual(plan.chain, [...TYPESCRIPT_BUILDS, 'stage:runtime']);
  assert.deepEqual(plan.beside, ['build:web']);
});

test('the full gate builds the bundle even when no suite declares it', () => {
  const plan = gatePlanFor({ queries: [], selected: [plain] });
  assert.equal(plan.kind, 'full');
  assert.deepEqual(plan.beside, ['build:web']);
});

test('a named suite builds over the tree, without the scripts build or the bundle', () => {
  const plan = gatePlanFor({ queries: ['x'], selected: [plain] });
  assert.equal(plan.kind, 'targeted');
  assert.deepEqual(plan.chain, ['build:contracts', 'build:electron', 'build:morph', 'build:preload', 'stage:runtime']);
  assert.deepEqual(plan.beside, []);
  assert.match(targetedNotice(plan), /skipping the clean, tsc, ESLint, Prettier/);
  assert.match(targetedNotice(plan), /the renderer bundle\./);
});

test('a named suite that reads the renderer bundle builds it beside the chain', () => {
  const plan = gatePlanFor({ queries: ['buildLayout', 'x'], selected: [plain, renderer] });
  assert.equal(plan.kind, 'targeted');
  assert.deepEqual(plan.beside, ['build:web']);
  assert.equal(plan.chain.includes('build:web'), false);
  assert.doesNotMatch(targetedNotice(plan), /renderer bundle/);
});

test('a run with no suite, and a notice for the full gate, are refused', () => {
  assert.throws(() => gatePlanFor({ queries: [], selected: [] }), /^Error: gatePlanFor: no suite is selected$/);
  const full = gatePlanFor({ queries: [], selected: [plain] });
  assert.throws(() => targetedNotice(full), /^Error: targetedNotice: only a targeted run skips anything$/);
});
