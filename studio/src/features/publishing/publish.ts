import {
  parsePublishSource,
  type PublishConfig,
  type PublishTarget,
} from '../../../vendor/stacki/shared/properties/publishConfig';
import {
  deployHosting,
  runPublishScripts,
} from '../../../vendor/stacki/electron/project/publishCommands';
import { readMetadataSource } from '../settings/projectMetadata';
import { deploymentFromEnvironment } from './deployment';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubRepository, type RepositoryAccess } from '../github/github';
import { RemoteRepository } from '../github/remoteRepository';
import { ok } from '../../../vendor/stacki/shared/core/result';
import type { PublishReceipt } from '../github/nativePublish';
import { NativeRepository } from '../github/nativeRepository';
import { capturePublishSource, type PublishedFile } from './publishSource';
import { createHostingSnapshot } from './publishHostingSnapshot';
import { published, publishFailure, PublishFailure } from './publishFailure';
import { record, string } from '../../shared/validation';
import { SerialQueue } from '../../shared/serialQueue';
import type { ReviewReceipt } from '../../../vendor/stacki/shared/properties/publishReview';

export type PublishStage = 'preparing' | 'building' | 'committing' | 'cleanup' | 'deploying';
export type PublishState =
  | ({ readonly kind: 'review-open'; readonly id: string } & ReviewReceipt)
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'building';
      readonly id: string;
      readonly stage?: PublishStage;
      readonly deployment?: 'pending';
    }
  | {
      readonly kind: 'committed';
      readonly id: string;
      readonly sha: string;
      readonly url: string;
      readonly cleanupWarning?: string;
      readonly github?: 'skipped';
      readonly deployment?: 'live' | 'pending';
    }
  | { readonly kind: 'failed'; readonly id: string; readonly message: string };
export class Publisher {
  private current: PublishState = { kind: 'idle' };
  private readonly listeners = new Set<(state: PublishState) => void>();
  get state() {
    return this.current;
  }
  set state(state: PublishState) {
    this.current = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
  subscribe(listener: (state: PublishState) => void) {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
  private running = false;
  constructor(
    readonly root: string,
    readonly github: RepositoryAccess | undefined,
    readonly coordinator = new SerialQueue(),
    readonly build: (root: string) => Promise<void> = runBuild,
    readonly cleanup?: (
      files: readonly PublishedFile[],
      sha: string,
    ) => Promise<{ readonly warning?: string }>,
    readonly deploy:
      ((sha: string) => Promise<'live' | 'pending'>) | undefined = deploymentFromEnvironment(),
    readonly refresh?: () => Promise<unknown>,
  ) {}
  start(target: PublishTarget = 'all'): PublishState {
    if (!this.github && target !== 'hosting') {
      throw new Error('Configure the GitHub App and repository before publishing.');
    }
    if (!this.running) {
      // Respond before building. The browser polls this job instead of holding
      // one request open through a build, GitHub commit, and storage cleanup.
      void this.publish(target).catch((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    }
    return this.state;
  }
  async publish(target: PublishTarget = 'all') {
    if (!this.github && target !== 'hosting') {
      throw new Error('Configure the GitHub App and repository before publishing.');
    }
    if (this.running) {
      throw new Error('A publish is already running');
    }
    this.running = true;
    const id = randomUUID();
    const progress = {
      kind: 'building' as const,
      id,
      ...(this.deploy ? { deployment: 'pending' as const } : {}),
    };
    this.state = { ...progress, stage: 'preparing' };
    const temporary = path.join(tmpdir(), 'astro-studio-publish-' + id);
    const snapshot = path.join(temporary, 'site');
    let savedToGitHub = false;
    try {
      const config = published(
        await readMetadataSource(this.root, 'publish')
          .then((stored) => parsePublishSource(stored.source))
          .then(ok, publishFailure),
      );
      if (config.githubWorkflow?.kind === 'pull-request') {
        if (target === 'hosting') {
          throw new PublishFailure(
            'Submit changes for review and deploy the merged branch through your repository workflow.',
          );
        }
        return await this.submitReview(temporary, progress);
      }
      if (target === 'hosting') {
        return await this.publishHosting(snapshot, progress, config);
      }
      const { files, result } = await this.buildAndCommit(snapshot, progress, config, target);
      savedToGitHub = true;
      return await this.completePublish(snapshot, progress, config, target, files, result);
    } catch (error) {
      if (!(error instanceof PublishFailure)) {
        throw error;
      }
      this.state = {
        kind: 'failed',
        id,
        message:
          (savedToGitHub ? 'Saved to GitHub. Remaining publish steps failed: ' : '') +
          (error instanceof Error ? error.message : 'Publish failed'),
      };
      return this.state;
    } finally {
      this.running = false;
      const cleanup = await rm(temporary, { recursive: true, force: true }).then(
        ok,
        publishFailure,
      );
      if (!cleanup.ok) {
        console.error('Publish temporary directory cleanup failed.');
      }
    }
  }
  private async completePublish(
    snapshot: string,
    progress: Extract<PublishState, { kind: 'building' }>,
    config: PublishConfig,
    target: PublishTarget,
    files: readonly PublishedFile[],
    result: PublishReceipt,
  ): Promise<PublishState> {
    this.state = { ...progress, stage: 'cleanup' };
    if (this.github) {
      published(await this.github.acceptBase(result.sha).then(ok, publishFailure));
    }
    published(
      await writeFile(
        path.join(this.root, '.studio-state/github-base.json'),
        JSON.stringify({ sha: result.sha }),
      ).then(ok, publishFailure),
    );
    const cleanupWarning = await this.cleanPublishedAssets(files, result.sha);
    const deployment =
      target === 'github'
        ? undefined
        : config.hosting.provider !== 'none'
          ? await this.deployConfigured(snapshot, progress, config)
          : this.deploy
            ? await this.confirmDeployment(result.sha, progress)
            : undefined;
    if (target !== 'github' && config.hosting.provider !== 'none') {
      await afterPublish(snapshot, config, target, { hostingComplete: deployment === 'live' });
    }
    this.state = {
      kind: 'committed',
      id: progress.id,
      ...result,
      ...(cleanupWarning ? { cleanupWarning } : {}),
      ...(deployment ? { deployment } : {}),
    };
    return this.state;
  }
  private async submitReview(
    temporary: string,
    progress: Extract<PublishState, { kind: 'building' }>,
  ): Promise<PublishState> {
    if (!this.github?.review) {
      throw new PublishFailure('This repository connection does not support pull request review.');
    }
    if (this.refresh) {
      published(await this.refresh().then(ok, publishFailure));
    }
    const captured = await this.coordinator.run(async () => {
      const expectedHead = published(
        await readFile(path.join(this.root, '.studio-state/github-base.json'), 'utf8')
          .then((body) => {
            const baseline: unknown = JSON.parse(body);
            const sha = string(record(baseline)['sha'], 40);
            if (!/^[a-f0-9]{40}$/.test(sha)) {
              throw new Error('Invalid review baseline.');
            }
            return sha;
          })
          .then(ok, publishFailure),
      );
      return { expectedHead, source: published(await capturePublishSource(this.root, temporary)) };
    });
    this.state = { ...progress, stage: 'committing' };
    const receipt = published(await this.github.review(captured.source, captured.expectedHead));
    this.state = { kind: 'review-open', id: progress.id, ...receipt };
    return this.state;
  }
  private async buildAndCommit(
    snapshot: string,
    progress: Extract<PublishState, { kind: 'building' }>,
    config: PublishConfig,
    target: PublishTarget,
  ) {
    const github = this.github;
    if (!github) {
      throw new Error('GitHub is not configured');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      this.state = { ...progress, stage: 'preparing' };
      if (this.refresh) {
        published(await this.refresh().then(ok, publishFailure));
      }
      const { source, expectedHead } = await this.coordinator.run(async () => {
        const expectedHead = published(
          await readFile(path.join(this.root, '.studio-state/github-base.json'), 'utf8')
            .then((body) => {
              const baseline: unknown = JSON.parse(body);
              const sha = string(record(baseline)['sha'], 40);
              if (!/^[a-f0-9]{40}$/.test(sha)) {
                throw new Error('Invalid publish baseline.');
              }
              return sha;
            })
            .then(ok, publishFailure),
        );
        if (target !== 'github' && config.hosting.provider !== 'none') {
          published(await createHostingSnapshot(this.root, snapshot));
        }
        const sourceRoot =
          target !== 'github' && config.hosting.provider !== 'none' ? snapshot : this.root;
        const source = published(
          await capturePublishSource(sourceRoot, path.dirname(snapshot), { assetRoot: this.root }),
        );
        return { source, expectedHead };
      });
      if (target !== 'github' && config.hosting.provider !== 'none') {
        this.state = { ...progress, stage: 'building' };
        published(
          await runPublishScripts(snapshot, config.beforePublish, {
            STACKI_PUBLISH_TARGET: target,
          }).then(ok, publishFailure),
        );
        if (config.buildScript === 'build') {
          published(await this.build(snapshot).then(ok, publishFailure));
        } else {
          published(
            await runPublishScripts(snapshot, [config.buildScript]).then(ok, publishFailure),
          );
        }
      }
      this.state = { ...progress, stage: 'committing' };
      const result = await github.commit(source, expectedHead);
      if (result.ok) {
        return { files: source.files, result: result.value };
      }
      if (result.error.code !== 'github_changed' || !this.refresh || attempt === 2) {
        published(result);
      }
      published(
        await rm(path.dirname(snapshot), { recursive: true, force: true }).then(ok, publishFailure),
      );
    }
    throw new PublishFailure('GitHub is changing too quickly. Try publishing again.');
  }
  private async deployConfigured(
    snapshot: string,
    progress: Extract<PublishState, { kind: 'building' }>,
    config: PublishConfig,
  ): Promise<'live'> {
    this.state = { ...progress, stage: 'deploying', deployment: 'pending' };
    published(await deployHosting(snapshot, config).then(ok, publishFailure));
    return 'live';
  }
  private async publishHosting(
    snapshot: string,
    progress: Extract<PublishState, { kind: 'building' }>,
    config: PublishConfig,
  ): Promise<PublishState> {
    if (config.hosting.provider === 'none') {
      throw new PublishFailure('Choose a hosting provider in Publish settings.');
    }
    await this.coordinator.run(async () => {
      published(await createHostingSnapshot(this.root, snapshot));
    });
    this.state = { ...progress, stage: 'building', deployment: 'pending' };
    published(
      await runPublishScripts(snapshot, config.beforePublish, {
        STACKI_PUBLISH_TARGET: 'hosting',
      }).then(ok, publishFailure),
    );
    if (config.buildScript === 'build') {
      published(await this.build(snapshot).then(ok, publishFailure));
    } else {
      published(await runPublishScripts(snapshot, [config.buildScript]).then(ok, publishFailure));
    }
    await this.deployConfigured(snapshot, progress, config);
    await afterPublish(snapshot, config, 'hosting', { hostingComplete: true });
    this.state = {
      kind: 'committed',
      id: progress.id,
      sha: '',
      url: '',
      github: 'skipped',
      deployment: 'live',
    };
    return this.state;
  }
  private async confirmDeployment(
    sha: string,
    progress: Extract<PublishState, { kind: 'building' }>,
  ) {
    this.state = { ...progress, stage: 'deploying' };
    try {
      return (await this.deploy?.(sha)) ?? 'pending';
    } catch (error: unknown) {
      publishFailure(error);
      return 'pending';
    }
  }
  private async cleanPublishedAssets(files: readonly PublishedFile[], sha: string) {
    try {
      return (await this.cleanup?.(files, sha))?.warning;
    } catch (error: unknown) {
      publishFailure(error);
      return 'Published successfully. Storage cleanup will retry after the next GitHub publish.';
    }
  }
}

export async function runBuild(root: string): Promise<void> {
  // A bounded child heap leaves room for the preview and Git on the standard-2 container.
  await runPublishScripts(root, ['build'], { NODE_OPTIONS: '--max-old-space-size=2048' });
}
export function githubFromEnvironment() {
  const backend = process.env['STUDIO_BACKEND_URL'];
  const token = process.env['STUDIO_CONTAINER_TOKEN'];
  if (backend && token) {
    return new NativeRepository(new RemoteRepository(backend, token));
  }
  const appId = process.env['GITHUB_APP_ID'];
  const installationId = process.env['GITHUB_INSTALLATION_ID'];
  const privateKey = process.env['GITHUB_PRIVATE_KEY'];
  const repository = process.env['GITHUB_REPOSITORY'];
  if (!appId || !installationId || !privateKey || !repository) {
    return undefined;
  }
  return new NativeRepository(
    new GitHubRepository({
      appId,
      installationId,
      privateKey,
      repository,
      branch: process.env['GITHUB_BRANCH'] ?? 'main',
    }),
  );
}

async function afterPublish(
  snapshot: string,
  config: PublishConfig,
  target: PublishTarget,
  options: { readonly hostingComplete: boolean },
) {
  try {
    await runPublishScripts(snapshot, config.afterPublish, { STACKI_PUBLISH_TARGET: target });
  } catch (error: unknown) {
    const failure = publishFailure(error);
    const message = failure.ok ? '' : failure.error.message;
    throw new PublishFailure(
      (options.hostingComplete ? 'Hosting deployment completed. ' : '') + message,
    );
  }
}
