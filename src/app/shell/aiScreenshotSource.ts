// Desktop's answer to the AI composer's screenshots (src/lib/screenshotSource.ts): where the canvas
// sits in the window and the breakpoint width it renders at, so a dragged region over the canvas is
// told from one over a panel. The window position comes from the canvas's own DOM, as the apps'
// canvas snapshot reads it (desktopAppHost.ts).
import { useEffect } from 'react';
import { setScreenshotSource, type CanvasTarget } from '../../lib/screenshotSource';
import './aiScreenshot.css';

/** The body class that hides the editor's marks over the canvas for the frame of a capture (aiScreenshot.css). */
const HIDE_MARKS_CLASS = 'is-taking-screenshot';

/** Installs the source while the shell is mounted; it reads the canvas's DOM at each capture. */
export function useAiScreenshotSource(): void {
  useEffect(
    () =>
      setScreenshotSource({
        canvas: () => canvasTarget(),
        hideMarks: () => {
          document.body.classList.add(HIDE_MARKS_CLASS);
          return () => document.body.classList.remove(HIDE_MARKS_CLASS);
        },
      }),
    [],
  );
}

function canvasTarget(): CanvasTarget | undefined {
  const clip = document.querySelector<HTMLElement>('.frame-clip') ?? undefined;
  const sized = document.querySelector<HTMLElement>('.frame-sized') ?? undefined;
  if (clip === undefined || sized === undefined || sized.offsetWidth === 0) {
    return undefined;
  }
  const box = clip.getBoundingClientRect();
  const x = Math.floor(box.left);
  const y = Math.floor(box.top);
  const width = Math.ceil(box.right) - x;
  const height = Math.ceil(box.bottom) - y;
  if (width < 1 || height < 1) {
    return undefined;
  }
  return { rect: { x, y, width, height }, breakpointPx: sized.offsetWidth };
}
