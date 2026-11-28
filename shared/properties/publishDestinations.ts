// `.stacki/publish-destinations.json`: the places a project publishes besides production. Production stays where it
// always was (`.stacki/publish.json`, publishConfig.ts); today the only other destination is staging, and the file
// holds a bounded list so more can be added without a new shape.
//
// Why a file of its own: Stacki 1.4.21 rebuilds publish.json from the keys it knows, and rewrites it on its own when
// it learns the published site's address. A staging block kept there would be silently erased by a teammate on that
// version. It never reads or writes this file, so it can neither lose staging nor deploy staging settings anywhere.
//
// The invariant every rule here serves: publishing to staging can never change production. A staging destination
// never carries an account or project of its own that could name production's: a provider destination borrows
// production's identifiers and only says how it differs, and `stagingConflict` refuses one that does not differ.
// What only the site's own files or the host can say (Wrangler routes, the host's production branch) is checked by
// electron/project/publishStaging.ts before anything is built, pushed or deployed.
import { list, record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { described, type Described } from './i18n/messageRef';
import { parsePublishedSiteURL } from './publishSite';
import { isPublishScriptName, parseHostName, type PublishConfig, type PublishTarget } from './publishConfig';

export const DESTINATION_LIMITS = {
  destinationsMax: 4,
  sourceCharsMax: 16_384,
  hooksMax: 8,
  branchCharsMax: 100,
  workerNameCharsMax: 63,
  netlifyAliasCharsMax: 37,
  environmentsMax: 20,
} as const satisfies Record<string, number>;

/** What a publish request can ask for. `staging` is never a default target: 1.4.21 refuses a default it does not know. */
export type PublishRequestTarget = PublishTarget | 'staging';

export const DESTINATION_IDS = ['staging'] as const;
export type DestinationId = (typeof DESTINATION_IDS)[number];

export type StagingTarget =
  /** An `env.*` section of the site's Wrangler config, deployed beside production's Worker. */
  | { readonly kind: 'cloudflare-environment'; readonly environment: string }
  /** A separate Worker deployed from the top-level Wrangler config, without its routes or schedules. */
  | { readonly kind: 'cloudflare-worker'; readonly project: string }
  /** A preview branch of production's Pages project. */
  | { readonly kind: 'cloudflare-pages'; readonly branch: string }
  /** A Vercel preview deployment of production's project. */
  | { readonly kind: 'vercel' }
  /** A Netlify draft deploy of production's site under a fixed alias. */
  | { readonly kind: 'netlify'; readonly alias: string }
  /** A host that builds a staging branch by itself: Stacki pushes to that branch only. */
  | { readonly kind: 'github-branch'; readonly branch: string }
  /** Stacki builds, then runs a package.json script. GitHub is not touched. */
  | { readonly kind: 'script'; readonly script: string }
  /** Stacki pushes to the staging branch only, then sends staging's own deploy link. */
  | { readonly kind: 'link'; readonly branch: string };

export type StagingKind = StagingTarget['kind'];

export interface Destination {
  readonly id: DestinationId;
  readonly name?: string;
  readonly target: StagingTarget;
  readonly buildScript: string;
  /** This destination's own hooks. Production's hooks never run for it. */
  readonly beforePublish: readonly string[];
  readonly afterPublish: readonly string[];
  readonly siteUrl?: string;
}

export interface PublishDestinations {
  readonly version: 1;
  readonly destinations: readonly Destination[];
}

export const NO_DESTINATIONS: PublishDestinations = { version: 1, destinations: [] };

export function stagingDestination(destinations: PublishDestinations): Destination | undefined {
  return destinations.destinations.find((destination) => destination.id === 'staging');
}

export function withStaging(destinations: PublishDestinations, staging: Destination | undefined): PublishDestinations {
  const others = destinations.destinations.filter((destination) => destination.id !== 'staging');
  const next: PublishDestinations = { version: 1, destinations: staging === undefined ? others : [...others, staging] };
  assert(next.destinations.length <= DESTINATION_LIMITS.destinationsMax, 'Publish destinations stay bounded');
  assert(stagingDestination(next) === staging, 'The staging destination is the one given');
  return next;
}

export function parsePublishRequestTarget(input: unknown): PublishRequestTarget {
  if (input === 'all' || input === 'github' || input === 'hosting' || input === 'staging') {
    return input;
  }
  throw new Error('Choose all, github, hosting, or staging as the publish target.');
}

export function parseDestinationsSource(source: string | undefined): PublishDestinations {
  if (source === undefined) {
    return NO_DESTINATIONS;
  }
  if (source.length > DESTINATION_LIMITS.sourceCharsMax) {
    throw new Error('Publish destinations exceed 16 KiB.');
  }
  const input: unknown = JSON.parse(source);
  return parsePublishDestinations(input);
}

export function parsePublishDestinations(input: unknown): PublishDestinations {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported publish destinations version.');
  }
  requireKeys(value, ['version', 'destinations']);
  const destinations = list(parseDestination)(value['destinations']);
  if (destinations.length > DESTINATION_LIMITS.destinationsMax) {
    throw new Error('Too many publish destinations.');
  }
  if (new Set(destinations.map((destination) => destination.id)).size !== destinations.length) {
    throw new Error('Each publish destination appears once.');
  }
  assert(destinations.length <= DESTINATION_IDS.length, 'At most one destination of each kind is saved');
  return { version: 1, destinations };
}

/** Strict, like custom hosting: an unknown key is refused, so a deploy link cannot be saved in this tracked file. */
function parseDestination(input: unknown): Destination {
  const value = record(input);
  requireKeys(value, ['id', 'name', 'target', 'buildScript', 'beforePublish', 'afterPublish', 'siteUrl']);
  const id = DESTINATION_IDS.find((entry) => entry === value['id']);
  if (id === undefined) {
    throw new Error('Unknown publish destination.');
  }
  return {
    id,
    ...(value['name'] === undefined ? {} : { name: parseHostName(value['name']) }),
    target: parseStagingTarget(value['target']),
    buildScript: scriptName(value['buildScript']),
    beforePublish: scriptNames(value['beforePublish']),
    afterPublish: scriptNames(value['afterPublish']),
    ...(value['siteUrl'] === undefined ? {} : { siteUrl: parseDestinationSiteURL(value['siteUrl']) }),
  };
}

export function parseStagingTarget(input: unknown): StagingTarget {
  const value = record(input);
  const kind = value['kind'];
  switch (kind) {
    case 'cloudflare-environment':
      requireKeys(value, ['kind', 'environment']);
      return { kind, environment: parseEnvironmentName(value['environment']) };
    case 'cloudflare-worker':
      requireKeys(value, ['kind', 'project']);
      return { kind, project: parseWorkerName(value['project']) };
    case 'cloudflare-pages':
    case 'github-branch':
    case 'link':
      requireKeys(value, ['kind', 'branch']);
      return { kind, branch: parseStagingBranch(value['branch']) };
    case 'vercel':
      requireKeys(value, ['kind']);
      return { kind };
    case 'netlify':
      requireKeys(value, ['kind', 'alias']);
      return { kind, alias: parseNetlifyAlias(value['alias']) };
    case 'script':
      requireKeys(value, ['kind', 'script']);
      return { kind, script: scriptName(value['script']) };
    default:
      throw new Error('Unknown staging destination kind.');
  }
}

function requireKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    // The key is not echoed: a pasted link could be the key itself.
    throw new Error('Publish destinations hold a setting Stacki does not know. A deploy link is never saved in this file.');
  }
}

function scriptName(input: unknown): string {
  const value = text(input);
  if (!isPublishScriptName(value)) {
    throw new Error('Publish identifiers must be nonempty names, not commands.');
  }
  return value;
}

function scriptNames(input: unknown): readonly string[] {
  const values = list(scriptName)(input);
  if (values.length > DESTINATION_LIMITS.hooksMax) {
    throw new Error('Use at most eight scripts per publish hook.');
  }
  return values;
}

/** A name Wrangler accepts after `--env`: it can never read as a command-line option. */
function parseEnvironmentName(input: unknown): string {
  const value = text(input);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value)) {
    throw new Error('A Wrangler environment is a short name.');
  }
  return value;
}

function parseWorkerName(input: unknown): string {
  const value = text(input);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error('A Worker name uses lowercase letters, numbers and hyphens.');
  }
  return value;
}

/** A branch name that is safe as one end of a refspec: no `+` (a forced push), no colon, no leading hyphen. */
export function parseStagingBranch(input: unknown): string {
  const value = text(input);
  const part = '[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_-])?';
  if (value.length > DESTINATION_LIMITS.branchCharsMax || !new RegExp(`^${part}(?:/${part})*$`).test(value)) {
    throw new Error('Enter a branch name such as staging.');
  }
  if (value.includes('..') || value.endsWith('.lock') || value.startsWith('refs/')) {
    throw new Error('Enter a branch name such as staging.');
  }
  return value;
}

function parseNetlifyAlias(input: unknown): string {
  const value = text(input);
  if (value.length > DESTINATION_LIMITS.netlifyAliasCharsMax || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error('A Netlify alias uses lowercase letters, numbers and hyphens, at most 37 characters.');
  }
  return value;
}

function parseDestinationSiteURL(input: unknown): string {
  try {
    return parsePublishedSiteURL(input);
  } catch {
    throw new Error('The site address must be like https://example.com, with no path.');
  }
}

/** Branch names that are production by convention, whatever this repository calls its default branch. */
const PRODUCTION_BRANCHES: readonly string[] = ['main', 'master', 'production', 'prod', 'gh-pages'];
const PRODUCTION_ENVIRONMENTS: readonly string[] = ['production', 'prod', 'live'];
/** Script names that conventionally deploy production. What a script does cannot be checked, only what it is called. */
const PRODUCTION_SCRIPTS: readonly string[] = ['deploy', 'deploy:prod', 'deploy:production', 'publish'];

export function isProductionBranchName(branch: string, otherProductionBranches: readonly string[]): boolean {
  assert(branch.length > 0, 'A branch is compared by its name');
  const name = branch.toLowerCase();
  return [...PRODUCTION_BRANCHES, ...otherProductionBranches].some((entry) => entry.toLowerCase() === name);
}

/**
 * What the settings alone can prove wrong: a staging destination that borrows a provider production no longer uses,
 * or one that names the same target as production. Answered as a value, so the form and the publish both say why.
 */
export function stagingConflict(production: PublishConfig, staging: Destination): Result<undefined, Described> {
  const { target } = staging;
  const { hosting } = production;
  assert(production.customHosting === undefined || hosting.provider === 'none', 'A custom host leaves the provider at none');
  switch (target.kind) {
    case 'cloudflare-environment':
      if (hosting.provider !== 'cloudflare-workers') {
        return providerChanged();
      }
      return PRODUCTION_ENVIRONMENTS.includes(target.environment.toLowerCase()) ? sameAsProduction() : ok(undefined);
    case 'cloudflare-worker':
      if (hosting.provider !== 'cloudflare-workers') {
        return providerChanged();
      }
      return target.project.toLowerCase() === hosting.project.toLowerCase() ? sameAsProduction() : ok(undefined);
    case 'cloudflare-pages':
      if (hosting.provider !== 'cloudflare') {
        return providerChanged();
      }
      return isProductionBranchName(target.branch, [hosting.branch]) ? sameAsProduction() : ok(undefined);
    case 'vercel':
      return hosting.provider === 'vercel' ? ok(undefined) : providerChanged();
    case 'netlify':
      if (hosting.provider !== 'netlify') {
        return providerChanged();
      }
      return PRODUCTION_BRANCHES.includes(target.alias) ? sameAsProduction() : ok(undefined);
    case 'github-branch':
    case 'link':
      return isProductionBranchName(target.branch, hosting.provider === 'cloudflare' ? [hosting.branch] : []) ? sameAsProduction() : ok(undefined);
    case 'script': {
      const productionScript = production.customHosting?.deploy === 'script' ? production.customHosting.script : undefined;
      const named = PRODUCTION_SCRIPTS.includes(target.script.toLowerCase()) || target.script === productionScript;
      return named ? sameAsProduction() : ok(undefined);
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function providerChanged(): Result<never, Described> {
  return err(described('publish.staging.error.providerChanged'));
}

function sameAsProduction(): Result<never, Described> {
  return err(described('publish.staging.error.sameAsProduction'));
}

/** Whether Stacki's own build produces what the destination serves; where the host builds, a build script is not offered. */
export function stagingBuildsLocally(kind: StagingKind): boolean {
  switch (kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
    case 'cloudflare-pages':
    case 'netlify':
    case 'script':
      return true;
    case 'vercel':
    case 'github-branch':
    case 'link':
      return false;
  }
}

/** Whether publishing the destination pushes its staging branch to GitHub. No other kind touches GitHub at all. */
export function stagingBranchOf(target: StagingTarget): string | undefined {
  return target.kind === 'github-branch' || target.kind === 'link' ? target.branch : undefined;
}

/** A Wrangler environment found in the site's config: its Worker, and the address its own custom domain gives it. */
export interface WorkerEnvironment {
  readonly name: string;
  readonly worker: string;
  readonly siteUrl?: string;
}

export interface DetectedProject {
  readonly scripts: readonly string[];
  readonly environments: readonly WorkerEnvironment[];
}

/** The staging setup a project most likely wants, from what it already declares. Empty fields are left for the person. */
export function suggestStaging(production: PublishConfig, detected: DetectedProject): Destination {
  assert(detected.environments.length <= DESTINATION_LIMITS.environmentsMax, 'Detected environments stay bounded');
  const target = suggestTarget(production, detected);
  const stagingBuild = ['build:staging', 'build-staging'].find((name) => detected.scripts.includes(name));
  const siteUrl = target.kind === 'cloudflare-environment' ? detected.environments.find((entry) => entry.name === target.environment)?.siteUrl : undefined;
  return {
    id: 'staging',
    target,
    buildScript: stagingBuild ?? (production.buildScript === '' ? 'build' : production.buildScript),
    beforePublish: [],
    afterPublish: [],
    ...(siteUrl === undefined ? {} : { siteUrl }),
  };
}

function suggestTarget(production: PublishConfig, detected: DetectedProject): StagingTarget {
  switch (production.hosting.provider) {
    case 'cloudflare-workers': {
      const environment = detected.environments.find((entry) => entry.name === 'staging') ?? detected.environments[0];
      return environment === undefined
        ? { kind: 'cloudflare-worker', project: stagingWorkerName(production.hosting.project) }
        : { kind: 'cloudflare-environment', environment: environment.name };
    }
    case 'cloudflare':
      return { kind: 'cloudflare-pages', branch: 'staging' };
    case 'vercel':
      return { kind: 'vercel' };
    case 'netlify':
      return { kind: 'netlify', alias: 'staging' };
    case 'none':
      return detected.scripts.includes('deploy:staging') ? { kind: 'script', script: 'deploy:staging' } : { kind: 'github-branch', branch: 'staging' };
    default: {
      const exhaustive: never = production.hosting;
      return exhaustive;
    }
  }
}

export function stagingWorkerName(project: string): string {
  const suffix = '-staging';
  const base = project
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, DESTINATION_LIMITS.workerNameCharsMax - suffix.length);
  const name = `${base}${suffix}`.replace(/^-+/, '');
  assert(name.length <= DESTINATION_LIMITS.workerNameCharsMax, 'A staging Worker name stays within Cloudflare’s limit');
  assert(!name.startsWith('-'), 'A Worker name never reads as a command-line option');
  return name;
}
