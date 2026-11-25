// A picture of a whole frame at its real size: the page as the frame shows it, every pixel of its width and
// height, for "Send to AI", "Copy as image" and "Export PNG".
//
// How: the window can only photograph what it draws, and a page is taller than a window. So the frame's
// document is laid out once more on a stage over the window at one CSS pixel per pixel, and the stage is
// photographed tile by tile through the AI panel's screenshot channel (`ai:screenshot`, which keeps the image in
// memory and writes nothing), each tile at most the channel's edge in device pixels so it is never scaled
// down. The tiles are drawn into one canvas. The stage shows for about a second; it is the frame itself.
import { SCREENSHOT_EDGE_PX_MAX } from '../../../../shared/ipc/aiChat';
import { aiScreenshot } from '../../../features/ai/aiBridge';
import { DESIGN_SANDBOX_FRAME_NAME } from '../../../../shared/designMode/designModeContract';

/** A finished capture: a canvas at `scale` device pixels per CSS pixel. */
export interface FrameCapture {
  readonly canvas: HTMLCanvasElement;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly scale: number;
}

const TILES_MAX = 400;
const LOAD_WAIT_MS_MAX = 10_000;
/** Chromium's canvas side limit, with room: a taller page is scaled to fit. */
const CANVAS_SIDE_PX_MAX = 16_000;

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

function loaded(frame: HTMLIFrameElement): Promise<Document | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(frame.contentDocument ?? undefined), LOAD_WAIT_MS_MAX);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve(frame.contentDocument ?? undefined);
      },
      { once: true },
    );
  });
}

async function settled(document: Document): Promise<void> {
  const images = [...document.images].filter((image) => !image.complete);
  const waits = [
    document.fonts.ready.then(() => undefined),
    ...images.map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  ];
  await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS_MAX))]);
}

function imageOf(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('A screenshot tile did not decode'));
    image.src = dataURL;
  });
}

/**
 * Photographs `html` laid out `widthPx` wide, `viewportHeightPx` being what its `vh` units resolve against.
 * `scale` is the output's pixels per CSS pixel: 1 for the AI, the screen's density for an export.
 */
export async function captureFrame(
  projectPath: string,
  html: string,
  widthPx: number,
  viewportHeightPx: number,
  scale: number,
): Promise<FrameCapture | undefined> {
  if (!(widthPx > 0) || !(scale > 0)) {
    throw new Error('Assertion failed: captureFrame: a positive width and scale');
  }
  const stage = document.createElement('div');
  stage.setAttribute('data-design-capture', '');
  stage.style.cssText = 'position:fixed;inset:0;z-index:2147483646;overflow:hidden;background:#fff;pointer-events:none;';
  const frame = document.createElement('iframe');
  frame.name = DESIGN_SANDBOX_FRAME_NAME;
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = `position:absolute;left:0;top:0;border:0;width:${String(widthPx)}px;height:${String(viewportHeightPx)}px;transform-origin:0 0;background:#fff;`;
  stage.append(frame);
  document.body.append(stage);
  try {
    const ready = loaded(frame);
    frame.srcdoc = html;
    const loadedDocument = await ready;
    if (loadedDocument === undefined) {
      return undefined;
    }
    loadedDocument.documentElement.style.setProperty('--design-vh', String(viewportHeightPx / 100) + 'px');
    await settled(loadedDocument);
    const body = loadedDocument.body;
    const contentHeight = body === null ? viewportHeightPx : Math.ceil(body.offsetTop + body.scrollHeight);
    const heightPx = Math.max(viewportHeightPx, contentHeight);
    frame.style.height = String(heightPx) + 'px';
    await frames(2);
    const density = window.devicePixelRatio || 1;
    // Each tile, in device pixels, at most the channel's edge, so main never scales it down; and on screen.
    const tileWidthPx = Math.max(1, Math.min(Math.floor(SCREENSHOT_EDGE_PX_MAX / density), window.innerWidth));
    const tileHeightPx = Math.max(1, Math.min(Math.floor(SCREENSHOT_EDGE_PX_MAX / density), window.innerHeight));
    const fit = Math.min(1, CANVAS_SIDE_PX_MAX / (heightPx * scale), CANVAS_SIDE_PX_MAX / (widthPx * scale));
    const outScale = scale * fit;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(widthPx * outScale));
    canvas.height = Math.max(1, Math.round(heightPx * outScale));
    const context = canvas.getContext('2d');
    if (context === null) {
      return undefined;
    }
    let tiles = 0;
    for (let top = 0; top < heightPx; top += tileHeightPx) {
      for (let left = 0; left < widthPx; left += tileWidthPx) {
        tiles += 1;
        if (tiles > TILES_MAX) {
          return undefined;
        }
        const width = Math.min(tileWidthPx, widthPx - left);
        const height = Math.min(tileHeightPx, heightPx - top);
        frame.style.transform = `translate(${String(-left)}px, ${String(-top)}px)`;
        await frames(2);
        const shot = await aiScreenshot({ projectPath, rect: { x: 0, y: 0, width, height } });
        if (!shot.ok) {
          return undefined;
        }
        const tile = await imageOf(`data:${shot.value.mimeType};base64,${shot.value.data}`);
        context.drawImage(tile, Math.round(left * outScale), Math.round(top * outScale), Math.round(width * outScale), Math.round(height * outScale));
      }
    }
    return { canvas, widthPx, heightPx, scale: outScale };
  } finally {
    stage.remove();
  }
}

/** A region of a capture as its own canvas (a close-up), in the capture's CSS pixels. */
export function cropCapture(
  capture: FrameCapture,
  region: { readonly xPx: number; readonly yPx: number; readonly widthPx: number; readonly heightPx: number },
): HTMLCanvasElement {
  const x = Math.max(0, Math.floor(region.xPx));
  const y = Math.max(0, Math.floor(region.yPx));
  const width = Math.max(1, Math.min(capture.widthPx - x, Math.ceil(region.widthPx)));
  const height = Math.max(1, Math.min(capture.heightPx - y, Math.ceil(region.heightPx)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * capture.scale));
  canvas.height = Math.max(1, Math.round(height * capture.scale));
  canvas
    .getContext('2d')
    ?.drawImage(capture.canvas, x * capture.scale, y * capture.scale, width * capture.scale, height * capture.scale, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A canvas as base64 image data within `charsMax`: PNG when it fits, else JPEG at falling quality, else scaled down. */
export function encodeCanvas(
  canvas: HTMLCanvasElement,
  charsMax: number,
): { readonly mimeType: 'image/png' | 'image/jpeg'; readonly data: string } | undefined {
  let source = canvas;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const png = source.toDataURL('image/png');
    if (png.length - 22 <= charsMax) {
      return { mimeType: 'image/png', data: png.slice(png.indexOf(',') + 1) };
    }
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      const jpeg = source.toDataURL('image/jpeg', quality);
      if (jpeg.length - 23 <= charsMax) {
        return { mimeType: 'image/jpeg', data: jpeg.slice(jpeg.indexOf(',') + 1) };
      }
    }
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(1, Math.floor(source.width * 0.75));
    smaller.height = Math.max(1, Math.floor(source.height * 0.75));
    smaller.getContext('2d')?.drawImage(source, 0, 0, smaller.width, smaller.height);
    source = smaller;
  }
  return undefined;
}
