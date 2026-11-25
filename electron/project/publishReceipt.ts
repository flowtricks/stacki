import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { record, text } from '../../shared/core/boundary';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { git } from '../lib/nodeTools';

export interface DeploymentReceipt {
  readonly version: 1;
  readonly tree: string;
  readonly configuration: string;
}

export function deploymentConfiguration(config: PublishConfig): string {
  // Account selection affects GitHub authentication, not the deployed website.
  const { hosting, buildScript, beforePublish, afterPublish } = config;
  return createHash('sha256').update(JSON.stringify({ hosting, buildScript, beforePublish, afterPublish })).digest('hex');
}

export function parseDeploymentReceipt(input: unknown): DeploymentReceipt {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported deployment receipt version.');
  }
  const tree = text(value['tree']);
  const configuration = text(value['configuration']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
    throw new Error('Invalid deployment tree.');
  }
  if (!/^[a-f0-9]{64}$/.test(configuration)) {
    throw new Error('Invalid deployment configuration.');
  }
  return { version: 1, tree, configuration };
}

export async function readDeploymentReceipt(root: string): Promise<DeploymentReceipt | undefined> {
  const file = await deploymentReceiptPath(root);
  const stats = await stat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (stats === undefined) {
    return undefined;
  }
  if (stats.size > 1024) {
    throw new Error('Deployment receipt exceeds 1 KiB.');
  }
  const source = await readFile(file, 'utf8');
  if (source.length > 1024) {
    throw new Error('Deployment receipt exceeds 1 KiB.');
  }
  const input: unknown = JSON.parse(source);
  return parseDeploymentReceipt(input);
}

export async function recordDeployment(root: string, receipt: DeploymentReceipt): Promise<void> {
  const validated = parseDeploymentReceipt(receipt);
  const file = await deploymentReceiptPath(root);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function deploymentReceiptPath(root: string): Promise<string> {
  // Git's private directory survives app restarts without dirtying the published project.
  const directory = (await git(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  if (!path.isAbsolute(directory)) {
    throw new Error('Git directory must be absolute.');
  }
  return path.join(directory, 'stacki-deployment.json');
}
