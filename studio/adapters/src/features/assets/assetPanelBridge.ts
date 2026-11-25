import type { ImageFormat } from '../../../shared/ipc/assetConversion';
import type { Parser } from '../../../shared/core/boundary';
import type { Result } from '../../../shared/core/result';
import type { MessageRef } from '../../../shared/properties/i18n/messageRef';
import type { WireAssetEntry } from '../../../shared/ipc/ipcResults';
import { BOUNDARY_LIMITS, boolean, count, list, pathText, record, text } from '../../../shared/core/boundary';
import { assetOperation, chooseReplacement, chooseUploads, uploadFiles } from '../../../../../src/features/assets/assetPanelClient';
import { request as studioRequest } from '../../../../../src/features/project/projectClient';

import { cleanError } from '../../lib/cleanError';
import { parseAssetEntry } from '../../ipc/assetBridge';

export type AssetRoot = 'public' | 'src';
export type AssetPanelEntry = WireAssetEntry & { readonly root: AssetRoot };

export interface AssetListing {
  readonly entries: readonly AssetPanelEntry[];
  readonly missing: boolean;
}

export function parseAssetListing(input: unknown): AssetListing {
  const value = record(input);
  const entries = list(parsePanelEntry)(value['entries']);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.rel)) {
      throw new Error(`Asset listing: duplicate path ${entry.rel}`);
    }
    seen.add(entry.rel);
  }
  const missing = boolean(value['missing']);
  const hasPublicRoot = entries.some((entry) => entry.isDir && entry.isRoot === true && entry.root === 'public');
  if (missing === hasPublicRoot) {
    throw new Error('Asset listing: missing state contradicts public root');
  }
  return { entries, missing };
}

export function readAssetListing(_projectPath: string) {
  return request(parseAssetListing, () => studioRequest('/studio/api/assets'));
}
export function pickUploadAssets(_projectPath: string, destinationRel: string) {
  return request(parseAdded, () => chooseUploads(destinationRel));
}
export function uploadAssets(_projectPath: string, destinationRel: string, files: readonly File[]) {
  return request(parseAdded, () => uploadFiles(destinationRel, files));
}
export function moveAsset(_projectPath: string, fromRel: string, toDirectoryRel: string) {
  return request(parseOutcome, () =>
    assetOperation({
      kind: 'move',
      rel: parseAssetRelativePath(fromRel),
      destination: parseAssetDestination(toDirectoryRel),
    }),
  );
}
export function renameAsset(_projectPath: string, rel: string, newName: string) {
  return request(parseSuccess, () =>
    assetOperation({
      kind: 'rename',
      rel: parseAssetRelativePath(rel),
      name: parseAssetName(newName),
    }),
  );
}
export function deleteAsset(_projectPath: string, rel: string) {
  return request(parseOutcome, () => assetOperation({ kind: 'delete', rel: parseAssetRelativePath(rel) }));
}
/** Asks for a file in the browser and writes it over the asset, keeping its path; false when cancelled. */
export async function replaceAsset(
  _projectPath: string,
  rel: string,
): Promise<{ readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly error: string; readonly messageRef?: MessageRef | undefined }> {
  // Studio's server words its own failures, so none carries a message reference.
  return request(boolean, () => chooseReplacement(parseAssetRelativePath(rel)));
}
export function makeAssetDirectory(_projectPath: string, parentRel: string, name: string) {
  return request(parseSuccess, () =>
    assetOperation({
      kind: 'mkdir',
      rel: parseAssetDestination(parentRel),
      name: parseAssetName(name),
    }),
  );
}
export function onAssetListingChanged(callback: () => void): () => void {
  window.addEventListener('studio:assets-changed', callback);
  return () => window.removeEventListener('studio:assets-changed', callback);
}

function parsePanelEntry(input: unknown): AssetPanelEntry {
  const entry = parseAssetEntry(input);
  const root = parseRoot(entry.root);
  const segments = assetSegments(entry.rel);
  const name = segments.at(-1);
  if (name !== entry.name) {
    throw new Error('Asset listing: name does not match relative path');
  }
  if (segments[0] !== root) {
    throw new Error('Asset listing: root does not match relative path');
  }
  if (parentOf(entry.rel) !== entry.parent) {
    throw new Error('Asset listing: parent does not match relative path');
  }
  if (entry.isDir && entry.isRoot === true) {
    validateRootEntry(entry.rel, entry.name, entry.parent, root);
  }
  return { ...entry, root };
}

function parseRoot(input: string): AssetRoot {
  if (input === 'public' || input === 'src') {
    return input;
  }
  throw new Error('Asset listing: unknown root');
}

function assetSegments(rel: string): readonly string[] {
  pathText(rel);
  const segments = rel.split('/');
  if (segments.length > BOUNDARY_LIMITS.depthMax) {
    throw new Error('Asset listing: path depth exceeds limit');
  }
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Asset listing: invalid relative path');
  }
  return segments;
}

function parseAssetRelativePath(input: string): string {
  const value = pathText(input);
  assetSegments(value);
  return value;
}

function parseAssetDestination(input: string): string {
  return input === '' ? '' : parseAssetRelativePath(input);
}

function parseAssetName(input: string): string {
  const value = text(input);
  if (value.length === 0 || value.length > 255 || value === '.' || value === '..') {
    throw new Error('Asset name: invalid length or reserved name');
  }
  if (value.trim() !== value || value.includes('/') || value.includes('\\')) {
    throw new Error('Asset name: expected one trimmed path segment');
  }
  return value;
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

function validateRootEntry(rel: string, name: string, parent: string, root: AssetRoot): void {
  if (rel !== root || name !== root || parent !== '') {
    throw new Error('Asset listing: invalid root entry');
  }
}

function parseAdded(input: unknown): number {
  return count(record(input)['added']);
}

function parseOutcome(input: unknown): boolean {
  return boolean(record(input)['ok']);
}

function parseSuccess(input: unknown): void {
  if (!boolean(record(input)['ok'])) {
    throw new Error('Asset operation: expected success');
  }
}

async function request<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parse(response) };
}

// Encoding currently belongs to the desktop host, not the Cloudflare worker.
export function convertAsset(_projectPath: string, _rel: string, _format: ImageFormat): Promise<Result<never, string>> {
  return Promise.resolve({ ok: false, error: 'Image conversion requires the desktop app.' });
}
