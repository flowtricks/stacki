import { cp, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { retainedPath, type StudioRelease } from '../../shared/ipc/studioRelease';
import {
  STUDIO_LEGACY_DIRECTORIES,
  STUDIO_LOCAL_DIRECTORY,
  STUDIO_UPDATES_DIRECTORY,
} from '../../shared/properties/studioLocal';

export async function writeRelease(directory: string, release: StudioRelease) {
  for (const file of release.files) {
    const destination = path.join(directory, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: 'wx' });
  }
}
export async function validateInstallation(directory: string, project: string): Promise<void> {
  for (const args of [
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['run', 'check'],
    ['run', 'build'],
  ]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: directory,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, STUDIO_PROJECT_ROOT: project },
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Studio validation failed; the existing installation was retained'));
        }
      });
    });
  }
}

// Only the Studio directory is exchanged. Website source never enters the
// transaction; runtime state is moved, not copied or reset by an update.
export function installRelease(
  target: string,
  release: StudioRelease,
  validate: (directory: string, project: string) => Promise<void> = validateInstallation,
) {
  return installReleaseWithMode(target, release, { mode: 'replace' }, validate);
}

export function installNewRelease(
  target: string,
  release: StudioRelease,
  validate: (directory: string, project: string) => Promise<void> = validateInstallation,
) {
  return installReleaseWithMode(target, release, { mode: 'install' }, validate);
}

async function installReleaseWithMode(
  target: string,
  release: StudioRelease,
  options: { readonly mode: 'install' | 'replace' },
  validate: (directory: string, project: string) => Promise<void>,
) {
  const directory = path.resolve(target);
  if (path.basename(directory) !== 'studio') {
    throw new Error('Updates target a project’s studio directory');
  }
  const metadata = await updateStorage(path.dirname(directory));
  if ((await lstat(metadata)).isSymbolicLink()) {
    throw new Error('Update storage must not be a symlink');
  }
  await writeFile(path.join(metadata, '.gitignore'), '*\n');
  const lock = await open(path.join(metadata, 'update.lock'), 'wx');
  const identifier = `${release.version}-${randomUUID()}`;
  const staging = path.join(metadata, 'staging-' + identifier);
  const backup = path.join(metadata, 'backup-' + identifier);
  try {
    const previous = await lstat(directory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (previous && options.mode === 'install') {
      throw new Error('Studio already exists; setup will not replace it');
    }
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) {
      throw new Error('Studio must be a real directory');
    }
    await mkdir(staging);
    await writeRelease(staging, release);
    if (!previous) {
      await cp(path.join(staging, 'templates/cloudflare'), path.join(staging, 'cloudflare'), {
        recursive: true,
      });
    }
    await validate(staging, path.dirname(directory));
    if (previous) {
      await activate(directory, staging, backup);
    } else {
      await rename(staging, directory);
    }
    return { version: release.version, backup: previous ? backup : undefined };
  } finally {
    // Failed staging directories are retained for inspection and interrupted recovery.
    // In particular, never delete state if a rollback filesystem operation fails.
    await lock.close();
    await rm(path.join(metadata, 'update.lock'), { force: true });
  }
}

async function activate(directory: string, staging: string, backup: string) {
  const preserved = (await readdir(directory)).filter(retainedPath);
  const moved: string[] = [];
  await rename(directory, backup);
  try {
    for (const entry of preserved) {
      await rename(path.join(backup, entry), path.join(staging, entry));
      moved.push(entry);
    }
    await rename(staging, directory);
  } catch (error: unknown) {
    for (const entry of moved.reverse()) {
      await rename(path.join(staging, entry), path.join(backup, entry));
    }
    await rename(backup, directory);
    throw error;
  }
}

// The updater's staging, backups and lock, under `.stacki/studio/`, which
// ignores its own contents. An older site's `.stacki-studio` moves in whole,
// once, so earlier backups stay where recovery looks for them.
async function updateStorage(site: string): Promise<string> {
  const local = path.join(site, STUDIO_LOCAL_DIRECTORY);
  const metadata = path.join(site, STUDIO_UPDATES_DIRECTORY);
  const legacyName = STUDIO_LEGACY_DIRECTORIES[STUDIO_UPDATES_DIRECTORY];
  if (legacyName === undefined || legacyName === '') {
    throw new Error('The older update folder must be named');
  }
  const legacy = path.join(site, legacyName);
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, '.gitignore'), '*\n');
  const moved = await lstat(metadata).catch(() => undefined);
  const older = await lstat(legacy).catch(() => undefined);
  if (!moved && older?.isDirectory()) {
    await rename(legacy, metadata);
  }
  await mkdir(metadata, { recursive: true });
  return metadata;
}
