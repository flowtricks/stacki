// Studio's client shows project files through `/studio/api/asset?file=…`, set as an
// image, video or font source rather than fetched, so the fetch stand-in never sees
// it, and a static host has no such route. This file rewrites that URL where it is
// set, before the browser can request it: a public file maps to the baked site, which
// serves `public/` at its root, and anything else maps to an empty answer that fails
// at once instead of reaching the network.
const ASSET_PATH = '/studio/api/asset';
const FILE_CHARS_MAX = 1_000;

/** What an image or font may load in place of a file the static host does not have. */
export const NO_ASSET_URL = 'data:,';

/** The URL a file has on the baked site, or undefined when the build gave it no fixed URL. */
export type AssetResolver = (file: string) => string | undefined;

/** Public files keep their path below the site's base; Astro hashes everything else. */
export function publicAssetResolver(base: string): AssetResolver {
  if (!base.startsWith('/') || !base.endsWith('/')) {
    throw new Error('The site base is a path with both slashes');
  }
  return (file) => {
    if (!file.startsWith('public/') || file.length > FILE_CHARS_MAX) {
      return undefined;
    }
    const segments = file.slice('public/'.length).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return undefined;
    }
    return `${base}${segments.map(encodeURIComponent).join('/')}`;
  };
}

/** The URL to load in place of `value`, or undefined when `value` is not Studio's asset route. */
export function assetSiteURL(value: string, origin: string, resolve: AssetResolver): string | undefined {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || url.pathname !== ASSET_PATH) {
    return undefined;
  }
  const file = url.searchParams.get('file');
  const mapped = file === null ? undefined : resolve(file);
  return mapped === undefined ? NO_ASSET_URL : `${mapped}${url.hash}`;
}

/** Rewrites every `url(...)` in a FontFace source list. */
export function fontSourceURLs(source: string, origin: string, resolve: AssetResolver): string {
  return source.replace(/url\((["']?)([^"')]+)\1\)/g, (whole, quote: string, value: string) => {
    const mapped = assetSiteURL(value, origin, resolve);
    return mapped === undefined ? whole : `url(${quote}${mapped}${quote})`;
  });
}

function patchSourceProperty(prototype: object, rewrite: (value: string) => string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src');
  const set = descriptor?.set;
  if (descriptor === undefined || set === undefined) {
    return;
  }
  Object.defineProperty(prototype, 'src', {
    ...descriptor,
    set(this: Element, value: unknown) {
      set.call(this, typeof value === 'string' ? rewrite(value) : value);
    },
  });
}

/** Installs the rewrite on every way the client sets a media source. Call once, before the client loads. */
export function installAssetURLs(resolve: AssetResolver): void {
  const origin = location.origin;
  const rewrite = (value: string): string => assetSiteURL(value, origin, resolve) ?? value;
  // Read here, not at load, so Node can import the pure helpers above.
  const sourceElements = [HTMLImageElement, HTMLMediaElement, HTMLSourceElement] as const;
  for (const element of sourceElements) {
    patchSourceProperty(element.prototype, rewrite);
  }
  // React sets `src` as an attribute, not through the property.
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    const media = sourceElements.some((element) => this instanceof element);
    setAttribute.call(this, name, media && name.toLowerCase() === 'src' ? rewrite(String(value)) : value);
  };
  const NativeFontFace = window.FontFace;
  window.FontFace = class extends NativeFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? fontSourceURLs(source, origin, resolve) : source, descriptors);
    }
  };
}
