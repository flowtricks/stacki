// Where the AI composer's screenshots learn what the canvas shows (docs/contracts.md, "Screenshots").
// The composer lives in the AI feature, the canvas in the preview feature and the selection in the
// shell, and features may not import each other: the Desktop shell installs a source here while a
// project is open (src/app/shell/aiScreenshotSource.ts), and the composer asks through this one seam.
// With nothing installed, region captures of the window still work; each is then a panel capture.

/** A region of the window, in its CSS pixels, rounded outwards to whole pixels. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The canvas as the window shows it: where it sits and the breakpoint width it renders at. */
export interface CanvasTarget {
  readonly rect: WindowRect;
  readonly breakpointPx: number;
}

/** What the shell installs. */
export interface ScreenshotSource {
  /** The part of the window the canvas shows and its breakpoint width, or undefined with no visible canvas; tells a canvas region from a panel one. */
  readonly canvas: () => CanvasTarget | undefined;
  /**
   * Readies the canvas for a capture until the returned call restores it: the last hovered node stays outlined (the pointer
   * has left the canvas for the screenshot button), and the editor's transient tooltips step aside. Selected outlines, tag
   * labels and text marks are the canvas's own and are never hidden: the capture shows what the person sees.
   */
  readonly prepare: () => () => void;
}

let source: ScreenshotSource | undefined;

/** Installs the shell's source; returns the uninstall, which leaves a newer source in place. */
export function setScreenshotSource(next: ScreenshotSource): () => void {
  source = next;
  return () => {
    if (source === next) {
      source = undefined;
    }
  };
}

/** The installed source, or undefined outside Desktop's editor. */
export function screenshotSource(): ScreenshotSource | undefined {
  return source;
}
