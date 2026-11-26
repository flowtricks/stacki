// Design mode (experimental, removable: docs/design-mode/REMOVE.md): a frame's picture, for the board and the AI.
//
// The picture is the canvas as the person sees it: the preview frame's box in the window, taken by the AI panel's
// own screenshot channel (window capture, nothing written), then scaled down to a board-sized PNG.
import { aiScreenshot } from '../../features/ai/aiBridge';
import { DESIGN_SESSION_LIMITS } from '../../../shared/ipc/designSession';

/** Widest picture kept: enough for the AI to read a layout, small enough to keep several. */
const PICTURE_WIDTH_PX_MAX = 1_600;

/** The canvas's preview frame: the largest frame inside the window's middle column. */
export function canvasFrameBox(): DOMRect | undefined {
  const center = document.querySelector('.main > .center');
  if (center === null) {
    return undefined;
  }
  let best: DOMRect | undefined = undefined;
  for (const frame of center.querySelectorAll('iframe')) {
    const box = frame.getBoundingClientRect();
    if (box.width * box.height > (best === undefined ? 0 : best.width * best.height)) {
      best = box;
    }
  }
  return best;
}

/** The canvas as a PNG data URL, or undefined when there is no canvas on screen or the capture failed. */
export async function captureCanvas(projectPath: string): Promise<string | undefined> {
  const box = canvasFrameBox();
  if (box === undefined || box.width < 1 || box.height < 1) {
    return undefined;
  }
  const visible = {
    x: Math.max(0, Math.floor(box.left)),
    y: Math.max(0, Math.floor(box.top)),
    width: Math.floor(Math.min(box.width, window.innerWidth - Math.max(0, box.left))),
    height: Math.floor(Math.min(box.height, window.innerHeight - Math.max(0, box.top))),
  };
  // The bar sits over the canvas: it is hidden for the picture, so a frame shows the page alone.
  document.documentElement.classList.add('dm-capturing');
  let shot: Awaited<ReturnType<typeof aiScreenshot>>;
  try {
    await nextPaint();
    shot = await aiScreenshot({ projectPath, rect: visible });
  } finally {
    document.documentElement.classList.remove('dm-capturing');
  }
  if (!shot.ok) {
    return undefined;
  }
  const scaled = await scaledPng(`data:${shot.value.mimeType};base64,${shot.value.data}`);
  return scaled !== undefined && scaled.length <= DESIGN_SESSION_LIMITS.imageCharsMax ? scaled : undefined;
}

/** Resolves after the next two frames, so a style change is on screen. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function scaledPng(source: string): Promise<string | undefined> {
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
  } catch {
    return undefined;
  }
  const scale = Math.min(1, PICTURE_WIDTH_PX_MAX / Math.max(1, image.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (context === null) {
    return undefined;
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
