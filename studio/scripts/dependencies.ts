import { readFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function linkImageDependencies(root: string, cached = '/opt/site') {
  try {
    const [site, image] = await Promise.all([readFile(path.join(root, 'package-lock.json')), readFile(path.join(cached, 'package-lock.json'))]);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    if (digest(site) !== digest(image)) {
      return false;
    }
    await symlink(path.join(cached, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
