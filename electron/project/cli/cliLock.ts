// The CLI's project lock: one CLI or MCP writer at a time per project, in a file the running app ignores.
//
// Why a lock besides the app's per-file locks: a command can change several files, and the app's lock covers one file at a time, so two
// commands (an agent and a script, say) could interleave their files. This lock makes a whole apply one unit between CLI writers. Against a
// running Stacki Desktop or Studio the protection is the per-file lock and byte witness of the document actors, which the CLI writes through
// (cliFiles.ts); the app has no project-wide lock to take, and none is invented here (docs/stacki-cli.md, "Running app").
// The lock is `.stacki/io/cli-project.lock`: created exclusively, naming its owner; stale when its owner is gone or it is older than ten minutes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, ok, type Result } from '../../../shared/core/result';
import { toRecord } from '../../../shared/core/record';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';

export const LOCK_LIMITS = {
  /** A lock older than this is abandoned: an apply holds it for a few file writes. */
  staleMsMax: 600_000,
  /** The longest `--wait` a caller may ask for, in seconds. */
  waitSecondsMax: 120,
  /** Polls of a held lock: one per second up to the wait. */
  pollsMax: 120,
} as const satisfies Record<string, number>;

export interface ProjectLock {
  readonly release: () => void;
}

export function lockFileOf(root: string): string {
  return path.join(root, '.stacki', 'io', 'cli-project.lock');
}

export async function acquireProjectLock(root: string, options: { readonly waitSeconds: number }): Promise<Result<ProjectLock, CliError>> {
  const file = lockFileOf(root);
  const attempts = Math.min(LOCK_LIMITS.pollsMax, Math.max(0, Math.floor(options.waitSeconds))) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const taken = tryTake(file);
    if (taken.ok) {
      return taken;
    }
    if (taken.error.code !== 'locked') {
      return taken;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      return taken;
    }
  }
  return err({ code: 'locked', message: 'The project is locked by another Stacki command.' });
}

function tryTake(file: string): Result<ProjectLock, CliError> {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const descriptor = fs.openSync(file, 'wx', 0o644);
    fs.writeSync(descriptor, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(descriptor);
    return ok({ release: () => fs.rmSync(file, { force: true }) });
  } catch (error: unknown) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') {
      return breakIfStale(file);
    }
    return err({ code: 'write-failed', message: `The project lock could not be taken: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function breakIfStale(file: string): Result<ProjectLock, CliError> {
  const owner = readOwner(file);
  const abandoned = owner === undefined ? true : Date.now() - owner.at > LOCK_LIMITS.staleMsMax || !alive(owner.pid);
  if (!abandoned) {
    return err({ code: 'locked', message: `Another Stacki command (process ${owner?.pid ?? 'unknown'}) holds this project; retry, or pass --wait <seconds>.` });
  }
  fs.rmSync(file, { force: true });
  return tryTake(file);
}

function readOwner(file: string): { readonly pid: number; readonly at: number } | undefined {
  try {
    if (fs.statSync(file).size > 1024) {
      return undefined;
    }
    const text: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = toRecord(text);
    const pid = parsed?.['pid'];
    const at = parsed?.['at'];
    return typeof pid === 'number' && typeof at === 'number' ? { pid, at } : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to someone else: it is alive.
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}
