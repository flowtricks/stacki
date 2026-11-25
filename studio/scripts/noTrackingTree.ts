// Reads the tree that noTracking.ts judges. The Desktop launch point lives beside `studio/`:
// this runs from the canonical repository only, since installed releases omit the tests and
// the release script's `release:bundle` command, so a missing file there is a real failure.
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../vendor/stacki/shared/core/assert';
import { NO_TRACKING_FILES_MAX, type NoTrackingInput, type TextFile } from './noTracking';

export type DistributionPolicy = 'required' | 'when-present';

const DIRECTORY_DEPTH_MAX = 20;
const SOURCE_DIRECTORIES = ['adapters', 'scripts', 'src', 'templates', 'vendor'] as const;
const SOURCE_FILES = ['package-lock.json', 'package.json'] as const;
// Source maps repeat the bundles they describe, and the bundles are what actually ship.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.astro', '.cjs', '.css', '.html', '.js', '.json', '.jsonc', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

export async function readNoTrackingInput(studio: string, policy: DistributionPolicy): Promise<NoTrackingInput> {
  assert(path.isAbsolute(studio), 'The no-tracking check reads an absolute Studio directory');
  const read = (file: string) => readFile(path.join(studio, file), 'utf8');
  const source: TextFile[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    await collectTextFiles(studio, directory, source);
  }
  for (const file of SOURCE_FILES) {
    source.push({ path: file, content: await read(file) });
  }
  const sharedSource: unknown = JSON.parse(await read('scripts/shared-source.json'));
  return {
    distribution: await readDistribution(studio, policy),
    launchPoints: {
      containerScript: await read('scripts/container.ts'),
      desktopStudioLaunch: await read('../electron/previewServer/studioLocal.ts'),
      devScript: await read('scripts/dev.ts'),
      dockerfile: await read('Dockerfile'),
      telemetrySource: await read('vendor/stacki/shared/properties/studioTelemetry.ts'),
    },
    sharedSource,
    source,
  };
}

async function readDistribution(studio: string, policy: DistributionPolicy): Promise<readonly TextFile[] | undefined> {
  const present = await lstat(path.join(studio, 'dist')).then(
    (information) => information.isDirectory(),
    () => false,
  );
  if (present) {
    const files: TextFile[] = [];
    await collectTextFiles(studio, 'dist', files);
    return files;
  }
  if (policy === 'required') {
    throw new Error('Studio has no dist directory. Run npm run build before this check.');
  }
  return undefined;
}

async function collectTextFiles(studio: string, directory: string, files: TextFile[]): Promise<void> {
  assert(directory.split('/').length <= DIRECTORY_DEPTH_MAX, 'The no-tracking scan stays within its directory depth');
  const entries = await readdir(path.join(studio, directory), { withFileTypes: true });
  for (const entry of entries) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        await collectTextFiles(studio, file, files);
      }
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      assert(files.length < NO_TRACKING_FILES_MAX, 'The no-tracking scan stays within its file limit');
      files.push({ path: file, content: await readFile(path.join(studio, file), 'utf8') });
    }
  }
}
