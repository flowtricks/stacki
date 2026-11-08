// Where each project asset under `src/` ended up in the baked site. Astro copies an
// imported asset to `_astro/<name>.<hash>.<ext>`, so its URL cannot be derived from its
// path the way a `public/` file's can. The bake writes this map beside the snapshot, as
// its own optional file, and the demo shows asset previews from it. Runs in Node and in
// the browser: matching and parsing only, no file access.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { MEDIA_EXT } from '../assets/assetStateTypes';
import { filePath, record, string } from '../../shared/validation';

export const BAKE_ASSET_URLS_FILE = 'asset-urls.json';

export const ASSET_URL_LIMITS = {
  /** Assets a map may hold; a site with more keeps previews for the first ones. */
  entriesMax: 2_000,
  urlCharsMax: 1_000,
  /** The map file is read in one request before the editor loads. */
  fileBytesMax: 1_000_000,
} as const satisfies Record<string, number>;

/** A file and the digest of its bytes. */
export interface HashedFile {
  readonly path: string;
  readonly sha256: string;
}

const EMITTED_NAME = /^(.+)\.[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9]+)$/;

function stem(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name.toLowerCase();
}

const RASTER = /\.(png|jpe?g|gif|webp|avif)$/i;

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Pairs each `src/` asset with what the build emitted: same bytes first, then a unique
 * `<name>.<hash>.<ext>` of the same name, since an optimised image changes its bytes, and
 * last, for a raster image, any rendering of it: Astro may emit only resized `.webp`
 * variants, any of which shows the picture. */
export function matchAssetURLs(sources: readonly HashedFile[], emitted: readonly HashedFile[], base: string): Readonly<Record<string, string>> {
  assert(base.startsWith('/'), 'The site base is a path');
  assert(base.endsWith('/'), 'The site base ends with a slash');
  const byDigest = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const renderings = new Map<string, string[]>();
  for (const file of [...emitted].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!byDigest.has(file.sha256)) {
      byDigest.set(file.sha256, file.path);
    }
    const match = EMITTED_NAME.exec(stem(file.path));
    if (match !== null) {
      const key = `${match[1] ?? ''}${match[2] ?? ''}`;
      byName.set(key, [...(byName.get(key) ?? []), file.path]);
      if (RASTER.test(file.path)) {
        const picture = match[1] ?? '';
        renderings.set(picture, [...(renderings.get(picture) ?? []), file.path]);
      }
    }
  }
  const urls: Record<string, string> = {};
  for (const source of sources.slice(0, ASSET_URL_LIMITS.entriesMax)) {
    const named = byName.get(stem(source.path));
    const rendered = RASTER.test(source.path) ? renderings.get(withoutExtension(stem(source.path)))?.[0] : undefined;
    const found = byDigest.get(source.sha256) ?? (named?.length === 1 ? named[0] : undefined) ?? rendered;
    if (found !== undefined) {
      urls[source.path] = `${base}${found.split('/').map(encodeURIComponent).join('/')}`;
    }
  }
  return urls;
}

/** Parses the map file. Throws on any shape or bound it cannot trust. */
export function parseAssetURLs(text: string, base: string): Readonly<Record<string, string>> {
  if (text.length > ASSET_URL_LIMITS.fileBytesMax) {
    throw new Error('Asset URL map exceeds its size limit');
  }
  const entries = Object.entries(record(JSON.parse(text) as unknown));
  if (entries.length > ASSET_URL_LIMITS.entriesMax) {
    throw new Error('Asset URL map has too many entries');
  }
  const urls: Record<string, string> = {};
  for (const [file, value] of entries) {
    const source = filePath(file);
    if (!source.startsWith('src/') || !MEDIA_EXT.test(source)) {
      throw new Error('Asset URL map names a file that is not a src asset');
    }
    const url = string(value, ASSET_URL_LIMITS.urlCharsMax);
    if (!url.startsWith(base) || url.includes('..') || url.includes('//')) {
      throw new Error('Asset URL map points outside the site');
    }
    urls[source] = url;
  }
  return urls;
}
