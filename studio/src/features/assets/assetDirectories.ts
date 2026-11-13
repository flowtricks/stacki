import { ReferencedError } from '../../shared/referencedError';
import { readdir } from 'node:fs/promises';
import { safePath } from '../project/projectServer';
import { managedAsset } from './assetStateTypes';

// Validate every directory entry before a move; the generic project scan skips
// hidden files and links, which must never silently disappear with their folder.
export async function assetDirectoryContents(root: string, directory: string) {
  const directories = [directory];
  const files: string[] = [];
  for (let index = 0; index < directories.length; index++) {
    const current = directories[index];
    if (!current || directories.length > 200 || files.length > 200) {
      throw new ReferencedError('assets.error.moveMaxEntries', { count: 200 });
    }
    for (const entry of await readdir(await safePath(root, current), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        throw new ReferencedError('assets.error.folderHidden');
      }
      const file = current + '/' + entry.name;
      if (entry.isDirectory()) {
        directories.push(file);
      } else if (entry.isFile()) {
        files.push(managedAsset(file));
      } else {
        throw new ReferencedError('assets.error.folderUnsupportedEntry');
      }
    }
  }
  return { directories, files };
}
