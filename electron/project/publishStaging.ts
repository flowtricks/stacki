// Publishing to staging, destination by destination. Every path here is separate from production's, and each one is
// refused, never adjusted, when it cannot be shown to leave production alone:
//
// - Cloudflare Workers: publishStagingWorker.ts.
// - Cloudflare Pages: the project's real production branch is asked of Cloudflare first; the settings' copy may be
//   wrong, and `pages deploy --branch <that branch>` is a production deploy.
// - Vercel: a new project's FIRST deployment is production even without `--prod`, so the project must already have a
//   ready production deployment. `--prod` is never passed.
// - Netlify: `--alias` without `--prod` is a draft deploy. `--prod` and `--prod-if-unlocked` are never passed.
// - A custom host: only the staging branch is pushed, or only the staging script or staging link is used.
//
// A failed or unreadable check refuses the publish. Checks run before anything is built or pushed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import { hostingCommand, type PublishCommand } from '../../shared/properties/publishCommands';
import { parseDestinationsSource, stagingConflict, type Destination, type PublishDestinations } from '../../shared/properties/publishDestinations';
import type { Hosting, PublishConfig } from '../../shared/properties/publishConfig';
import { savedPublishedSite } from '../../shared/properties/publishSite';
import { parseDeploymentURL } from '../../shared/properties/publishState';
import { WORKER_SETUP_NEEDED_KEY } from '../../shared/properties/publishWorkerSetup';
import { readProjectMetadata } from './projectMetadata';
import { publishToolInstalled } from './publishExecutable';
import { runPublishCommandOutput, runPublishScripts } from './publishCommands';
import { discoveryCommand } from './publishDiscoveryCommand';
import { cloudflareHeaders, cloudflareRequest } from './publishDiscoveryCloudflare';
import { netlifyBuildPlan, netlifyDeployResult, requireBuildOutput, requireNetlifySite } from './publishNetlifyDeploy';
import { checkWorkerStaging, planWorkerStaging, type WorkerProduction, type WorkerStagingTarget } from './publishStagingWorker';
import { withTemporaryWorkerConfig } from './publishWorkerConfig';
import { checkDeployScript } from './publishCustom';
import type { ExecutableCommand } from './publishExecutable';

type Problem = Pick<AppError, 'message' | 'messageRef'>;

/** The questions only the host can answer, and the tools; a test stands in for them so nothing reaches a real host. */
export interface StagingServices {
  readonly workerToolInstalled: (root: string) => boolean;
  readonly pagesProductionBranch: (root: string, hosting: PagesHosting) => Promise<string>;
  readonly vercelHasProduction: (root: string, hosting: VercelHosting) => Promise<boolean>;
  readonly run: (root: string, command: ExecutableCommand) => Promise<string>;
  readonly netlifySite: typeof requireNetlifySite;
}

type PagesHosting = Extract<Hosting, { readonly provider: 'cloudflare' }>;
type VercelHosting = Extract<Hosting, { readonly provider: 'vercel' }>;

export const STAGING_SERVICES: StagingServices = {
  workerToolInstalled: (root) => publishToolInstalled(root, 'wrangler'),
  pagesProductionBranch,
  vercelHasProduction,
  run: runPublishCommandOutput,
  netlifySite: requireNetlifySite,
};

/**
 * Variables of this computer a staging command never inherits: each can send a Wrangler deploy somewhere other than
 * where its arguments say.
 */
const WITHHELD: readonly string[] = ['WRANGLER_CI_OVERRIDE_NAME', 'WRANGLER_CI_MATCH_TAG', 'CLOUDFLARE_ENV'];

export function readPublishDestinations(root: string): PublishDestinations {
  const metadata = readProjectMetadata(root, 'publishDestinations');
  if (!metadata.ok) {
    throw new Error(metadata.error.message);
  }
  return parseDestinationsSource(metadata.value.source);
}

/** What staging's build, hooks and scripts see. The site decides what staging means (drafts, noindex); Stacki only says. */
export function stagingEnvironment(staging: Destination): Readonly<Record<string, string>> {
  return {
    STACKI_PUBLISH_ENV: 'staging',
    STACKI_PUBLISH_TARGET: 'staging',
    // The Cloudflare Vite adapter picks the Wrangler environment while building, not while deploying.
    ...(staging.target.kind === 'cloudflare-environment' ? { CLOUDFLARE_ENV: staging.target.environment } : {}),
  };
}

export async function runStagingScripts(root: string, staging: Destination, scripts: readonly string[]): Promise<void> {
  await runPublishScripts(root, scripts, stagingEnvironment(staging), WITHHELD);
}

function workerProduction(config: PublishConfig): WorkerProduction {
  assert(config.hosting.provider === 'cloudflare-workers', 'Worker staging belongs to Worker production');
  const published = savedPublishedSite(config)?.url;
  return { project: config.hosting.project, hosts: published === undefined ? [] : [new URL(published).hostname] };
}

function isWorkerTarget(target: Destination['target']): target is WorkerStagingTarget {
  return target.kind === 'cloudflare-environment' || target.kind === 'cloudflare-worker';
}

/** The destination's own readiness, asked before anything is built or pushed. Git and deploy links are checked apart. */
export async function checkStagingDestination(
  root: string,
  config: PublishConfig,
  staging: Destination,
  services: StagingServices,
): Promise<Result<undefined, Problem>> {
  const conflict = stagingConflict(config, staging);
  if (!conflict.ok) {
    return conflict;
  }
  const { target } = staging;
  if (isWorkerTarget(target)) {
    const worker = await checkWorkerStaging(root, target, workerProduction(config));
    if (!worker.ok) {
      return worker;
    }
    return services.workerToolInstalled(root) ? ok(undefined) : err(described(WORKER_SETUP_NEEDED_KEY));
  }
  switch (target.kind) {
    case 'cloudflare-pages':
      return checkPagesStaging(root, config, target.branch, services);
    case 'vercel':
      return checkVercelStaging(root, config, services);
    case 'netlify': {
      const plan = await netlifyBuildPlan(root, ['branch-deploy', target.alias]);
      return plan.ok ? ok(undefined) : plan;
    }
    case 'script':
      return checkDeployScript(root, target.script);
    case 'github-branch':
    case 'link':
      return ok(undefined);
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

async function checkPagesStaging(root: string, config: PublishConfig, branch: string, services: StagingServices): Promise<Result<undefined, Problem>> {
  assert(config.hosting.provider === 'cloudflare', 'Pages staging belongs to Pages production');
  let production: string;
  try {
    production = await services.pagesProductionBranch(root, config.hosting);
  } catch {
    return err(described('publish.staging.error.pagesUnconfirmed'));
  }
  return production.toLowerCase() === branch.toLowerCase() ? err(described('publish.staging.error.sameAsProduction')) : ok(undefined);
}

async function checkVercelStaging(root: string, config: PublishConfig, services: StagingServices): Promise<Result<undefined, Problem>> {
  assert(config.hosting.provider === 'vercel', 'A Vercel preview belongs to Vercel production');
  let exists: boolean;
  try {
    exists = await services.vercelHasProduction(root, config.hosting);
  } catch {
    return err(described('publish.staging.error.vercelUnconfirmed'));
  }
  return exists ? ok(undefined) : err(described('publish.staging.error.vercelFirstDeploy'));
}

async function pagesProductionBranch(root: string, hosting: PagesHosting): Promise<string> {
  const credentials = record(await discoveryCommand(root, 'wrangler', ['auth', 'token', '--json']));
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${hosting.accountId}/pages/projects/${hosting.project}`;
  const response = record(await cloudflareRequest(endpoint, cloudflareHeaders(credentials)));
  if (response['success'] !== true) {
    throw new Error('Cloudflare did not describe the Pages project.');
  }
  const branch = text(record(response['result'])['production_branch']);
  assert(branch.length > 0, 'A Pages project names its production branch');
  return branch;
}

async function vercelHasProduction(root: string, hosting: VercelHosting): Promise<boolean> {
  const endpoint = `/v6/deployments?projectId=${encodeURIComponent(hosting.projectId)}&target=production&state=READY&limit=1`;
  const response = record(await discoveryCommand(root, 'vercel', ['api', endpoint, '--method', 'GET', '--raw', '--scope', hosting.organizationId]));
  const deployments = response['deployments'];
  if (!Array.isArray(deployments)) {
    throw new Error('Vercel did not list deployments.');
  }
  return deployments.some((entry: unknown) => record(entry)['target'] === 'production');
}

/**
 * Deploys the built snapshot to a provider's staging, or runs the staging script. Answers the address the host's tool
 * printed, when it printed one. Branch and link destinations are the publisher's, since they push and send a request.
 */
export async function deployStaging(
  snapshot: string,
  config: PublishConfig,
  staging: Destination,
  services: StagingServices,
): Promise<{ readonly url?: string }> {
  // Asked again at the moment of deploying: the build ran project code, and settings may have changed meanwhile.
  const ready = await checkStagingDestination(snapshot, config, staging, services);
  if (!ready.ok) {
    throw new DescribedError(ready.error);
  }
  const { target } = staging;
  const run = (command: ExecutableCommand): Promise<string> =>
    services.run(snapshot, { ...command, environment: { ...command.environment, ...stagingEnvironment(staging) }, withheld: WITHHELD });
  if (isWorkerTarget(target)) {
    return deployWorkerStaging(snapshot, config, target, services, staging);
  }
  switch (target.kind) {
    case 'cloudflare-pages': {
      const output = await run(pagesStagingCommand(config.hosting, target.branch));
      return addressIn(output, /https:\/\/[a-z0-9.-]+\.pages\.dev/g);
    }
    case 'vercel': {
      const output = await run(vercelStagingCommand(config.hosting));
      return addressIn(output, /https:\/\/[a-z0-9.-]+\.vercel\.app/g);
    }
    case 'netlify':
      return deployNetlifyStaging(snapshot, config.hosting, target.alias, services, run);
    case 'script':
      await runStagingScripts(snapshot, staging, [target.script]);
      return {};
    case 'github-branch':
    case 'link':
      throw new Error('A staging branch is pushed by the publisher.');
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

async function deployWorkerStaging(
  snapshot: string,
  config: PublishConfig,
  target: WorkerStagingTarget,
  services: StagingServices,
  staging: Destination,
): Promise<{ readonly url?: string }> {
  assert(config.hosting.provider === 'cloudflare-workers', 'Worker staging belongs to Worker production');
  const { accountId } = config.hosting;
  const plan = await planWorkerStaging(snapshot, target, workerProduction(config), accountId);
  if (!plan.ok) {
    throw new DescribedError(plan.error);
  }
  // The generated config of an adapter build is already the environment's: naming one again would pick it twice.
  const environment = stagingEnvironment(staging);
  const { CLOUDFLARE_ENV: selected, ...announced } = environment;
  void selected;
  const output = await withTemporaryWorkerConfig(plan.value.filename, plan.value.config, (configuration) =>
    services.run(snapshot, {
      executable: 'wrangler',
      arguments: [...plan.value.arguments, '--config', configuration],
      environment: { ...announced, CLOUDFLARE_ACCOUNT_ID: accountId },
      withheld: WITHHELD,
    }),
  );
  return addressIn(output, /https:\/\/[a-z0-9.-]+\.workers\.dev/g);
}

export function pagesStagingCommand(hosting: Hosting, branch: string): PublishCommand {
  assert(hosting.provider === 'cloudflare', 'Pages staging belongs to Pages production');
  assert(branch.toLowerCase() !== hosting.branch.toLowerCase(), 'A preview never deploys the production branch');
  return hostingCommand({ ...hosting, branch });
}

export function vercelStagingCommand(hosting: Hosting): PublishCommand {
  assert(hosting.provider === 'vercel', 'A Vercel preview belongs to Vercel production');
  const command = hostingCommand(hosting);
  const preview = command.arguments.filter((argument) => argument !== '--prod');
  assert(!preview.includes('--prod'), 'A preview is never a production deploy');
  // Vercel builds on its own servers, so what the build should know travels with the deploy.
  return { ...command, arguments: [...preview, '--build-env', 'STACKI_PUBLISH_ENV=staging'] };
}

async function deployNetlifyStaging(
  snapshot: string,
  hosting: Hosting,
  alias: string,
  services: StagingServices,
  run: (command: ExecutableCommand) => Promise<string>,
): Promise<{ readonly url?: string }> {
  assert(hosting.provider === 'netlify', 'A Netlify alias belongs to Netlify production');
  const plan = await netlifyBuildPlan(snapshot, ['branch-deploy', alias]);
  if (!plan.ok) {
    throw new DescribedError(plan.error);
  }
  if (plan.value.kind === 'prebuilt') {
    await requireBuildOutput(snapshot, plan.value.directory);
  } else if (!existsSync(path.join(snapshot, 'netlify.toml'))) {
    throw new DescribedError(described('publish.netlify.error.config'));
  }
  await services.netlifySite(snapshot, hosting);
  const base = hostingCommand(hosting);
  const draft = base.arguments.filter((argument) => argument !== '--prod');
  const extra =
    plan.value.kind === 'prebuilt'
      ? ['--no-build', '--dir', plan.value.directory]
      : ['--context', `branch:${alias}`, ...(plan.value.directory === undefined ? [] : ['--dir', plan.value.directory])];
  const command = { ...base, arguments: [...draft, '--alias', alias, ...extra] };
  assert(!command.arguments.some((argument) => argument.startsWith('--prod')), 'A staging deploy is a draft');
  const output = await run(command);
  const deployed = netlifyDeployResult(output);
  if (deployed === undefined) {
    throw new DescribedError(described('publish.netlify.error.unconfirmed'));
  }
  if (deployed.siteId !== hosting.siteId) {
    throw new DescribedError(described('publish.netlify.error.otherSite'));
  }
  return addressIn(output, /(?<="deploy_url":\s?")https:\/\/[a-z0-9.-]+\.netlify\.app/g);
}

/** The last matching address printed: tools print progress first and the deployment's address at the end. */
function addressIn(output: string, pattern: RegExp): { readonly url?: string } {
  const found = output.match(pattern)?.at(-1);
  if (found === undefined) {
    return {};
  }
  try {
    return { url: parseDeploymentURL(found) };
  } catch {
    return {};
  }
}
