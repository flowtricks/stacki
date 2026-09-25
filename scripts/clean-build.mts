// A clean output tree prevents removed modules and obsolete renderer bundles
// from entering the next package. Resolve from this script, never the shell cwd.
import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

function repositoryRoot(): string {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    throw new Error('Clean build requires an entry script path.');
  }
  const scriptDirectory = dirname(resolve(entryPath));
  return basename(dirname(scriptDirectory)) === 'dist'
    ? resolve(scriptDirectory, '..', '..')
    : resolve(scriptDirectory, '..');
}

async function main(): Promise<void> {
  await rm(resolve(repositoryRoot(), 'dist'), { recursive: true, force: true });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
