// Keeps a hand-run Playwright flow (test/integration/*Flow.js, componentCanvasLifecycle.js) off the person's screen
// and keychain.
//
// Why a file given as Electron's own `-r` argument: Playwright deletes NODE_OPTIONS before it starts Electron, so the
// gate's preload set there never loads and the flow's windows open on screen.
//
// Method: the gate's preload (hideDockPreload.js: mock keychain, no Dock tile, hidden windows) loads first; then, one
// turn later like it, a window is never shown at all, as in the soak (e2e/electronEntry.js). A hidden window still
// paints, takes the flow's input and answers capturePage.

'use strict';

require('./hideDockPreload.js');

if (process.versions.electron !== undefined && process.type === 'browser') {
  // Queued after hideDockPreload's own patches of the same methods, so these are the ones left standing.
  setImmediate(() => {
    const { app, BrowserWindow } = require('electron');
    BrowserWindow.prototype.show = function show() {};
    BrowserWindow.prototype.showInactive = function showInactive() {};
    // Throttled, a window that is never shown gets no animation frames and the app never draws.
    app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));
  });
}
