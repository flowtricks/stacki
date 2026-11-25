// Keep save files outside source trees so Astro never scans a disappearing lock
// or temporary file. Staging must share the target's device for atomic renames.
import fs from 'node:fs';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { translateMain } from '../lib/mainLocale';

export const ATOMIC_DIRECTORY = path.join('.stacki', 'io');
const ANCESTORS_MAX = 256;

interface AtomicDirectoryError {
  readonly code: 'filesystem';
  readonly message: string;
}

export function atomicDirectoryOf(file: string): string {
  return path.join(atomicDirectoryRoot(file), ATOMIC_DIRECTORY);
}

/** Validate both levels separately so a linked .stacki cannot redirect staging. */
export function prepareAtomicDirectory(file: string): Result<string, AtomicDirectoryError> {
  const directory = atomicDirectoryOf(file);
  try {
    const device = fs.statSync(path.dirname(file)).dev;
    for (const folder of [path.dirname(directory), directory]) {
      try {
        fs.mkdirSync(folder);
      } catch (error: unknown) {
        if (!prepareAtomicDirectoryExists(error)) {
          return prepareAtomicDirectoryFailure(folder, error);
        }
      }
      const metadata = fs.lstatSync(folder);
      if (!metadata.isDirectory()) {
        return prepareAtomicDirectoryFailure(folder, 'Expected a directory, not a file or link');
      }
      if (metadata.dev !== device) {
        return prepareAtomicDirectoryFailure(folder, 'Must be on the target filesystem');
      }
    }
  } catch (error: unknown) {
    return prepareAtomicDirectoryFailure(directory, error);
  }
  return ok(directory);
}

function atomicDirectoryRoot(file: string): string {
  const parent = path.dirname(path.resolve(file));
  let directory = parent;
  // Resolve from disk, not the active window: cooperating processes must choose
  // the same staging directory. Standalone files use their own parent folder.
  for (let depth = 0; depth < ANCESTORS_MAX; depth += 1) {
    if (path.basename(directory) === '.stacki') {
      return path.dirname(directory);
    }
    if (fs.existsSync(path.join(directory, '.stacki'))) {
      return directory;
    }
    if (fs.existsSync(path.join(directory, 'package.json'))) {
      return directory;
    }
    if (path.basename(directory) === 'node_modules') {
      return parent;
    }
    const ancestor = path.dirname(directory);
    if (ancestor === directory) {
      return parent;
    }
    directory = ancestor;
  }
  return parent;
}

function prepareAtomicDirectoryExists(error: unknown): boolean {
  if (error instanceof Error) {
    if ('code' in error) {
      return error.code === 'EEXIST';
    }
  }
  return false;
}

function prepareAtomicDirectoryFailure(directory: string, error: unknown): Result<never, AtomicDirectoryError> {
  const message = error instanceof Error ? error.message : String(error);
  return err({ code: 'filesystem', message: translateMain('error.documents.prepareFailed', { folder: directory, reason: message }) });
}
