import { parsePageImage, parsePageType } from '../../shared/properties/pageMetadata';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';

export function renderedPageType(document: Document): string | undefined {
  const type = document.querySelector('meta[property="og:type"]')?.getAttribute('content');
  if (!type) {
    return undefined;
  }
  try {
    return parsePageType(type);
  } catch {
    return undefined;
  }
}

export function renderedPageImage(document: Document): string | undefined {
  const image =
    document.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
  if (!image) {
    return undefined;
  }
  if (image.length > BOUNDARY_LIMITS.pathLengthMax) {
    return undefined;
  }
  // Social metadata uses the production origin even during local preview.
  // Match it to the canonical page before treating it as a project asset;
  // a CMS/CDN URL on another origin must keep pointing to that remote image.
  try {
    const url = new URL(parsePageImage(new URL(image, document.baseURI).href));
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const pageURL = new URL(canonical ?? document.URL, document.baseURI);
    if (url.origin === pageURL.origin) {
      return parsePageImage(`${url.pathname}${url.search}${url.hash}`);
    }
    if (url.origin === new URL(document.URL).origin) {
      return parsePageImage(`${url.pathname}${url.search}${url.hash}`);
    }
    return parsePageImage(url.href);
  } catch {
    // Malformed page metadata is unavailable, not an editor failure.
    return undefined;
  }
}
