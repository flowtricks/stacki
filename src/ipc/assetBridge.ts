import { parseResolvePathResult } from '../../shared/ipc/ipcContract';
import type { ResolvePathResult } from '../../shared/ipc/ipcContract';
import { toProjectPath, toFilePath } from '../../shared/core/brand';
// Asset cards only consume the entry list. Parse every entry before a path or
// dimension reaches a DOM attribute; unrelated result metadata stays opaque.
import { boolean, count, list, object, optional, pathText, record, text } from '../../shared/core/boundary';
import type { WireAssetEntry } from '../../shared/ipc/ipcResults';
import type { Result } from '../../shared/core/result';

const entryBase = object({ rel: pathText, name: text, parent: pathText, root: text });
const entryFile = object({ abs: pathText, size: count });
const entryDirectory = object({ isRoot: optional(boolean) });

export function parseAssetEntry(input: unknown): WireAssetEntry {
  const value = record(input);
  const base = entryBase(value);
  if (boolean(value['isDir'])) {
    const { isRoot } = entryDirectory(value);
    return isRoot ? { ...base, isDir: true, isRoot: true } : { ...base, isDir: true };
  }
  return { ...base, isDir: false, ...entryFile(value) };
}

export const parseAssetEntries = object({ entries: list(parseAssetEntry) });

export async function listAssetEntries(projectPath: string): Promise<Result<readonly WireAssetEntry[], string>> {
  let response: unknown;
  try {
    response = await window.avb.listAssets(projectPath);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A malformed bridge response is a programmer error; never catch it as a disk failure.
  return { ok: true, value: parseAssetEntries(response).entries };
}

export function onAssetEntriesChanged(callback: () => void): () => void {
  return window.avb.onAssetsChanged(callback);
}

// Transport failures mean an unavailable preview; a malformed result remains a contract bug.
export async function resolveAssetImport(projectPath: string, fromFile: string, spec: string): Promise<ResolvePathResult> {
  const payload = {
    projectPath: toProjectPath(projectPath),
    fromFile: toFilePath(fromFile),
    spec: pathText(spec),
  };
  let response: unknown;
  try {
    response = await window.avb.resolveSourcePath(payload);
  } catch {
    return { ok: false };
  }
  const result = parseResolvePathResult(response);
  return result.ok ? { ok: true, rel: pathText(result.rel) } : result;
}

// Image headers encode unsigned 32-bit dimensions; larger values cannot describe a file.
function imageDimension(input: unknown): number {
  const value = count(input);
  if (value === 0 || value > 0xffff_ffff) {
    throw new Error('AssetDimensions: expected positive 32-bit dimension');
  }
  return value;
}
const dimensions = object({ w: imageDimension, h: imageDimension });
export function parseAssetDimensions(input: unknown) {
  return optional(dimensions)(record(input)['dims']);
}

export async function readAssetDimensions(projectPath: string, rel: string): Promise<Result<ReturnType<typeof parseAssetDimensions>, string>> {
  const payload = { projectPath: toProjectPath(projectPath), rel: pathText(rel) };
  let response: unknown;
  try {
    response = await window.avb.assetDimensions(payload);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, value: parseAssetDimensions(response) };
}
