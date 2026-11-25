// Keeps every Electron process the gate starts out of the macOS Dock.
//
// Goal: a test or probe that opens a window must not add a Dock tile, bounce, or
// outlive its test as a stray icon. On macOS each Electron process launched from a
// terminal is a regular app with its own tile; sixteen suites at once filled the Dock.
//
// Method: the gate puts `--require <this file>` in NODE_OPTIONS for its test
// commands, so the Electron main process of every probe, in every suite, runs this
// before the probe's own code, with no edit to any probe. It hides the Dock tile at once,
// which also moves the process from the "Foreground" to the "UIElement" activation
// policy; windows, focus and input are unaffected, so :hover and key probes still pass.
//
// Why a deferral: NODE_OPTIONS preloads run before Electron installs its built-in `electron`
// module. A require made now would resolve to the npm package of that name, which exports only the
// binary's path (and Node caches it, so a later require would get the path too). One `setImmediate`
// later the built-in is installed, and that is still before `app` is ready and any window opens.
// Everywhere else (plain Node, renderer and helper processes, Windows, Linux) this does nothing.

'use strict';

function hideDock() {
  const electron = require('electron');
  // Loud on purpose: a probe that silently kept its Dock tile is the failure this file exists to end.
  if (typeof electron !== 'object' || electron.app === undefined || electron.app.dock === undefined) {
    throw new Error('hideDockPreload: the electron built-in is not installed one turn after startup');
  }
  electron.app.dock.hide();
}

// Test windows stay off the person's screen too (hideWindows.js says how); this runs on every platform.
function hideWindows() {
  const electron = require('electron');
  if (typeof electron !== 'object' || electron.app === undefined) {
    throw new Error('hideDockPreload: the electron built-in is not installed one turn after startup');
  }
  require('./hideWindows.js').installWindowHiding(electron);
}

// A test run never touches the person's login keychain or their app data. Without the mock keychain macOS puts up
// "Keychain Not Found" or asks for the "Electron Key" while a run is going: Chromium's safe storage gets an in-memory
// key instead. A probe that names no user-data folder gets a temporary one, removed when it exits, so no probe shares
// (or writes) the folder under the person's Application Support. Both are set before `app` is ready; an entry that
// sets its own userData path later (the soak's) still wins.
function isolateProfile() {
  const electron = require('electron');
  if (typeof electron !== 'object' || electron.app === undefined || electron.app.commandLine === undefined) {
    throw new Error('hideDockPreload: the electron built-in is not installed one turn after startup');
  }
  const { app } = electron;
  app.commandLine.appendSwitch('use-mock-keychain');
  if (app.commandLine.hasSwitch('user-data-dir')) {
    return;
  }
  const fs = require('node:fs');
  const directory = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'stacki-test-profile-'));
  app.setPath('userData', directory);
  process.once('exit', () => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // A helper process may still hold a file; the folder is in the temporary directory.
    }
  });
}

// Only Electron's main process on macOS has a Dock tile; every other process stops here.
if (process.versions.electron !== undefined && process.type === 'browser') {
  setImmediate(isolateProfile);
  if (process.platform === 'darwin') {
    setImmediate(hideDock);
  }
  setImmediate(hideWindows);
}
