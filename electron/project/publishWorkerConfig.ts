import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { parseConfigFileTextToJson } from 'typescript';
import { record, text } from '../../shared/core/boundary';
import { assert } from '../../shared/core/assert';

const CONFIG_BYTES_MAX = 65_536;

/** A sibling config preserves asset paths while overriding Wrangler's account precedence. */
export async function withWorkerAccount(root: string, accountId: string, deploy: (configuration: string) => Promise<void>): Promise<void> {
  assert(accountId.length > 0, 'Worker deployment has a selected account');
  assert(accountId.length <= 100, 'Worker account identifier stays bounded');
  const filename = await workerConfigPath(root);
  const source = await workerConfigSource(root, filename);
  if (source === undefined) {
    throw new Error('Configure this project for Cloudflare Workers before publishing.');
  }
  const value = workerConfigParse(filename, source);
  const temporary = path.join(path.dirname(filename), `.stacki-worker-${randomUUID()}.json`);
  // Never rewrite the authored or generated config; deploy's temporary sibling is always removed.
  await writeFile(temporary, JSON.stringify({ ...value, account_id: accountId }), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await deploy(temporary);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function workerConfigPath(root: string): Promise<string> {
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
  for (const name of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
    const filename = path.join(root, name);
    if ((await workerConfigSource(root, filename)) !== undefined) {
      return filename;
    }
  }
  throw new Error('Configure this project for Cloudflare Workers before publishing.');
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
    throw new Error('Wrangler configuration must stay inside the publish snapshot.');
  }
  const metadata = await stat(canonical);
  if (metadata.size > CONFIG_BYTES_MAX) {
    throw new Error('Wrangler configuration exceeds 64 KiB.');
  }
  const source = await readFile(canonical, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > CONFIG_BYTES_MAX) {
    throw new Error('Wrangler configuration exceeds 64 KiB.');
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
    throw new Error('Cannot read Wrangler configuration.');
  }
  return record(parsed.config);
}
