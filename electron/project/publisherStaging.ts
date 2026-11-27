// One staging publish, from checks to record. It shares nothing with production's flow that could write to
// production: it never commits to or pushes the person's branch, runs only staging's own hooks, and keeps its own
// receipt. Progress and the outcome are reported through `show`, as the same states the Publish popup draws.
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { stagingBranchOf, stagingBuildsLocally, stagingDestination, type Destination } from '../../shared/properties/publishDestinations';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { parseDesktopPublishProgress, type DesktopPublishState } from '../../shared/properties/publishState';
import { readPublishConfig } from './publishConfig';
import { createPublishSnapshot, createPublishSource, type PublishSource } from './publishSnapshot';
import { publishingGitEnvironment, publishingGitRemote } from './publishGitHub';
import { publishFilesystemFailure, readPublishHead, runPublishGit } from './publishGitCommand';
import type { PublishRepository } from './publishCommit';
import { releasePublishTemporary, type PublishTemporarySeams } from './publishTemporary';
import { recordDeployment, stagingConfiguration } from './publishReceipt';
import { checkStagingDestination, deployStaging, readPublishDestinations, runStagingScripts, type StagingServices } from './publishStaging';
import { checkStagingBranch, pushStagingBranch } from './publishStagingBranch';
import type { DeployLinkStore } from './deployLinkStore';
import { sendDeployRequest, type DeployTransport } from './deployRequest';

type Problem = Pick<AppError, 'message' | 'messageRef'>;
type Part = 'github' | 'hosting';
/** Told as each external step is confirmed, so a later failure still says what already happened. */
type Reached = (part: Part) => void;

export interface StagingPublish {
  readonly root: string;
  readonly show: (state: DesktopPublishState) => void;
  readonly temporary: PublishTemporarySeams;
  readonly services: StagingServices;
  readonly deployLinks: DeployLinkStore | undefined;
  readonly transport: DeployTransport;
}

interface StagingJob {
  readonly config: PublishConfig;
  readonly staging: Destination;
  /** Present only for a destination that pushes its staging branch. */
  readonly branch: { readonly name: string; readonly repository: PublishRepository; readonly productionBranches: readonly string[] } | undefined;
}

export async function publishStagingJob(publish: StagingPublish): Promise<void> {
  const parts = new Set<Part>();
  const prepared = await prepareStagingJob(publish);
  const outcome = prepared.ok ? await runStagingJob(publish, prepared.value, (part) => parts.add(part)) : prepared;
  const completed = { github: parts.has('github'), hosting: parts.has('hosting') };
  if (!outcome.ok) {
    const { message, messageRef } = outcome.error;
    publish.show({ kind: 'failed', message, ...(messageRef === undefined ? {} : { messageRef }), ...completed, destination: 'staging' });
    return;
  }
  const { kind } = outcome.value.staging.target;
  const handoff = kind === 'script' ? 'script' : kind === 'link' ? 'link' : kind === 'github-branch' ? 'github' : undefined;
  publish.show({ kind: 'done', ...completed, destination: 'staging', ...(handoff === undefined ? {} : { handoff }) });
}

/** Everything that can refuse, asked before anything is built, pushed or sent. */
async function prepareStagingJob(publish: StagingPublish): Promise<Result<StagingJob, Problem>> {
  let config: PublishConfig;
  let staging: Destination | undefined;
  try {
    config = readPublishConfig(publish.root);
    staging = stagingDestination(readPublishDestinations(publish.root));
  } catch (error: unknown) {
    return publishFilesystemFailure(error);
  }
  if (staging === undefined) {
    return err(described('publish.staging.error.notSetUp'));
  }
  // A project that publishes through review sends nothing out directly, staging included.
  if (config.githubWorkflow?.kind === 'pull-request') {
    return err(described('publish.staging.error.review'));
  }
  const ready = await checkStagingDestination(publish.root, config, staging, publish.services).catch(publishFilesystemFailure);
  if (!ready.ok) {
    return ready;
  }
  if (staging.target.kind === 'link') {
    const link = await stagingLink(publish);
    if (!link.ok) {
      return link;
    }
  }
  const name = stagingBranchOf(staging.target);
  if (name === undefined) {
    return ok({ config, staging, branch: undefined });
  }
  const repository = await stagingRepository(publish.root, config);
  if (!repository.ok) {
    return repository;
  }
  const head = await readPublishHead(publish.root);
  if (!head.ok) {
    return head;
  }
  const production = await productionBranchNames(publish, config);
  if (!production.ok) {
    return production;
  }
  const productionBranches = production.value;
  const checked = await checkStagingBranch(publish.root, repository.value, name, head.value, productionBranches);
  return checked.ok ? ok({ config, staging, branch: { name, repository: repository.value, productionBranches } }) : checked;
}

/**
 * Branches the host is known to deploy as production, beyond GitHub's default. A Pages project is asked for its own:
 * the settings' copy may be out of date. Other hosts' choices are not Stacki's to read.
 */
async function productionBranchNames(publish: StagingPublish, config: PublishConfig): Promise<Result<readonly string[], Problem>> {
  if (config.hosting.provider !== 'cloudflare') {
    return ok([]);
  }
  try {
    const actual = await publish.services.pagesProductionBranch(publish.root, config.hosting);
    return ok([config.hosting.branch, actual]);
  } catch {
    return err(described('publish.staging.error.pagesUnconfirmed'));
  }
}

async function stagingRepository(root: string, config: PublishConfig): Promise<Result<PublishRepository, Problem>> {
  try {
    const remote = await publishingGitRemote(root, config);
    const environment = await publishingGitEnvironment(root, config);
    const branch = await runPublishGit(root, ['symbolic-ref', '--short', 'HEAD']);
    if (!branch.ok) {
      return err(described('error.publish.chooseBranch'));
    }
    return ok({ remote, environment, branch: branch.value.trim() });
  } catch (error: unknown) {
    return publishFilesystemFailure(error);
  }
}

async function stagingLink(publish: StagingPublish): Promise<Result<string, Described>> {
  const store = publish.deployLinks;
  return store === undefined ? err(described('publish.custom.link.unavailable')) : store.linkToSend(publish.root, 'staging');
}

async function runStagingJob(publish: StagingPublish, job: StagingJob, reached: Reached): Promise<Result<StagingJob, Problem>> {
  const { staging } = job;
  const hooks = staging.beforePublish.length + staging.afterPublish.length > 0;
  // A destination its host builds, with no hooks, runs nothing here: no checkout, no installed dependencies needed.
  const checkout = stagingBuildsLocally(staging.target.kind) || hooks;
  const captured = checkout ? await createPublishSnapshot(publish.root) : await createPublishSource(publish.root, 'github');
  if (!captured.ok) {
    return captured;
  }
  const source = captured.value;
  const directory = 'root' in source && typeof source.root === 'string' ? source.root : publish.root;
  try {
    const outcome = await publishCaptured(publish, job, source, directory, reached);
    return outcome.ok ? ok(job) : outcome;
  } finally {
    await releasePublishTemporary(source.temporary, publish.temporary);
  }
}

async function publishCaptured(
  publish: StagingPublish,
  job: StagingJob,
  source: PublishSource,
  directory: string,
  reached: Reached,
): Promise<Result<undefined, Problem>> {
  const { staging } = job;
  publish.show(running(described('publish.staging.step.building'), 1));
  const build = stagingBuildsLocally(staging.target.kind) ? [staging.buildScript] : [];
  const built = await attempt(() => runStagingScripts(directory, staging, [...staging.beforePublish, ...build]));
  if (!built.ok) {
    return built;
  }
  let url: string | undefined;
  if (job.branch !== undefined) {
    assert(stagingBranchOf(staging.target) === job.branch.name, 'The pushed branch is the saved staging branch');
    publish.show(running(described('publish.staging.step.pushing', { branch: job.branch.name }), 2));
    const pushed = await pushStagingBranch(publish.root, job.branch.repository, job.branch.name, source, job.branch.productionBranches);
    if (!pushed.ok) {
      return pushed;
    }
    reached('github');
  }
  if (staging.target.kind === 'link') {
    publish.show(running(described('publish.status.step.deployLink'), 3));
    const link = await stagingLink(publish);
    const sent = link.ok ? await sendDeployRequest(link.value, publish.transport) : link;
    if (!sent.ok) {
      return sent;
    }
    reached('hosting');
  } else if (staging.target.kind !== 'github-branch') {
    publish.show(running(described(staging.target.kind === 'script' ? 'publish.status.step.deployScript' : 'publish.staging.step.deploying'), 3));
    const deployed = await deployStaging(directory, job.config, staging, publish.services).then(ok, publishFilesystemFailure);
    if (!deployed.ok) {
      return deployed;
    }
    url = deployed.value.url;
    reached('hosting');
  }
  const recorded = await attempt(() =>
    recordDeployment(
      publish.root,
      {
        version: 1,
        tree: source.tree,
        configuration: stagingConfiguration(job.config, staging),
        publishedAtMs: Date.now(),
        ...(url === undefined ? {} : { url }),
      },
      'staging',
    ),
  );
  if (!recorded.ok) {
    return recorded;
  }
  publish.show(running(described('publish.status.step.afterScripts'), 4));
  return attempt(() => runStagingScripts(directory, staging, staging.afterPublish));
}

async function attempt(work: () => Promise<void>): Promise<Result<undefined, Problem>> {
  return work().then(() => ok(undefined), publishFilesystemFailure);
}

function running(step: Described, completed: number): DesktopPublishState {
  return {
    kind: 'running',
    step: step.message,
    ...(step.messageRef === undefined ? {} : { stepRef: step.messageRef }),
    progress: parseDesktopPublishProgress({ completed, total: 5 }),
  };
}
