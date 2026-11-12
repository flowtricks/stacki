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

// Only Electron's main process on macOS has a Dock tile; every other process stops here.
if (process.versions.electron !== undefined && process.type === 'browser' && process.platform === 'darwin') {
  setImmediate(hideDock);
}
