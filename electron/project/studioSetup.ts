// Reuse Studio's release parser and transactional installer for published
// releases, the development checkout's bundle, and explicitly chosen local files.
import * as path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { downloadRelease } from './studioCatalog';
import { parseRelease, releaseVersion, RELEASE_BYTES_MAX, type StudioRelease } from '../../shared/ipc/studioRelease';
import { installNewRelease } from './studioInstall';
import { record } from '../../shared/core/boundary';
import type { StudioStatus } from '../../shared/ipc/studioSetup';
import { run, resolveNodeBin } from '../lib/nodeTools';
import { isWin } from '../lib/mainHelpers';
import type { StudioInstallUpdate } from '../../shared/ipc/studioProgress';
import { runStudioCommand } from './studioCommand';

export type StudioReleaseEnvironment = { readonly kind: 'packaged' } | { readonly kind: 'development'; readonly appPath: string };

export async function automaticStudio(input: string, environment: StudioReleaseEnvironment): Promise<StudioRelease> {
  const version = releaseVersion(input);
  if (environment.kind === 'packaged') {
    return publishedStudio(version);
  }
  // Development versions may not be published. Only the app's own generated
  // bundle is eligible; the open website must never supply executable installer code.
  const file = path.join(environment.appPath, 'studio/release', `stacki-studio-${version}.json`);
  const info = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (!info) {
    throw new Error('Build the development Studio bundle with npm run studio:release, then retry.');
  }
  const release = await readStudioRelease(file);
  if (release.version !== version) {
    throw new Error('Development Studio version does not match Stacki. Run npm run studio:release.');
  }
  return release;
}

export async function studioStatus(project: string, desktopVersion: string): Promise<StudioStatus> {
  const directory = path.join(project, 'studio');
  const existing = await lstat(directory).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (!existing) {
    return { kind: 'missing', desktopVersion };
  }
  if (existing.isDirectory() && !existing.isSymbolicLink()) {
    try {
      const file = path.join(directory, 'src/shared/release.json');
      if ((await lstat(file)).size > 4096) {
        throw new Error('Release metadata exceeds limit');
      }
      const metadata: unknown = JSON.parse(await readFile(file, 'utf8'));
      return {
        kind: 'installed',
        desktopVersion,
        version: releaseVersion(record(metadata)['version']),
      };
    } catch {
      // An unrelated studio directory must never be treated as replaceable.
    }
  }
  return {
    kind: 'blocked',
    desktopVersion,
    message: 'A studio folder already exists. Setup will not overwrite it. Ask your agent to inspect it.',
  };
}

export async function readStudioRelease(file: string): Promise<StudioRelease> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > RELEASE_BYTES_MAX) {
    throw new Error('Choose a Studio release JSON file smaller than 32 MB.');
  }
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  return parseRelease(value);
}

export async function installStudio(project: string, release: StudioRelease, onProgress: (update: StudioInstallUpdate) => void = () => {}): Promise<string> {
  onProgress({ kind: 'stage', stage: 'files' });
  await installNewRelease(path.join(project, 'studio'), release, async (directory, projectRoot) => {
    await validateStudio(directory, projectRoot, onProgress);
    onProgress({ kind: 'stage', stage: 'activate' });
  });
  onProgress({ kind: 'stage', stage: 'complete' });
  return release.version;
}

export async function publishedStudio(version: string): Promise<StudioRelease> {
  try {
    return await downloadRelease(version);
  } catch {
    throw new Error(
      'Could not download Studio ' +
        version +
        '. Check your connection and try again. ' +
        'If the Studio bundle is not published yet, use the agent setup prompt in Go live.',
    );
  }
}

async function validateStudio(directory: string, project: string, onProgress: (update: StudioInstallUpdate) => void): Promise<void> {
  const node = resolveNodeBin();
  if (!node) {
    throw new Error('Install Node.js 22.19 or newer, then reopen Stacki and retry.');
  }
  const result = await run(node, ['--version'], directory);
  const match = /^v(\d+)\.(\d+)\./.exec(result.stdout.trim());
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!(major > 22 || (major === 22 && minor >= 19))) {
    throw new Error('Studio needs Node.js 22.19 or newer. Update Node.js and retry.');
  }
  for (const command of [
    { stage: 'dependencies', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
    { stage: 'check', args: ['run', 'check'] },
    { stage: 'build', args: ['run', 'build'] },
  ] as const) {
    onProgress({ kind: 'stage', stage: command.stage });
    onProgress({ kind: 'output', text: `\n$ npm ${command.args.join(' ')}\n` });
    const outcome = await runStudioCommand(
      {
        command: isWin ? 'npm.cmd' : 'npm',
        argumentsList: command.args,
        directory,
        project,
        timeoutMs: 180_000,
      },
      (text) => onProgress({ kind: 'output', text }),
    );
    if (!outcome.ok) {
      onProgress({ kind: 'output', text: `\n${outcome.error}\n` });
      throw new Error('Studio could not finish npm ' + command.args.join(' ') + '. ' + 'See the output above. Your project was not replaced.');
    }
  }
}
