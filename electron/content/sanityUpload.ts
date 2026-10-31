// Storing an image or file in a Sanity dataset, from a file the person chose.
// Sanity keeps it as an asset document; the panel then writes a field that
// points at it, as Sanity Studio does. The file goes straight from disk to
// Sanity's assets API with the connection's key; nothing else is sent.

import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { RemoteAsset, RemoteAssetKind } from '../../shared/properties/cmsRemote';
import { SANITY_API_VERSION, type SanityDataset } from './sanityContent';

// The largest file uploaded from the panel, and how long one may take.
const UPLOAD_BYTES_MAX = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'tif', 'tiff'];

/** Uploads a file the system dialog picked (Desktop). */
export async function sanityUpload(
  target: SanityDataset,
  kind: RemoteAssetKind,
  file: string,
): Promise<RemoteAsset> {
  assert(path.isAbsolute(file), 'An upload reads an absolute path the dialog returned');
  if (fs.statSync(file).size > UPLOAD_BYTES_MAX) {
    throw new Error('This file is larger than 100 MB.');
  }
  return sanityUploadBytes(target, kind, path.basename(file), fs.readFileSync(file));
}

/** Uploads a file's bytes under its name (Desktop's dialog, or a browser in Studio). */
export async function sanityUploadBytes(
  target: SanityDataset,
  kind: RemoteAssetKind,
  name: string,
  bytes: Uint8Array,
): Promise<RemoteAsset> {
  const filename = path.basename(name).slice(0, 200) || 'upload';
  if (bytes.byteLength > UPLOAD_BYTES_MAX) {
    throw new Error('This file is larger than 100 MB.');
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (kind === 'image' && !IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error('Choose an image file.');
  }
  assert(bytes.byteLength <= UPLOAD_BYTES_MAX, 'An upload stays within its size bound');
  const url =
    `https://${target.projectId}.api.sanity.io/${SANITY_API_VERSION}/assets/` +
    `${kind === 'image' ? 'images' : 'files'}/${target.dataset}` +
    `?filename=${encodeURIComponent(filename)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': mimeOf(extension) },
    // A copy on its own ArrayBuffer: what fetch takes as a body in every runtime.
    body: new Uint8Array(bytes),
    redirect: 'error',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`Sanity did not accept the upload (${response.status}).`);
  }
  return assetOf(body, filename);
}

/** The largest file the CMS panel uploads, for a host to bound a request body by. */
export const SANITY_UPLOAD_BYTES_MAX = UPLOAD_BYTES_MAX;

function assetOf(body: unknown, filename: string): RemoteAsset {
  const document: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'document') : undefined;
  const id: unknown =
    typeof document === 'object' && document !== null ? Reflect.get(document, '_id') : undefined;
  const url: unknown =
    typeof document === 'object' && document !== null ? Reflect.get(document, 'url') : undefined;
  if (typeof id !== 'string' || typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('Sanity returned an unexpected asset.');
  }
  return { id, url, filename };
}

function mimeOf(extension: string): string {
  const types: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    pdf: 'application/pdf',
  };
  return types[extension] ?? 'application/octet-stream';
}
