// Goal: the updater drives the in-app popup and never a native dialog. Every step of an update (found, downloading, downloaded,
// failed) reaches the window as one `UpdateEvent`, progress is bounded and monotonic whatever electron-updater reports, and the File
// menu's check answers with a popup state either way.
// Method: AutoUpdates runs with a fake updater (an EventEmitter whose scheduled check never settles, as a download in flight does)
// and a `send` that records events. The updater's events are emitted in the order a real download produces them, including the
// reports it should not make (NaN, a count that goes backwards, progress before any version is named), and the recorded events are
// read back. Waits are on promises and the event loop turning, never on elapsed time.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { AutoUpdates, updateStateOf } = require('#dist/electron/app/autoUpdate.js');
const { NO_DOWNLOAD_PROGRESS } = require('#dist/shared/ipc/updateState.js');

const MEGABYTE = 1024 * 1024;

function fakeUpdater(overrides = {}) {
  const updater = new EventEmitter();
  Object.assign(updater, {
    // The scheduled check stays in flight, as it does while a download runs.
    checkForUpdatesAndNotify: () => new Promise(() => undefined),
    checkForUpdates: () => new Promise(() => undefined),
    quitAndInstall: () => {
      updater.installed += 1;
    },
    installed: 0,
    ...overrides,
  });
  return updater;
}

function start({ updater = fakeUpdater(), isPackaged = true } = {}) {
  const events = [];
  const steps = [];
  const host = {
    app: { isPackaged, isReady: () => false, getPath: () => '', getVersion: () => '1.4.9' },
    autoUpdater: updater,
    beforeInstall: () => steps.push('beforeInstall'),
    send: (event) => events.push(event),
  };
  const updates = new AutoUpdates(host);
  const realLog = console.log;
  console.log = () => undefined; // The module logs each event; the test reads what was sent.
  const realSetInterval = global.setInterval;
  // start() schedules a six-hourly check; unref it so the finished test does not keep the process alive.
  global.setInterval = (...args) => realSetInterval(...args).unref();
  try {
    updates.start();
  } finally {
    global.setInterval = realSetInterval;
  }
  return { updates, updater, events, steps, restore: () => (console.log = realLog) };
}

const turnEventLoop = () => new Promise((resolve) => setImmediate(resolve));

test('a download reaches the popup with live progress, only when the display would change', () => {
  const { updater, events, restore } = start();
  try {
    updater.emit('update-available', { version: '1.4.10' });
    assert.deepEqual(events.at(-1), { state: { kind: 'downloading', version: '1.4.10', progress: NO_DOWNLOAD_PROGRESS }, reveal: true });

    updater.emit('download-progress', { transferred: 10 * MEGABYTE, total: 40 * MEGABYTE, percent: 25 });
    assert.equal(events.length, 2);
    assert.equal(events.at(-1).reveal, false, 'a tick is not news to someone who hid the popup');
    assert.deepEqual(events.at(-1).state.progress, { transferredBytes: 10 * MEGABYTE, totalBytes: 40 * MEGABYTE, percent: 25 });

    updater.emit('download-progress', { transferred: 10 * MEGABYTE + 100, total: 40 * MEGABYTE, percent: 25 });
    assert.equal(events.length, 2, 'a change below a tenth of a megabyte draws nothing new');

    updater.emit('download-progress', { transferred: 20 * MEGABYTE, total: 40 * MEGABYTE, percent: 50 });
    assert.equal(events.at(-1).state.progress.percent, 50);
  } finally {
    restore();
  }
});

test('the updater reporting nonsense cannot move the bar backwards or off the scale', () => {
  const { updater, events, restore } = start();
  try {
    updater.emit('update-available', { version: '1.4.10' });
    updater.emit('download-progress', { transferred: 30 * MEGABYTE, total: 40 * MEGABYTE });
    const settled = events.length;
    for (const report of [
      { transferred: Number.NaN, total: Number.NaN },
      { transferred: -4, total: -4 },
      { transferred: 1 * MEGABYTE, total: 40 * MEGABYTE },
      { transferred: Number.POSITIVE_INFINITY, total: Number.POSITIVE_INFINITY },
    ]) {
      updater.emit('download-progress', report);
    }
    assert.equal(events.length, settled, 'none of those changes what is shown');
    updater.emit('download-progress', { transferred: 400 * MEGABYTE, total: 40 * MEGABYTE });
    assert.equal(events.at(-1).state.progress.percent, 100);
    assert.equal(events.at(-1).state.progress.transferredBytes, 40 * MEGABYTE, 'bytes stop at the total');
  } finally {
    restore();
  }
});

test('a download of unknown length shows bytes and no percent; one resumed before a version is named still shows', () => {
  const { updater, events, restore } = start();
  try {
    updater.emit('download-progress', { transferred: 5 * MEGABYTE, total: Number.NaN });
    assert.equal(events.at(-1).reveal, true, 'the first tick of a download nobody announced is news');
    assert.equal(events.at(-1).state.version, undefined);
    assert.deepEqual(events.at(-1).state.progress, { transferredBytes: 5 * MEGABYTE, totalBytes: undefined, percent: 0 });
  } finally {
    restore();
  }
});

test('a finished download offers the restart, and only a downloaded update installs', async () => {
  const { updates, updater, events, steps, restore } = start();
  try {
    updates.act('install');
    assert.equal(updater.installed, 0, 'no update downloaded yet: the click is ignored');
    assert.deepEqual(steps, []);

    updater.emit('update-available', { version: '1.4.10' });
    updater.emit('update-downloaded', { version: '1.4.10' });
    assert.deepEqual(events.at(-1), { state: { kind: 'ready', version: '1.4.10' }, reveal: true });
    assert.deepEqual(updates.current(), { kind: 'ready', version: '1.4.10' });

    updates.act('install');
    assert.equal(updater.installed, 1);
    assert.deepEqual(steps, ['beforeInstall']);
  } finally {
    restore();
  }
});

test('the File menu check says where an update stands, or that there is none', async () => {
  const { updates, updater, events, restore } = start();
  try {
    await updates.checkFromMenu();
    assert.deepEqual(events.at(-1), { state: { kind: 'notice', notice: 'alreadyChecking', version: '1.4.9' }, reveal: true });

    updater.emit('update-available', { version: '1.4.10' });
    updater.emit('download-progress', { transferred: 10 * MEGABYTE, total: 40 * MEGABYTE });
    const before = events.length;
    await updates.checkFromMenu();
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1).reveal, true, 'asking brings the hidden popup back');
    assert.equal(events.at(-1).state.progress.percent, 25);

    updater.emit('update-downloaded', { version: '1.4.10' });
    await updates.checkFromMenu();
    assert.deepEqual(events.at(-1), { state: { kind: 'ready', version: '1.4.10' }, reveal: true });
  } finally {
    restore();
  }
});

test('a check that finds nothing, fails, or runs in development answers in the popup', async () => {
  const idle = fakeUpdater({
    checkForUpdatesAndNotify: () => Promise.resolve(undefined),
    checkForUpdates: () => Promise.resolve({ updateInfo: { version: '1.4.9' } }),
  });
  const quiet = start({ updater: idle });
  try {
    await turnEventLoop();
    await quiet.updates.checkFromMenu();
    assert.deepEqual(quiet.events.at(-1), { state: { kind: 'notice', notice: 'latest', version: '1.4.9' }, reveal: true });
  } finally {
    quiet.restore();
  }

  const broken = fakeUpdater({
    checkForUpdatesAndNotify: () => Promise.resolve(undefined),
    checkForUpdates: () => Promise.reject(new Error('HttpError: 403 Forbidden\n"headers": {"secret": 1}')),
  });
  const failing = start({ updater: broken });
  try {
    await turnEventLoop();
    await failing.updates.checkFromMenu();
    assert.deepEqual(failing.events.at(-1), { state: { kind: 'error', stage: 'check', detail: 'Error: HttpError: 403 Forbidden' }, reveal: true });
  } finally {
    failing.restore();
  }

  const dev = start({ isPackaged: false });
  try {
    await dev.updates.checkFromMenu();
    assert.deepEqual(dev.events.at(-1), { state: { kind: 'notice', notice: 'development', version: '1.4.9' }, reveal: true });
  } finally {
    dev.restore();
  }
});

test('a failed download tells the popup, drops the download, and retry checks again', async () => {
  let checks = 0;
  const updater = fakeUpdater({
    checkForUpdatesAndNotify: () => Promise.resolve(undefined),
    checkForUpdates: () => {
      checks += 1;
      return Promise.resolve({ updateInfo: { version: '1.4.9' } });
    },
  });
  const { updates, events, restore } = start({ updater });
  try {
    await turnEventLoop();
    updater.emit('update-available', { version: '1.4.10' });
    updater.emit('download-progress', { transferred: 10 * MEGABYTE, total: 40 * MEGABYTE });
    updater.emit('error', new Error('net::ERR_CONNECTION_CLOSED'));
    assert.deepEqual(events.at(-1), { state: { kind: 'error', stage: 'download', detail: 'Error: net::ERR_CONNECTION_CLOSED' }, reveal: true });
    assert.deepEqual(updates.current(), { kind: 'idle' });

    updates.act('retry');
    await turnEventLoop();
    assert.equal(checks, 1);
  } finally {
    restore();
  }
});

test('a background check failure is shown once, and a dropped connection never', () => {
  const { updater, events, restore } = start();
  try {
    updater.emit('error', new Error('net::ERR_CONNECTION_CLOSED'));
    assert.equal(events.length, 0, 'the user can do nothing about being offline');
    updater.emit('error', new Error('Code signature did not pass validation'));
    assert.equal(events.length, 1);
    assert.equal(events.at(-1).state.kind, 'error');
    updater.emit('error', new Error('Code signature did not pass validation'));
    assert.equal(events.length, 1, 'the second is only logged');
  } finally {
    restore();
  }
});

test('the state a new window mounts with follows the download', () => {
  assert.deepEqual(updateStateOf({ kind: 'none' }), { kind: 'idle' });
  const progress = { transferredBytes: 1, totalBytes: 2, percent: 50 };
  assert.deepEqual(updateStateOf({ kind: 'downloading', version: '1.4.10', progress }), { kind: 'downloading', version: '1.4.10', progress });
  assert.deepEqual(updateStateOf({ kind: 'downloaded', version: '1.4.10' }), { kind: 'ready', version: '1.4.10' });
});
