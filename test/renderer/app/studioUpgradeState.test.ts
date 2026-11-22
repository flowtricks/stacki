// Goal: the Studio box's upgrade state machine moves only along its declared transitions, so a late answer,
// a stale progress snapshot or a double click can never put the box in a state the person did not cause; and a
// restore is offered only while an upgrade's backup is known.
// Method: drive the pure reducer with event sequences: the happy path, failure then retry, restore and its
// failure, ignored events in each state, and a check that arrives while an operation runs. The module is
// bundled through the renderer's bundler (test/helpers/rendererModule.js), because renderer sources import
// without file extensions and Node's own type stripping cannot resolve them; its types come from a type-only import.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type * as UpgradeModule from '../../../src/features/studioSetup/upgradeState.ts';
import type { UpgradeState } from '../../../src/features/studioSetup/upgradeState.ts';

const loadRenderer: unknown = createRequire(import.meta.url)('../../helpers/rendererModule.js');

// The bundled renderer module, checked for each export this test calls.
const isLoader = (value: unknown): value is (file: string) => unknown => typeof value === 'function';
const isUpgradeModule = (value: unknown): value is typeof UpgradeModule =>
  typeof value === 'object' &&
  value !== null &&
  'UPGRADE_INITIAL' in value &&
  'canStartUpgrade' in value &&
  typeof value.canStartUpgrade === 'function' &&
  'reduceUpgrade' in value &&
  typeof value.reduceUpgrade === 'function' &&
  'restorableNote' in value &&
  typeof value.restorableNote === 'function';

function upgradeModule(): typeof UpgradeModule {
  assert.ok(isLoader(loadRenderer), 'the renderer loader is a function');
  const loaded = loadRenderer('src/features/studioSetup/upgradeState.ts');
  assert.ok(isUpgradeModule(loaded), 'the module exports the reducer and its helpers');
  return loaded;
}

const { UPGRADE_INITIAL, canStartUpgrade, reduceUpgrade, restorableNote } = upgradeModule();

const snapshot = (requestId: string, stage: 'release' | 'build' = 'release', output = '') => ({ projectPath: '/site', requestId, stage, output });
const note = { from: '1.4.10', to: '1.4.12', changed: { listed: [{ kind: 'modifiedFile' as const, path: 'src/a.ts' }], total: 1 } };
const ready = reduceUpgrade(UPGRADE_INITIAL, { type: 'checked', check: { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: undefined } });

test('a check moves checking to each answer', () => {
  assert.deepEqual(reduceUpgrade(UPGRADE_INITIAL, { type: 'checked', check: { kind: 'unavailable' } }), { kind: 'unavailable' });
  assert.deepEqual(reduceUpgrade(UPGRADE_INITIAL, { type: 'checked', check: { kind: 'current', version: '1.4.12', previous: note } }), {
    kind: 'current',
    version: '1.4.12',
    previous: note,
  });
  assert.deepEqual(ready, { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: undefined });
  assert.equal(canStartUpgrade(UPGRADE_INITIAL), false);
  assert.equal(canStartUpgrade(ready), true);
});

test('start, progress and success keep the backup note for a restore', () => {
  let state: UpgradeState = reduceUpgrade(ready, { type: 'start', requestId: 'a', progress: snapshot('a') });
  assert.equal(state.kind, 'running');
  state = reduceUpgrade(state, { type: 'progress', progress: snapshot('a', 'build', 'log') });
  assert.equal(state.kind === 'running' && state.progress.stage, 'build');
  assert.equal(reduceUpgrade(state, { type: 'progress', progress: snapshot('other', 'release') }), state, 'another request is ignored');
  assert.equal(reduceUpgrade(state, { type: 'start', requestId: 'b', progress: snapshot('b') }), state, 'a second click while running does nothing');
  assert.equal(reduceUpgrade(state, { type: 'restore' }), state, 'no restore while an upgrade runs');
  state = reduceUpgrade(state, { type: 'finished', result: { kind: 'upgraded', version: '1.4.12', note } });
  assert.deepEqual(state, { kind: 'success', note });
  assert.equal(restorableNote(state), note);
  assert.equal(
    reduceUpgrade(state, { type: 'checked', check: { kind: 'current', version: '1.4.12', previous: undefined } }),
    state,
    'the refreshed version does not replace the success line',
  );
});

test('failure keeps the versions and a retry runs again', () => {
  let state = reduceUpgrade(ready, { type: 'start', requestId: 'a', progress: snapshot('a') });
  state = reduceUpgrade(state, { type: 'finished', result: { kind: 'error', message: 'npm failed' } });
  assert.deepEqual(state, { kind: 'failure', installed: '1.4.10', latest: '1.4.12', message: 'npm failed' });
  assert.equal(canStartUpgrade(state), true);
  assert.equal(restorableNote(state), undefined, 'nothing was replaced, so nothing to restore');
  const retry = reduceUpgrade(state, { type: 'start', requestId: 'b', progress: snapshot('b') });
  assert.equal(retry.kind === 'running' && retry.latest, '1.4.12');
  assert.equal(retry.kind === 'running' && retry.requestId, 'b');
  assert.equal(reduceUpgrade(state, { type: 'checked', check: { kind: 'unavailable' } }), state, 'a late check does not hide a failure');
});

test('restore is offered only with a note, and its failure can be retried', () => {
  assert.equal(reduceUpgrade(ready, { type: 'restore' }), ready, 'no earlier upgrade, no restore');
  const withNote = reduceUpgrade(UPGRADE_INITIAL, { type: 'checked', check: { kind: 'ready', installed: '1.4.12', latest: '1.4.13', previous: note } });
  let state = reduceUpgrade(withNote, { type: 'restore' });
  assert.deepEqual(state, { kind: 'restoring', note });
  assert.equal(reduceUpgrade(state, { type: 'restore' }), state, 'a second click while restoring does nothing');
  state = reduceUpgrade(state, { type: 'restoreFinished', result: { kind: 'error', message: 'busy' } });
  assert.deepEqual(state, { kind: 'restoreFailure', note, message: 'busy' });
  state = reduceUpgrade(state, { type: 'restore' });
  state = reduceUpgrade(state, { type: 'restoreFinished', result: { kind: 'restored', version: '1.4.10' } });
  assert.deepEqual(state, { kind: 'restored', version: '1.4.10' });
  assert.equal(restorableNote(state), undefined);
});

test('events that do not fit the state are ignored', () => {
  const current = reduceUpgrade(UPGRADE_INITIAL, { type: 'checked', check: { kind: 'current', version: '1.4.12', previous: undefined } });
  assert.equal(reduceUpgrade(current, { type: 'start', requestId: 'a', progress: snapshot('a') }), current, 'up to date has nothing to start');
  assert.equal(reduceUpgrade(ready, { type: 'finished', result: { kind: 'upgraded', version: '1.4.12', note } }), ready);
  assert.equal(reduceUpgrade(ready, { type: 'progress', progress: snapshot('a') }), ready);
  assert.equal(reduceUpgrade(ready, { type: 'restoreFinished', result: { kind: 'restored', version: '1.4.10' } }), ready);
});

test('a start whose snapshot belongs to another request is a programmer error', () => {
  assert.throws(() => reduceUpgrade(ready, { type: 'start', requestId: 'a', progress: snapshot('b') }), /belongs to the request/);
});
