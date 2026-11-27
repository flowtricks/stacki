// Classic scrollbars for one test process, whatever the computer is set to.
//
// A Mac with a trackpad draws overlay scrollbars, which take no width, so a test of "the page keeps its frame's
// whole width" passes there however the frame is built. That is how a narrowed frame went unnoticed. macOS reads
// `-AppleShowScrollBars Always` from a process's own arguments (NSUserDefaults' argument domain) ahead of the
// person's setting: the one Electron process given it draws classic scrollbars, and nothing on the computer changes.
// Linux and Windows runners draw classic scrollbars already.
//
// A test that relies on this still checks it: an untreated frame of the same page must lose width.

'use strict';

/** The arguments an Electron under test takes, after its script, to draw classic scrollbars. */
function classicScrollbarArguments() {
  return process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : [];
}

module.exports = { classicScrollbarArguments };
