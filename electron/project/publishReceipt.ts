import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { count, record, text } from '../../shared/core/boundary';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { git } from '../lib/nodeTools';
import { parseDestinationId, type Destination, type DestinationId } from '../../shared/properties/publishDestinations';
import { parseDeploymentURL } from '../../shared/properties/publishState';

type ReceiptDestination = 'production' | DestinationId;
const RECEIPT_BYTES_MAX = 1024;

export interface DeploymentReceipt {
  readonly version: 1;
  readonly tree: string;
  readonly configuration: string;
  /** When it was published. Absent from receipts older Stacki wrote, which ignores both of these. */
  readonly publishedAtMs?: number;
  /** The address the host's tool printed for this deploy, when it printed one. */
  readonly url?: string;
}

export function deploymentConfiguration(config: PublishConfig): string {
  // Account selection affects GitHub authentication, not the deployed website.
  const { hosting, customHosting, buildScript, beforePublish, afterPublish } = config;
  // A custom host's name and address change nothing deployed. Without one, the digest is what 1.4.21 wrote.
  const custom =
    customHosting === undefined
      ? {}
      : { custom: { deploy: customHosting.deploy, ...(customHosting.deploy === 'script' ? { script: customHosting.script } : {}) } };
  return createHash('sha256')
    .update(JSON.stringify({ hosting, buildScript, beforePublish, afterPublish, ...custom }))
    .digest('hex');
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
  const publishedAtMs = value['publishedAtMs'] === undefined ? undefined : count(value['publishedAtMs']);
  const url = value['url'] === undefined ? undefined : parseDeploymentURL(value['url']);
  return {
    version: 1,
    tree,
    configuration,
    ...(publishedAtMs === undefined ? {} : { publishedAtMs }),
    ...(url === undefined ? {} : { url }),
  };
}

/**
 * Each destination keeps a receipt of its own, so publishing one can never mark another as up to date. Its label and
 * address change nothing deployed. A destination with a project of its own does not depend on production's host.
 */
export function destinationConfiguration(config: PublishConfig, destination: Destination): string {
  const { target, buildScript, beforePublish, afterPublish } = destination;
  const borrowed = target.kind === 'host' ? {} : { hosting: config.hosting };
  return createHash('sha256')
    .update(JSON.stringify({ ...borrowed, target, buildScript, beforePublish, afterPublish }))
    .digest('hex');
}

export async function readDeploymentReceipt(root: string, destination: ReceiptDestination = 'production'): Promise<DeploymentReceipt | undefined> {
  const file = await deploymentReceiptPath(root, destination);
  const stats = await stat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (stats === undefined) {
    return undefined;
  }
  if (stats.size > RECEIPT_BYTES_MAX) {
    throw new Error('Deployment receipt exceeds 1 KiB.');
  }
  const source = await readFile(file, 'utf8');
  if (source.length > RECEIPT_BYTES_MAX) {
    throw new Error('Deployment receipt exceeds 1 KiB.');
  }
  const input: unknown = JSON.parse(source);
  return parseDeploymentReceipt(input);
}

export async function recordDeployment(root: string, receipt: DeploymentReceipt, destination: ReceiptDestination = 'production'): Promise<void> {
  const validated = parseDeploymentReceipt(receipt);
  const file = await deploymentReceiptPath(root, destination);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function deploymentReceiptPath(root: string, destination: ReceiptDestination): Promise<string> {
  // Git's private directory survives app restarts without dirtying the published project.
  const directory = (await git(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  if (!path.isAbsolute(directory)) {
    throw new Error('Git directory must be absolute.');
  }
  // The id names a file, so it is held to the destination id rule here too.
  const name = destination === 'production' ? 'stacki-deployment.json' : `stacki-deployment-${parseDestinationId(destination)}.json`;
  return path.join(directory, name);
}
