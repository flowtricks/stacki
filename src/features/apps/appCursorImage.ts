// An app's own cursor for canvas capture (docs/apps.md, "Canvas clicks"):
// `canvas.capture({ on: true, cursor: { image: 'pin.svg', hotspot } })` names a
// PNG or SVG in the app's bundle. Stacki reads it here, checks it is a small
// image (APP_RPC_LIMITS.cursorImageBytesMax, at most cursorImagePxMax a side,
// which is all a browser will draw as a cursor), and hands the canvas frame a
// data URL: the frame is the project's dev server and cannot read the app's
// bundle itself. The frame checks the URL's shape again before drawing it
// (electron/preload/frameAppCursor.ts), with the crosshair as its fallback.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppCanvasCursor, type AppCanvasCursorRequest } from '../../../shared/properties/appsRpc';

export type CursorImageOutcome = { readonly ok: true; readonly cursor: AppCanvasCursor } | { readonly ok: false; readonly reason: string };

/** Reads a bundle file's bytes, at most `bytesMax` of them; undefined when it cannot be read or is larger. */
export type BundleBytesReader = (appId: string, path: string, bytesMax: number) => Promise<Uint8Array | undefined>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** The PNG header's width and height follow the signature, the chunk length and `IHDR`. */
const PNG_SIZE_OFFSET = 16;

/** The cursor the canvas shows for a request: a named one as it is, an image read and checked. */
export async function resolveCanvasCursor(appId: string, request: AppCanvasCursorRequest, read: BundleBytesReader): Promise<CursorImageOutcome> {
  if (typeof request === 'string') {
    return { ok: true, cursor: request };
  }
  const bytes = await read(appId, request.image, APP_RPC_LIMITS.cursorImageBytesMax);
  if (bytes === undefined) {
    return { ok: false, reason: `cursor.image must be a file in the app’s bundle of at most ${APP_RPC_LIMITS.cursorImageBytesMax} bytes` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  assert(bytes.length <= APP_RPC_LIMITS.cursorImageBytesMax, 'A reader keeps to the byte bound');
  const checked = request.image.endsWith('.png') ? checkPNG(bytes) : checkSVG(bytes);
  if (!checked.ok) {
    return checked;
  }
  const url = `data:${checked.type};base64,${base64Of(bytes)}`;
  return { ok: true, cursor: { url, hotspot: request.hotspot } };
}

/** Reads a bundle file through its frame URL, stopping past `bytesMax`. */
export function bundleBytesReader(urlFor: (appId: string, path: string) => string): BundleBytesReader {
  return async (appId, path, bytesMax) => {
    let response: Response;
    try {
      response = await fetch(urlFor(appId, path));
    } catch {
      return undefined; // The bundle server refused or is gone: no such file, as far as the app can tell.
    }
    if (!response.ok || response.body === null) {
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Bounded by bytesMax: every chunk but the last adds at least a byte, and reading stops past it.
    while (total <= bytesMax) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      chunks.push(value);
    }
    if (total > bytesMax) {
      await reader.cancel();
      return undefined;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  };
}

type Checked = { readonly ok: true; readonly type: 'image/png' | 'image/svg+xml' } | { readonly ok: false; readonly reason: string };

/** A PNG by its signature, no larger than a cursor by its header. */
export function checkPNG(bytes: Uint8Array): Checked {
  if (bytes.length < PNG_SIZE_OFFSET + 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return { ok: false, reason: 'cursor.image ends in .png but is not a PNG' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return sized(view.getUint32(PNG_SIZE_OFFSET), view.getUint32(PNG_SIZE_OFFSET + 4), 'image/png');
}

/** An SVG by its root element, sized by its own `width` and `height` in pixels, as a cursor must be. */
export function checkSVG(bytes: Uint8Array): Checked {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'cursor.image ends in .svg but is not UTF-8 text' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  const root = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (root === undefined) {
    return { ok: false, reason: 'cursor.image ends in .svg but has no <svg> element' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  const width = pixelsOf(/\swidth\s*=\s*["']\s*([0-9.]+)\s*(?:px)?\s*["']/i.exec(root)?.[1]);
  const height = pixelsOf(/\sheight\s*=\s*["']\s*([0-9.]+)\s*(?:px)?\s*["']/i.exec(root)?.[1]);
  if (width === undefined || height === undefined) {
    return { ok: false, reason: 'A cursor SVG sets width and height in pixels on its <svg> element' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  return sized(width, height, 'image/svg+xml');
}

function sized(width: number, height: number, type: 'image/png' | 'image/svg+xml'): Checked {
  const max = APP_RPC_LIMITS.cursorImagePxMax;
  if (width < 1 || height < 1 || width > max || height > max) {
    return { ok: false, reason: `A cursor image is 1 to ${max} pixels a side; this one is ${width}×${height}` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  return { ok: true, type };
}

function pixelsOf(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = Number(input);
  return Number.isFinite(value) ? value : undefined;
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
