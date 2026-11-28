import { deploysFromStacki, type PublishConfig } from '../../shared/properties/publishConfig';
import {
  UNKNOWN_PUBLISH_AVAILABILITY,
  parseGitHubPush,
  type DestinationStatus,
  type PublishAvailability,
  type PublishDestinationState,
} from '../../shared/properties/publishState';
import { ensureToolPath, git } from '../lib/nodeTools';
import { readPublishConfig } from './publishConfig';
import { publishingGitRemote } from './publishGitHub';
import { deploymentConfiguration, readDeploymentReceipt, stagingConfiguration } from './publishReceipt';
import { stagingDestination } from '../../shared/properties/publishDestinations';
import { readPublishDestinations } from './publishStaging';
import { readPublishTree } from './publishSnapshot';

export async function readPublishAvailability(root: string): Promise<PublishAvailability> {
  await ensureToolPath();
  let config: PublishConfig;
  try {
    config = readPublishConfig(root);
  } catch {
    // Invalid or unreadable settings must remain actionable through the setup dialog.
    return UNKNOWN_PUBLISH_AVAILABILITY;
  }
  const [github, hosting, production, staging] = await Promise.all([
    githubAvailability(root, config).catch(() => ({ github: 'unknown' as const })),
    hostingAvailability(root, config).catch(() => 'unknown' as const),
    readDeploymentReceipt(root).catch(() => undefined),
    stagingAvailability(root, config).catch(() => ({ state: 'unknown' as const })),
  ]);
  const publishedAtMs = production?.publishedAtMs;
  return {
    ...github,
    hosting,
    ...(publishedAtMs === undefined || hosting === 'unconfigured' ? {} : { hostingPublishedAtMs: publishedAtMs }),
    ...(staging === undefined ? {} : { staging }),
  };
}

async function stagingAvailability(root: string, config: PublishConfig): Promise<DestinationStatus | undefined> {
  const staging = stagingDestination(readPublishDestinations(root));
  if (staging === undefined) {
    return undefined;
  }
  const receipt = await readDeploymentReceipt(root, 'staging');
  if (receipt === undefined) {
    return { state: 'pending' };
  }
  const last = {
    ...(receipt.publishedAtMs === undefined ? {} : { publishedAtMs: receipt.publishedAtMs }),
    ...(receipt.url === undefined ? {} : { url: receipt.url }),
  };
  if (receipt.configuration !== stagingConfiguration(config, staging)) {
    // Another destination's address is not this one's.
    return { state: 'pending' };
  }
  const source = await readPublishTree(root);
  if (!source.ok) {
    return { state: 'unknown', ...last };
  }
  return { state: receipt.tree === source.value ? 'current' : 'pending', ...last };
}

async function githubAvailability(root: string, config: PublishConfig): Promise<Pick<PublishAvailability, 'github' | 'githubPush'>> {
  const remoteUrl = await publishingGitRemote(root, config);
  const branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
    .then((result) => result.stdout.trim())
    .catch(() => undefined);
  const remote = await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
    .then((result) => result.stdout.trim())
    .catch(() => undefined);
  const count = head === undefined ? '0' : (await git(root, ['rev-list', '--count', remote === undefined ? head : `${remote}..${head}`])).stdout.trim();
  const headTree = head === undefined ? undefined : (await git(root, ['rev-parse', `${head}^{tree}`])).stdout.trim();
  // Publish stages the complete worktree, so staged-only differences must not add a
  // phantom commit. Its isolated index compares exactly the snapshot Publish will use.
  const source = await readPublishTree(root);
  if (!source.ok) {
    return { github: 'unknown' };
  }
  const dirty = headTree !== source.value;
  const githubPush = parseGitHubPush({
    commits: Number(count) + (dirty ? 1 : 0),
    repositoryUrl: remoteUrl.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, ''),
  });
  return { github: !dirty && head === remote ? 'current' : 'pending', githubPush };
}

async function hostingAvailability(root: string, config: PublishConfig): Promise<PublishDestinationState> {
  if (!deploysFromStacki(config)) {
    return 'unconfigured';
  }
  const receipt = await readDeploymentReceipt(root);
  if (receipt === undefined) {
    return 'pending';
  }
  if (receipt.configuration !== deploymentConfiguration(config)) {
    return 'pending';
  }
  // Compare the actual deploy input, including uncommitted and untracked files.
  // A hosting-only deployment need not create a Git commit to become current.
  const source = await readPublishTree(root);
  if (!source.ok) {
    return 'unknown';
  }
  return receipt.tree === source.value ? 'current' : 'pending';
}
