import { rm, realpath } from 'node:fs/promises';
import { submitPublishReview } from './publishReview';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { readPublishConfig } from './publishConfig';
import { ensureToolPath } from '../lib/nodeTools';
import { parsePublishCommitMessage, type PublishConfig, type PublishTarget } from '../../shared/properties/publishConfig';
import { parseDesktopPublishProgress, type DesktopPublishState } from '../../shared/properties/publishState';
import { deployHosting, runPublishScripts } from './publishCommands';
import { createPublishSnapshot, createPublishSource, type PublishSource, type PublishSnapshot } from './publishSnapshot';
import { publishingGitEnvironment, publishingGitRemote, recordPublishedGitHub } from './publishGitHub';
import { deploymentConfiguration, recordDeployment } from './publishReceipt';
import { publishFilesystemFailure, runPublishGit } from './publishGitCommand';
import { checkPublishIncoming, commitPublishSource, requirePublishMessage, type PublishRepository } from './publishCommit';

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
  readonly warning: string | undefined;
}

// One job per desktop process bounds concurrency and prevents overlapping commits and pushes.
export class DesktopPublisher {
  private project = '';
  private current: DesktopPublishState = { kind: 'idle' };

  state(root: string): DesktopPublishState {
    return this.project === root ? this.current : { kind: 'idle' };
  }

  start(root: string, target: PublishTarget, commitMessage?: string): DesktopPublishState {
    if (this.current.kind === 'running') {
      if (this.project === root) {
        return this.current;
      }
      throw new Error('Another project is publishing. Wait for it to finish.');
    }
    const message = commitMessage === undefined ? undefined : parsePublishCommitMessage(commitMessage);
    this.project = root;
    this.current = { kind: 'running', step: 'Preparing publish…' };
    void this.publish(root, target, message);
    return this.current;
  }

  private async publish(root: string, target: PublishTarget, message: string | undefined): Promise<void> {
    ensureToolPath();
    const prepared = await preparePublishJob(root, target, message);
    if (!prepared.ok) {
      this.fail(prepared.error.message, { github: false, hosting: false });
      return;
    }
    const job = prepared.value;
    const captured = job.plan.kind === 'github' ? await createPublishSource(job.root, 'github') : await createPublishSnapshot(job.root);
    if (!captured.ok) {
      this.fail(captured.error.message, { github: false, hosting: false });
      return;
    }
    try {
      if (job.config.githubWorkflow?.kind === 'pull-request') {
        assert(job.plan.repository !== undefined, 'Review submission has a repository');
        const review = await submitPublishReview(job.root, captured.value, job.plan.repository);
        if (review.ok) {
          this.current = { kind: 'review-open', ...review.value };
        } else {
          this.fail(review.error.message, { github: false, hosting: false });
        }
        return;
      }
      if (job.plan.kind === 'github') {
        const pushed = await this.push(job, captured.value, job.plan.repository);
        if (!pushed.ok) {
          this.fail(pushed.error.message, { github: false, hosting: false });
        } else if (pushed.value.warning !== undefined) {
          this.fail(pushed.value.warning, { github: true, hosting: false });
        } else {
          this.current = { kind: 'done', github: true, hosting: false };
        }
      } else {
        assert('root' in captured.value, 'Hosting owns a materialized snapshot');
        assert(typeof captured.value.root === 'string', 'Hosting snapshot has a directory');
        await this.deploy(job, { ...captured.value, root: captured.value.root });
      }
    } finally {
      const cleanup = await rm(captured.value.temporary, { recursive: true, force: true }).then(ok, publishFilesystemFailure);
      if (!cleanup.ok) {
        const completed = this.current;
        assert(completed.kind === 'done' || completed.kind === 'failed' || completed.kind === 'review-open', 'Cleanup follows publishing');
        const message = completed.kind === 'failed' ? `${completed.message} ` : '';
        this.fail(`${message}Temporary publish files could not be removed.`, completed.kind === 'review-open' ? { github: false, hosting: false } : completed);
      }
    }
  }

  private async push(job: PublishJob, source: PublishSource, repository: PublishRepository): Promise<Result<PublishPush>> {
    const message = await requirePublishMessage(job.root, source, job.message);
    if (!message.ok) {
      return message;
    }
    const total = job.plan.kind === 'github' ? 3 : 5;
    this.current = runningState('Checking GitHub for incoming changes…', 1, total);
    const incoming = await checkPublishIncoming(job.root, repository, source.head);
    if (!incoming.ok) {
      return incoming;
    }
    this.current = runningState('Committing and pushing to GitHub…', 2, total);
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
      warning: recorded.ok ? undefined : 'Saved to GitHub, but local push status could not be updated. Refresh Git.',
    });
  }

  private async deploy(job: PublishJob, snapshot: PublishSnapshot): Promise<void> {
    const completed = { github: false, hosting: false };
    const repository = job.plan.repository;
    if (repository !== undefined) {
      const message = await requirePublishMessage(job.root, snapshot, job.message);
      if (!message.ok) {
        this.fail(message.error.message, completed);
        return;
      }
    }
    this.current = runningState('Running hooks and building website…', 1, 5);
    const built = await buildPublishSnapshot(job, snapshot);
    if (!built.ok) {
      this.fail(built.error.message, completed);
      return;
    }
    if (repository !== undefined) {
      const pushed = await this.push(job, snapshot, repository);
      if (!pushed.ok) {
        this.fail(pushed.error.message, completed);
        return;
      }
      completed.github = true;
      if (pushed.value.warning !== undefined) {
        this.fail(pushed.value.warning, completed);
        return;
      }
    }
    this.current = runningState(`Deploying to ${job.config.hosting.provider}…`, 3, 5);
    const deployed = await deployHosting(snapshot.root, job.config).then(ok, publishFilesystemFailure);
    if (!deployed.ok) {
      this.fail(deployed.error.message, completed);
      return;
    }
    completed.hosting = true;
    const recorded = await recordDeployment(job.root, {
      version: 1,
      tree: snapshot.tree,
      configuration: deploymentConfiguration(job.config),
    }).then(ok, publishFilesystemFailure);
    if (!recorded.ok) {
      this.fail(recorded.error.message, completed);
      return;
    }
    this.current = runningState('Running after-publish scripts…', 4, 5);
    const after = await runPublishScripts(snapshot.root, job.config.afterPublish, {
      STACKI_PUBLISH_TARGET: job.target,
    }).then(ok, publishFilesystemFailure);
    if (!after.ok) {
      this.fail(after.error.message, completed);
      return;
    }
    this.current = { kind: 'done', ...completed };
  }

  private fail(message: string, completed: { readonly github: boolean; readonly hosting: boolean }): void {
    this.current = {
      kind: 'failed',
      message,
      github: completed.github,
      hosting: completed.hosting,
    };
  }
}

function runningState(step: string, completed: number, total: number): DesktopPublishState {
  return { kind: 'running', step, progress: parseDesktopPublishProgress({ completed, total }) };
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
        message: 'Submit changes for review and deploy the merged branch ' + 'through your repository workflow.',
      });
    }
    if (config.hosting.provider === 'none') {
      return err({
        code: 'hosting-required',
        message: 'Choose a hosting provider in Publish settings.',
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
  const kind = target === 'github' || config.hosting.provider === 'none' || config.githubWorkflow?.kind === 'pull-request' ? 'github' : 'hosting';
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
    return err({ code: 'detached-head', message: 'Choose a branch before publishing to GitHub.' });
  }
  return ok({ branch: branch.value.trim(), remote: remote.value, environment: environment.value });
}

async function buildPublishSnapshot(job: PublishJob, snapshot: PublishSnapshot): Promise<Result<void>> {
  const before = await runPublishScripts(snapshot.root, job.config.beforePublish, {
    STACKI_PUBLISH_TARGET: job.target,
  }).then(ok, publishFilesystemFailure);
  if (!before.ok) {
    return before;
  }
  return runPublishScripts(snapshot.root, [job.config.buildScript]).then(ok, publishFilesystemFailure);
}
