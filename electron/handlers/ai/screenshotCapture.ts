// `ai:screenshot`: a photograph of part of the sender's own window for the AI composer
// (docs/contracts.md, "Screenshots"). Privacy is the design constraint: the capture is a
// NativeImage in this process's memory, encoded to base64 and returned in the invoke reply;
// nothing is written to disk, nothing is logged, and no temporary file is ever made.
//
// Why no file: both agents take images inline. The ACP prompt carries an `image` block with
// base64 `data` over the adapter's stdin, and the Claude adapter hands it to the CLI as a base64
// `source` (no path), so a file would only add a copy on disk to clean up.
//
// The image is downscaled to SCREENSHOT_EDGE_PX_MAX on its longer side (a Retina window captures
// at twice its CSS size) and encoded as PNG, which keeps interface text crisp, or as JPEG at falling
// quality when the PNG is past the size target.
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { SCREENSHOT_EDGE_PX_MAX, type AiFailure, type ScreenshotRect, type ScreenshotReply } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { described } from './aiMessages';

/** The base64 size an encoded screenshot aims under: the composer's own image target, well inside AI_LIMITS.imageBase64CharsMax. */
export const SCREENSHOT_BASE64_CHARS_TARGET = 1_500_000;
/** JPEG qualities tried, best first, once the PNG is too large. */
const JPEG_QUALITIES = [90, 75, 60, 45] as const;

/** What the encoder needs of Electron's NativeImage, so a test can hand it a stand-in. */
export interface ScreenshotImage {
  readonly isEmpty: () => boolean;
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly resize: (options: { readonly width: number; readonly height: number; readonly quality: 'good' }) => ScreenshotImage;
  readonly toPNG: () => Buffer;
  readonly toJPEG: (quality: number) => Buffer;
}

/** The sender's side of the capture: Electron's `webContents.capturePage`. */
export interface ScreenshotSender {
  readonly capturePage: (rect: ScreenshotRect, options: { readonly stayHidden: boolean; readonly stayAwake: boolean }) => Promise<ScreenshotImage>;
}

/**
 * A rect in the page's CSS pixels as `capturePage` takes it, in the window's device-independent pixels: the same
 * numbers at the default zoom, multiplied by the page's zoom factor otherwise (View > Zoom), rounded outwards so
 * the whole region is inside. Without this a zoomed window would photograph a shifted, cropped region.
 */
export function cssRectToWindow(rect: ScreenshotRect, zoomFactor: number): ScreenshotRect {
  assert(Number.isFinite(zoomFactor), 'cssRectToWindow: a finite zoom');
  assert(zoomFactor > 0, 'cssRectToWindow: a positive zoom');
  const x = Math.floor(rect.x * zoomFactor);
  const y = Math.floor(rect.y * zoomFactor);
  const width = Math.ceil((rect.x + rect.width) * zoomFactor) - x;
  const height = Math.ceil((rect.y + rect.height) * zoomFactor) - y;
  assert(width >= rect.width || zoomFactor < 1, 'cssRectToWindow: a zoom of one or more never shrinks the rect');
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}

/** Photographs `rect` of the sender's window and encodes it; a capture that fails or comes back empty is an expected failure. */
export async function captureScreenshot(sender: ScreenshotSender, rect: ScreenshotRect): Promise<Result<ScreenshotReply, AiFailure>> {
  assert(rect.width >= 1, 'captureScreenshot: the payload parser refuses an empty rect');
  assert(rect.height >= 1, 'captureScreenshot: the payload parser refuses an empty rect');
  let image: ScreenshotImage;
  try {
    image = await sender.capturePage(rect, { stayHidden: false, stayAwake: false });
  } catch {
    // The reason is not logged: a capture error says nothing a person can act on, and logs stay free of screen content.
    return err({ code: 'invalid', ...described('ai.screenshot.failed') });
  }
  return encodeScreenshot(image);
}

/** The image at most SCREENSHOT_EDGE_PX_MAX on its longer side, as PNG or JPEG base64 within the size target. */
export function encodeScreenshot(image: ScreenshotImage): Result<ScreenshotReply, AiFailure> {
  if (image.isEmpty()) {
    return err({ code: 'invalid', ...described('ai.screenshot.failed') });
  }
  const scaled = scaledToEdge(image);
  const size = scaled.getSize();
  assert(Math.max(size.width, size.height) <= SCREENSHOT_EDGE_PX_MAX, 'encodeScreenshot: scaled within the edge bound');
  assert(Math.min(size.width, size.height) >= 1, 'encodeScreenshot: at least a pixel each way');
  const png = scaled.toPNG().toString('base64');
  if (png.length <= SCREENSHOT_BASE64_CHARS_TARGET) {
    return ok({ mimeType: 'image/png', data: png, width: size.width, height: size.height });
  }
  for (const quality of JPEG_QUALITIES) {
    const jpeg = scaled.toJPEG(quality).toString('base64');
    if (jpeg.length <= SCREENSHOT_BASE64_CHARS_TARGET) {
      assert(jpeg.length <= AI_LIMITS.imageBase64CharsMax, 'encodeScreenshot: within the attachment bound');
      return ok({ mimeType: 'image/jpeg', data: jpeg, width: size.width, height: size.height });
    }
  }
  return err({ code: 'invalid', ...described('ai.image.detailed') });
}

/** The longer side brought down to `edgePxMax` (the screenshot bound unless given), keeping the aspect; an image already within it is kept. */
export function scaledToEdge(image: ScreenshotImage, edgePxMax: number = SCREENSHOT_EDGE_PX_MAX): ScreenshotImage {
  assert(edgePxMax >= 1, 'scaledToEdge: the edge bound is at least a pixel');
  const { width, height } = image.getSize();
  const edge = Math.max(width, height);
  if (edge <= edgePxMax) {
    return image;
  }
  const scale = edgePxMax / edge;
  // Floor so rounding can never push a side past the bound; at least one pixel so a sliver survives.
  return image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), quality: 'good' });
}
