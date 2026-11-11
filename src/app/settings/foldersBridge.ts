// The Folders tab's transport: `.stacki/folders.json` through the same metadata
// read and write every other project settings file uses (projectMetadataBridge),
// so saves are witnessed against the bytes the tab read, and the system folder
// dialog, whose answer is parsed here before the tab sees it.
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { record, text } from '../../../shared/core/boundary';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { isUnknownKind } from '../../ipc/projectFolderSettings';

export { isUnknownKind };
import { readProjectFoldersSource, serializeProjectFolders, type ProjectFolders, type ProjectFoldersRead } from '../../../shared/properties/projectFolders';

export interface FoldersFile {
  /** The bytes read, the base the next save is checked against; undefined when the file does not exist. */
  readonly source: string | undefined;
  readonly read: ProjectFoldersRead;
}

export type FolderPick =
  { readonly kind: 'canceled' } | { readonly kind: 'picked'; readonly path: string } | { readonly kind: 'outside'; readonly message: string };

/** What the host answered: the file, or that it predates folder settings and cannot store them. */
export type FoldersLoad = { readonly kind: 'file'; readonly file: FoldersFile } | { readonly kind: 'unsupported' };

export async function readFoldersFile(projectPath: string): Promise<FoldersLoad> {
  let file;
  try {
    file = await readMetadata(projectPath, 'folders');
  } catch (failure: unknown) {
    if (isUnknownKind(failure)) {
      return { kind: 'unsupported' };
    }
    throw failure;
  }
  return { kind: 'file', file: { source: file.source, read: readProjectFoldersSource(file.source) } };
}

/** Writes `config` over the bytes the tab read; a newer edit elsewhere makes this throw rather than be overwritten. */
export async function saveFoldersFile(projectPath: string, base: string | undefined, config: ProjectFolders): Promise<FoldersFile> {
  const source = serializeProjectFolders(config);
  const saved = await writeMetadata(projectPath, base === undefined ? { kind: 'folders', source } : { kind: 'folders', source, base });
  return { source: saved.source, read: readProjectFoldersSource(saved.source) };
}

/** Opens the system dialog on the project for a folder, or for one file with `target: 'file'`. */
export async function pickProjectPath(projectPath: string, target?: 'file'): Promise<FolderPick> {
  const payload = parseIpcPayload('project:pickFolder', target === undefined ? { projectPath } : { projectPath, target });
  return parseFolderPick(await window.avb.pickProjectFolder(payload));
}

export function parseFolderPick(input: unknown): FolderPick {
  const value = record(input);
  const kind = value['kind'];
  if (kind === 'canceled') {
    return { kind };
  }
  if (kind === 'picked') {
    return { kind, path: text(value['path']) };
  }
  if (kind === 'outside') {
    return { kind, message: text(value['message']) };
  }
  throw new Error('Folder pick: unknown answer');
}
