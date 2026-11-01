import {
  DEFAULT_PUBLISH_CONFIG,
  parsePublishConfig,
  type Hosting,
  type PublishConfig,
  type PublishTarget,
} from '../../../vendor/stacki/shared/properties/publishConfig';
import { PublishFailure } from './publishFailure';

export function managedHostingFromEnvironment(): Hosting | undefined {
  const project = process.env['STUDIO_GITHUB_DEPLOY_WORKER'];
  const accountId = process.env['STUDIO_GITHUB_DEPLOY_ACCOUNT'];
  if (!project && !accountId) {
    return undefined;
  }
  if (!process.env['STUDIO_DEPLOYMENT_URL']) {
    throw new PublishFailure('GitHub hosting requires a deployment confirmation URL.');
  }
  return parsePublishConfig({
    ...DEFAULT_PUBLISH_CONFIG,
    hosting: { provider: 'cloudflare-workers', project, accountId },
  }).hosting;
}

export function managedPublishConfig(config: PublishConfig, target: PublishTarget, managed: Hosting | undefined): PublishConfig {
  if (config.githubWorkflow?.kind === 'pull-request') {
    return config;
  }
  if (target === 'github') {
    return config;
  }
  if (managed?.provider !== 'cloudflare-workers') {
    return config;
  }
  const selected = config.hosting;
  if (selected.provider !== managed.provider) {
    return config;
  }
  if (selected.accountId !== managed.accountId || selected.project !== managed.project) {
    return config;
  }
  if (target === 'hosting') {
    throw new PublishFailure('This site deploys automatically from GitHub. Use Publish to save and deploy changes together.');
  }
  if (config.beforePublish.length > 0 || config.afterPublish.length > 0 || config.buildScript !== 'build') {
    throw new PublishFailure('This site builds through GitHub. Configure custom publish scripts in Cloudflare Workers Builds.');
  }
  // The connected GitHub build owns validation and deployment. Keep the saved destination,
  // but use the existing commit-and-confirm path so Studio never builds or deploys it twice.
  return { ...config, hosting: { provider: 'none' } };
}
