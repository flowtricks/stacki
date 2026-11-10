// Media hosting over IPC: connect, list and remove hosts, and browse and change
// one host's folders from the Assets panel. Keys come in once, with a save, and
// never go back out: every reply is the public half of a connection, or a
// listing read with its keys here. Every network call runs in this process.

import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import type { MainHost } from './mainHost';
import type { MediaConnectionStore } from '../content/media/mediaConnectionStore';
import type { MediaConnection, MediaConnectionDraft, MediaResult, MediaSaveResult } from '../../shared/properties/mediaHosting';
import { MEDIA_HOSTING_LIMITS, parseMediaConnection } from '../../shared/properties/mediaHosting';
import { MEDIA_HTTP_LIMITS, type MediaFetch } from '../content/media/mediaHttp';
import { mediaService, type MediaService, type UploadFile } from '../content/media/mediaService';
import { storeFor } from '../content/media/mediaStore';
import { accountConnectionDraft, discoverMediaAccounts } from '../content/media/mediaAccounts';

const failureMessageCharsMax = 900;

export function registerMediaHostingHandlers(
  host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'showOpenDialog'>,
  store: MediaConnectionStore,
  fetcher: MediaFetch = (url, init) => fetch(url, init),
): void {
  // The open project only, by its real path: connections are keyed by it.
  const root = (projectPath: string) => {
    const canonical = realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    return canonical;
  };
  const options = { fetch: fetcher, now: () => new Date() };
  // The service for one saved connection, its keys decrypted for this request only.
  const service = (projectPath: string, connectionId: string): MediaService => {
    const saved = store.connection(root(projectPath), connectionId);
    if (saved === undefined) {
      throw new Error('This media connection was removed. Connect it again in the Assets panel.');
    }
    if (saved.secret === undefined) {
      throw new Error('Stacki could not read this connection’s keys. Connect it again in the Assets panel.');
    }
    return mediaService(storeFor(saved.connection, saved.secret, options));
  };
  const { ipcMain } = host;
  ipcMain.handle('mediaHosting:connections', (_event, input) => store.list(root(input.projectPath)));
  // A connection is tried before it is kept, so a typo shows now, not at first use.
  const trySave = async (projectPath: string, draft: MediaConnectionDraft): Promise<MediaSaveResult> => {
    const project = root(projectPath);
    const tried = await attempt(() => mediaService(storeFor(publicFields(draft), draft.secret, options)).list(''));
    if (!tried.ok) {
      return { ok: false, message: tried.message };
    }
    const saved = attemptSync(() => store.save(project, draft));
    return saved.ok ? { ok: true, list: store.list(project) } : { ok: false, message: saved.message };
  };
  ipcMain.handle('mediaHosting:save', (_event, input) => trySave(input.projectPath, input.draft));
  // "Connect with Cloudflare / Bunny": the pasted account key finds what to
  // choose from, then derives the chosen connection's keys (mediaAccounts.ts).
  ipcMain.handle('mediaHosting:discover', (_event, input) => {
    root(input.projectPath);
    return attempt(() => discoverMediaAccounts(fetcher, input.key));
  });
  ipcMain.handle('mediaHosting:connectAccount', async (_event, input): Promise<MediaSaveResult> => {
    const draft = await attempt(() => accountConnectionDraft(fetcher, input.connect));
    return draft.ok ? trySave(input.projectPath, draft.value) : { ok: false, message: draft.message };
  });
  ipcMain.handle('mediaHosting:remove', (_event, input) => {
    const project = root(input.projectPath);
    store.remove(project, input.id);
    return store.list(project);
  });
  ipcMain.handle('mediaHosting:list', (_event, input) => attempt(() => service(input.projectPath, input.connectionId).list(input.folder)));
  ipcMain.handle('mediaHosting:createFolder', (_event, input) =>
    attempt(() => service(input.projectPath, input.connectionId).createFolder(input.folder, input.name)),
  );
  ipcMain.handle('mediaHosting:rename', (_event, input) =>
    attempt(() => service(input.projectPath, input.connectionId).rename(input.folder, { entry: input.entry, from: input.from, to: input.to })),
  );
  ipcMain.handle('mediaHosting:delete', (_event, input) =>
    attempt(() => service(input.projectPath, input.connectionId).remove(input.folder, { entry: input.entry, name: input.name })),
  );
  ipcMain.handle('mediaHosting:reorder', (_event, input) => attempt(() => service(input.projectPath, input.connectionId).reorder(input.folder, input.order)));
  // Files dropped from the system: their paths, read here.
  ipcMain.handle('mediaHosting:upload', (_event, input) =>
    attempt(() => service(input.projectPath, input.connectionId).upload(input.folder, readUploads(input.filePaths))),
  );
  // A replacement keeps the file's key, so its public URL and every link to it stay.
  ipcMain.handle('mediaHosting:replace', (_event, input) =>
    attempt(async () => {
      const target = service(input.projectPath, input.connectionId);
      const picked = await host.showOpenDialog({ title: `Replace ${input.name}`, properties: ['openFile'] });
      const file = picked.filePaths[0];
      if (picked.canceled || file === undefined) {
        return undefined;
      }
      const [upload] = readUploads([file]);
      if (upload === undefined) {
        throw new Error('The chosen file could not be read.');
      }
      return target.replace(input.folder, input.name, upload);
    }),
  );
  // The person picks the files in the system dialog; a cancel is no listing, not a failure.
  ipcMain.handle('mediaHosting:pickUpload', (_event, input) =>
    attempt(async () => {
      const target = service(input.projectPath, input.connectionId);
      const picked = await host.showOpenDialog({ title: 'Upload media', properties: ['openFile', 'multiSelections'] });
      if (picked.canceled || picked.filePaths.length === 0) {
        return undefined;
      }
      return target.upload(input.folder, readUploads(picked.filePaths));
    }),
  );
}

// The public half of a draft, with a placeholder id, to try it before saving.
function publicFields(draft: MediaConnectionDraft): MediaConnection {
  return parseMediaConnection({ ...draft, id: '00000000-0000-4000-8000-000000000000' });
}

function readUploads(filePaths: readonly string[]): readonly UploadFile[] {
  if (filePaths.length > MEDIA_HOSTING_LIMITS.uploadFilesMax) {
    throw new Error(`Upload at most ${MEDIA_HOSTING_LIMITS.uploadFilesMax} files at once.`);
  }
  return filePaths.map((file) => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      throw new Error(`${path.basename(file)} is a folder; upload the files in it.`);
    }
    if (stat.size > MEDIA_HTTP_LIMITS.fileBytesMax) {
      throw new Error(`${path.basename(file)} is larger than ${MEDIA_HTTP_LIMITS.fileBytesMax / 1024 / 1024} MB.`);
    }
    return { name: path.basename(file), bytes: fs.readFileSync(file) };
  });
}

// Expected failures — offline, a revoked key, a missing bucket, a name taken —
// are answers, not crashes: the panel shows them where the person is looking.
async function attempt<T>(run: () => Promise<T>): Promise<MediaResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    return { ok: false, message: messageOf(error) };
  }
}

function attemptSync<T>(run: () => T): MediaResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error: unknown) {
    return { ok: false, message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, failureMessageCharsMax) || 'The media host did not answer.';
}
