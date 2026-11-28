// One destination's publish, from checks to record. It shares nothing with production's flow that could write to
// production: it never commits to or pushes the person's branch, runs only this destination's hooks, and keeps its own
// receipt. Progress and the outcome are reported through `show`, as the same states the Publish popup draws.
//
// One publish targets exactly one destination. Settings are read again at the moment anything leaves this computer: if
// the destination, production or a neighbouring destination changed meanwhile, the checks are made against what is
// saved now, and a destination that was itself edited is refused.
import { isDeepStrictEqual } from 'node:util';
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import {
  destinationBranch,
  destinationBuildsLocally,
  findDestination,
  otherDestinations,
  type Destination,
  type DestinationId,
  type PublishDestinations,
} from '../../shared/properties/publishDestinations';
import { destinationConflict } from '../../shared/properties/publishDestinationConflicts';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { parseDesktopPublishProgress, type DesktopPublishState, type PublishedDestination } from '../../shared/properties/publishState';
import { readPublishConfig } from './publishConfig';
import { createPublishSnapshot, createPublishSource, type PublishSource } from './publishSnapshot';
import { publishingGitEnvironment, publishingGitRemote } from './publishGitHub';
import { publishFilesystemFailure, readPublishHead, runPublishGit } from './publishGitCommand';
import type { PublishRepository } from './publishCommit';
import { releasePublishTemporary, type PublishTemporarySeams } from './publishTemporary';
import { destinationConfiguration, recordDeployment } from './publishReceipt';
import {
  checkDestination,
  deployDestination,
  readPublishDestinations,
  runDestinationScripts,
  type DestinationJob,
  type DestinationServices,
} from './publishDestination';
import { checkDestinationBranch, pushDestinationBranch, type DestinationBranchTarget } from './publishDestinationBranch';
import type { DeployLinkStore } from './deployLinkStore';
import { sendDeployRequest, type DeployTransport } from './deployRequest';

type Problem = Pick<AppError, 'message' | 'messageRef'>;
type Part = 'github' | 'hosting';
/** Told as each external step is confirmed, so a later failure still says what already happened. */
type Reached = (part: Part) => void;

export interface DestinationPublish {
  readonly root: string;
  readonly id: DestinationId;
  readonly show: (state: DesktopPublishState) => void;
  readonly temporary: PublishTemporarySeams;
  readonly services: DestinationServices;
  readonly deployLinks: DeployLinkStore | undefined;
  readonly transport: DeployTransport;
}

/** The saved settings a destination publish stands on. */
interface Settings {
  readonly config: PublishConfig;
  readonly destination: Destination;
  readonly others: readonly Destination[];
}

interface Job extends Settings {
  /** Present only for a destination that pushes its branch. */
  readonly branch: { readonly repository: PublishRepository; readonly target: DestinationBranchTarget } | undefined;
}

export async function publishDestinationJob(publish: DestinationPublish): Promise<void> {
  const parts = new Set<Part>();
  const settings = readSettings(publish);
  const named: { readonly destination?: PublishedDestination } = settings.ok ? { destination: published(settings.value.destination) } : {};
  // Every state of this publish says which destination it is about.
  const show = (state: DesktopPublishState) => publish.show(state.kind === 'idle' || state.kind === 'review-open' ? state : { ...state, ...named });
  const labelled: DestinationPublish = { ...publish, show };
  const prepared = settings.ok ? await prepareJob(labelled, settings.value) : settings;
  const outcome = prepared.ok ? await runJob(labelled, prepared.value, (part) => parts.add(part)) : prepared;
  const completed = { github: parts.has('github'), hosting: parts.has('hosting') };
  if (!outcome.ok) {
    const { message, messageRef } = outcome.error;
    show({ kind: 'failed', message, ...(messageRef === undefined ? {} : { messageRef }), ...completed });
    return;
  }
  const { kind } = outcome.value.destination.target;
  const handoff = kind === 'script' ? 'script' : kind === 'link' ? 'link' : kind === 'github-branch' ? 'github' : undefined;
  show({ kind: 'done', ...completed, ...(handoff === undefined ? {} : { handoff }) });
}

export function published(destination: Destination): PublishedDestination {
  return { id: destination.id, label: destination.label };
}

function readSettings(publish: Pick<DestinationPublish, 'root' | 'id'>): Result<Settings, Problem> {
  let config: PublishConfig;
  let saved: PublishDestinations;
  try {
    config = readPublishConfig(publish.root);
    saved = readPublishDestinations(publish.root);
  } catch (error: unknown) {
    return publishFilesystemFailure(error);
  }
  const destination = findDestination(saved, publish.id);
  if (destination === undefined) {
    return err(described('publish.destination.error.notSetUp'));
  }
  return ok({ config, destination, others: otherDestinations(saved.destinations, publish.id) });
}

function checkedAt(publish: DestinationPublish, settings: Settings, root: string): DestinationJob {
  const { config, destination, others } = settings;
  return { project: publish.root, root, config, destination, others };
}

/** Everything that can refuse, asked before anything is built, pushed or sent. */
async function prepareJob(publish: DestinationPublish, settings: Settings): Promise<Result<Job, Problem>> {
  const { config, destination } = settings;
  // A project that publishes through review sends nothing out directly, to any destination.
  if (config.githubWorkflow?.kind === 'pull-request') {
    return err(described('publish.destination.error.review'));
  }
  const ready = await checkDestination(checkedAt(publish, settings, publish.root), publish.services).catch(publishFilesystemFailure);
  if (!ready.ok) {
    return ready;
  }
  if (destination.target.kind === 'link') {
    const link = await destinationLink(publish, settings);
    if (!link.ok) {
      return link;
    }
  }
  const name = destinationBranch(destination.target);
  if (name === undefined) {
    return ok({ ...settings, branch: undefined });
  }
  const repository = await destinationRepository(publish.root, config);
  if (!repository.ok) {
    return repository;
  }
  const head = await readPublishHead(publish.root);
  if (!head.ok) {
    return head;
  }
  const production = await productionBranchNames(publish, settings);
  if (!production.ok) {
    return production;
  }
  const target = { branch: name, label: destination.label, productionBranches: production.value };
  const checked = await checkDestinationBranch(publish.root, repository.value, target, head.value);
  return checked.ok ? ok({ ...settings, branch: { repository: repository.value, target } }) : checked;
}

/**
 * Branches a host is known to deploy as production, beyond GitHub's default. A Pages project, production's or another
 * destination's own, is asked for its own: the settings' copy may be out of date. Other hosts' choices are not
 * Stacki's to read.
 */
async function productionBranchNames(publish: DestinationPublish, settings: Settings): Promise<Result<readonly string[], Problem>> {
  const own = settings.others.flatMap((other) =>
    other.target.kind === 'host' && other.target.hosting.provider === 'cloudflare' ? [other.target.hosting] : [],
  );
  const { hosting } = settings.config;
  const projects = [...(hosting.provider === 'cloudflare' ? [hosting] : []), ...own];
  const names: string[] = [];
  for (const project of projects) {
    try {
      names.push(project.branch, (await publish.services.pagesProject(publish.root, project)).productionBranch);
    } catch {
      return err(described('publish.destination.error.pagesUnconfirmed', { label: settings.destination.label }));
    }
  }
  return ok(names);
}

async function destinationRepository(root: string, config: PublishConfig): Promise<Result<PublishRepository, Problem>> {
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

async function destinationLink(publish: DestinationPublish, settings: Settings): Promise<Result<string, Described>> {
  const store = publish.deployLinks;
  const others = settings.others.map((other) => other.id);
  return store === undefined ? err(described('publish.custom.link.unavailable')) : store.linkToSend(publish.root, publish.id, others);
}

/**
 * The settings as they are saved at the moment something is about to leave this computer. The destination must be the
 * one that was built; production and the other destinations are taken as they are now, and checked against again.
 */
function settingsNow(publish: DestinationPublish, job: Job): Result<Settings, Problem> {
  const now = readSettings(publish);
  if (!now.ok) {
    return now;
  }
  const { destination, config, others } = now.value;
  // Only where production deploys is compared: Stacki itself rewrites other parts of publish.json, such as the site's address.
  const moved = !isDeepStrictEqual(config.hosting, job.config.hosting) || !isDeepStrictEqual(config.customHosting, job.config.customHosting);
  if (moved || !isDeepStrictEqual(destination, job.destination)) {
    return err(described('publish.destination.error.changed', { label: job.destination.label }));
  }
  if (config.githubWorkflow?.kind === 'pull-request') {
    return err(described('publish.destination.error.review'));
  }
  const conflict = destinationConflict(config, destination, others);
  return conflict.ok ? now : conflict;
}

async function runJob(publish: DestinationPublish, job: Job, reached: Reached): Promise<Result<Job, Problem>> {
  const { destination } = job;
  const hooks = destination.beforePublish.length + destination.afterPublish.length > 0;
  // A destination its host builds, with no hooks, runs nothing here: no checkout, no installed dependencies needed.
  const checkout = destinationBuildsLocally(destination.target) || hooks;
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
  publish: DestinationPublish,
  job: Job,
  source: PublishSource,
  directory: string,
  reached: Reached,
): Promise<Result<undefined, Problem>> {
  const { destination } = job;
  const { label } = destination;
  publish.show(running(described('publish.destination.step.building', { label }), 1));
  const build = destinationBuildsLocally(destination.target) ? [destination.buildScript] : [];
  const built = await attempt(() => runDestinationScripts(directory, destination, [...destination.beforePublish, ...build]));
  if (!built.ok) {
    return built;
  }
  if (job.branch !== undefined) {
    const { target, repository } = job.branch;
    assert(destinationBranch(destination.target) === target.branch, 'The pushed branch is the destination’s saved branch');
    publish.show(running(described('publish.destination.step.pushing', { branch: target.branch }), 2));
    const pushed = await pushBranch(publish, job, repository, source);
    if (!pushed.ok) {
      return pushed;
    }
    reached('github');
  }
  const deployed = await deployStep(publish, job, directory);
  if (!deployed.ok) {
    return deployed;
  }
  if (deployed.value.hosting === 'reached') {
    reached('hosting');
  }
  const { url } = deployed.value;
  const recorded = await attempt(() =>
    recordDeployment(
      publish.root,
      {
        version: 1,
        tree: source.tree,
        configuration: destinationConfiguration(job.config, destination),
        publishedAtMs: Date.now(),
        ...(url === undefined ? {} : { url }),
      },
      destination.id,
    ),
  );
  if (!recorded.ok) {
    return recorded;
  }
  publish.show(running(described('publish.status.step.afterScripts'), 4));
  return attempt(() => runDestinationScripts(directory, destination, destination.afterPublish));
}

async function pushBranch(publish: DestinationPublish, job: Job, repository: PublishRepository, source: PublishSource): Promise<Result<undefined, Problem>> {
  const now = settingsNow(publish, job);
  if (!now.ok) {
    return now;
  }
  // The host's production branch is asked again too: the build may have taken minutes.
  const production = await productionBranchNames(publish, now.value);
  if (!production.ok) {
    return production;
  }
  assert(job.branch !== undefined, 'Only a destination with a branch pushes one');
  return pushDestinationBranch(publish.root, repository, { ...job.branch.target, productionBranches: production.value }, source);
}

interface Deployed {
  /** Whether anything beyond a push reached the host. */
  readonly hosting: 'reached' | 'not-asked';
  readonly url?: string;
}

/** The destination's own last step: its deploy link, its provider or its script. A pushed branch needs none. */
async function deployStep(publish: DestinationPublish, job: Job, directory: string): Promise<Result<Deployed, Problem>> {
  const { kind } = job.destination.target;
  if (kind === 'github-branch') {
    return ok({ hosting: 'not-asked' });
  }
  const { label } = job.destination;
  const step =
    kind === 'link'
      ? described('publish.status.step.deployLink')
      : kind === 'script'
        ? described('publish.status.step.deployScript')
        : described('publish.destination.step.deploying', { label });
  publish.show(running(step, 3));
  const now = settingsNow(publish, job);
  if (!now.ok) {
    return now;
  }
  if (kind === 'link') {
    const link = await destinationLink(publish, now.value);
    const sent = link.ok ? await sendDeployRequest(link.value, publish.transport) : link;
    return sent.ok ? ok({ hosting: 'reached' }) : sent;
  }
  const deployed = await deployDestination(checkedAt(publish, now.value, directory), publish.services).then(ok, publishFilesystemFailure);
  return deployed.ok ? ok({ hosting: 'reached', ...deployed.value }) : deployed;
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
