// Keeps every window a test opens off the owner's screen.
//
// Goal: a gate run is background work. No test or probe may put a window in front of the person
// running it, take keyboard focus from the app they are typing in, or leave a tile in Mission Control.
//
// Method: `installWindowHiding(electron)` patches the main process once. Every BrowserWindow is made
// fully transparent and click-through when it is shown, and `show`, `showInactive` and `focus`
// are redirected so a window opened visibly is moved beyond the display (x = y = -32000) and shown
// without activation. Transparent plus off-screen keeps Chromium painting (the soak records real
// frames), while the window is nowhere a person could see, click or type into. Pages still get real
// input through `webContents.sendInputEvent` and focus emulation, neither of which needs the OS to
// activate the window. `hideDockPreload.js` loads this for every gate Electron process, and the
// soak entry loads it itself so a run started by hand is hidden too.
//
// Why not only `show: false`: the soak drives the real app, whose main window is revealed by the app's
// own code on its first frame (windowReveal.ts); a test cannot pass that window an option.

'use strict';

const OFFSCREEN_PX = -32000;
const INSTALLED = Symbol.for('stacki.hideWindows.installed');

/** Makes one window invisible, unfocusable and click-through. */
function hideWindow(window) {
  if (typeof window.setOpacity !== 'function') {
    throw new Error('Assertion failed: hideWindow takes a BrowserWindow');
  }
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
}

/** Patches `electron.BrowserWindow` and `electron.app` once; returns whether this call installed it. */
function installWindowHiding(electron) {
  if (typeof electron !== 'object' || electron === null || electron.BrowserWindow === undefined || electron.app === undefined) {
    throw new Error('Assertion failed: installWindowHiding takes the electron built-in');
  }
  const { app, BrowserWindow } = electron;
  if (BrowserWindow.prototype[INSTALLED] === true) {
    return false;
  }
  BrowserWindow.prototype[INSTALLED] = true;
  const showInactive = BrowserWindow.prototype.showInactive;
  const moveOffscreen = (window) => {
    hideWindow(window);
    window.setPosition(OFFSCREEN_PX, OFFSCREEN_PX);
  };
  BrowserWindow.prototype.show = function show() {
    moveOffscreen(this);
    showInactive.call(this);
  };
  BrowserWindow.prototype.showInactive = function showInactiveHidden() {
    moveOffscreen(this);
    showInactive.call(this);
  };
  // A window that never takes OS focus cannot pull the person out of the app they are typing in.
  BrowserWindow.prototype.focus = function focus() {};
  // Only a window that is already visible is touched here: a hidden one (show: false) is left exactly as the
  // test made it, because a fully transparent window is treated as occluded on macOS and Chromium then
  // stops the visibility signals a test reads (the asset grid's tiles reported none visible on CI). A hidden
  // window is made invisible at the moment it is shown, by the patched `show` above.
  app.on('browser-window-created', (_event, window) => {
    if (window.isVisible()) {
      moveOffscreen(window);
    }
  });
  return true;
}

module.exports = { OFFSCREEN_PX, hideWindow, installWindowHiding };
