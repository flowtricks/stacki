// Goal: main's side of the boot path (electron/boot): the snapshot file is read before the window exists, saves are
// validated and written rarely and atomically, a snapshot of a vanished project is never handed to the renderer, and
// the three raw channels answer only the main window's own top frame.
// Method: the store runs on a temporary folder with a fake clock (no wall-clock assertions) and a fake `exists`;
// the channels register on a fake ipcMain whose events are plain objects, driven with a main-frame event and a
// foreign one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BOOT_FILE, createBootStore, readBootFile } = require('#dist/electron/boot/bootStore.js');
const { registerBootChannels } = require('#dist/electron/boot/bootChannels.js');

function fakeClock() {
  let pending;
  let nowMs = 0;
  return {
    clock: {
      now: () => nowMs,
      setTimer: (task, delayMs) => (pending = { task, dueMs: nowMs + delayMs }),
      clearTimer: (timer) => {
        if (pending === timer) {
          pending = undefined;
        }
      },
    },
    advance: (durationMs) => {
      nowMs += durationMs;
      if (pending !== undefined && pending.dueMs <= nowMs) {
        const { task } = pending;
        pending = undefined;
        task();
      }
    },
  };
}

const snapshotText = (projectPath, extra = {}) => JSON.stringify({ version: 1, projectPath, ...extra });

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-boot-'));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a save is validated, kept, written after a quiet, and read back next start', () => {
  withDirectory((directory) => {
    const time = fakeClock();
    const store = createBootStore(directory, time.clock, () => true);
    assert.equal(store.save('{broken'), false);
    assert.equal(store.save(JSON.stringify({ version: 9 })), false, 'an invalid snapshot is dropped');
    assert.equal(store.save('x'.repeat(10 * 1024 * 1024)), false, 'an oversized one is refused before parsing');
    assert.equal(fs.existsSync(path.join(directory, BOOT_FILE)), false, 'nothing is written for a drop');
    assert.equal(store.save(snapshotText('/p', { pageName: 'index.astro' })), true);
    assert.equal(fs.existsSync(path.join(directory, BOOT_FILE)), false, 'and not at once');
    time.advance(60_000);
    assert.equal(readBootFile(directory).projects[0].pageName, 'index.astro');
    const next = createBootStore(directory, time.clock, () => true);
    assert.equal(next.payload('/p').pendingProject, '/p');
    assert.equal(next.payload(undefined).pendingProject, undefined);
    assert.equal(next.payload('/p').snapshots.length, 1);
  });
});

test('flush writes a waiting save; a damaged or oversized file reads as empty', () => {
  withDirectory((directory) => {
    const store = createBootStore(directory, fakeClock().clock, () => true);
    store.save(snapshotText('/p'));
    store.flush();
    assert.equal(readBootFile(directory).projects.length, 1);
    fs.writeFileSync(path.join(directory, BOOT_FILE), '{not json', 'utf8');
    assert.deepEqual(readBootFile(directory).projects, []);
    fs.writeFileSync(path.join(directory, BOOT_FILE), 'x'.repeat(2 * 1024 * 1024), 'utf8');
    assert.deepEqual(readBootFile(directory).projects, []);
  });
});

test('a snapshot of a project that is gone is not handed to the renderer', () => {
  withDirectory((directory) => {
    const store = createBootStore(directory, fakeClock().clock, (projectPath) => projectPath !== '/gone');
    store.save(snapshotText('/gone'));
    store.save(snapshotText('/here'));
    assert.deepEqual(
      store.payload(undefined).snapshots.map((entry) => entry.projectPath),
      ['/here'],
    );
  });
});

test('the channels answer the main window only', () => {
  withDirectory((directory) => {
    const handlers = new Map();
    const store = createBootStore(directory, fakeClock().clock, () => true);
    let frames = 0;
    registerBootChannels({
      ipcMain: { on: (channel, listener) => handlers.set(channel, listener) },
      store,
      pendingProject: () => '/p',
      isMainFrame: (event) => event.main === true,
      onFirstFrame: () => (frames += 1),
    });
    assert.deepEqual([...handlers.keys()].sort(), ['boot:first-frame', 'boot:read', 'boot:save']);
    const foreign = { main: false };
    handlers.get('boot:read')(foreign);
    assert.equal(foreign.returnValue, undefined, 'a preview frame gets nothing');
    const own = { main: true };
    handlers.get('boot:read')(own);
    assert.equal(own.returnValue.pendingProject, '/p');
    handlers.get('boot:first-frame')(foreign);
    assert.equal(frames, 0);
    handlers.get('boot:first-frame')(own);
    assert.equal(frames, 1);
    handlers.get('boot:save')(foreign, snapshotText('/q'));
    handlers.get('boot:save')(own, 42);
    assert.equal(store.payload(undefined).snapshots.length, 0, 'a foreign or non-text save is ignored');
    handlers.get('boot:save')(own, snapshotText('/q'));
    assert.equal(store.payload(undefined).snapshots.length, 1);
  });
});
