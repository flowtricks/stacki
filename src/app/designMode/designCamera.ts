// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the canvas's camera: pure pan, zoom and fit.
import type { DesignPlace } from '../../../shared/ipc/designSession';
import type { DesignCamera } from './designStore';

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
const MARGIN_PX = 32;
/** Room above the frames for their names, and below them for the bar. */
const TOP_PX = 48;
const BOTTOM_PX = 72;

export interface CameraBox {
  readonly at: DesignPlace;
  readonly widthPx: number;
}

/** Every frame's width in view, their tops under the canvas's top: pages are taller than the window, so width leads. */
export function fitCamera(frames: readonly CameraBox[], boardWidthPx: number, boardHeightPx: number): DesignCamera {
  if (frames.length === 0 || boardWidthPx <= 2 * MARGIN_PX) {
    return { x: MARGIN_PX, y: TOP_PX, zoom: 1 };
  }
  const left = Math.min(...frames.map((frame) => frame.at.x));
  const right = Math.max(...frames.map((frame) => frame.at.x + frame.widthPx));
  const top = Math.min(...frames.map((frame) => frame.at.y));
  const fit = (boardWidthPx - 2 * MARGIN_PX) / Math.max(1, right - left);
  // A screen's worth of the page is in view even in a short window.
  const tall = Math.max(1, boardHeightPx - TOP_PX - BOTTOM_PX) / 600;
  const zoom = Math.min(1, Math.max(ZOOM_MIN, Math.min(fit, tall)));
  const spare = boardWidthPx - (right - left) * zoom;
  return { x: Math.round(Math.max(MARGIN_PX, spare / 2) - left * zoom), y: Math.round(TOP_PX - top * zoom), zoom };
}

/** The camera zoomed to `zoom`, keeping the canvas point under (x, y), in the board's own pixels, where it is. */
export function zoomAt(camera: DesignCamera, zoom: number, x: number, y: number): DesignCamera {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  const ratio = next / camera.zoom;
  return { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, zoom: next };
}
