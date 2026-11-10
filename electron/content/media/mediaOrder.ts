// A folder's custom file order. Object stores list keys by name and keep no
// order of their own, so the order lives in a small manifest object inside the
// folder it orders (`.stacki-order.json`, MEDIA_ORDER_FILE), not in a project
// file: the order belongs to the media, so every project and every person using
// the bucket sees the same order, and nothing in the site's repository churns
// when someone drags a picture. Listings never show the manifest. It holds only
// file names, so being publicly readable at the bucket's URL reveals nothing
// the listing does not.
//
// The order is a convenience. A missing or damaged manifest reads as no order
// and files fall back to name order; the files themselves are never at risk.

import { assert } from '../../../shared/core/assert';
import { MEDIA_HOSTING_LIMITS, MEDIA_ORDER_FILE, mediaKeyOf } from '../../../shared/properties/mediaHosting';
import type { MediaStore } from './mediaStore';

const ORDER_VERSION = 1;
// Names at their longest, quoted, for a folder's bound: about 1.3 MB.
const ORDER_BYTES_MAX = MEDIA_HOSTING_LIMITS.entriesPerFolderMax * (MEDIA_HOSTING_LIMITS.nameCharsMax + 8);

export async function readOrder(store: MediaStore, folder: string): Promise<readonly string[]> {
  const bytes = await store.read(mediaKeyOf(folder, MEDIA_ORDER_FILE), ORDER_BYTES_MAX);
  if (bytes === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parseOrderManifest(parsed);
  } catch {
    return [];
  }
}

/** Saves the order; an empty order removes the manifest. */
export async function writeOrder(store: MediaStore, folder: string, names: readonly string[]): Promise<void> {
  assert(names.length <= MEDIA_HOSTING_LIMITS.entriesPerFolderMax, 'An order is bounded by a folder');
  assert(new Set(names).size === names.length, 'An order names each file once');
  const key = mediaKeyOf(folder, MEDIA_ORDER_FILE);
  if (names.length === 0) {
    await store.remove(key);
    return;
  }
  const body = new TextEncoder().encode(JSON.stringify({ version: ORDER_VERSION, order: names }));
  assert(body.length <= ORDER_BYTES_MAX, 'An order manifest stays within its size');
  await store.write(key, body, 'application/json');
}

export function parseOrderManifest(input: unknown): readonly string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Order manifest: expected an object');
  }
  if (Reflect.get(input, 'version') !== ORDER_VERSION) {
    throw new Error('Order manifest: unknown version');
  }
  const order: unknown = Reflect.get(input, 'order');
  if (!Array.isArray(order) || order.length > MEDIA_HOSTING_LIMITS.entriesPerFolderMax) {
    throw new Error('Order manifest: expected a bounded list');
  }
  const names = order.filter((name): name is string => typeof name === 'string' && name.length <= MEDIA_HOSTING_LIMITS.nameCharsMax);
  return [...new Set(names)];
}

/** Names in the saved order first, then the rest by name, as people sort (2 before 10). */
export function applyOrder<T extends { readonly name: string }>(entries: readonly T[], order: readonly string[]): readonly T[] {
  const rank = new Map(order.map((name, index) => [name, index]));
  const sorted = [...entries].sort((left, right) => {
    const leftRank = rank.get(left.name);
    const rightRank = rank.get(right.name);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  assert(sorted.length === entries.length, 'Ordering keeps every entry');
  return sorted;
}

/** The saved order with one name renamed, or left out when it was removed. */
export function orderAfter(order: readonly string[], change: { readonly from: string; readonly to: string | undefined }): readonly string[] {
  const next =
    change.to === undefined ? order.filter((name) => name !== change.from) : order.map((name) => (name === change.from ? (change.to ?? name) : name));
  assert(next.length <= order.length, 'A change never lengthens an order');
  return next;
}
