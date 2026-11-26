// Design mode (experimental, removable: docs/design-mode/REMOVE.md): canvases and videos on a snapshot.
//
// A copied canvas holds no pixels, and in a document that runs no script Chromium does not even give it a canvas's
// box: it draws its fallback text inline, so a canvas in the flow collapses. A video loses its source. Each is
// pictured on the live page: a canvas becomes a picture of the same intrinsic size carrying the same attributes (so
// the page's class and id rules still fit it), and a video gets its present frame as its poster.
import type { AssetBudget } from './designSnapshotAssets';

/** A picture of a canvas or video is kept at most this many pixels across. */
const SURFACE_PX_MAX = 960;
const SURFACE_QUALITY = 0.82;
/** The side of the small copy that is read to tell a blank picture from a drawn one. */
const PROBE_PX = 32;

function sizeOf(element: HTMLCanvasElement | HTMLVideoElement): { readonly width: number; readonly height: number } {
  return element instanceof HTMLVideoElement ? { width: element.videoWidth, height: element.videoHeight } : { width: element.width, height: element.height };
}

/** The element's present picture, or undefined when it shows nothing or its pixels may not be read. */
export function canvasPicture(element: HTMLCanvasElement | HTMLVideoElement): string | undefined {
  const size = sizeOf(element);
  if (size.width < 1 || size.height < 1 || (element instanceof HTMLVideoElement && element.readyState < 2)) {
    return undefined;
  }
  const scale = Math.min(1, SURFACE_PX_MAX / size.width);
  const copy = document.createElement('canvas');
  copy.width = Math.max(1, Math.round(size.width * scale));
  copy.height = Math.max(1, Math.round(size.height * scale));
  const probe = document.createElement('canvas');
  probe.width = PROBE_PX;
  probe.height = PROBE_PX;
  const context = copy.getContext('2d');
  const probeContext = probe.getContext('2d', { willReadFrequently: true });
  if (context === null || probeContext === null) {
    return undefined;
  }
  try {
    context.drawImage(element, 0, 0, copy.width, copy.height);
    probeContext.drawImage(copy, 0, 0, PROBE_PX, PROBE_PX);
    const pixels = probeContext.getImageData(0, 0, PROBE_PX, PROBE_PX).data;
    return blankPixels(pixels) ? undefined : copy.toDataURL('image/webp', SURFACE_QUALITY);
  } catch {
    return undefined; // Another origin's pixels may not be read.
  }
}

/**
 * Whether the pixels show nothing: all of them clear, or all of them black, which is how a WebGL canvas without an
 * alpha channel reads once its frame has been shown. Either way what lies under the canvas is the better picture.
 */
export function blankPixels(pixels: Uint8ClampedArray): boolean {
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const clear = pixels[at + 3] === 0;
    const black = pixels[at] === 0 && pixels[at + 1] === 0 && pixels[at + 2] === 0;
    if (!clear && !black) {
      return false;
    }
  }
  return true;
}

/** A picture drawn at exactly `width` by `height`, whatever size its pixels were kept at. */
export function sizedPicture(width: number, height: number, data: string | undefined): string {
  const across = String(Math.max(0, Math.round(width)));
  const down = String(Math.max(0, Math.round(height)));
  const image = data === undefined ? '' : `<image width="${across}" height="${down}" preserveAspectRatio="none" href="${data}"/>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${across}" height="${down}" viewBox="0 0 ${across} ${down}">${image}</svg>`)}`;
}

export interface DesignSurface {
  readonly source: HTMLCanvasElement | HTMLVideoElement;
  readonly copy: Element;
}

/** The page's canvases and videos beside their copies, while the copy still lists the page's elements one for one. */
export function pairSurfaces(sources: readonly Element[], targets: readonly Element[]): readonly DesignSurface[] {
  const pairs: DesignSurface[] = [];
  sources.forEach((source, index) => {
    const copy = targets[index];
    if (copy !== undefined && (source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement)) {
      pairs.push({ source, copy });
    }
  });
  return pairs;
}

/** Puts each surface's picture on its copy, while the budget lasts: the one read on screen, else the present one. */
export function showSurfaces(surfaces: readonly DesignSurface[], held: ReadonlyMap<Element, string>, budget: AssetBudget): void {
  for (const { source, copy } of surfaces) {
    if (!copy.isConnected && copy.parentNode === null) {
      continue;
    }
    const read = held.get(source) ?? canvasPicture(source);
    const data = read !== undefined && budget.spend(read) ? read : undefined;
    if (source instanceof HTMLVideoElement) {
      // A poster the page chose stands: it is what the video shows until it is played.
      if (data !== undefined && !copy.hasAttribute('poster')) {
        copy.setAttribute('poster', data);
      }
      continue;
    }
    const picture = document.createElement('img');
    for (const attribute of Array.from(copy.attributes)) {
      if (attribute.name !== 'width' && attribute.name !== 'height') {
        picture.setAttribute(attribute.name, attribute.value);
      }
    }
    picture.setAttribute('alt', '');
    picture.setAttribute('src', sizedPicture(source.width, source.height, data));
    copy.replaceWith(picture);
  }
}
