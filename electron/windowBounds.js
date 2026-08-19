// How big the window opens.
//
// It used to open at a fixed 1480×940 — a size chosen for a laptop, and on
// anything larger a window with the desk showing around it. The app is a canvas
// with panels down both sides, so every pixel it isn't using is one the page
// being built isn't shown in: it opens filled instead.
//
// Filled means the work area, not the screen: the menu bar and the Dock are the
// operating system's, and a window drawn under them is a window with its title
// bar out of reach. Full screen proper is a different thing — a space of its
// own, which is the user's choice to make, not the app's to make for them.

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;

/**
 * The bounds to open at on a display, given that display's work area — the
 * screen minus whatever the OS keeps for itself.
 *
 * A display smaller than the minimum still gets the minimum: the panels have a
 * width below which they stop being usable, and a window that starts too small
 * to use is worse than one that hangs over an edge.
 */
function openingBounds(workArea) {
  const area = workArea || {};
  const width = Math.max(MIN_WIDTH, Math.round(area.width) || MIN_WIDTH);
  const height = Math.max(MIN_HEIGHT, Math.round(area.height) || MIN_HEIGHT);
  return {
    x: Math.round(area.x) || 0,
    y: Math.round(area.y) || 0,
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
  };
}

module.exports = { openingBounds, MIN_WIDTH, MIN_HEIGHT };
