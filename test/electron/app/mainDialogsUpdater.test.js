// The update dialogs speak the language the person chose, and switch with it.
//
//   node test/electron/app/mainDialogsUpdater.test.js
//
// The method: AutoUpdates runs with a fake updater (an EventEmitter) and a dialog that records what it is asked to show. The
// "downloaded" event is emitted once in English and once after French has been loaded, and the dialog title, buttons and
// parameters are compared. The download message helper keeps its bound assertion.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { AutoUpdates, updateDownloadingMessage } = require('#dist/electron/app/autoUpdate.js');
const { MAIN_ENGLISH, loadMainLocale, setMainLocale } = require('#dist/electron/lib/mainLocale.js');

test('the update dialogs speak the chosen language and switch with it', async () => {
  const updater = new EventEmitter();
  Object.assign(updater, {
    checkForUpdatesAndNotify: () => new Promise(() => undefined),
    checkForUpdates: () => new Promise(() => undefined),
    quitAndInstall: () => undefined,
  });
  const shown = [];
  const host = {
    app: { isPackaged: true, isReady: () => false, getPath: () => '', getVersion: () => '1.2.3' },
    autoUpdater: updater,
    beforeInstall: () => undefined,
    parentWindow: () => undefined,
    showMessageBox: async (_parent, options) => {
      shown.push(options);
      return { response: 1, checkboxChecked: false };
    },
  };
  const log = console.log;
  console.log = () => undefined;
  try {
    // start() schedules a six-hourly check; unref it so the finished test does not keep the process alive.
    const realSetInterval = global.setInterval;
    global.setInterval = (...args) => realSetInterval(...args).unref();
    const updates = new AutoUpdates(host);
    updates.start();
    global.setInterval = realSetInterval;
    updater.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown.at(-1)?.title, 'Update Ready');
    assert.deepEqual(shown.at(-1)?.buttons, ['Restart Now', 'Later']);
    setMainLocale(await loadMainLocale('fr'));
    updater.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown.at(-1)?.title, 'Mise à jour prête');
    assert.deepEqual(shown.at(-1)?.buttons, ['Redémarrer maintenant', 'Plus tard']);
    assert.ok(shown.at(-1)?.message?.includes('2.0.0'));
    assert.match(updateDownloadingMessage({ kind: 'downloading', version: '2.0.0', percent: 50 }).detail, /50/);
    assert.throws(() => updateDownloadingMessage({ kind: 'downloading', version: undefined, percent: Number.NaN }), /Assertion failed/);
  } finally {
    console.log = log;
    setMainLocale(MAIN_ENGLISH);
  }
});
