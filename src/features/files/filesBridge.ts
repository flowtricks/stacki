// The Files panel's calls to main, each payload parsed before it is sent and each reply parsed before a component
// sees it (shared/ipc/fileExplorer.ts holds both halves of the contract).
import type { Digest } from '../../../shared/core/brand';
import { record } from '../../../shared/core/boundary';
import {
  parseChecksumValue,
  parseExplorerContent,
  parseExplorerListing,
  parseExplorerResult,
  parseFilesChanged,
  parseFindAnswer,
  parsePathValue,
  parsePlacements,
  type CollisionChoice,
  type CreateKind,
  type ExplorerContent,
  type ExplorerListing,
  type ExplorerPath,
  type ExplorerResult,
  type FindAnswer,
  type TransferMode,
  type TransferPlacement,
  parseFileGitStatus,
  type FileGitStatus,
} from '../../../shared/ipc/fileExplorer';
import { count } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';

export async function listFiles(projectPath: string, path: ExplorerPath): Promise<ExplorerResult<ExplorerListing>> {
  const payload = parseIpcPayload('files:list', { projectPath, path });
  return parseExplorerResult(await window.avb.listFiles(payload), parseExplorerListing);
}

export async function readFile(projectPath: string, path: ExplorerPath): Promise<ExplorerResult<ExplorerContent>> {
  const payload = parseIpcPayload('files:read', { projectPath, path });
  return parseExplorerResult(await window.avb.readFile(payload), parseExplorerContent);
}

export async function writeFile(
  projectPath: string,
  write: { readonly path: ExplorerPath; readonly text: string; readonly byteOrderMark: boolean; readonly base: Digest },
): Promise<ExplorerResult<{ readonly checksum: Digest }>> {
  const payload = parseIpcPayload('files:write', { projectPath, ...write });
  return parseExplorerResult(await window.avb.writeFile(payload), parseChecksumValue);
}

export async function createEntry(
  projectPath: string,
  parent: ExplorerPath,
  name: string,
  kind: CreateKind,
): Promise<ExplorerResult<{ readonly path: ExplorerPath }>> {
  const payload = parseIpcPayload('files:create', { projectPath, parent, name, kind });
  return parseExplorerResult(await window.avb.createFileEntry(payload), parsePathValue);
}

export async function renameEntry(projectPath: string, path: ExplorerPath, name: string): Promise<ExplorerResult<{ readonly path: ExplorerPath }>> {
  const payload = parseIpcPayload('files:rename', { projectPath, path, name });
  return parseExplorerResult(await window.avb.renameFileEntry(payload), parsePathValue);
}

export async function transferEntries(
  projectPath: string,
  request: { readonly paths: readonly ExplorerPath[]; readonly target: ExplorerPath; readonly mode: TransferMode; readonly collision: CollisionChoice },
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>> {
  const payload = parseIpcPayload('files:transfer', { projectPath, ...request });
  return parseExplorerResult(await window.avb.transferFileEntries(payload), parsePlacements);
}

export async function trashEntries(projectPath: string, paths: readonly ExplorerPath[]): Promise<ExplorerResult<{ readonly count: number }>> {
  const payload = parseIpcPayload('files:trash', { projectPath, paths });
  return parseExplorerResult(await window.avb.trashFileEntries(payload), (value) => ({ count: count(record(value)['count']) }));
}

export async function importEntries(
  projectPath: string,
  request: { readonly sources: readonly string[]; readonly target: ExplorerPath; readonly collision: CollisionChoice },
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>> {
  const payload = parseIpcPayload('files:import', { projectPath, ...request });
  return parseExplorerResult(await window.avb.importFileEntries(payload), parsePlacements);
}

export async function revealEntry(projectPath: string, path: ExplorerPath): Promise<ExplorerResult<unknown>> {
  const payload = parseIpcPayload('files:reveal', { projectPath, path });
  return parseExplorerResult(await window.avb.revealFileEntry(payload), (value) => value);
}

export async function findFiles(projectPath: string, query: string): Promise<ExplorerResult<FindAnswer>> {
  const payload = parseIpcPayload('files:find', { projectPath, query });
  return parseExplorerResult(await window.avb.findFiles(payload), parseFindAnswer);
}

export async function watchFolders(projectPath: string, directories: readonly ExplorerPath[]): Promise<number> {
  const payload = parseIpcPayload('files:watch', { projectPath, directories });
  return count(record(await window.avb.watchFiles(payload))['watching']);
}

export async function readFileGitStatus(projectPath: string): Promise<FileGitStatus> {
  const payload = parseIpcPayload('files:gitStatus', { projectPath });
  return parseFileGitStatus(await window.avb.fileGitStatus(payload));
}

export async function guardClose({ unsaved }: { readonly unsaved: boolean }): Promise<void> {
  const payload = parseIpcPayload('files:guardClose', { unsaved });
  record(await window.avb.guardFilesClose(payload));
}

export async function allowClose({ proceed }: { readonly proceed: boolean }): Promise<void> {
  const payload = parseIpcPayload('files:allowClose', { proceed });
  record(await window.avb.allowFilesClose(payload));
}

export function onFoldersChanged(callback: (directories: readonly ExplorerPath[]) => void): () => void {
  if (typeof window.avb.onFilesChanged !== 'function') {
    return () => {};
  }
  return window.avb.onFilesChanged((input) => callback(parseFilesChanged(input).directories));
}

export function onCloseRequested(callback: () => void): () => void {
  if (typeof window.avb.onFilesCloseRequested !== 'function') {
    return () => {};
  }
  return window.avb.onFilesCloseRequested(callback);
}
