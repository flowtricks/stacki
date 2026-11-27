import { realpath } from 'node:fs/promises';
import { submitPublishReview } from './publishReview';
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { readPublishConfig } from './publishConfig';
import { ensureToolPath } from '../lib/nodeTools';
import { deploysFromStacki, parsePublishCommitMessage, type CustomDeploy, type PublishConfig, type PublishTarget } from '../../shared/properties/publishConfig';
import type { DeployLinkStore } from './deployLinkStore';
import type { PublishRequestTarget } from '../../shared/properties/publishDestinations';
import { STAGING_SERVICES, type StagingServices } from './publishStaging';
import { publishStagingJob } from './publisherStaging';
import { DEPLOY_TRANSPORT, sendDeployRequest, type DeployTransport } from './deployRequest';
import { parseDesktopPublishProgress, type DesktopPublishState } from '../../shared/properties/publishState';
import { checkHostingReady, deployHosting, runPublishScripts } from './publishCommands';
import { createPublishSnapshot, createPublishSource, type PublishSource, type PublishSnapshot } from './publishSnapshot';
import { publishingGitEnvironment, publishingGitRemote, recordPublishedGitHub } from './publishGitHub';
import { deploymentConfiguration, recordDeployment } from './publishReceipt';
import { PUBLISH_TEMPORARY_SEAMS, releasePublishTemporary, sweepPublishTemporaries, type PublishTemporarySeams } from './publishTemporary';
import { publishFilesystemFailure, runPublishGit } from './publishGitCommand';
import { checkPublishIncoming, commitPublishSource, requirePublishMessage, type PublishRepository } from './publishCommit';
import { translateMain } from '../lib/mainLocale';

type PublishPlan =
  { readonly kind: 'github'; readonly repository: PublishRepository } | { readonly kind: 'hosting'; readonly repository: PublishRepository | undefined };

interface PublishJob {
  readonly root: string;
  readonly config: PublishConfig;
  readonly target: PublishTarget;
  readonly plan: PublishPlan;
  readonly message: string | undefined;
}

interface PublishPush {
  readonly warning: Described | undefined;
}

// One job per desktop process bounds concurrency and prevents overlapping commits and pushes.
export class DesktopPublisher {
  private project = '';
  private current: DesktopPublishState = { kind: 'idle' };

  private readonly deployLinks: DeployLinkSender;
  private readonly stagingServices: StagingServices;
  /** The running job's custom host, if it has one, so every outcome says what was only handed over. */
  private custom: CustomDeploy | undefined;

  // The seams let a test make directory removal fail the way Windows does, without a real lock, and stand in
  // for the network a deploy link is sent over.
  constructor(
    private readonly temporary: PublishTemporarySeams = PUBLISH_TEMPORARY_SEAMS,
    options: { readonly deployLinks?: DeployLinkStore; readonly transport?: DeployTransport; readonly staging?: StagingServices } = {},
  ) {
    this.deployLinks = { store: options.deployLinks, transport: options.transport ?? DEPLOY_TRANSPORT };
    this.stagingServices = options.staging ?? STAGING_SERVICES;
  }

  state(root: string): DesktopPublishState {
    return this.project === root ? this.current : { kind: 'idle' };
  }

  start(root: string, target: PublishRequestTarget, commitMessage?: string): DesktopPublishState {
    if (this.current.kind === 'running') {
      if (this.project === root) {
        return this.current;
      }
      throw new Error(translateMain('error.publish.anotherRunning'));
    }
    const message = commitMessage === undefined ? undefined : parsePublishCommitMessage(commitMessage);
    this.project = root;
    this.custom = undefined;
    const preparing = described('error.publish.preparing');
    this.current = { kind: 'running', step: preparing.message, stepRef: preparing.messageRef };
    if (target === 'staging') {
      // A flow of its own: nothing production's publish does (a commit, a push of this branch) can happen here.
      void this.publishStaging(root);
    } else {
      void this.publish(root, target, message);
    }
    return this.current;
  }

  private async publishStaging(root: string): Promise<void> {
    ensureToolPath();
    await sweepPublishTemporaries(this.temporary);
    const canonical = await realpath(root).then(ok, publishFilesystemFailure);
    if (!canonical.ok) {
      this.fail(canonical.error, { github: false, hosting: false });
      return;
    }
    await publishStagingJob({
      root: canonical.value,
      show: (state) => {
        this.current = state;
      },
      temporary: this.temporary,
      services: this.stagingServices,
      deployLinks: this.deployLinks.store,
      transport: this.deployLinks.transport,
    });
  }

  private async publish(root: string, target: PublishTarget, message: string | undefined): Promise<void> {
    ensureToolPath();
    // Leftovers from earlier publishes whose cleanup was blocked; bounded and never failing.
    await sweepPublishTemporaries(this.temporary);
    const prepared = await preparePublishJob(root, target, message);
    if (!prepared.ok) {
      this.fail(prepared.error, { github: false, hosting: false });
      return;
    }
    const job = prepared.value;
    this.custom = job.config.customHosting?.deploy;
    if (job.plan.kind === 'hosting') {
      // Before any build or push: a site that cannot deploy says so now, and the dialog can offer to set it up.
      const ready = await this.checkReady(job);
      if (!ready.ok) {
        this.fail(ready.error, { github: false, hosting: false });
        return;
      }
    }
    // A deploy link with no hooks runs nothing here, so it needs no checkout and no installed dependencies.
    const checkout = job.plan.kind === 'hosting' && needsCheckout(job.config);
    const captured = checkout ? await createPublishSnapshot(job.root) : await createPublishSource(job.root, 'github');
    if (!captured.ok) {
      this.fail(captured.error, { github: false, hosting: false });
      return;
    }
    try {
      if (job.config.githubWorkflow?.kind === 'pull-request') {
        assert(job.plan.repository !== undefined, 'Review submission has a repository');
        const review = await submitPublishReview(job.root, captured.value, job.plan.repository);
        if (review.ok) {
          this.current = { kind: 'review-open', ...review.value };
        } else {
          this.fail(review.error, { github: false, hosting: false });
        }
        return;
      }
      if (job.plan.kind === 'github') {
        const pushed = await this.push(job, captured.value, job.plan.repository);
        if (!pushed.ok) {
          this.fail(pushed.error, { github: false, hosting: false });
        } else if (pushed.value.warning !== undefined) {
          this.fail(pushed.value.warning, { github: true, hosting: false });
        } else {
          this.current = { kind: 'done', github: true, hosting: false, ...this.handoff({ hosting: false }) };
        }
      } else if (checkout) {
        assert('root' in captured.value, 'Hosting owns a materialized snapshot');
        assert(typeof captured.value.root === 'string', 'Hosting snapshot has a directory');
        await this.deploy(job, { ...captured.value, root: captured.value.root });
      } else {
        await this.deploy(job, { ...captured.value, root: job.root });
      }
    } finally {
      // Housekeeping after the outcome is decided: a directory that will not go is logged and swept, never reported as a failed publish.
      await releasePublishTemporary(captured.value.temporary, this.temporary);
    }
  }

  private async checkReady(job: PublishJob): Promise<Result<void, Described>> {
    if (job.config.customHosting?.deploy !== 'link') {
      return checkHostingReady(job.root, job.config);
    }
    const link = await this.deployLink(job.root);
    return link.ok ? ok(undefined) : link;
  }

  private async deployLink(root: string): Promise<Result<string, Described>> {
    const store = this.deployLinks.store;
    return store === undefined ? err(described('publish.custom.link.unavailable')) : store.linkToSend(root);
  }

  /** The destination's own step: its provider's tool, the chosen script, or one request to the deploy link. */
  private async runDeployment(job: PublishJob, root: string): Promise<Result<unknown, Pick<AppError, 'message' | 'messageRef'>>> {
    if (job.config.customHosting?.deploy !== 'link') {
      return deployHosting(root, job.config, productionEnvironment(job.target)).then(ok, publishFilesystemFailure);
    }
    // Read again at the moment of sending: the repository may have been reconnected while the push ran.
    const link = await this.deployLink(job.root);
    return link.ok ? sendDeployRequest(link.value, this.deployLinks.transport) : link;
  }

  private handoff(completed: { readonly hosting: boolean }): { readonly handoff?: CustomDeploy } {
    if (this.custom === undefined) {
      return {};
    }
    return { handoff: completed.hosting ? this.custom : 'github' };
  }

  private async push(job: PublishJob, source: PublishSource, repository: PublishRepository): Promise<Result<PublishPush>> {
    const message = await requirePublishMessage(job.root, source, job.message);
    if (!message.ok) {
      return message;
    }
    const total = job.plan.kind === 'github' ? 3 : 5;
    this.current = runningState(described('publish.status.step.checkingIncoming'), 1, total);
    const incoming = await checkPublishIncoming(job.root, repository, source.head);
    if (!incoming.ok) {
      return incoming;
    }
    this.current = runningState(described('publish.status.step.committingAndPushing'), 2, total);
    const committed = await commitPublishSource(job.root, source, repository.branch, job.message);
    if (!committed.ok) {
      return committed;
    }
    const pushed = await runPublishGit(job.root, ['push', repository.remote, `${committed.value}:refs/heads/${repository.branch}`], {
      env: repository.environment,
      timeout: 120_000,
    });
    if (!pushed.ok) {
      return pushed;
    }
    // A bookkeeping failure must not pretend the external push failed or retry that push.
    const recorded = await recordPublishedGitHub(job.root, repository.branch, committed.value).then(ok, publishFilesystemFailure);
    return ok({
      warning: recorded.ok ? undefined : described('error.publish.localStatusStale'),
    });
  }

  private async deploy(job: PublishJob, snapshot: PublishSnapshot): Promise<void> {
    const completed = { github: false, hosting: false };
    const repository = job.plan.repository;
    if (repository !== undefined) {
      const message = await requirePublishMessage(job.root, snapshot, job.message);
      if (!message.ok) {
        this.fail(message.error, completed);
        return;
      }
    }
    this.current = runningState(buildStep(job.config), 1, 5);
    const built = await buildPublishSnapshot(job, snapshot);
    if (!built.ok) {
      this.fail(built.error, completed);
      return;
    }
    if (repository !== undefined) {
      const pushed = await this.push(job, snapshot, repository);
      if (!pushed.ok) {
        this.fail(pushed.error, completed);
        return;
      }
      completed.github = true;
      if (pushed.value.warning !== undefined) {
        this.fail(pushed.value.warning, completed);
        return;
      }
    }
    this.current = runningState(deployStep(job.config), 3, 5);
    const deployed = await this.runDeployment(job, snapshot.root);
    if (!deployed.ok) {
      this.fail(deployed.error, completed);
      return;
    }
    completed.hosting = true;
    const push = completed.github ? 'pushed' : 'not-pushed';
    const recorded = await recordCompletedDeployment(job, snapshot, push).then(ok, publishFilesystemFailure);
    if (!recorded.ok) {
      this.fail(recorded.error, completed);
      return;
    }
    this.current = runningState(described('publish.status.step.afterScripts'), 4, 5);
    const after = await runPublishScripts(snapshot.root, job.config.afterPublish, productionEnvironment(job.target)).then(ok, publishFilesystemFailure);
    if (!after.ok) {
      this.fail(after.error, completed);
      return;
    }
    this.current = { kind: 'done', ...completed, ...this.handoff(completed) };
  }

  private fail(problem: Pick<AppError, 'message' | 'messageRef'>, completed: { readonly github: boolean; readonly hosting: boolean }): void {
    this.current = {
      kind: 'failed',
      message: problem.message,
      ...(problem.messageRef === undefined ? {} : { messageRef: problem.messageRef }),
      github: completed.github,
      hosting: completed.hosting,
      ...this.handoff(completed),
    };
  }
}

interface DeployLinkSender {
  /** Absent where nothing keeps links; a deploy link publish then refuses before doing anything. */
  readonly store: DeployLinkStore | undefined;
  readonly transport: DeployTransport;
}

function needsCheckout(config: PublishConfig): boolean {
  if (config.customHosting?.deploy !== 'link') {
    return true;
  }
  return config.beforePublish.length > 0 || config.afterPublish.length > 0;
}

function buildStep(config: PublishConfig): Described {
  return described(config.customHosting?.deploy === 'link' ? 'publish.status.preparing' : 'publish.status.step.runningHooks');
}

function deployStep(config: PublishConfig): Described {
  switch (config.customHosting?.deploy) {
    case 'script':
      return described('publish.status.step.deployScript');
    case 'link':
      return described('publish.status.step.deployLink');
    case 'github':
    case undefined:
      return described('publish.status.step.deployingTo', { provider: config.hosting.provider });
  }
}

/**
 * Remembers what the destination now has. A deploy link's host builds what is on GitHub, not what is on this
 * computer, so a request sent without a push is recorded only when GitHub already holds exactly these files.
 */
async function recordCompletedDeployment(job: PublishJob, source: PublishSource, push: 'pushed' | 'not-pushed'): Promise<void> {
  if (job.config.customHosting?.deploy === 'link' && push === 'not-pushed') {
    if ((await publishedTree(job.root)) !== source.tree) {
      return;
    }
  }
  await recordDeployment(job.root, { version: 1, tree: source.tree, configuration: deploymentConfiguration(job.config) });
}

/** The files on this branch as GitHub last had them, from the tracking ref availability reads too. */
async function publishedTree(root: string): Promise<string | undefined> {
  const branch = await runPublishGit(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch.ok) {
    return undefined;
  }
  const tree = await runPublishGit(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch.value.trim()}^{tree}`]);
  return tree.ok ? tree.value.trim() : undefined;
}

function productionEnvironment(target: PublishTarget): Readonly<Record<string, string>> {
  return { STACKI_PUBLISH_TARGET: target, STACKI_PUBLISH_ENV: 'production' };
}

function runningState(step: Described, completed: number, total: number): DesktopPublishState {
  return {
    kind: 'running',
    step: step.message,
    ...(step.messageRef === undefined ? {} : { stepRef: step.messageRef }),
    progress: parseDesktopPublishProgress({ completed, total }),
  };
}

async function preparePublishJob(root: string, target: PublishTarget, message: string | undefined): Promise<Result<PublishJob>> {
  const canonical = await realpath(root).then(ok, publishFilesystemFailure);
  if (!canonical.ok) {
    return canonical;
  }
  // Settings are untrusted file input; parser failures belong to this boundary.
  let config: PublishConfig;
  try {
    config = readPublishConfig(canonical.value);
  } catch (error: unknown) {
    return publishFilesystemFailure(error);
  }
  if (target === 'hosting') {
    if (config.githubWorkflow?.kind === 'pull-request') {
      return err({
        code: 'review-required',
        ...described('error.publish.reviewHint'),
      });
    }
    if (!deploysFromStacki(config)) {
      return err({
        code: 'hosting-required',
        ...described(config.customHosting === undefined ? 'error.publish.chooseHosting' : 'publish.custom.autoDeploy'),
      });
    }
    return ok({
      root: canonical.value,
      target,
      config,
      message,
      plan: { kind: 'hosting', repository: undefined },
    });
  }
  const repository = await preparePublishRepository(canonical.value, config);
  if (!repository.ok) {
    return repository;
  }
  const kind = target === 'github' || !deploysFromStacki(config) || config.githubWorkflow?.kind === 'pull-request' ? 'github' : 'hosting';
  return ok({
    root: canonical.value,
    target,
    config,
    message,
    plan: { kind, repository: repository.value },
  });
}

async function preparePublishRepository(root: string, config: PublishConfig): Promise<Result<PublishRepository>> {
  const remote = await publishingGitRemote(root, config).then(ok, publishFilesystemFailure);
  if (!remote.ok) {
    return remote;
  }
  const environment = await publishingGitEnvironment(root, config).then(ok, publishFilesystemFailure);
  if (!environment.ok) {
    return environment;
  }
  const branch = await runPublishGit(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch.ok) {
    return err({ code: 'detached-head', ...described('error.publish.chooseBranch') });
  }
  return ok({ branch: branch.value.trim(), remote: remote.value, environment: environment.value });
}

async function buildPublishSnapshot(job: PublishJob, snapshot: PublishSnapshot): Promise<Result<void>> {
  const before = await runPublishScripts(snapshot.root, job.config.beforePublish, productionEnvironment(job.target)).then(ok, publishFilesystemFailure);
  if (!before.ok) {
    return before;
  }
  // The host behind a deploy link does its own build from GitHub.
  if (job.config.customHosting?.deploy === 'link') {
    return ok(undefined);
  }
  return runPublishScripts(snapshot.root, [job.config.buildScript], { STACKI_PUBLISH_ENV: 'production' }).then(ok, publishFilesystemFailure);
}
