import { parseConversionResult, type ImageFormat } from '../../../shared/ipc/assetConversion';
import type { Parser } from '../../../shared/core/boundary';
import type { Result } from '../../../shared/core/result';
import type { WireAssetEntry } from '../../../shared/ipc/ipcResults';
import { BOUNDARY_LIMITS, boolean, count, list, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { toProjectPath } from '../../../shared/core/brand';
import { cleanError } from '../../lib/cleanError';
import { parseAssetEntry } from '../../ipc/assetBridge';
import { parseMediaResult } from '../../../shared/properties/mediaHosting';

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

export function readAssetListing(projectPath: string) {
  const payload = parseIpcPayload('assets:list', toProjectPath(projectPath));
  return request(parseAssetListing, () => window.avb.listAssets(payload));
}

export function pickUploadAssets(projectPath: string, destinationRel: string) {
  const payload = parseIpcPayload('assets:pickUpload', {
    projectPath: toProjectPath(projectPath),
    destRel: parseAssetDestination(destinationRel),
  });
  return request(parseAdded, () => window.avb.pickUploadAssets(payload));
}

export function uploadAssets(projectPath: string, destinationRel: string, files: readonly (File | string)[]) {
  const filePaths = files.map((file) => (typeof file === 'string' ? file : window.avb.getFilePath(file))).filter((file): file is string => !!file);
  const payload = parseIpcPayload('assets:upload', {
    projectPath: toProjectPath(projectPath),
    destRel: parseAssetDestination(destinationRel),
    filePaths,
  });
  return request(parseAdded, () => window.avb.uploadAssets(payload));
}

export function moveAsset(projectPath: string, fromRel: string, toDirectoryRel: string) {
  const payload = parseIpcPayload('assets:move', {
    projectPath: toProjectPath(projectPath),
    fromRel: parseAssetRelativePath(fromRel),
    toDirRel: parseAssetDestination(toDirectoryRel),
  });
  return request(parseOutcome, () => window.avb.moveAsset(payload));
}

export function renameAsset(projectPath: string, rel: string, newName: string) {
  const payload = parseIpcPayload('assets:rename', {
    projectPath: toProjectPath(projectPath),
    rel: parseAssetRelativePath(rel),
    newName: parseAssetName(newName),
  });
  return request(parseSuccess, () => window.avb.renameAsset(payload));
}

export function deleteAsset(projectPath: string, rel: string) {
  const payload = parseIpcPayload('assets:delete', {
    projectPath: toProjectPath(projectPath),
    rel: parseAssetRelativePath(rel),
  });
  return request(parseOutcome, () => window.avb.deleteAsset(payload));
}

/** Asks for a file in the system dialog and writes it over the asset, keeping its path; false when cancelled. */
export async function replaceAsset(projectPath: string, rel: string): Promise<Result<boolean, string>> {
  const payload = parseIpcPayload('assets:replace', {
    projectPath: toProjectPath(projectPath),
    rel: parseAssetRelativePath(rel),
  });
  const answer = await request(
    (input) => parseMediaResult(input, boolean),
    () => window.avb.replaceAsset(payload),
  );
  if (!answer.ok) {
    return answer;
  }
  return answer.value.ok ? { ok: true, value: answer.value.value } : { ok: false, error: answer.value.message };
}

export function makeAssetDirectory(projectPath: string, parentRel: string, name: string) {
  const payload = parseIpcPayload('assets:mkdir', {
    projectPath: toProjectPath(projectPath),
    parentRel: parseAssetDestination(parentRel),
    name: parseAssetName(name),
  });
  return request(parseSuccess, () => window.avb.mkdirAssets(payload));
}

export function onAssetListingChanged(callback: () => void): () => void {
  return window.avb.onAssetsChanged(callback);
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

export function convertAsset(projectPath: string, rel: string, format: ImageFormat) {
  const payload = parseIpcPayload('assets:convert', { projectPath, rel, format });
  return request(parseConversionResult, () => window.avb.convertAsset(payload));
}
