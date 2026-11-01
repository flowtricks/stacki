import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../../vendor/stacki/shared/core/assert';

/** Include empty folders so live rename validation agrees with the filesystem. */
export async function projectPageFolders(root: string): Promise<readonly string[]> {
  const folders: string[] = [];
  const pending = [''];
  let visited = 0;
  for (let index = 0; index < pending.length; index++) {
    const relative = pending[index];
    assert(relative !== undefined, 'Page folder queue has a current entry');
    assert(index <= 10_000, 'Page folder traversal stays bounded');
    const directory = await opendir(path.join(root, 'src/pages', relative)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!directory) {
      continue;
    }
    for await (const entry of directory) {
      if (++visited > 100_000) {
        throw new Error('Too many page directory entries.');
      }
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const folder = relative ? relative + '/' + entry.name : entry.name;
      if (folders.length >= 10_000 || folder.split('/').length > 32) {
        throw new Error('Too many page folders or folder levels.');
      }
      folders.push(folder);
      pending.push(folder);
    }
  }
  return folders;
}
