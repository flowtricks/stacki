import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { parseConfigFileTextToJson } from 'typescript';
import { record, text } from '../../shared/core/boundary';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import { WORKER_SETUP_NEEDED_KEY } from '../../shared/properties/publishWorkerSetup';
import { publishToolInstalled } from './publishExecutable';

const CONFIG_BYTES_MAX = 65_536;

/** The Wrangler config files a site may author, in the order Wrangler itself looks for them. */
export const WORKER_CONFIG_NAMES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;

export interface WorkerReadinessSeams {
  /** Whether the deploy tool can run for this site; a test fakes it so a tool on the machine's PATH cannot decide the outcome. */
  readonly toolInstalled: (root: string) => boolean;
}

export const WORKER_READINESS_SEAMS: WorkerReadinessSeams = { toolInstalled: (root) => publishToolInstalled(root, 'wrangler') };

export interface WorkerConfig {
  readonly filename: string;
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * Whether a site can deploy to Cloudflare Workers right now: the one check Publish runs before it builds and Add Worker
 * runs after it sets a site up, so the two can never disagree. Call after ensureToolPath(), as publishToolInstalled asks.
 */
export async function checkWorkerReady(root: string, seams: WorkerReadinessSeams = WORKER_READINESS_SEAMS): Promise<Result<WorkerConfig, Described>> {
  const config = await readWorkerConfig(root);
  if (!config.ok) {
    return config;
  }
  if (seams.toolInstalled(root)) {
    return config;
  }
  return err(described(WORKER_SETUP_NEEDED_KEY));
}

/**
 * The site's Worker config, when it names what to deploy: a Worker script (`main`) or a static assets folder. A build may
 * redirect to a generated config (.wrangler/deploy/config.json), which wins, as it does for Wrangler. Deploy reads the
 * snapshot through this too, so a config that passed before the build is read the same way after it.
 */
export async function readWorkerConfig(root: string): Promise<Result<WorkerConfig, Described>> {
  let filename: string | undefined;
  let source: string | undefined;
  try {
    filename = await workerConfigPath(root);
    source = filename === undefined ? undefined : await workerConfigSource(root, filename);
  } catch (failure: unknown) {
    // Size, escape and parse refusals are expected answers about the site; anything else is a fault and stays thrown.
    if (failure instanceof DescribedError) {
      return err(failure.problem);
    }
    throw failure;
  }
  if (filename === undefined || source === undefined) {
    return err(described(WORKER_SETUP_NEEDED_KEY));
  }
  let value: Record<string, unknown>;
  try {
    value = workerConfigParse(filename, source);
  } catch (failure: unknown) {
    if (failure instanceof DescribedError) {
      return err(failure.problem);
    }
    throw failure;
  }
  if (workerDeployTarget(value)) {
    return ok({ filename, value });
  }
  return err(described(WORKER_SETUP_NEEDED_KEY));
}

/** The config the site's author wrote, never a build's generated one. Absent when the site has none. */
export async function readAuthoredWorkerConfig(root: string): Promise<WorkerConfig | undefined> {
  for (const name of WORKER_CONFIG_NAMES) {
    const filename = path.join(root, name);
    const source = await workerConfigSource(root, filename);
    if (source !== undefined) {
      return { filename, value: workerConfigParse(filename, source) };
    }
  }
  return undefined;
}

/** A Worker config deploys something only when it names a script or a static assets folder. */
export function workerDeployTarget(value: Readonly<Record<string, unknown>>): boolean {
  const main = value['main'];
  if (typeof main === 'string') {
    if (main.length > 0) {
      return true;
    }
  }
  const assets = value['assets'];
  if (typeof assets === 'object' && assets !== null) {
    const directory = record(assets)['directory'];
    if (typeof directory === 'string') {
      return directory.length > 0;
    }
  }
  return false;
}

/** A sibling config preserves asset paths while overriding Wrangler's account precedence. */
export async function withWorkerAccount(root: string, accountId: string, deploy: (configuration: string) => Promise<void>): Promise<void> {
  assert(accountId.length > 0, 'Worker deployment has a selected account');
  assert(accountId.length <= 100, 'Worker account identifier stays bounded');
  const config = await readWorkerConfig(root);
  if (!config.ok) {
    throw new DescribedError(config.error);
  }
  const { filename, value } = config.value;
  await withTemporaryWorkerConfig(filename, { ...value, account_id: accountId }, deploy);
}

/** Never rewrites the authored or generated config: the deploy reads a sibling copy, which is always removed. */
export async function withTemporaryWorkerConfig<T>(
  filename: string,
  value: Readonly<Record<string, unknown>>,
  deploy: (configuration: string) => Promise<T>,
): Promise<T> {
  const temporary = path.join(path.dirname(filename), `.stacki-worker-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    return await deploy(temporary);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function workerConfigPath(root: string): Promise<string | undefined> {
  const redirect = path.join(root, '.wrangler/deploy/config.json');
  const source = await workerConfigSource(root, redirect);
  if (source !== undefined) {
    const value = workerConfigParse(redirect, source);
    const relative = text(value['configPath']);
    if (relative.length === 0 || relative.length > 4096) {
      throw new Error('Invalid generated Wrangler configuration path.');
    }
    return path.resolve(path.dirname(redirect), relative);
  }
  for (const name of WORKER_CONFIG_NAMES) {
    const filename = path.join(root, name);
    if ((await workerConfigSource(root, filename)) !== undefined) {
      return filename;
    }
  }
  return undefined;
}

async function workerConfigSource(root: string, filename: string): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(filename);
  } catch (failure: unknown) {
    if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT') {
      return undefined;
    }
    throw failure;
  }
  const relative = path.relative(await realpath(root), canonical);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new DescribedError(described('publish.worker.error.configOutside'));
  }
  const metadata = await stat(canonical);
  if (metadata.size > CONFIG_BYTES_MAX) {
    throw new DescribedError(described('publish.worker.error.configTooLarge'));
  }
  const source = await readFile(canonical, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > CONFIG_BYTES_MAX) {
    throw new DescribedError(described('publish.worker.error.configTooLarge'));
  }
  return source;
}

export function workerConfigParse(filename: string, source: string): Record<string, unknown> {
  if (filename.endsWith('.toml')) {
    return record(parseTOML(source));
  }
  // TypeScript diagnostics require slash-normalized paths, including on Windows.
  const parsed = parseConfigFileTextToJson(filename.replaceAll('\\', '/'), source);
  if (parsed.error) {
    throw new DescribedError(described('publish.worker.error.configUnreadable'));
  }
  return record(parsed.config);
}
