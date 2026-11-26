// Design mode (experimental, removable: docs/design-mode/REMOVE.md): a snapshot's own pictures.
//
// A frame is read from the app's origin, and the dev server refuses another origin's no-cors requests for its
// files, so a frame's pictures would be broken (and would be gone with the server). The ones this page's own
// origin serves are copied into the snapshot: an <img> from the pixels already decoded, at no more than the size it
// is drawn, and a stylesheet's pictures from their files. Another origin's keep their address, which loads anywhere.
import { DESIGN_SNAPSHOT_LIMITS } from '../../../shared/ipc/designSnapshot';

/** Pictures already encoded, by address and width: a snapshot follows every change, and a picture rarely changes. */
const encoded = new Map<string, string>();
const ENCODED_MAX = 200;
/** A picture is kept at most this many pixels across, and at most twice as wide as it is drawn. */
const PICTURE_PX_MAX = 1_600;
const PICTURE_QUALITY = 0.86;

/** The characters one snapshot's pictures may take together. */
export class AssetBudget {
  private charsLeft: number = DESIGN_SNAPSHOT_LIMITS.assetsCharsMax;

  /** Takes room for `data`, or says there is none for it. */
  spend(data: string): boolean {
    if (data.length > DESIGN_SNAPSHOT_LIMITS.assetCharsMax || data.length > this.charsLeft) {
      return false;
    }
    this.charsLeft -= data.length;
    return true;
  }
}

function keep(key: string, data: string): void {
  if (encoded.size >= ENCODED_MAX) {
    const oldest = encoded.keys().next().value;
    if (oldest !== undefined) {
      encoded.delete(oldest);
    }
  }
  encoded.set(key, data);
}

function sameOrigin(address: string): boolean {
  try {
    return new URL(address, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** The pixels of a decoded picture as a data URL, no larger than the picture is drawn needs. */
function encodePicture(image: HTMLImageElement): string | undefined {
  const drawnPx = Math.max(image.getBoundingClientRect().width, 1) * 2;
  // A picture with no size of its own (an SVG without one) is drawn at the size it is shown.
  const naturalWidth = image.naturalWidth > 0 ? image.naturalWidth : drawnPx;
  const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : Math.max(image.getBoundingClientRect().height, 1) * 2;
  const widthPx = Math.max(1, Math.round(Math.min(naturalWidth, drawnPx, PICTURE_PX_MAX)));
  const key = `${image.currentSrc} ${String(widthPx)}`;
  const held = encoded.get(key);
  if (held !== undefined) {
    return held;
  }
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.max(1, Math.round((naturalHeight * widthPx) / naturalWidth));
  const context = canvas.getContext('2d');
  if (context === null) {
    return undefined;
  }
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/webp', PICTURE_QUALITY);
    keep(key, data);
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Puts each of the copy's same-origin pictures in the copy itself: images (from their decoded pixels, or from their
 * file when the page has not drawn them yet: lazy ones further down, ones hidden at this width), pictures in SVG,
 * and video posters. `source` and `target` list the same elements.
 */
export async function inlinePictures(source: Element, target: Element, budget: AssetBudget): Promise<void> {
  const sources = Array.from(source.querySelectorAll('img'));
  const targets = Array.from(target.querySelectorAll('img'));
  if (sources.length === targets.length) {
    const unread: { readonly address: string; readonly copy: Element }[] = [];
    sources.forEach((image, index) => {
      const copy = targets[index];
      const address = image.currentSrc !== '' ? image.currentSrc : image.src;
      if (copy === undefined || address === '' || address.startsWith('data:') || !sameOrigin(address)) {
        return;
      }
      const drawn = image.complete && image.currentSrc !== '' && image.getBoundingClientRect().width > 0;
      const data = drawn ? encodePicture(image) : undefined;
      if (data !== undefined && budget.spend(data)) {
        showOnly(copy, data);
      } else {
        unread.push({ address, copy });
      }
    });
    // Those the page has not drawn come from their files, after the ones it shows have had the budget.
    for (const { address, copy } of unread.slice(0, ENCODED_MAX)) {
      const data = await readAsDataURL(address);
      if (data !== undefined && budget.spend(data)) {
        showOnly(copy, data);
      }
    }
  }
  const others = Array.from(target.querySelectorAll('video[poster], image[href]')).slice(0, ENCODED_MAX);
  for (const element of others) {
    const attribute = element.hasAttribute('poster') ? 'poster' : 'href';
    const written = element.getAttribute(attribute) ?? '';
    if (written === '' || written.startsWith('data:') || !sameOrigin(written)) {
      continue;
    }
    const data = await readAsDataURL(new URL(written, location.href).href);
    if (data !== undefined && budget.spend(data)) {
      element.setAttribute(attribute, data);
    }
  }
}

/** The copy shows exactly what the page chose, so its other choices go. */
function showOnly(copy: Element, data: string): void {
  copy.setAttribute('src', data);
  copy.removeAttribute('srcset');
  copy.removeAttribute('sizes');
  copy.removeAttribute('loading');
  if (copy.parentElement?.tagName === 'PICTURE') {
    for (const other of Array.from(copy.parentElement.querySelectorAll('source'))) {
      other.remove();
    }
  }
}

const CSS_PICTURE = /url\(\s*(['"]?)(https?:[^'")]+\.(?:png|jpe?g|gif|webp|avif|svg)[^'")]*)\1\s*\)/gi;
/** Pictures one stylesheet brings in. */
const CSS_PICTURES_MAX = 60;

/** `text` (its addresses already absolute) with this origin's pictures put in it, while the budget lasts. */
export async function inlineStylePictures(text: string, budget: AssetBudget): Promise<string> {
  const wanted = [...new Set(Array.from(text.matchAll(CSS_PICTURE), (match) => match[2] ?? ''))].filter(sameOrigin).slice(0, CSS_PICTURES_MAX);
  const found = new Map<string, string>();
  for (const address of wanted) {
    const data = encoded.get(address) ?? (await readAsDataURL(address));
    if (data !== undefined && budget.spend(data)) {
      keep(address, data);
      found.set(address, data);
    }
  }
  if (found.size === 0) {
    return text;
  }
  return text.replace(CSS_PICTURE, (whole, quote: string, address: string) => {
    const data = found.get(address);
    return data === undefined ? whole : `url(${quote}${data}${quote})`;
  });
}

export async function readAsDataURL(address: string): Promise<string | undefined> {
  try {
    const response = await fetch(address, { cache: 'force-cache', credentials: 'same-origin' });
    if (!response.ok) {
      return undefined;
    }
    const blob = await response.blob();
    // Three base64 characters for every two bytes, rounded up: checked before reading the whole file in.
    if (Math.ceil((blob.size * 4) / 3) > DESIGN_SNAPSHOT_LIMITS.assetCharsMax) {
      return undefined;
    }
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}
