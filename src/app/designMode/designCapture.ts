// Design mode (experimental, removable: docs/design-mode/REMOVE.md): each frame's picture, for the AI.
//
// Taken only when the frames are sent. The canvas shows one frame alone, as wide as it fits, with no outline, name
// or bar over it, and the AI panel's own screenshot channel pictures that part of the window (nothing is written).
// So a picture holds its frame and nothing else of Design mode.
import { aiScreenshot } from '../../features/ai/aiBridge';
import { DESIGN_SESSION_LIMITS, type DesignFrameId, type DesignSessionState } from '../../../shared/ipc/designSession';
import { designView, updateDesignView } from './designStore';

/** Widest picture kept: enough for the AI to read a layout, small enough to keep several. */
const PICTURE_WIDTH_PX_MAX = 1_600;
/** After the camera moves to a frame, the time its document has to be drawn there. */
const DRAW_MS = 150;

export interface FramePicture {
  readonly frame: DesignFrameId;
  readonly name: string;
  readonly image: string;
}

/** The top of every frame that has a document, one at a time. */
export async function pictureFrames(projectPath: string, session: Extract<DesignSessionState, { kind: 'on' }>): Promise<readonly FramePicture[]> {
  const before = designView().camera;
  const pictures: FramePicture[] = [];
  document.documentElement.classList.add('dm-capturing');
  try {
    for (const frame of session.frames) {
      const widthPx = designView().snapshots.get(frame.id)?.viewportWidthPx;
      const plane = document.querySelector('.dm-plane');
      if (widthPx === undefined || widthPx < 1 || plane === null) {
        continue;
      }
      const zoom = Math.min(1, plane.clientWidth / widthPx);
      const camera = { x: -frame.at.x * zoom, y: -frame.at.y * zoom, zoom };
      updateDesignView((view) => ({ ...view, photo: frame.id, camera, selection: { kind: 'none' } }));
      await drawn();
      const body = document.querySelector(`.dm-tile[data-dm-tile="${frame.id}"] .dm-body`);
      const image = body === null ? undefined : await captureBox(projectPath, body.getBoundingClientRect(), plane.getBoundingClientRect());
      if (image !== undefined) {
        pictures.push({ frame: frame.id, name: frame.name, image });
      }
    }
  } finally {
    document.documentElement.classList.remove('dm-capturing');
    updateDesignView((view) => ({ ...view, photo: undefined, camera: before }));
  }
  return pictures;
}

/** Resolves once what changed is on screen. */
function drawn(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, DRAW_MS)));
  });
}

/** The part of `box` inside `clip`, as a PNG data URL, or undefined when none of it is on screen or it failed. */
async function captureBox(projectPath: string, box: DOMRect, clip: DOMRect): Promise<string | undefined> {
  const left = Math.max(box.left, clip.left, 0);
  const top = Math.max(box.top, clip.top, 0);
  const right = Math.min(box.right, clip.right, window.innerWidth);
  const bottom = Math.min(box.bottom, clip.bottom, window.innerHeight);
  if (right - left < 1 || bottom - top < 1) {
    return undefined;
  }
  const rect = { x: Math.floor(left), y: Math.floor(top), width: Math.floor(right - left), height: Math.floor(bottom - top) };
  const shot = await aiScreenshot({ projectPath, rect });
  if (!shot.ok) {
    return undefined;
  }
  const scaled = await scaledPng(`data:${shot.value.mimeType};base64,${shot.value.data}`);
  return scaled !== undefined && scaled.length <= DESIGN_SESSION_LIMITS.imageCharsMax ? scaled : undefined;
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
