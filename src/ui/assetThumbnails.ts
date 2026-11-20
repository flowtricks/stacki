// Small copies of large pictures, for thumbnails drawn a few dozen pixels wide.
//
// Why: an asset folder is full of camera photos, 4000 to 8000 pixels a side. Handed to <img> in a
// 72px tile, each one is decoded at full size (up to ~200 MB of pixels) for every tile that draws it,
// and the browser's decoded-image cache cannot hold a screenful, so scrolling the Assets panel showed
// tiles half painted, in strips, while pictures were decoded, evicted and decoded again. Here each
// picture is fetched and decoded once, off the main thread (`createImageBitmap`),
// drawn scaled down, re-encoded as a small WebP and kept as an object URL. A tile draws that: a few kilobytes, decoded
// in microseconds.
//
// Bounds: `THUMBNAIL_READS_MAX` decodes at once (each holds a full-size picture while it runs),
// `THUMBNAIL_QUEUE_MAX` waiting, newest first (the oldest request has most likely scrolled away and
// asks again if it comes back), and `THUMBNAIL_ENTRIES_MAX` small copies kept, the least recently used
// released first. A picture that cannot be read this way (no `createImageBitmap`, a decode error, a
// refused fetch) or that is already no wider than the copy is answered "direct": the tile draws the file itself, as it did before.
import { useEffect, useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';

// Each decode holds a full-size picture (a 6000 x 4000 photo is ~96 MB) until it is scaled down.
export const THUMBNAIL_READS_MAX = 2;
export const THUMBNAIL_QUEUE_MAX = 256;
export const THUMBNAIL_ENTRIES_MAX = 600;
/** The small copy's width: twice the widest grid tile is sharp on a 2x screen without costing more. */
export const THUMBNAIL_WIDTH_PX = 256;

/** Raster formats worth shrinking. SVG is drawn at any size for free; GIF and ICO keep their own frames. */
export const THUMBNAIL_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i;

export type ThumbnailState = { readonly kind: 'pending' } | { readonly kind: 'ready'; readonly url: string } | { readonly kind: 'direct' };

/** Makes one small copy; resolves to a blob, or rejects when the picture cannot be read this way. */
export type ThumbnailMaker = (source: string, widthPx: number) => Promise<Blob>;

export interface ThumbnailCache {
  readonly get: (key: string) => ThumbnailState | undefined;
  readonly request: (key: string, source: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly stats: () => { readonly made: number; readonly entries: number; readonly waiting: number };
}

export function createThumbnailCache(
  make: ThumbnailMaker,
  urls: { readonly create: (blob: Blob) => string; readonly revoke: (url: string) => void },
): ThumbnailCache {
  // A Map keeps insertion order: deleting and re-setting a key on use makes it the newest.
  const entries = new Map<string, ThumbnailState>();
  const waiting = new Map<string, string>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let made = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const remember = (key: string, state: ThumbnailState): void => {
    entries.delete(key);
    entries.set(key, state);
    if (entries.size > THUMBNAIL_ENTRIES_MAX) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        const released = entries.get(oldest);
        entries.delete(oldest);
        if (released?.kind === 'ready') {
          urls.revoke(released.url);
        }
      }
    }
    assert(entries.size <= THUMBNAIL_ENTRIES_MAX, 'The thumbnail cache keeps at most its entry count');
  };
  const finish = (key: string, state: ThumbnailState): void => {
    inFlight.delete(key);
    remember(key, state);
    notify();
    queueMicrotask(drain);
  };
  const pump = (): void => {
    while (inFlight.size < THUMBNAIL_READS_MAX && waiting.size > 0) {
      const key = [...waiting.keys()].at(-1);
      assert(key !== undefined, 'A non-empty queue has a newest request');
      const source = waiting.get(key);
      assert(source !== undefined, 'A waiting request names its source');
      waiting.delete(key);
      inFlight.add(key);
      made += 1;
      void make(source, THUMBNAIL_WIDTH_PX).then(
        (blob) => finish(key, { kind: 'ready', url: urls.create(blob) }),
        // Any failure draws the file itself: a thumbnail is an optimisation, never a reason for a blank tile.
        () => finish(key, { kind: 'direct' }),
      );
    }
    assert(inFlight.size <= THUMBNAIL_READS_MAX, 'Decodes in flight stay within their bound');
  };
  function drain(): void {
    pump();
  }
  return {
    get: (key) => entries.get(key),
    request: (key, source) => {
      if (entries.has(key) || waiting.has(key) || inFlight.has(key)) {
        return;
      }
      waiting.set(key, source);
      if (waiting.size > THUMBNAIL_QUEUE_MAX) {
        const oldest = waiting.keys().next().value;
        if (oldest !== undefined) {
          waiting.delete(oldest);
        }
      }
      assert(waiting.size <= THUMBNAIL_QUEUE_MAX, 'The thumbnail queue stays within its bound');
      pump();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stats: () => ({ made, entries: entries.size, waiting: waiting.size }),
  };
}

/** The browser's own maker: fetch, decode off the main thread, draw scaled down, re-encode small. */
export async function makeThumbnail(source: string, widthPx: number): Promise<Blob> {
  assert(widthPx > 0, 'A thumbnail has a width');
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Thumbnail: ${response.status}`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    // A picture already as small as the copy would be is drawn as it is: a copy would only blur it.
    if (bitmap.width <= widthPx) {
      throw new Error('Thumbnail: already small');
    }
    const heightPx = Math.max(1, Math.round((bitmap.height * widthPx) / bitmap.width));
    const canvas = new OffscreenCanvas(widthPx, heightPx);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Thumbnail: no 2D context');
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, widthPx, heightPx);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } finally {
    bitmap.close();
  }
}

let sharedCache: ThumbnailCache | undefined;

function thumbnailCache(): ThumbnailCache {
  sharedCache ??= createThumbnailCache(makeThumbnail, { create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url) });
  return sharedCache;
}

const PENDING: ThumbnailState = { kind: 'pending' };
const DIRECT: ThumbnailState = { kind: 'direct' };

/**
 * The small copy for a picture while `wanted`, keyed by what makes it stale (path, size, modified
 * time). Unwanted, or where the platform cannot make one, the answer is "direct".
 */
export function useThumbnail(key: string, source: string | undefined, options: { readonly wanted: boolean }): ThumbnailState {
  const usable = options.wanted && source !== undefined && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
  const cache = usable ? thumbnailCache() : undefined;
  useEffect(() => {
    if (cache !== undefined && source !== undefined) {
      cache.request(key, source);
    }
  }, [cache, key, source]);
  return useSyncExternalStore(cache === undefined ? noSubscription : cache.subscribe, () => (cache === undefined ? DIRECT : (cache.get(key) ?? PENDING)));
}

function noSubscription(): () => void {
  return () => undefined;
}
