// Goal: a column guide change is never lost. One made while the settings file was
// being re-read was ignored, and a save that failed was dropped although its
// message promised a retry. Method: the real controller against an in-memory disk
// whose reads can be held back and whose writes can be made to fail; `reload` is
// the retry the app runs every 15 seconds and when the window returns. Waits are
// for observed states, never for a length of time. The negative space: an
// unreadable guide file is never written over, and nothing is saved unasked.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { waitFor } = require('../../helpers/waitFor');

const until = (what, holds) => waitFor({ what, read: holds, until: Boolean });
const { createGuideController } = loadRenderer('src/features/preview/guidePersistence.ts');

const BASE = { visible: false, columns: { kind: 'automatic' }, color: '#abc', opacity: 0.1, numbers: true, columnDefaultsVersion: 1 };
const fileWith = (settings) => JSON.stringify({ version: 1, settings: { ...BASE, ...settings } }, undefined, 2) + '\n';

function disk(initial) {
  const state = { source: initial, writes: 0, reads: 0, failWrites: 0, held: undefined };
  globalThis.CSS = { supports: () => true };
  globalThis.localStorage = { getItem: () => undefined };
  globalThis.window = {
    avb: {
      projectMetadata: async () => {
        state.reads += 1;
        const source = state.source;
        await state.held?.promise;
        return { ok: true, value: source === undefined ? {} : { source } };
      },
      writeProjectMetadata: async ({ write }) => {
        if (state.failWrites > 0) {
          state.failWrites -= 1;
          return { ok: false, error: { code: 'metadata', message: 'The disk is full.' } };
        }
        if (write.base !== state.source) {
          return { ok: false, error: { code: 'conflict', message: 'Changed in another editor.' } };
        }
        state.source = write.source;
        state.writes += 1;
        return { ok: true, value: { source: write.source } };
      },
    },
  };
  state.hold = () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    state.held = { promise };
    return () => {
      state.held = undefined;
      release();
    };
  };
  state.settings = () => JSON.parse(state.source).settings;
  return state;
}

async function opened(project = '/project') {
  const states = [];
  const controller = createGuideController(project, (next) => states.push(next));
  const last = () => states.at(-1);
  controller.reload();
  await until('the first load', () => last()?.loading === false);
  return { controller, states, last };
}

test('a change made while the settings are being re-read is kept and saved', async () => {
  const file = disk(fileWith({ opacity: 0.1 }));
  const { controller, last } = await opened();
  const release = file.hold();
  controller.reload();
  // Another editor's change lands while this one is reading.
  controller.change((settings) => ({ ...settings, opacity: 0.4 }));
  assert.equal(last().settings.opacity, 0.4, 'shown at once');
  release();
  await until('the change to be saved', () => file.writes === 1);
  assert.equal(file.settings().opacity, 0.4);
  controller.close();
});

test('a failed save is retried by the next re-read, over the newer file', async () => {
  const file = disk(fileWith({ opacity: 0.1, numbers: true }));
  const { controller, last } = await opened();
  file.failWrites = 1;
  controller.change((settings) => ({ ...settings, opacity: 0.3 }));
  await until('the failure', () => last().problem.includes('The disk is full.'));
  assert.equal(last().settings.opacity, 0.3, 'the change stays on screen');
  // A second change while failing is kept too, and another editor changes a third setting.
  controller.change((settings) => ({ ...settings, visible: true }));
  assert.match(last().problem, /The disk is full/);
  file.source = fileWith({ opacity: 0.1, numbers: false });
  controller.reload();
  await until('the retry', () => file.writes === 1);
  assert.deepEqual([file.settings().opacity, file.settings().visible, file.settings().numbers], [0.3, true, false]);
  await until('the problem to clear', () => last().problem === '');
  // Nothing is left to save: the next re-read writes nothing.
  const reads = file.reads;
  controller.reload();
  await until('a quiet re-read', () => file.reads === reads + 1 && last().loading === false);
  assert.equal(file.writes, 1);
  controller.close();
});

test('closing with a change still unsaved saves it', async () => {
  const file = disk(fileWith({ opacity: 0.1 }));
  const { controller } = await opened();
  const release = file.hold();
  controller.reload();
  controller.change((settings) => ({ ...settings, opacity: 0.5 }));
  controller.close();
  release();
  await until('the save on close', () => file.writes === 1);
  assert.equal(file.settings().opacity, 0.5);
});

test('an unreadable guide file is never written over', async () => {
  const file = disk('{broken');
  const { controller, last } = await opened();
  assert.notEqual(last().problem, '');
  controller.change((settings) => ({ ...settings, opacity: 0.5 }));
  const reads = file.reads;
  controller.reload();
  await until('the re-read', () => file.reads === reads + 1 && last().loading === false);
  controller.close();
  await until('the read on close', () => file.reads === reads + 2);
  assert.equal(file.source, '{broken');
  assert.equal(file.writes, 0);
});
