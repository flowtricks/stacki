// The Assets panel's operations on a media host, written once over the
// MediaStore adapters: listing a folder in its saved order, uploading under
// names that never overwrite, making, renaming and deleting folders and files,
// and saving a folder's order. A rename is a copy and a delete, because no
// object store renames in place; a folder rename moves each object below it.

import { assert } from '../../../shared/core/assert';
import { described } from '../../../shared/properties/i18n/messageRef';
import { MEDIA_HOSTING_LIMITS, mediaKeyOf, mediaKindOf, replacementRefusal, type MediaListing } from '../../../shared/properties/mediaHosting';
import { MEDIA_HTTP_LIMITS, MediaHostError } from './mediaHttp';
import { applyOrder, orderAfter, readOrder, writeOrder } from './mediaOrder';
import { MEDIA_FOLDER_KEYS_MAX, contentTypeOf, type MediaStore, type StoredListing } from './mediaStore';

export interface UploadFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type MediaEntryKind = 'file' | 'folder';

export interface MediaService {
  list(folder: string): Promise<MediaListing>;
  upload(folder: string, files: readonly UploadFile[]): Promise<MediaListing>;
  createFolder(folder: string, name: string): Promise<MediaListing>;
  rename(folder: string, change: { readonly entry: MediaEntryKind; readonly from: string; readonly to: string }): Promise<MediaListing>;
  remove(folder: string, target: { readonly entry: MediaEntryKind; readonly name: string }): Promise<MediaListing>;
  reorder(folder: string, names: readonly string[]): Promise<MediaListing>;
  /** Writes new bytes to an existing file's key, so every link to it keeps working. */
  replace(folder: string, name: string, file: UploadFile): Promise<MediaListing>;
}

export function mediaService(store: MediaStore): MediaService {
  const list = async (folder: string): Promise<MediaListing> => listingOf(store, folder, await store.list(folder), await readOrder(store, folder));
  return {
    list,
    async upload(folder, files) {
      assert(files.length <= MEDIA_HOSTING_LIMITS.uploadFilesMax, 'An upload carries a bounded number of files');
      const listed = await store.list(folder);
      const taken = new Set([...listed.files.map((file) => file.name), ...listed.folders]);
      for (const file of files) {
        if (file.bytes.length > MEDIA_HTTP_LIMITS.fileBytesMax) {
          throw new MediaHostError(described('cmsBackend.media.fileTooLarge', { name: file.name, size: MEDIA_HTTP_LIMITS.fileBytesMax / 1024 / 1024 }), 0);
        }
        const name = uniqueName(file.name, taken);
        taken.add(name);
        await store.write(mediaKeyOf(folder, name), file.bytes, contentTypeOf(name));
      }
      return list(folder);
    },
    async createFolder(folder, name) {
      const listed = await store.list(folder);
      if (listed.folders.includes(name) || listed.files.some((file) => file.name === name)) {
        throw new MediaHostError(described('cmsBackend.media.nameExists'), 0);
      }
      await store.createFolder(mediaKeyOf(folder, name));
      return list(folder);
    },
    async rename(folder, change) {
      if (change.from === change.to) {
        return list(folder);
      }
      const listed = await store.list(folder);
      if (listed.folders.includes(change.to) || listed.files.some((file) => file.name === change.to)) {
        throw new MediaHostError(described('cmsBackend.media.nameExists'), 0);
      }
      const from = mediaKeyOf(folder, change.from);
      const to = mediaKeyOf(folder, change.to);
      if (change.entry === 'file') {
        await store.copy(from, to);
        await store.remove(from);
        await saveOrderChange(store, folder, { from: change.from, to: change.to });
      } else {
        await moveFolder(store, from, to);
      }
      return list(folder);
    },
    async remove(folder, target) {
      const key = mediaKeyOf(folder, target.name);
      if (target.entry === 'file') {
        await store.remove(key);
        await saveOrderChange(store, folder, { from: target.name, to: undefined });
      } else {
        await store.removeFolder(key);
      }
      return list(folder);
    },
    async reorder(folder, names) {
      const listed = await store.list(folder);
      const present = new Set(listed.files.map((file) => file.name));
      const missing = names.find((name) => !present.has(name));
      if (missing !== undefined) {
        throw new MediaHostError(described('cmsBackend.media.missingInFolder', { name: missing }), 0);
      }
      await writeOrder(store, folder, names);
      return list(folder);
    },
    async replace(folder, name, file) {
      const refusal = replacementRefusal(name, file.name);
      if (refusal !== undefined) {
        throw new MediaHostError(refusal, 0);
      }
      if (file.bytes.length > MEDIA_HTTP_LIMITS.fileBytesMax) {
        throw new MediaHostError(described('cmsBackend.media.fileTooLarge', { name: file.name, size: MEDIA_HTTP_LIMITS.fileBytesMax / 1024 / 1024 }), 0);
      }
      const listed = await store.list(folder);
      if (!listed.files.some((entry) => entry.name === name)) {
        throw new MediaHostError(described('cmsBackend.media.missingInFolder', { name }), 0);
      }
      // The old file's content type: the key, and so what it serves as, is unchanged.
      await store.write(mediaKeyOf(folder, name), file.bytes, contentTypeOf(name));
      return list(folder);
    },
  };
}

// Each object below the folder, copied to the new folder, then the old folder
// removed. Copies first: a failure part-way leaves the originals whole.
async function moveFolder(store: MediaStore, from: string, to: string): Promise<void> {
  const keys = await store.keysUnder(from, MEDIA_FOLDER_KEYS_MAX);
  assert(keys.length <= MEDIA_FOLDER_KEYS_MAX, 'A folder move is bounded');
  await store.createFolder(to);
  for (const key of keys) {
    if (key.endsWith('/')) {
      await store.createFolder(`${to}/${key.slice(0, -1)}`);
    } else {
      await store.copy(`${from}/${key}`, `${to}/${key}`);
    }
  }
  await store.removeFolder(from);
}

async function saveOrderChange(store: MediaStore, folder: string, change: { readonly from: string; readonly to: string | undefined }): Promise<void> {
  const order = await readOrder(store, folder);
  if (order.includes(change.from)) {
    await writeOrder(store, folder, orderAfter(order, change));
  }
}

function listingOf(store: MediaStore, folder: string, listed: StoredListing, order: readonly string[]): MediaListing {
  const files = applyOrder(listed.files, order).map((file) => {
    const key = mediaKeyOf(folder, file.name);
    return { name: file.name, key, kind: mediaKindOf(file.name), sizeBytes: file.sizeBytes, modified: file.modified, url: store.publicURL(key) };
  });
  const folders = [...listed.folders]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
    .map((name) => ({ name, path: mediaKeyOf(folder, name) }));
  assert(files.length === listed.files.length, 'Every listed file is kept');
  return { folder, folders, files, truncated: listed.truncated };
}

/** The name, or `name 2.ext`, `name 3.ext` … until it is free, as Finder does. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  // Taken names are bounded by a folder, so a free number is found within that many tries.
  for (let number = 2; number <= taken.size + 2; number++) {
    const candidate = `${stem} ${number}${extension}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('uniqueName: no free name within the taken set, which cannot happen');
}
