// The asset folders a Studio write may touch. Kept apart from assetStateTypes.ts,
// which the Cloudflare worker also loads: this one reads the project's
// `.stacki/folders.json` from disk, which only the Node server can.
import { filePath } from '../../shared/validation';
import { projectFoldersFor } from '../../../vendor/stacki/electron/lib/projectFolders';
import { folderHolding } from '../../../vendor/stacki/shared/properties/projectFolders';

/**
 * A path the assets panel may write: inside one of the project's asset folders
 * (.stacki/folders.json; by default all of public/ and src/). Desktop's
 * assetAbs holds the same rule, so a folder the project leaves out is
 * read-only in both editors.
 */
export function assetFolderPath(root: string, value: unknown): string {
  const file = filePath(value);
  if (folderHolding(projectFoldersFor(root, 'assets'), file) === undefined) {
    throw new Error(`${file} is not in one of the project's asset folders`);
  }
  return file;
}
