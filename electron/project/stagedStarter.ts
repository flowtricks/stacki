import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import type { CreatePackageManager } from '../../shared/properties/packageManager';
import { MAIN_LIMITS } from '../lib/mainLimits';
import type { runCreateCommand } from './starter';

export type Log = (chunk: string) => void;
export type CommandRunner = typeof runCreateCommand;

export const STAGED_COMMAND_OPTIONS = { waitForStop: true, outputBytesMax: MAIN_LIMITS.commandOutputBytesMax } as const;

export const STARTER_LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
} as const satisfies Record<CreatePackageManager, string>;

const FOREIGN_LOCKFILES = ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'] as const;
const GENERATED_ROOT_ENTRIES_MAX = 64;
const GENERATED_CONFIG_BYTES_MAX = 16_384;
const MANAGER_VERSION_TIMEOUT_MS = 60_000;

class PublicationRecoveryError extends Error {}

export async function withStarterStage<T>(parent: string, starter: 'heroui' | 'shadcn', onLog: Log, create: (staging: string) => Promise<T>): Promise<T> {
  const staging = await fs.promises.mkdtemp(path.join(parent, `.stacki-${starter}-`));
  let preserveStage = false;
  try {
    return await create(staging);
  } catch (error: unknown) {
    preserveStage = error instanceof PublicationRecoveryError;
    throw error;
  } finally {
    if (!preserveStage) {
      try {
        await fs.promises.rm(staging, { recursive: true, force: true });
      } catch (error: unknown) {
        onLog(`\nCould not clean up ${staging}. ${errorMessage(error)}\n`);
      }
    }
  }
}

export function refuseExistingDestination(destination: string): void {
  const entry = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (entry !== undefined) {
    throw new Error(`${path.basename(destination)} already exists in that folder.`);
  }
}

export function publishGeneratedSite(directory: string, destination: string): void {
  const names = fs.readdirSync(directory);
  assert(names.includes('package.json'), 'A generated project must have a package manifest before publication');
  assert(names.includes('.git'), 'A generated project must have Git history before publication');
  if (names.length > GENERATED_ROOT_ENTRIES_MAX) {
    throw new Error('The generated project exceeds its root entry limit.');
  }
  // Exclusive mkdir claims the name on each platform. Renaming entries on the
  // same volume preserves installed symlinks and avoids recopying node_modules.
  try {
    fs.mkdirSync(destination);
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'EEXIST') {
      throw new Error(`${path.basename(destination)} already exists in that folder.`);
    }
    throw error;
  }
  const claim = fs.lstatSync(destination);
  let movedCount = 0;
  try {
    for (const name of names) {
      confirmDirectoryClaim(destination, claim);
      refuseExistingDestination(path.join(destination, name));
      fs.renameSync(path.join(directory, name), path.join(destination, name));
      movedCount += 1;
    }
    confirmDirectoryClaim(destination, claim);
  } catch (error: unknown) {
    try {
      confirmDirectoryClaim(destination, claim);
      for (const name of names.slice(0, movedCount).reverse()) {
        confirmDirectoryClaim(destination, claim);
        refuseExistingDestination(path.join(directory, name));
        fs.renameSync(path.join(destination, name), path.join(directory, name));
      }
      // Only remove the directory if nothing external was written into it.
      fs.rmdirSync(destination);
    } catch (rollback: unknown) {
      throw new PublicationRecoveryError(
        `Could not publish ${destination}. ${errorMessage(error)} Could not undo publication. ${errorMessage(rollback)} The files remain in ${directory} and ${destination}.`,
      );
    }
    throw error;
  }
}

function confirmDirectoryClaim(destination: string, claim: fs.Stats): void {
  const current = fs.lstatSync(destination);
  if (!current.isDirectory() || current.dev !== claim.dev || current.ino !== claim.ino) {
    throw new Error(`The destination changed during publication: ${destination}.`);
  }
}

export function managerCommand(manager: CreatePackageManager): string {
  return process.platform === 'win32' ? `${manager}.cmd` : manager;
}

export async function readManagerVersion(manager: CreatePackageManager, run: CommandRunner): Promise<string> {
  const output = await run(managerCommand(manager), ['--version'], os.tmpdir(), undefined, {
    ...STAGED_COMMAND_OPTIONS,
    timeoutMs: MANAGER_VERSION_TIMEOUT_MS,
    stdoutOnly: true,
  });
  const version = output.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Could not determine the installed ${manager} version.`);
  }
  return version;
}

export async function stagingEnvironment(staging: string, manager: CreatePackageManager): Promise<NodeJS.ProcessEnv> {
  const scratch = path.join(staging, '.scratch');
  await fs.promises.mkdir(scratch);
  return {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    // Let the already selected tool run without consulting an ancestor's pin.
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: scratch,
    ...(manager === 'npm' ? { npm_config_workspaces: 'false' } : {}),
  };
}

export function confirmPackageManager(directory: string, manager: CreatePackageManager, starter: string): void {
  const lockfile = STARTER_LOCKFILES[manager];
  const expected = fs.lstatSync(path.join(directory, lockfile), { throwIfNoEntry: false });
  if (expected?.isFile() !== true || expected.size === 0) {
    throw new Error(`${starter} did not install the website with ${manager}.`);
  }
  for (const filename of [...Object.values(STARTER_LOCKFILES), ...FOREIGN_LOCKFILES]) {
    if (filename !== lockfile) {
      if (fs.lstatSync(path.join(directory, filename), { throwIfNoEntry: false }) !== undefined) {
        throw new Error(`${starter} wrote ${filename} while installing with ${manager}.`);
      }
    }
  }
}

export async function readGeneratedJSON(filename: string): Promise<unknown> {
  const file = await fs.promises.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(GENERATED_CONFIG_BYTES_MAX + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) {
      throw new Error(`The generated ${path.basename(filename)} exceeds its size limit.`);
    }
    const data: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    return data;
  } finally {
    await file.close();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
