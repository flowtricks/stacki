// Reads and writes the sign-in variables in a project's `studio/cloudflare/wrangler.jsonc`. The text
// edit itself is shared with `npm create stacki` (shared/ipc/studioAuthConfigFile.ts), so Desktop and
// the command line write byte-identical files. This layer only does the file work: a bounded read of
// a regular file, and an atomic replace so a crash never leaves half a config.
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { STUDIO_CONFIG_BYTES_MAX, applyStudioAuth, readStudioSignIn, type StudioAuthExisting } from '../../shared/ipc/studioAuthConfigFile';
import type { StudioAuthConfig, StudioSignIn } from '../../shared/ipc/studioAuth';
import { err, ok, type Result } from '../../shared/core/result';

export type StudioAuthWriteProblem = 'missing' | 'unreadable' | 'alreadySet';

export function wranglerConfigPath(studioDirectory: string): string {
  return path.join(studioDirectory, 'cloudflare', 'wrangler.jsonc');
}

async function readConfig(file: string): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > STUDIO_CONFIG_BYTES_MAX) {
    return undefined;
  }
  return readFile(file, 'utf8');
}

/** What the project's file says today. A file that is absent means Studio's default, GitHub. */
export async function readStudioSignInFile(studioDirectory: string): Promise<StudioSignIn> {
  const text = await readConfig(wranglerConfigPath(studioDirectory));
  if (text === undefined) {
    return 'github';
  }
  const read = readStudioSignIn(text);
  return read.ok ? read.value : 'custom';
}

/**
 * Write the choice into the file. `existing: 'refuse'` is for a fresh installation, where an AUTH_PROVIDER
 * already present is the owner's; `'replace'` is the explicit "Change sign-in type" action.
 */
export async function writeStudioSignInFile(
  studioDirectory: string,
  config: StudioAuthConfig,
  existing: StudioAuthExisting,
): Promise<Result<StudioSignIn, StudioAuthWriteProblem>> {
  const file = wranglerConfigPath(studioDirectory);
  const text = await readConfig(file);
  if (text === undefined) {
    return err('missing');
  }
  const edited = applyStudioAuth(text, config, existing);
  if (!edited.ok) {
    return err(edited.error.kind === 'alreadySet' ? 'alreadySet' : 'unreadable');
  }
  if (edited.value !== text) {
    const temporary = `${file}.stacki-${process.pid}`;
    await writeFile(temporary, edited.value, { flag: 'w' });
    await rename(temporary, file);
  }
  return ok(config.kind);
}
