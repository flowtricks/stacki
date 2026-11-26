// Design mode (experimental, removable: docs/design-mode/REMOVE.md): a frame's picture, for the AI.
//
// The picture is all the AI is given of a design, so it holds the whole page. A frame's document is already laid out
// at the page's full height (its screen units stay one screen's, and fixed and sticky elements sit once), so the
// canvas shows that one frame alone and its camera walks down it, picturing what is on screen through the AI panel's
// own screenshot channel (window capture, nothing written) and putting the pieces together. A page much taller than
// it is wide is cut into slices, top to bottom, so none is shrunk past reading.
import { aiScreenshot } from '../../features/ai/aiBridge';
import { DESIGN_SESSION_LIMITS, type DesignFrameId, type DesignPlace } from '../../../shared/ipc/designSession';
import { sliceHeights } from './designSlices';
import { designView, updateDesignView } from './designStore';

/** Widest picture kept: enough to read a desktop page. */
const PICTURE_WIDTH_PX_MAX = 1_440;
/** After the camera moves, the time what it now shows has to be drawn. */
const DRAW_MS = 150;
/** The longest a frame's fonts and pictures are waited for. */
const READY_MS_MAX = 3_000;
/** Screens one page is walked in: past the tallest frame at the shortest canvas. */
const STEPS_MAX = 200;

/** Waits for the frame's fonts and pictures, so none is missing from the picture. */
async function ready(frame: Document): Promise<void> {
  const loaded = Promise.all([frame.fonts.ready, ...Array.from(frame.images, (image) => (image.complete ? undefined : image.decode().catch(() => undefined)))]);
  await Promise.race([loaded, new Promise((resolve) => window.setTimeout(resolve, READY_MS_MAX))]);
}

/**
 * The whole of frame `frame` as PNG data URLs, top to bottom. Undefined when the frame has no document or the window
 * could not be pictured: half a page is never sent as the page.
 */
export async function pictureFrame(
  projectPath: string,
  frame: { readonly id: DesignFrameId; readonly at: DesignPlace },
): Promise<readonly string[] | undefined> {
  const before = designView().camera;
  document.documentElement.classList.add('dm-capturing');
  try {
    updateDesignView((view) => ({ ...view, photo: frame.id, selection: { kind: 'none' } }));
    await drawn();
    const plane = document.querySelector('.dm-plane');
    const body = document.querySelector<HTMLElement>(`.dm-tile[data-dm-tile="${frame.id}"] .dm-body`);
    const shown = body?.querySelector<HTMLIFrameElement>('.dm-document')?.contentDocument ?? undefined;
    if (plane === null || body === null || shown === undefined) {
      return undefined;
    }
    await ready(shown);
    const widthPx = body.offsetWidth;
    const heightPx = body.offsetHeight;
    const zoom = Math.min(1, plane.clientWidth / widthPx);
    const pieces: Piece[] = [];
    // Walked a canvas-full at a time, in the page's own pixels.
    const stepPx = plane.clientHeight / zoom;
    for (let step = 0; step < STEPS_MAX && step * stepPx < heightPx - 1; step += 1) {
      const topPx = step * stepPx;
      updateDesignView((view) => ({ ...view, camera: { x: -frame.at.x * zoom, y: -(frame.at.y + topPx) * zoom, zoom } }));
      await drawn();
      const piece = await capture(projectPath, body.getBoundingClientRect(), plane.getBoundingClientRect(), zoom);
      if (piece === undefined) {
        return undefined;
      }
      pieces.push(piece);
    }
    return await assemble(pieces, widthPx, heightPx);
  } finally {
    document.documentElement.classList.remove('dm-capturing');
    updateDesignView((view) => ({ ...view, photo: undefined, camera: before }));
  }
}

/** Resolves once what changed is on screen. */
function drawn(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, DRAW_MS)));
  });
}

/** One screenful: the picture, and the band of the page it shows, in the page's pixels. */
interface Piece {
  readonly image: HTMLImageElement;
  readonly topPx: number;
  readonly heightPx: number;
  readonly widthPx: number;
}

async function capture(projectPath: string, box: DOMRect, clip: DOMRect, zoom: number): Promise<Piece | undefined> {
  const left = Math.ceil(Math.max(box.left, clip.left, 0));
  const top = Math.ceil(Math.max(box.top, clip.top, 0));
  const right = Math.floor(Math.min(box.right, clip.right, window.innerWidth));
  const bottom = Math.floor(Math.min(box.bottom, clip.bottom, window.innerHeight));
  if (right - left < 1 || bottom - top < 1) {
    return undefined;
  }
  const shot = await aiScreenshot({ projectPath, rect: { x: left, y: top, width: right - left, height: bottom - top } });
  if (!shot.ok) {
    return undefined;
  }
  const image = new Image();
  image.src = `data:${shot.value.mimeType};base64,${shot.value.data}`;
  try {
    await image.decode();
  } catch {
    return undefined;
  }
  return { image, topPx: (top - box.top) / zoom, heightPx: (bottom - top) / zoom, widthPx: (right - left) / zoom };
}

async function assemble(pieces: readonly Piece[], widthPx: number, heightPx: number): Promise<readonly string[] | undefined> {
  const scale = Math.min(1, PICTURE_WIDTH_PX_MAX / widthPx);
  const slices: string[] = [];
  let sliceTopPx = 0;
  for (const slicePx of sliceHeights(widthPx, heightPx)) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(widthPx * scale));
    canvas.height = Math.max(1, Math.round(slicePx * scale));
    const context = canvas.getContext('2d');
    if (context === null) {
      return undefined;
    }
    for (const piece of pieces) {
      if (piece.topPx < sliceTopPx + slicePx && piece.topPx + piece.heightPx > sliceTopPx) {
        context.drawImage(piece.image, 0, (piece.topPx - sliceTopPx) * scale, piece.widthPx * scale, piece.heightPx * scale);
      }
    }
    let data = canvas.toDataURL('image/png');
    if (data.length > DESIGN_SESSION_LIMITS.imageCharsMax) {
      data = canvas.toDataURL('image/jpeg', 0.85);
    }
    if (data.length > DESIGN_SESSION_LIMITS.imageCharsMax) {
      return undefined;
    }
    slices.push(data);
    sliceTopPx += slicePx;
  }
  return slices;
}
