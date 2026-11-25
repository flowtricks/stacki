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

const WIDTH_PX_MIN = 1024;
const HEIGHT_PX_MIN = 640;

/** The display's work area — the screen minus whatever the OS keeps for
 * itself. Every field is optional because the caller reads it from Electron's
 * `display.workArea` and may hand us nothing at all. */
interface WorkArea {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

const rounded = (value: number | undefined): number => (value === undefined ? NaN : Math.round(value));

/**
 * The bounds to open at on a display, given that display's work area — the
 * screen minus whatever the OS keeps for itself.
 *
 * A display smaller than the minimum still gets the minimum: the panels have a
 * width below which they stop being usable, and a window that starts too small
 * to use is worse than one that hangs over an edge.
 */
function openingBounds(workArea?: WorkArea): WindowBounds {
  const area: WorkArea = workArea ?? {};
  const width = Math.max(WIDTH_PX_MIN, rounded(area.width) || WIDTH_PX_MIN);
  const height = Math.max(HEIGHT_PX_MIN, rounded(area.height) || HEIGHT_PX_MIN);
  return {
    x: rounded(area.x) || 0,
    y: rounded(area.y) || 0,
    width,
    height,
    minWidth: WIDTH_PX_MIN,
    minHeight: HEIGHT_PX_MIN,
  };
}

export { openingBounds, WIDTH_PX_MIN, HEIGHT_PX_MIN };
export type { WorkArea, WindowBounds };
