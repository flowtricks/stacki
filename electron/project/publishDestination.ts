// Publishing to a destination, host by host. Every path here is separate from production's, and each one is refused,
// never adjusted, when it cannot be shown to leave production and every other destination alone:
//
// - First what the settings alone can prove (publishDestinationConflicts.ts).
// - Cloudflare Workers: publishDestinationWorker.ts, then the Worker must not already serve a protected hostname.
// - A Pages preview of production's project: the project's real production branch is asked of Cloudflare first; the
//   settings' copy may be wrong, and `pages deploy --branch <that branch>` is a production deploy.
// - A Vercel preview: a new project's FIRST deployment is production even without `--prod`, so the project must
//   already have a ready production deployment. `--prod` is never passed.
// - A Netlify draft: `--alias` without `--prod` is a draft deploy. `--prod` and `--prod-if-unlocked` are never passed.
// - An account and project of the destination's own is published as that project's live site, so the host is asked
//   what that project is. It is refused when it serves a protected hostname, when it builds from this repository while
//   Stacki does not deploy production itself (it may be production), or when it is the linked project Publish would
//   treat as production.
// - A custom host: only the destination's branch is pushed, or only its script or its link is used.
//
// A failed or unreadable check refuses the publish. Checks run before anything is built or pushed, and again at the
// moment of deploying.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toArray, toRecord } from '../../shared/core/record';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import { hostingCommand, type PublishCommand } from '../../shared/properties/publishCommands';
import { destinationConflict, destinationSiteHosts, previewName } from '../../shared/properties/publishDestinationConflicts';
import { parseDestinationsSource, type Destination, type OwnHosting, type PublishDestinations } from '../../shared/properties/publishDestinations';
import type { Hosting, PublishConfig } from '../../shared/properties/publishConfig';
import { parseDeploymentURL } from '../../shared/properties/publishState';
import { WORKER_SETUP_NEEDED_KEY } from '../../shared/properties/publishWorkerSetup';
import { readProjectMetadata } from './projectMetadata';
import { publishToolInstalled } from './publishExecutable';
import { runPublishCommandOutput, runPublishScripts } from './publishCommands';
import { netlifyBuildPlan, netlifyDeployCommand, netlifyDeployResult, requireBuildOutput, requireNetlifySite } from './publishNetlifyDeploy';
import {
  checkWorkerDestination,
  claimsHost,
  knownProductionHosts,
  planWorkerDestination,
  workerPlace,
  type WorkerCheck,
  type WorkerPlace,
} from './publishDestinationWorker';
import { withTemporaryWorkerConfig, workerConfigParse } from './publishWorkerConfig';
import { HOST_QUESTIONS, type HostQuestions } from './publishDestinationHost';
import type { HostProject, HostRepository, NetlifyHosting, PagesHosting, VercelHosting } from './publishDestinationReplies';
import { checkDeployScript } from './publishCustom';
import { linkedPublishProject } from './publishLinkedProject';
import { deployLinkBinding } from './deployLinkStore';
import { siteFile } from './publishSiteBuild';
import type { ExecutableCommand } from './publishExecutable';

type Problem = Pick<AppError, 'message' | 'messageRef'>;
type Checked = Result<undefined, Problem>;

/** The host's answers and the tools; a test stands in for them so nothing reaches a real host. */
export interface DestinationServices extends HostQuestions {
  readonly workerToolInstalled: (root: string) => boolean;
  readonly run: (root: string, command: ExecutableCommand) => Promise<string>;
  readonly netlifySite: typeof requireNetlifySite;
}

export const DESTINATION_SERVICES: DestinationServices = {
  ...HOST_QUESTIONS,
  workerToolInstalled: (root) => publishToolInstalled(root, 'wrangler'),
  run: runPublishCommandOutput,
  netlifySite: requireNetlifySite,
};

/** One destination being checked or deployed, beside everything it must leave alone. */
export interface DestinationJob {
  /** The person's project folder. */
  readonly project: string;
  /** The folder being checked: the project's, or the built copy about to be deployed. */
  readonly root: string;
  readonly config: PublishConfig;
  readonly destination: Destination;
  readonly others: readonly Destination[];
}

/**
 * Variables of this computer a destination's command never inherits: each can send a Wrangler deploy somewhere other
 * than where its arguments say.
 */
const WITHHELD: readonly string[] = ['WRANGLER_CI_OVERRIDE_NAME', 'WRANGLER_CI_MATCH_TAG', 'CLOUDFLARE_ENV'];

export function readPublishDestinations(root: string): PublishDestinations {
  const metadata = readProjectMetadata(root, 'publishDestinations');
  if (!metadata.ok) {
    throw new Error(metadata.error.message);
  }
  return parseDestinationsSource(metadata.value.source);
}

/**
 * What a destination's build, hooks and scripts see. Every destination is not-production, so the first two say
 * `staging` for all of them; the id says which one. The site decides what that means (drafts, noindex).
 */
export function destinationEnvironment(destination: Destination): Readonly<Record<string, string>> {
  const { target } = destination;
  return {
    STACKI_PUBLISH_ENV: 'staging',
    STACKI_PUBLISH_TARGET: 'staging',
    STACKI_PUBLISH_DESTINATION: destination.id,
    // The Cloudflare Vite adapter picks the Wrangler environment while building, not while deploying.
    ...(target.kind === 'cloudflare-environment' ? { CLOUDFLARE_ENV: target.environment } : {}),
  };
}

export async function runDestinationScripts(root: string, destination: Destination, scripts: readonly string[]): Promise<void> {
  await runPublishScripts(root, scripts, destinationEnvironment(destination), WITHHELD);
}

/** The destination's own readiness, asked before anything is built or pushed. Git and deploy links are checked apart. */
export async function checkDestination(job: DestinationJob, services: DestinationServices): Promise<Checked> {
  const conflict = destinationConflict(job.config, job.destination, job.others);
  if (!conflict.ok) {
    return conflict;
  }
  const { target } = job.destination;
  const place = workerPlace(job.config, job.destination);
  if (place !== undefined) {
    return checkWorker(job, place, services);
  }
  switch (target.kind) {
    case 'cloudflare-pages':
      return checkPagesPreview(job, target.branch, services);
    case 'vercel':
      return checkVercelPreview(job, services);
    case 'netlify': {
      const plan = await netlifyBuildPlan(job.root, ['branch-deploy', target.alias]);
      return plan.ok ? ok(undefined) : plan;
    }
    case 'host':
      assert(target.hosting.provider !== 'cloudflare-workers', 'A destination’s own Worker was checked as a Worker');
      return checkOwnProject(job, target.hosting, services);
    case 'script':
      return checkDeployScript(job.root, target.script);
    case 'github-branch':
    case 'link':
      return ok(undefined);
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      throw new Error('A Worker destination was checked as a Worker.');
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function workerCheck(job: DestinationJob, place: WorkerPlace): WorkerCheck {
  const { config, destination, others } = job;
  const roots = job.root === job.project ? [job.project] : [job.project, job.root];
  return { production: config, destination, others, place, roots };
}

async function checkWorker(job: DestinationJob, place: WorkerPlace, services: DestinationServices): Promise<Checked> {
  const worker = await checkWorkerDestination(workerCheck(job, place));
  if (!worker.ok) {
    return worker;
  }
  if (!services.workerToolInstalled(job.root)) {
    return err(described(WORKER_SETUP_NEEDED_KEY));
  }
  return checkWorkerHostnames(job, place.account, worker.value, services);
}

/** A Worker given production's custom domain in Cloudflare's dashboard serves it whatever the Wrangler file says. */
async function checkWorkerHostnames(
  job: DestinationJob,
  account: string,
  checked: { readonly worker: string; readonly protectedHosts: readonly string[] },
  services: DestinationServices,
): Promise<Checked> {
  if (checked.protectedHosts.length === 0) {
    return ok(undefined);
  }
  let served: readonly string[];
  try {
    served = await services.workerHostnames(job.root, account, checked.worker);
  } catch {
    return err(described('publish.destination.error.hostUnconfirmed', { label: job.destination.label }));
  }
  return checkDomains(job, served, checked.protectedHosts);
}

/** Refuses a project or Worker that serves a hostname production or another destination uses. */
function checkDomains(job: DestinationJob, served: readonly string[], protectedHosts: readonly string[]): Checked {
  assert(
    protectedHosts.every((host) => host === host.toLowerCase()),
    'Hostnames are compared in lowercase',
  );
  const taken = served.find((domain) => protectedHosts.some((host) => claimsHost(domain, host)));
  return taken === undefined ? ok(undefined) : err(described('publish.destination.error.servesAddress', { label: job.destination.label, host: taken }));
}

async function checkPagesPreview(job: DestinationJob, branch: string, services: DestinationServices): Promise<Checked> {
  const { hosting } = job.config;
  assert(hosting.provider === 'cloudflare', 'A Pages preview belongs to Pages production');
  let production: string;
  try {
    production = await services.pagesProductionBranch(job.root, hosting);
  } catch {
    return err(described('publish.destination.error.pagesUnconfirmed', { label: job.destination.label }));
  }
  // Two branch names can share one preview address, so a name that shortens to production's counts as production's.
  const same = production.toLowerCase() === branch.toLowerCase() || previewName(production) === previewName(branch);
  return same ? err(described('publish.destination.error.sameAsProduction', { label: job.destination.label })) : ok(undefined);
}

async function checkVercelPreview(job: DestinationJob, services: DestinationServices): Promise<Checked> {
  const { hosting } = job.config;
  assert(hosting.provider === 'vercel', 'A Vercel preview belongs to Vercel production');
  const { label } = job.destination;
  let exists: boolean;
  try {
    exists = await services.vercelHasProduction(job.root, hosting);
  } catch {
    return err(described('publish.destination.error.vercelUnconfirmed', { label }));
  }
  return exists ? ok(undefined) : err(described('publish.destination.error.vercelFirstDeploy', { label }));
}

async function checkOwnProject(
  job: DestinationJob,
  hosting: Exclude<OwnHosting, { provider: 'cloudflare-workers' }>,
  services: DestinationServices,
): Promise<Checked> {
  if (await isLinkedProduction(job, hosting)) {
    return err(described('publish.destination.error.linkedProject', { label: job.destination.label }));
  }
  if (hosting.provider === 'netlify') {
    const plan = await netlifyBuildPlan(job.root);
    if (!plan.ok) {
      return plan;
    }
  }
  const project = await readOwnProject(job.root, hosting, services);
  return project.ok ? checkProject(job, project.value) : err(unconfirmed(job));
}

function unconfirmed(job: DestinationJob): Described {
  return described('publish.destination.error.hostUnconfirmed', { label: job.destination.label });
}

async function readOwnProject(
  root: string,
  hosting: PagesHosting | VercelHosting | NetlifyHosting,
  services: DestinationServices,
): Promise<Result<HostProject, 'unconfirmed'>> {
  const read = (): Promise<HostProject> => {
    switch (hosting.provider) {
      case 'cloudflare':
        return services.pagesProject(root, hosting);
      case 'vercel':
        return services.vercelProject(root, hosting);
      case 'netlify':
        return services.netlifyProject(root, hosting);
    }
  };
  return read().then(ok, () => err('unconfirmed' as const));
}

/** What the host said about a destination's own project, held against production and the other destinations. */
async function checkProject(job: DestinationJob, project: HostProject): Promise<Checked> {
  const protectedHosts = [...(await knownProductionHosts(job.config, job.project)), ...destinationSiteHosts(job.others)];
  // With no hostname to protect, there is nothing the domains could clash with.
  if (protectedHosts.length > 0) {
    if (project.domains.kind === 'unread') {
      return err(unconfirmed(job));
    }
    const domains = checkDomains(job, [...project.domains.hosts, ...(await vercelAliases(job))], protectedHosts);
    if (!domains.ok) {
      return domains;
    }
  }
  // Where Stacki does not deploy production itself, a project that builds from this repository may be production.
  return job.config.hosting.provider === 'none' ? checkRepository(job, project.repository) : ok(undefined);
}

async function checkRepository(job: DestinationJob, connected: HostRepository): Promise<Checked> {
  switch (connected.kind) {
    case 'not-connected':
    case 'elsewhere':
      return ok(undefined);
    case 'unread':
      return err(unconfirmed(job));
    case 'github': {
      const { repository } = await deployLinkBinding(job.project);
      return repository.toLowerCase() === connected.repository
        ? err(described('publish.destination.error.sameRepository', { label: job.destination.label }))
        : ok(undefined);
    }
    default: {
      const exhaustive: never = connected;
      return exhaustive;
    }
  }
}

/** Domains a `vercel.json` hands to a production deploy of whatever project it is run against. */
async function vercelAliases(job: DestinationJob): Promise<readonly string[]> {
  const { target } = job.destination;
  if (target.kind !== 'host' || target.hosting.provider !== 'vercel') {
    return [];
  }
  const filename = path.join(job.root, 'vercel.json');
  const source = await siteFile(filename);
  if (source === undefined) {
    return [];
  }
  const alias = toRecord(workerConfigParse(filename, source))?.['alias'];
  const entries = typeof alias === 'string' ? [alias] : (toArray(alias) ?? []);
  return entries.flatMap((entry) => (typeof entry === 'string' ? [entry.toLowerCase()] : []));
}

/**
 * With no saved publish settings, Publish deploys production to whatever project the folder is linked to
 * (publishLinkedProject.ts), so that project cannot also be a destination.
 */
async function isLinkedProduction(job: DestinationJob, hosting: PagesHosting | VercelHosting | NetlifyHosting): Promise<boolean> {
  if (hosting.provider === 'cloudflare' || existsSync(path.join(job.project, '.stacki', 'publish.json'))) {
    return false;
  }
  const linked = await linkedPublishProject(job.project, hosting.provider).catch(() => undefined);
  if (linked === undefined) {
    // A link file that cannot be read cannot rule itself out.
    return true;
  }
  return linked.some((entry) => sameLinkedProject(entry.hosting, hosting));
}

function sameLinkedProject(linked: Hosting, hosting: VercelHosting | NetlifyHosting): boolean {
  if (linked.provider === 'vercel') {
    return hosting.provider === 'vercel' && linked.projectId === hosting.projectId;
  }
  return linked.provider === 'netlify' && hosting.provider === 'netlify' && linked.siteId === hosting.siteId;
}

/**
 * Deploys the built copy to the destination's provider, or runs its script. Answers the address the host's tool
 * printed, when it printed one. Branch and link destinations are the publisher's, since they push and send a request.
 */
export async function deployDestination(job: DestinationJob, services: DestinationServices): Promise<{ readonly url?: string }> {
  // Asked again at the moment of deploying: hooks and the build ran project code.
  const ready = await checkDestination(job, services);
  if (!ready.ok) {
    throw new DescribedError(ready.error);
  }
  const { destination, config } = job;
  const { target } = destination;
  const place = workerPlace(config, destination);
  if (place !== undefined) {
    return deployWorker(job, place, services);
  }
  const run = (command: ExecutableCommand): Promise<string> =>
    services.run(job.root, { ...command, environment: { ...command.environment, ...destinationEnvironment(destination) }, withheld: WITHHELD });
  switch (target.kind) {
    case 'cloudflare-pages':
      return addressIn(await run(pagesPreviewCommand(config.hosting, target.branch)), PAGES_ADDRESS);
    case 'vercel':
      return addressIn(await run(vercelPreviewCommand(config.hosting, destination)), VERCEL_ADDRESS);
    case 'netlify':
      return deployNetlifyDraft(job, target.alias, services, run);
    case 'host':
      return deployOwnProject(job, target.hosting, services, run);
    case 'script':
      await runDestinationScripts(job.root, destination, [target.script]);
      return {};
    case 'github-branch':
    case 'link':
      throw new Error('A destination’s branch is pushed by the publisher.');
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      throw new Error('A Worker destination is deployed as a Worker.');
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

const PAGES_ADDRESS = /https:\/\/[a-z0-9.-]+\.pages\.dev/g;
const VERCEL_ADDRESS = /https:\/\/[a-z0-9.-]+\.vercel\.app/g;
const WORKER_ADDRESS = /https:\/\/[a-z0-9.-]+\.workers\.dev/g;
const NETLIFY_DRAFT_ADDRESS = /(?<="deploy_url":\s?")https:\/\/[a-z0-9.-]+\.netlify\.app/g;
const NETLIFY_SITE_ADDRESS = /(?<="(?:ssl_url|url)":\s?")https:\/\/[a-z0-9.-]+\.netlify\.app/g;

async function deployWorker(job: DestinationJob, place: WorkerPlace, services: DestinationServices): Promise<{ readonly url?: string }> {
  const plan = await planWorkerDestination(workerCheck(job, place));
  if (!plan.ok) {
    throw new DescribedError(plan.error);
  }
  // The generated config of an adapter build is already the environment's: naming one again would pick it twice.
  const { CLOUDFLARE_ENV: selected, ...announced } = destinationEnvironment(job.destination);
  void selected;
  const output = await withTemporaryWorkerConfig(plan.value.filename, plan.value.config, (configuration) =>
    services.run(job.root, {
      executable: 'wrangler',
      arguments: [...plan.value.arguments, '--config', configuration],
      environment: { ...announced, CLOUDFLARE_ACCOUNT_ID: place.account },
      withheld: WITHHELD,
    }),
  );
  return addressIn(output, WORKER_ADDRESS);
}

export function pagesPreviewCommand(hosting: Hosting, branch: string): PublishCommand {
  assert(hosting.provider === 'cloudflare', 'A Pages preview belongs to Pages production');
  assert(branch.toLowerCase() !== hosting.branch.toLowerCase(), 'A preview never deploys the production branch');
  return hostingCommand({ ...hosting, branch });
}

// Vercel builds on its own servers, so what the build should know travels with the deploy.
function withVercelBuildEnvironment(command: PublishCommand, destination: Destination): PublishCommand {
  const variables = ['STACKI_PUBLISH_ENV=staging', `STACKI_PUBLISH_DESTINATION=${destination.id}`];
  return { ...command, arguments: [...command.arguments, ...variables.flatMap((variable) => ['--build-env', variable])] };
}

export function vercelPreviewCommand(hosting: Hosting, destination: Destination): PublishCommand {
  assert(hosting.provider === 'vercel', 'A Vercel preview belongs to Vercel production');
  const command = hostingCommand(hosting);
  const preview = command.arguments.filter((argument) => argument !== '--prod');
  assert(!preview.includes('--prod'), 'A preview is never a production deploy');
  return withVercelBuildEnvironment({ ...command, arguments: preview }, destination);
}

/** The destination's own project, published as that project's live site. Only ever reached after checkOwnProject. */
async function deployOwnProject(
  job: DestinationJob,
  hosting: OwnHosting,
  services: DestinationServices,
  run: (command: ExecutableCommand) => Promise<string>,
): Promise<{ readonly url?: string }> {
  assert(hosting.provider !== 'cloudflare-workers', 'A destination’s own Worker is deployed as a Worker');
  switch (hosting.provider) {
    case 'cloudflare': {
      // The project's own production branch, asked now: that is what its live site is built from.
      const { productionBranch } = await services.pagesProject(job.root, hosting);
      return addressIn(await run(hostingCommand({ ...hosting, branch: productionBranch })), PAGES_ADDRESS);
    }
    case 'vercel':
      return addressIn(await run(withVercelBuildEnvironment(hostingCommand(hosting), job.destination)), VERCEL_ADDRESS);
    case 'netlify': {
      const plan = await netlifyBuildPlan(job.root);
      if (!plan.ok) {
        throw new DescribedError(plan.error);
      }
      if (plan.value.kind === 'prebuilt') {
        await requireBuildOutput(job.root, plan.value.directory);
      }
      await services.netlifySite(job.root, hosting);
      return addressIn(requireSite(await run(netlifyDeployCommand(hosting, plan.value)), hosting), NETLIFY_SITE_ADDRESS);
    }
  }
}

function requireSite(output: string, hosting: NetlifyHosting): string {
  const deployed = netlifyDeployResult(output);
  if (deployed === undefined) {
    throw new DescribedError(described('publish.netlify.error.unconfirmed'));
  }
  if (deployed.siteId !== hosting.siteId) {
    throw new DescribedError(described('publish.netlify.error.otherSite'));
  }
  return output;
}

async function deployNetlifyDraft(
  job: DestinationJob,
  alias: string,
  services: DestinationServices,
  run: (command: ExecutableCommand) => Promise<string>,
): Promise<{ readonly url?: string }> {
  const { hosting } = job.config;
  assert(hosting.provider === 'netlify', 'A Netlify alias belongs to Netlify production');
  const plan = await netlifyBuildPlan(job.root, ['branch-deploy', alias]);
  if (!plan.ok) {
    throw new DescribedError(plan.error);
  }
  if (plan.value.kind === 'prebuilt') {
    await requireBuildOutput(job.root, plan.value.directory);
  } else if (!existsSync(path.join(job.root, 'netlify.toml'))) {
    throw new DescribedError(described('publish.netlify.error.config'));
  }
  await services.netlifySite(job.root, hosting);
  const base = hostingCommand(hosting);
  const draft = base.arguments.filter((argument) => argument !== '--prod');
  const extra =
    plan.value.kind === 'prebuilt'
      ? ['--no-build', '--dir', plan.value.directory]
      : ['--context', `branch:${alias}`, ...(plan.value.directory === undefined ? [] : ['--dir', plan.value.directory])];
  const command = { ...base, arguments: [...draft, '--alias', alias, ...extra] };
  assert(!command.arguments.some((argument) => argument.startsWith('--prod')), 'A destination’s alias deploy is a draft');
  return addressIn(requireSite(await run(command), hosting), NETLIFY_DRAFT_ADDRESS);
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
