// What "Check for Updates" says while an update is already on its way.
//
//   node test/electron/app/autoUpdateDownloading.test.js
//
// A 143 MB update took minutes on a slow connection, and the File menu's check
// answered "Already checking for updates." the whole time, which read as stuck.
// The method: drive AutoUpdates with a fake updater (an EventEmitter whose
// scheduled check never settles, as a download in flight does) and a fake
// dialog that records what it is asked to show. Emit the updater's events in
// the order a real download produces them and check the menu's answer at each
// step: downloading with the version and progress, ready to restart once
// downloaded, and back to checking after a failed download. The message helper
// is also checked on its own bounds.

const { EventEmitter } = require('events');
const { AutoUpdates, updateDownloadingMessage } = require('#dist/electron/app/autoUpdate.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

async function main() {
  const updater = new EventEmitter();
  // The scheduled check stays in flight, as it does while a download runs.
  updater.checkForUpdatesAndNotify = () => new Promise(() => {});
  updater.checkForUpdates = () => new Promise(() => {});
  updater.quitAndInstall = () => {};
  const shown = [];
  const host = {
    app: { isPackaged: true, isReady: () => false, getPath: () => '', getVersion: () => '1.0.21' },
    autoUpdater: updater,
    beforeInstall: () => {},
    parentWindow: () => undefined,
    showMessageBox: async (_parent, options) => {
      shown.push(options);
      return { response: 1, checkboxChecked: false }; // "Later" on the restart prompt.
    },
  };
  const log = console.log;
  console.log = () => {}; // The module logs each event; the test reads the dialogs.
  try {
    const updates = new AutoUpdates(host);
    updates.start();

    await updates.checkFromMenu();
    check('before anything is found, a second check is already checking', shown.at(-1)?.message === 'Already checking for updates.', shown.at(-1)?.message);

    updater.emit('update-available', { version: '1.0.22' });
    updater.emit('download-progress', { percent: 42.7 });
    await updates.checkFromMenu();
    check('while downloading, the menu names the version', shown.at(-1)?.message === 'Downloading Stacki 1.0.22…', shown.at(-1)?.message);
    check('and how far it has got, rounded down', shown.at(-1)?.detail?.startsWith('42% downloaded.'), shown.at(-1)?.detail);

    updater.emit('download-progress', { percent: Number.NaN });
    await updates.checkFromMenu();
    check('a download of unknown length reads as 0%, not NaN', shown.at(-1)?.detail?.startsWith('0% downloaded.'), shown.at(-1)?.detail);

    updater.emit('update-downloaded', { version: '1.0.22' });
    const before = shown.length;
    await updates.checkFromMenu();
    check('the download itself asks to restart', shown[before - 1]?.message === 'Stacki 1.0.22 has been downloaded.', shown[before - 1]?.message);
    check('and once downloaded, the menu asks again', shown.at(-1)?.message === 'Stacki 1.0.22 has been downloaded.', shown.at(-1)?.message);
    check('with a restart button', shown.at(-1)?.buttons?.[0] === 'Restart Now', JSON.stringify(shown.at(-1)?.buttons));

    // A second app instance whose download fails part way.
    const failing = new EventEmitter();
    failing.checkForUpdatesAndNotify = () => new Promise(() => {});
    failing.checkForUpdates = () => new Promise(() => {});
    const failingHost = { ...host, autoUpdater: failing };
    const failed = new AutoUpdates(failingHost);
    failed.start();
    failing.emit('update-available', { version: '1.0.22' });
    failing.emit('download-progress', { percent: 10 });
    failing.emit('error', new Error('net::ERR_CONNECTION_CLOSED'));
    await failed.checkFromMenu();
    check('a failed download is no longer reported as downloading', shown.at(-1)?.message === 'Already checking for updates.', shown.at(-1)?.message);

    // A resumed download can report progress before any update-available names it.
    const resuming = new EventEmitter();
    resuming.checkForUpdatesAndNotify = () => new Promise(() => {});
    resuming.checkForUpdates = () => new Promise(() => {});
    const resumed = new AutoUpdates({ ...host, autoUpdater: resuming });
    resumed.start();
    resuming.emit('download-progress', { percent: 5 });
    await resumed.checkFromMenu();
    check('progress before a version is named still says downloading', shown.at(-1)?.message === 'Downloading the Stacki update…', shown.at(-1)?.message);
  } finally {
    console.log = log;
  }

  check('100% stays 100%', updateDownloadingMessage({ kind: 'downloading', version: '1', percent: 100 }).detail.startsWith('100% '));
  check('past 100% is held at 100%', updateDownloadingMessage({ kind: 'downloading', version: '1', percent: 100.4 }).detail.startsWith('100% '));
  let threw = '';
  try {
    updateDownloadingMessage({ kind: 'downloading', version: '1', percent: Number.NaN });
  } catch (error) {
    threw = String(error);
  }
  check('a NaN reaching the message is a programmer error', threw.includes('download progress is a number'), threw);

  if (failures.length) {
    console.error(`\nauto-update-downloading: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`auto-update-downloading: ${checked} passed`);
  process.exit(0);
}

void main();
