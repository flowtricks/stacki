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
import { deploymentConfiguration, destinationConfiguration, readDeploymentReceipt } from './publishReceipt';
import type { Destination } from '../../shared/properties/publishDestinations';
import { readPublishDestinations } from './publishDestination';
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
  const [github, hosting, production, destinations] = await Promise.all([
    githubAvailability(root, config).catch(() => ({ github: 'unknown' as const })),
    hostingAvailability(root, config).catch(() => 'unknown' as const),
    readDeploymentReceipt(root).catch(() => undefined),
    // An unreadable destinations file offers no destination rows; the settings say why.
    destinationsAvailability(root, config).catch(() => undefined),
  ]);
  const publishedAtMs = production?.publishedAtMs;
  return {
    ...github,
    hosting,
    ...(publishedAtMs === undefined || hosting === 'unconfigured' ? {} : { hostingPublishedAtMs: publishedAtMs }),
    ...(destinations === undefined || destinations.length === 0 ? {} : { destinations }),
  };
}

/** One status each, from that destination's own record. The files to publish are read at most once for all of them. */
async function destinationsAvailability(root: string, config: PublishConfig): Promise<readonly DestinationStatus[]> {
  const { destinations } = readPublishDestinations(root);
  let tree: ReturnType<typeof readPublishTree> | undefined;
  const readTree = () => (tree ??= readPublishTree(root));
  return Promise.all(
    destinations.map((destination) =>
      destinationAvailability(root, config, destination, readTree).catch(() => ({ id: destination.id, state: 'unknown' as const })),
    ),
  );
}

async function destinationAvailability(
  root: string,
  config: PublishConfig,
  destination: Destination,
  readTree: () => ReturnType<typeof readPublishTree>,
): Promise<DestinationStatus> {
  const { id } = destination;
  const receipt = await readDeploymentReceipt(root, id);
  // A receipt for other settings says nothing about this destination: another target's address is not this one's.
  if (receipt === undefined || receipt.configuration !== destinationConfiguration(config, destination)) {
    return { id, state: 'pending' };
  }
  const last = {
    ...(receipt.publishedAtMs === undefined ? {} : { publishedAtMs: receipt.publishedAtMs }),
    ...(receipt.url === undefined ? {} : { url: receipt.url }),
  };
  const source = await readTree();
  if (!source.ok) {
    return { id, state: 'unknown', ...last };
  }
  return { id, state: receipt.tree === source.value ? 'current' : 'pending', ...last };
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
