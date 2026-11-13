// Media hosting from the renderer: connections and the Assets panel's hosted
// folders. Desktop asks the main process, which holds the keys and makes every
// network call; Stacki Studio replaces this module (studio/scripts/shared-source.json).
// Every reply is parsed before a component sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseOkResult } from '../../shared/ipc/ipcContract';
import { parseMediaAccountChoices, type MediaAccountChoices, type MediaAccountConnect, type MediaAccountKey } from '../../shared/properties/mediaAccounts';
import {
  parseMediaConnectionList,
  parseMediaListing,
  parseMediaURL,
  parseMediaResult,
  parseMediaSaveResult,
  type MediaConnectionDraft,
  type MediaConnectionList,
  type MediaListing,
  type MediaResult,
  type MediaSaveResult,
} from '../../shared/properties/mediaHosting';
import { described } from '../../shared/properties/i18n/messageRef';

/** What this host offers: Desktop connects media hosts; a host without them hides the panel's sources. */
export interface MediaHostingHost {
  readonly available: boolean;
}
export const MEDIA_HOSTING_HOST: MediaHostingHost = { available: true };

/** One hosted folder a request acts on. */
export interface HostedFolder {
  readonly projectPath: string;
  readonly connectionId: string;
  readonly folder: string;
}

export async function listMediaConnections(projectPath: string): Promise<MediaConnectionList> {
  const input = parseIpcPayload('mediaHosting:connections', { projectPath });
  return parseMediaConnectionList(await window.avb.mediaConnections(input));
}

export async function saveMediaConnection(projectPath: string, draft: MediaConnectionDraft): Promise<MediaSaveResult> {
  const input = parseIpcPayload('mediaHosting:save', { projectPath, draft });
  return parseMediaSaveResult(await window.avb.saveMediaConnection(input));
}

export async function removeMediaConnection(projectPath: string, id: string): Promise<MediaConnectionList> {
  const input = parseIpcPayload('mediaHosting:remove', { projectPath, id });
  return parseMediaConnectionList(await window.avb.removeMediaConnection(input));
}

export async function listHostedMedia(target: HostedFolder): Promise<MediaResult<MediaListing>> {
  const input = parseIpcPayload('mediaHosting:list', target);
  return parseMediaResult(await window.avb.listHostedMedia(input), parseMediaListing);
}

/** Asks for files in the system dialog and uploads them; undefined when cancelled. */
export async function pickUploadHostedMedia(target: HostedFolder): Promise<MediaResult<MediaListing | undefined>> {
  const input = parseIpcPayload('mediaHosting:pickUpload', target);
  return parseMediaResult(await window.avb.pickUploadHostedMedia(input), (value) => (value === undefined ? undefined : parseMediaListing(value)));
}

/** Uploads files dropped from the system, by their paths on disk. */
export async function uploadHostedMedia(target: HostedFolder, files: readonly File[]): Promise<MediaResult<MediaListing>> {
  const filePaths = files.map((file) => window.avb.getFilePath(file)).filter((file): file is string => file !== undefined && file !== '');
  if (filePaths.length === 0) {
    return { ok: false, ...described('error.bridge.noFilePaths') };
  }
  const input = parseIpcPayload('mediaHosting:upload', { ...target, filePaths });
  return parseMediaResult(await window.avb.uploadHostedMedia(input), parseMediaListing);
}

export async function createHostedFolder(target: HostedFolder, name: string): Promise<MediaResult<MediaListing>> {
  const input = parseIpcPayload('mediaHosting:createFolder', { ...target, name });
  return parseMediaResult(await window.avb.createHostedFolder(input), parseMediaListing);
}

export async function renameHostedMedia(
  target: HostedFolder,
  change: { readonly entry: 'file' | 'folder'; readonly from: string; readonly to: string },
): Promise<MediaResult<MediaListing>> {
  const input = parseIpcPayload('mediaHosting:rename', { ...target, ...change });
  return parseMediaResult(await window.avb.renameHostedMedia(input), parseMediaListing);
}

export async function deleteHostedMedia(
  target: HostedFolder,
  entry: { readonly entry: 'file' | 'folder'; readonly name: string },
): Promise<MediaResult<MediaListing>> {
  const input = parseIpcPayload('mediaHosting:delete', { ...target, ...entry });
  return parseMediaResult(await window.avb.deleteHostedMedia(input), parseMediaListing);
}

export async function reorderHostedMedia(target: HostedFolder, order: readonly string[]): Promise<MediaResult<MediaListing>> {
  const input = parseIpcPayload('mediaHosting:reorder', { ...target, order });
  return parseMediaResult(await window.avb.reorderHostedMedia(input), parseMediaListing);
}

/** Asks for a file in the system dialog and writes it to the same key; undefined when cancelled. */
export async function replaceHostedMedia(target: HostedFolder, name: string): Promise<MediaResult<MediaListing | undefined>> {
  const input = parseIpcPayload('mediaHosting:replace', { ...target, name });
  return parseMediaResult(await window.avb.replaceHostedMedia(input), (value) => (value === undefined ? undefined : parseMediaListing(value)));
}

/** Opens a hosted file's public URL in the system browser. */
export async function openHostedLink(url: string): Promise<void> {
  const input = parseIpcPayload('shell:openExternal', parseMediaURL(url, 'file URL'));
  parseOkResult(await window.avb.openExternal(input));
}

/** What a pasted Cloudflare token or Bunny API key can connect; nothing secret comes back. */
export async function discoverMediaAccounts(projectPath: string, key: MediaAccountKey): Promise<MediaResult<MediaAccountChoices>> {
  const input = parseIpcPayload('mediaHosting:discover', { projectPath, key });
  return parseMediaResult(await window.avb.discoverMediaAccounts(input), parseMediaAccountChoices);
}

/** Connects the chosen bucket or zone; the main process derives and keeps its keys. */
export async function connectMediaAccount(projectPath: string, connect: MediaAccountConnect): Promise<MediaSaveResult> {
  const input = parseIpcPayload('mediaHosting:connectAccount', { projectPath, connect });
  return parseMediaSaveResult(await window.avb.connectMediaAccount(input));
}
