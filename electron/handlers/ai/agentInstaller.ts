// Installs one pinned ACP adapter into userData/agents/<agent>-<version>/, on
// the person's request, the way an app bundle is installed
// (electron/project/appStore.ts): everything is built in a staging folder beside
// the final one and renamed into place only once it checks out, so a failed or
// interrupted install leaves the old state, never half of a new one.
//
// What is checked, in order: the shipped lockfile's SHA-256 (agentRegistry.ts);
// every tarball's integrity, by `npm ci` against that lockfile; and the SHA-256
// of the adapter's entry file after the install. Install scripts never run
// (`--ignore-scripts`), and optional dependencies are left out (`--omit=optional`):
// they are the agents' own platform binaries, which the person's installed CLI
// replaces (CLAUDE_CODE_EXECUTABLE, CODEX_PATH).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { AGENTS } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { run } from '../../lib/nodeTools';
import { adapterDirectory, adapterPackageJson, INSTALL_MARKER, readPinnedLock, sha256File, type AdapterSpec } from './agentRegistry';

const STAGING_PREFIX = '.staging-';

/** Runs npm in a folder; injectable so tests install from a local fixture instead of the registry. */
export type NpmRunner = (directory: string, args: readonly string[], environment: Readonly<Record<string, string | undefined>>) => Promise<void>;

export const runNpm: NpmRunner = async (directory, args, environment) => {
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, directory, {
    timeout: AI_LIMITS.installMsMax,
    env: { ...environment },
  });
};

export async function installAdapter(
  userData: string,
  spec: AdapterSpec,
  environment: Readonly<Record<string, string | undefined>>,
  npm: NpmRunner = runNpm,
): Promise<Result<string, string>> {
  const label = AGENTS[spec.agent].label;
  const target = adapterDirectory(userData, spec);
  let lock: Buffer;
  try {
    lock = readPinnedLock(spec);
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
  const staging = path.join(path.dirname(target), `${STAGING_PREFIX}${spec.agent}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), adapterPackageJson(spec), { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'package-lock.json'), lock, { flag: 'wx' });
    await npm(staging, ['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], environment);
    const entry = path.join(staging, ...spec.entry.split('/'));
    const digest = sha256File(entry);
    if (digest !== spec.entrySha256) {
      return err(`The downloaded ${label} adapter does not match the version Stacki pins; nothing was installed.`);
    }
    fs.writeFileSync(path.join(staging, INSTALL_MARKER), `${JSON.stringify({ version: spec.version, entrySha256: digest })}\n`, { flag: 'wx' });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (error: unknown) {
    return err(`Installing the ${label} adapter failed: ${installFailure(error)}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const installed = path.join(target, ...spec.entry.split('/'));
  assert(sha256File(installed) === spec.entrySha256, 'installAdapter: the entry reads back as the checked bytes');
  assert(fs.existsSync(path.join(target, INSTALL_MARKER)), 'installAdapter: the marker is in place');
  return ok(installed);
}

function installFailure(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? error : undefined;
  const stderr = record !== undefined && 'stderr' in record && typeof record.stderr === 'string' ? record.stderr : '';
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim() === '' ? message : stderr.trim();
  return detail.slice(-Math.floor(AI_LIMITS.labelCharsMax / 4));
}
