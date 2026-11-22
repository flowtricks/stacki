// Where dictation models live on this computer and what is there: `<userData>/models/whisper/
// <model>/<revision>/`, never inside a project (a model is the person's tool, not the site's, and
// 80 MB in a repository would be pushed with it). A folder is installed when its `verified.json`
// names this model, this revision and every manifest hash, and every file has its manifest size.
// The marker is checked here as it was written (dictationDownload.ts): the pair of assertions on both
// sides of storage that AGENTS.md §9 asks for.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { ModelInstall } from '../../shared/properties/voice/dictationModel';
import { modelTotalBytes, WHISPER_MODELS, type WhisperModel, type WhisperModelId } from '../../shared/properties/voice/whisperModels';
import { fileTarget, PART_SUFFIX, VERIFIED_FILE } from './dictationDownload';

/** The folder of every model: `<userData>/models/whisper`. */
export function whisperRoot(userData: string): string {
  assert(path.isAbsolute(userData), 'whisperRoot: the app data folder is absolute');
  const root = path.join(userData, 'models', 'whisper');
  assert(root.startsWith(userData), 'whisperRoot: inside the app data folder');
  return root;
}

/** The folder of one model at its pinned revision. */
export function modelDirectory(root: string, model: WhisperModel): string {
  const directory = path.join(root, model.id, model.revision);
  assert(path.dirname(path.dirname(directory)) === root, 'modelDirectory: two levels under the root');
  assert(/^[0-9a-f]{40}$/u.test(path.basename(directory)), 'modelDirectory: named by the revision');
  return directory;
}

/** What is on disk for `model`. A read failure other than "not there" is thrown: the disk is not answering. */
export async function readInstall(root: string, model: WhisperModel): Promise<ModelInstall> {
  const directory = modelDirectory(root, model);
  const totalBytes = modelTotalBytes(model);
  let receivedBytes = 0;
  let complete = true;
  for (const file of model.files) {
    const target = fileTarget(directory, file);
    const size = await sizeOf(target);
    if (size === file.sizeBytes) {
      receivedBytes += size;
      continue;
    }
    complete = false;
    // A part longer than the file is discarded by the next download; it counts for nothing here.
    receivedBytes += Math.min(file.sizeBytes, (await sizeOf(target + PART_SUFFIX)) ?? 0);
  }
  assert(receivedBytes <= totalBytes, 'readInstall: never more bytes than the model has');
  if (complete && (await markerMatches(directory, model))) {
    return { kind: 'installed', sizeBytes: totalBytes };
  }
  return receivedBytes > 0 ? { kind: 'partial', receivedBytes, totalBytes } : { kind: 'notInstalled' };
}

/** Whether `verified.json` names this model, this revision and exactly the manifest's hashes. */
async function markerMatches(directory: string, model: WhisperModel): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(directory, VERIFIED_FILE), 'utf8');
  } catch {
    return false;
  }
  if (raw.length > 64 * 1024) {
    return false;
  }
  let parsed: unknown;
  try {
    const value: unknown = JSON.parse(raw);
    parsed = value;
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || !('revision' in parsed) || !('files' in parsed)) {
    return false;
  }
  if (parsed.id !== model.id || parsed.revision !== model.revision || !Array.isArray(parsed.files)) {
    return false;
  }
  const listed: unknown[] = parsed.files;
  if (listed.length !== model.files.length) {
    return false;
  }
  return model.files.every((file, index) => {
    const entry = listed[index];
    return typeof entry === 'object' && entry !== null && 'path' in entry && 'sha256' in entry && entry.path === file.path && entry.sha256 === file.sha256;
  });
}

/** Removes every revision of one model. Only folders named by a known model id under the root are touched. */
export async function removeModel(root: string, id: WhisperModelId): Promise<void> {
  const target = path.join(root, WHISPER_MODELS[id].id);
  assert(path.dirname(target) === root, 'removeModel: one model folder directly under the root');
  assert(path.basename(target) === id, 'removeModel: the folder is named by the model id');
  await rm(target, { recursive: true, force: true });
}

/** Revisions on disk other than the pinned one: left by an older Stacki, removed when a newer model installs. */
export async function staleRevisions(root: string, model: WhisperModel): Promise<readonly string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(root, model.id));
  } catch {
    return [];
  }
  return names.filter((name) => /^[0-9a-f]{40}$/u.test(name) && name !== model.revision).map((name) => path.join(root, model.id, name));
}

async function sizeOf(filePath: string): Promise<number | undefined> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : undefined;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Folders inside a model folder that hold files (the root and `onnx/`); a bound on the walk below. */
const MODEL_FOLDERS_MAX = 4;

/**
 * Removes files in the model's folder that the manifest no longer names: a manifest that changes one file
 * (the standard model's encoder went from 8-bit to half precision) would otherwise leave the old one behind.
 * Only plain files directly in the folder or one level down, never a link or anything outside.
 */
export async function removeStrayFiles(root: string, model: WhisperModel): Promise<readonly string[]> {
  const directory = modelDirectory(root, model);
  const keep = new Set([VERIFIED_FILE, ...model.files.map((file) => path.join(...file.path.split('/')))]);
  const folders = ['', ...new Set(model.files.map((file) => path.dirname(file.path)).filter((folder) => folder !== '.'))];
  assert(folders.length <= MODEL_FOLDERS_MAX, 'removeStrayFiles: a model has few folders');
  const removed: string[] = [];
  for (const folder of folders) {
    let entries;
    try {
      entries = await readdir(path.join(directory, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = folder === '' ? entry.name : path.join(folder, entry.name);
      if (entry.isFile() && !keep.has(relative) && !relative.endsWith(PART_SUFFIX)) {
        const target = path.join(directory, relative);
        assert(target.startsWith(directory + path.sep), 'removeStrayFiles: inside the model folder');
        await rm(target, { force: true });
        removed.push(relative);
      }
    }
  }
  return removed;
}
