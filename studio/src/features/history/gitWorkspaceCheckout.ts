import { gitWorkspaceTree } from './gitWorkspaceTree';
import { isStudioLocalPath } from '../../../vendor/stacki/shared/properties/studioLocal';
import { mkdir, mkdtemp, rm, rename, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { published } from '../publishing/publishFailure';
import { publishTreeFiles } from '../publishing/publishSource';
import { publishInventory } from '../publishing/publishInventory';
import { sourceRoots } from '../publishing/publishSource';
import type { PublishGit } from '../publishing/publishGit';
import { gitWorkspaceRun } from './gitWorkspaceObjects';

/** Validate and stage every file before changing the visible shared checkout. */
export async function prepareGitWorkspaceCheckout(git: PublishGit, before: string, target: string) {
  const previous = await gitWorkspaceTree(gitWorkspaceRun(git), before);
  const files = published(await publishTreeFiles(git, target, { symbolicLinks: 'skip' }));
  const inventory = published(
    await publishInventory(git.root, await sourceRoots(git.root), 8 * 1024 ** 3),
  );
  const destinations = files.filter((file) => checkoutFile(file.path));
  const present = new Set(destinations.map((file) => file.path));
  const removed = [...new Set([...previous.map((file) => file.path), ...inventory.files])].filter(
    (file) => checkoutFile(file) && !present.has(file),
  );
  for (const file of [...removed, ...destinations.map((entry) => entry.path)]) {
    await checkoutPath(git.root, file);
    await checkoutPath(git.root, file + '.studio-tmp');
  }
  const temporary = await mkdtemp(path.join(git.root, '.stacki/studio/state/checkout-'));
  const run = gitWorkspaceRun({ ...git, root: temporary });
  try {
    await run(['read-tree', target]);
    await run(
      ['checkout-index', '--stdin', '-z'],
      destinations.map((file) => file.path + '\0').join(''),
    );
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    dispose: () => rm(temporary, { recursive: true, force: true }),
    apply: async () => {
      for (const file of removed) {
        await rm(await checkoutPath(git.root, file), { force: true });
      }
      for (const file of destinations) {
        const destination = await checkoutPath(git.root, file.path);
        await checkoutPath(git.root, file.path + '.studio-tmp');
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(temporary, file.path), destination + '.studio-tmp');
        await rename(destination + '.studio-tmp', destination);
      }
    },
  };
}
function checkoutFile(file: string): boolean {
  return (
    !file
      .split('/')
      .some((part) => ['.git', 'node_modules', '.astro', 'dist', '.studio'].includes(part)) &&
    !isStudioLocalPath(file) &&
    file !== 'studio' &&
    !file.startsWith('studio/') &&
    !file.startsWith('.stacki/preview/') &&
    !file.startsWith('.stacki/canvas/') &&
    !/^astro\.studio\.config\./.test(file) &&
    !/^wrangler\./.test(file)
  );
}

async function checkoutPath(root: string, file: string): Promise<string> {
  const parts = file.split('/');
  if (
    file.length > 1024 ||
    parts.length > 100 ||
    file.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid Git checkout path.');
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('Git checkout cannot replace or traverse symbolic links.');
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
  return path.join(root, file);
}
