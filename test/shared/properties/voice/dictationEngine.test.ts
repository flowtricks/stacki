// Goal: the on-device engine's visible state machine never shows something untrue. A model on disk is
// ready; a download shows bytes and never passes its total; a session goes ready → loading the model
// (only when cold) → listening → writing down the last words → ready; a stop while the model loads
// leaves nothing to decode; a failure always shows and stays until reset; a disk report never
// interrupts a running session. Also the real-time factor, the thread bound and the download percent.
// Methodology: drive reduceEngine with every event from every state that matters, plus the pure
// helpers over boundary values (short windows, zero cores, an isolated and a shared window).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENGINE_NOT_INSTALLED,
  canListen,
  downloadPercent,
  isEngineBusy,
  isTooSlow,
  realTimeFactor,
  reduceEngine,
  workerThreads,
  type DictationEngineEvent,
  type DictationEngineState,
} from '#dist/shared/properties/voice/dictationEngine.js';

const installed: DictationEngineEvent = { kind: 'install', install: { kind: 'installed', sizeBytes: 100 } };
const run = (state: DictationEngineState, ...events: readonly DictationEngineEvent[]): DictationEngineState => events.reduce(reduceEngine, state);

test('what is on disk decides the idle state', () => {
  assert.deepEqual(run(ENGINE_NOT_INSTALLED, installed), { kind: 'ready' });
  assert.deepEqual(run(ENGINE_NOT_INSTALLED, { kind: 'install', install: { kind: 'notInstalled' } }), ENGINE_NOT_INSTALLED);
  assert.deepEqual(run(ENGINE_NOT_INSTALLED, { kind: 'install', install: { kind: 'partial', receivedBytes: 5, totalBytes: 10 } }), ENGINE_NOT_INSTALLED);
  assert.deepEqual(run(ENGINE_NOT_INSTALLED, { kind: 'install', install: { kind: 'downloading', receivedBytes: 5, totalBytes: 10 } }), {
    kind: 'downloading',
    receivedBytes: 5,
    totalBytes: 10,
  });
  assert.equal(canListen(run(ENGINE_NOT_INSTALLED, installed)), true);
  assert.equal(canListen(ENGINE_NOT_INSTALLED), false);
});

test('a download shows its bytes, ends ready, and a cancel is not an error', () => {
  const going = run(ENGINE_NOT_INSTALLED, { kind: 'downloadProgress', receivedBytes: 40, totalBytes: 100 });
  assert.deepEqual(going, { kind: 'downloading', receivedBytes: 40, totalBytes: 100 });
  assert.deepEqual(
    run(going, { kind: 'downloadProgress', receivedBytes: 500, totalBytes: 100 }),
    { kind: 'downloading', receivedBytes: 100, totalBytes: 100 },
    'clamped',
  );
  assert.deepEqual(run(going, { kind: 'downloadEnded', outcome: { kind: 'installed', sizeBytes: 100 } }), { kind: 'ready' });
  assert.deepEqual(run(going, { kind: 'downloadEnded', outcome: { kind: 'failed', failure: 'cancelled' } }), ENGINE_NOT_INSTALLED);
  assert.deepEqual(run(going, { kind: 'downloadEnded', outcome: { kind: 'failed', failure: 'hashMismatch' } }), {
    kind: 'error',
    failure: { download: 'hashMismatch' },
  });
});

test('a cold session loads the model first; a warm one listens at once; stop writes down the last words', () => {
  const ready = run(ENGINE_NOT_INSTALLED, installed);
  assert.deepEqual(run(ready, { kind: 'listen', model: 'cold' }), { kind: 'loadingModel' });
  assert.deepEqual(run(ready, { kind: 'listen', model: 'cold' }, { kind: 'loaded' }), { kind: 'listening' });
  assert.deepEqual(run(ready, { kind: 'listen', model: 'loaded' }), { kind: 'listening' });
  const stopped = run(ready, { kind: 'listen', model: 'loaded' }, { kind: 'stop' });
  assert.deepEqual(stopped, { kind: 'transcribing' });
  assert.equal(isEngineBusy(stopped), true);
  assert.deepEqual(run(stopped, { kind: 'done' }), { kind: 'ready' });
  assert.deepEqual(run(ready, { kind: 'listen', model: 'cold' }, { kind: 'stop' }), { kind: 'ready' }, 'nothing heard yet, nothing to decode');
});

test('a session cannot start unless ready, and a disk report does not interrupt one', () => {
  assert.deepEqual(run(ENGINE_NOT_INSTALLED, { kind: 'listen', model: 'loaded' }), ENGINE_NOT_INSTALLED);
  const listening = run(ENGINE_NOT_INSTALLED, installed, { kind: 'listen', model: 'loaded' });
  assert.deepEqual(run(listening, { kind: 'install', install: { kind: 'notInstalled' } }), listening);
  assert.deepEqual(run(listening, { kind: 'downloadProgress', receivedBytes: 1, totalBytes: 2 }), listening);
  assert.deepEqual(run(listening, { kind: 'loaded' }), listening, 'loaded only moves a loading engine');
  assert.deepEqual(run(listening, { kind: 'listen', model: 'cold' }), listening);
});

test('a failure shows from any state and stays until reset, which goes back to what the disk says', () => {
  for (const from of [ENGINE_NOT_INSTALLED, run(ENGINE_NOT_INSTALLED, installed), run(ENGINE_NOT_INSTALLED, installed, { kind: 'listen', model: 'cold' })]) {
    assert.deepEqual(run(from, { kind: 'failed', failure: 'engineCrashed' }), { kind: 'error', failure: 'engineCrashed' });
  }
  const failed = run(ENGINE_NOT_INSTALLED, installed, { kind: 'failed', failure: 'modelCorrupt' });
  assert.deepEqual(run(failed, { kind: 'install', install: { kind: 'notInstalled' } }), failed, 'an undismissed error stays');
  assert.deepEqual(run(failed, { kind: 'reset', install: { kind: 'installed', sizeBytes: 1 } }), { kind: 'ready' });
  assert.deepEqual(run(failed, { kind: 'reset', install: { kind: 'notInstalled' } }), ENGINE_NOT_INSTALLED, 'a dismissed error shows what is on disk');
  assert.deepEqual(
    run(run(ENGINE_NOT_INSTALLED, installed), { kind: 'reset', install: { kind: 'notInstalled' } }),
    { kind: 'ready' },
    'reset only acts on an error',
  );
});

test('the real-time factor counts short windows as four seconds, and 1.5 is the bound', () => {
  assert.equal(realTimeFactor(2_000, 1_000), 0.5);
  assert.equal(realTimeFactor(2_000, 8_000), 0.25);
  assert.equal(isTooSlow(2_400, 7_400), false, 'base on the measured machine');
  assert.equal(isTooSlow(6_000, 4_000), false, 'exactly 1.5 is not over');
  assert.equal(isTooSlow(6_001, 4_000), true);
  assert.throws(() => realTimeFactor(-1, 100), /Assertion failed/);
});

test('threads: one in a shared window, otherwise cores minus one within the bound', () => {
  assert.equal(workerThreads(18, 'shared'), 1);
  assert.equal(workerThreads(18, 'isolated'), 4);
  assert.equal(workerThreads(3, 'isolated'), 2);
  assert.equal(workerThreads(1, 'isolated'), 1);
  assert.equal(workerThreads(0, 'isolated'), 1);
  assert.throws(() => workerThreads(2.5, 'isolated'), /whole number of cores/);
});

test('download percent is whole and never over 100', () => {
  assert.equal(downloadPercent(0, 79_664_191), 0);
  assert.equal(downloadPercent(39_832_095, 79_664_191), 49);
  assert.equal(downloadPercent(79_664_191, 79_664_191), 100);
  assert.equal(downloadPercent(80_000_000, 79_664_191), 100);
  assert.throws(() => downloadPercent(1, 0), /has a size/);
});
