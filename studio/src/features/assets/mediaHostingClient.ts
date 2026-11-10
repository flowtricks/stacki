// Media hosting from the Studio editor: the same calls as Desktop's bridge
// (src/ipc/mediaHostingBridge.ts, which this module replaces in Studio), over
// HTTP. Connections are kept by the Worker, or by a local Studio's server
// (src/cloudflare/mediaConnectionRoutes.ts, mediaHostingServer.ts); a media
// call names its connection in a header and never carries a key. Files are
// chosen with the browser's own chooser and sent one per request.
import {
  MEDIA_HOSTING_LIMITS,
  parseMediaConnectionList,
  parseMediaListing,
  parseMediaResult,
  parseMediaSaveResult,
  parseMediaURL,
  type MediaConnectionDraft,
  type MediaConnectionList,
  type MediaListing,
  type MediaResult,
  type MediaSaveResult,
} from '../../../vendor/stacki/shared/properties/mediaHosting';
import {
  parseMediaAccountChoices,
  type MediaAccountChoices,
  type MediaAccountConnect,
  type MediaAccountKey,
} from '../../../vendor/stacki/shared/properties/mediaAccounts';
import { MEDIA_CONNECTION_HEADER } from './mediaConnectionBook';
import { request } from '../project/projectClient';

export interface MediaHostingHost {
  readonly available: boolean;
}
export const MEDIA_HOSTING_HOST: MediaHostingHost = { available: true };

export interface HostedFolder {
  readonly projectPath: string;
  readonly connectionId: string;
  readonly folder: string;
}

export async function listMediaConnections(_projectPath: string): Promise<MediaConnectionList> {
  return parseMediaConnectionList(await request('/studio/api/media-connections'));
}

export async function saveMediaConnection(_projectPath: string, draft: MediaConnectionDraft): Promise<MediaSaveResult> {
  return parseMediaSaveResult(await post('/studio/api/media-connections/save', { draft }));
}

export async function removeMediaConnection(_projectPath: string, id: string): Promise<MediaConnectionList> {
  return parseMediaConnectionList(await post('/studio/api/media-connections/remove', { id }));
}

export function listHostedMedia(target: HostedFolder): Promise<MediaResult<MediaListing>> {
  return call(target, 'list', {});
}

/** Asks for files in the browser and uploads them; undefined when cancelled. */
export async function pickUploadHostedMedia(target: HostedFolder): Promise<MediaResult<MediaListing | undefined>> {
  const files = await chooseFiles({ multiple: true });
  return files.length === 0 ? { ok: true, value: undefined } : uploadHostedMedia(target, files);
}

/** Uploads files one request each; the first refusal stops the rest and is answered. */
export async function uploadHostedMedia(target: HostedFolder, files: readonly File[]): Promise<MediaResult<MediaListing>> {
  if (files.length === 0 || files.length > MEDIA_HOSTING_LIMITS.uploadFilesMax) {
    return { ok: false, message: `Upload 1 to ${MEDIA_HOSTING_LIMITS.uploadFilesMax} files at once.` };
  }
  let last: MediaResult<MediaListing> = { ok: false, message: 'Nothing was uploaded.' };
  for (const file of files) {
    last = await send(target, `upload?${new URLSearchParams({ folder: target.folder, filename: file.name })}`, file);
    if (!last.ok) {
      return last;
    }
  }
  return last;
}

export function createHostedFolder(target: HostedFolder, name: string): Promise<MediaResult<MediaListing>> {
  return call(target, 'createFolder', { name });
}

export function renameHostedMedia(
  target: HostedFolder,
  change: { readonly entry: 'file' | 'folder'; readonly from: string; readonly to: string },
): Promise<MediaResult<MediaListing>> {
  return call(target, 'rename', change);
}

export function deleteHostedMedia(
  target: HostedFolder,
  entry: { readonly entry: 'file' | 'folder'; readonly name: string },
): Promise<MediaResult<MediaListing>> {
  return call(target, 'delete', entry);
}

export function reorderHostedMedia(target: HostedFolder, order: readonly string[]): Promise<MediaResult<MediaListing>> {
  return call(target, 'reorder', { order });
}

/** Asks for a file in the browser and writes it to the same key; undefined when cancelled. */
export async function replaceHostedMedia(target: HostedFolder, name: string): Promise<MediaResult<MediaListing | undefined>> {
  const [file] = await chooseFiles({ multiple: false });
  if (file === undefined) {
    return { ok: true, value: undefined };
  }
  return send(target, `replace?${new URLSearchParams({ folder: target.folder, name, filename: file.name })}`, file);
}

/** Opens a hosted file's public URL in a new tab. */
export function openHostedLink(url: string): Promise<void> {
  window.open(parseMediaURL(url, 'file URL'), '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}

function call(target: HostedFolder, operation: string, input: object): Promise<MediaResult<MediaListing>> {
  return attempt(async () =>
    parseMediaResult(
      await request(`/studio/api/media-hosting/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [MEDIA_CONNECTION_HEADER]: target.connectionId },
        body: JSON.stringify({ ...input, folder: target.folder }),
      }),
      parseMediaListing,
    ),
  );
}

function send(target: HostedFolder, operation: string, file: File): Promise<MediaResult<MediaListing>> {
  return attempt(async () =>
    parseMediaResult(
      await request(`/studio/api/media-hosting/${operation}`, {
        method: 'POST',
        headers: { [MEDIA_CONNECTION_HEADER]: target.connectionId },
        body: file,
      }),
      parseMediaListing,
    ),
  );
}

// A request Studio could not complete (offline, signed out) is the panel's to show.
async function attempt<T>(run: () => Promise<MediaResult<T>>): Promise<MediaResult<T>> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 900) || 'The media request failed.' };
  }
}

async function post(url: string, input: object): Promise<unknown> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// The browser's own file chooser; a dismissed chooser is no files.
function chooseFiles(options: { readonly multiple: boolean }): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** What a pasted Cloudflare token or Bunny API key can connect; the key goes to the server only. */
export function discoverMediaAccounts(_projectPath: string, key: MediaAccountKey): Promise<MediaResult<MediaAccountChoices>> {
  return attempt(async () => parseMediaResult(await post('/studio/api/media-connections/discover', { key }), parseMediaAccountChoices));
}

/** Connects the chosen bucket or zone; the server derives and keeps its keys. */
export async function connectMediaAccount(_projectPath: string, connect: MediaAccountConnect): Promise<MediaSaveResult> {
  return parseMediaSaveResult(await post('/studio/api/media-connections/connect-account', { connect }));
}
