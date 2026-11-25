import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Docker receives only dependency manifests, never local site drafts or credentials.
export async function prepareSiteCache() {
  const root = path.resolve(process.env['STUDIO_PROJECT_ROOT'] ?? '..');
  const destination = '.studio-image/site';
  await mkdir(destination, { recursive: true });
  try {
    await readFile(path.join(root, 'package-lock.json'));
    await copyFile(path.join(root, 'package.json'), path.join(destination, 'package.json'));
    await copyFile(path.join(root, 'package-lock.json'), path.join(destination, 'package-lock.json'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    await rm(path.join(destination, 'package-lock.json'), { force: true });
    await writeFile(path.join(destination, 'package.json'), '{"private":true}');
  }
}
