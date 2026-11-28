// What the settings alone can prove wrong about a destination: that it would publish over production, or over another
// destination. Every refusal fails closed and names the destination, so the form and the publish both say why.
//
// What needs the site's own files or the host (resolved Worker names, Wrangler routes, a Pages project's real
// production branch, which domains a project serves) is checked by electron/project/publishDestinationCheck.ts. What
// a custom script does, or what a deploy link starts, cannot be checked at all.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { described, type Described } from './i18n/messageRef';
import type { Hosting, PublishConfig } from './publishConfig';
import { savedPublishedSite } from './publishSite';
import { destinationBuildsLocally, DESTINATION_LIMITS, type Destination, type DestinationTarget, type OwnHosting } from './publishDestinations';

/** Branch names that are production by convention, whatever this repository calls its default branch. */
const PRODUCTION_BRANCHES: readonly string[] = ['main', 'master', 'production', 'prod', 'gh-pages'];
const PRODUCTION_ENVIRONMENTS: readonly string[] = ['production', 'prod', 'live'];
/** Script names that conventionally deploy production. What a script does cannot be checked, only what it is called. */
const PRODUCTION_SCRIPTS: readonly string[] = ['deploy', 'deploy:prod', 'deploy:production', 'publish'];
/** Cloudflare shortens a preview branch's address to this many characters, so longer names can share one. */
const PAGES_ALIAS_CHARS_MAX = 28;

export function isProductionBranchName(branch: string, otherProductionBranches: readonly string[]): boolean {
  assert(branch.length > 0, 'A branch is compared by its name');
  const name = branch.toLowerCase();
  return [...PRODUCTION_BRANCHES, ...otherProductionBranches].some((entry) => entry.toLowerCase() === name);
}

/** The name a branch gets in a preview address (`<name>.<project>.pages.dev`, `<name>--<site>.netlify.app`). */
export function previewName(branch: string): string {
  const name = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, PAGES_ALIAS_CHARS_MAX)
    .replace(/^-+|-+$/g, '');
  assert(name.length <= PAGES_ALIAS_CHARS_MAX, 'A preview name stays within its length');
  return name;
}

/**
 * Whether two saved hostings name the same project at the same host. Identifiers are compared without case, which can
 * only refuse more than it must.
 */
export function sameProject(left: Hosting, right: Hosting): boolean {
  assert(left.provider.length > 0, 'A compared hosting names its provider');
  const key = projectKey(left);
  return key !== undefined && key === projectKey(right);
}

function projectKey(hosting: Hosting): string | undefined {
  switch (hosting.provider) {
    case 'none':
      return undefined;
    case 'cloudflare':
    case 'cloudflare-workers':
      return JSON.stringify([hosting.provider, hosting.accountId, hosting.project]).toLowerCase();
    case 'vercel':
      // A project id names one project whichever team is saved beside it.
      return JSON.stringify([hosting.provider, hosting.projectId]).toLowerCase();
    case 'netlify':
      return JSON.stringify([hosting.provider, hosting.siteId]).toLowerCase();
  }
}

/** The one thing a destination overwrites each time it is published, as far as the settings can say. */
type Claim =
  | { readonly kind: 'worker'; readonly account: string; readonly worker: string }
  | { readonly kind: 'environment'; readonly environment: string }
  | { readonly kind: 'pages-preview'; readonly account: string; readonly project: string; readonly name: string }
  | { readonly kind: 'netlify-alias'; readonly site: string; readonly name: string }
  | { readonly kind: 'project'; readonly hosting: OwnHosting }
  | { readonly kind: 'branch'; readonly branch: string }
  | { readonly kind: 'script'; readonly script: string }
  /** A Vercel preview gets an address of its own each time, so it overwrites nothing. */
  | { readonly kind: 'none' };

function claimOf(production: PublishConfig, destination: Destination): Claim {
  const { target } = destination;
  const { hosting } = production;
  switch (target.kind) {
    case 'cloudflare-environment':
      return { kind: 'environment', environment: target.environment.toLowerCase() };
    case 'cloudflare-worker':
      return hosting.provider === 'cloudflare-workers'
        ? { kind: 'worker', account: hosting.accountId.toLowerCase(), worker: target.project.toLowerCase() }
        : { kind: 'none' };
    case 'cloudflare-pages':
      return hosting.provider === 'cloudflare'
        ? {
            kind: 'pages-preview',
            account: hosting.accountId.toLowerCase(),
            project: hosting.project.toLowerCase(),
            name: previewName(target.branch),
          }
        : { kind: 'none' };
    case 'netlify':
      return hosting.provider === 'netlify' ? { kind: 'netlify-alias', site: hosting.siteId.toLowerCase(), name: target.alias } : { kind: 'none' };
    case 'vercel':
      return { kind: 'none' };
    case 'host':
      return target.hosting.provider === 'cloudflare-workers'
        ? { kind: 'worker', account: target.hosting.accountId.toLowerCase(), worker: target.hosting.project.toLowerCase() }
        : { kind: 'project', hosting: target.hosting };
    case 'github-branch':
    case 'link':
      return { kind: 'branch', branch: target.branch.toLowerCase() };
    case 'script':
      return { kind: 'script', script: target.script.toLowerCase() };
  }
}

/** A pushed branch that the host would build into the same preview address, or into a project's live site. */
function branchOverlaps(branch: string, other: Claim): boolean {
  assert(branch === branch.toLowerCase(), 'Claimed branches are compared in lowercase');
  switch (other.kind) {
    case 'branch':
      return other.branch === branch;
    case 'pages-preview':
    case 'netlify-alias':
      return previewName(branch) === other.name;
    case 'project':
      return other.hosting.provider === 'cloudflare' && other.hosting.branch.toLowerCase() === branch;
    case 'worker':
    case 'environment':
    case 'script':
    case 'none':
      return false;
  }
}

function claimsOverlap(left: Claim, right: Claim): boolean {
  if (left.kind === 'branch') {
    return branchOverlaps(left.branch, right);
  }
  if (right.kind === 'branch') {
    return branchOverlaps(right.branch, left);
  }
  switch (left.kind) {
    case 'worker':
      return right.kind === 'worker' && right.account === left.account && right.worker === left.worker;
    case 'environment':
      return right.kind === 'environment' && right.environment === left.environment;
    case 'pages-preview':
      return right.kind === 'pages-preview' && right.account === left.account && right.project === left.project && right.name === left.name;
    case 'netlify-alias':
      return right.kind === 'netlify-alias' && right.site === left.site && right.name === left.name;
    case 'project':
      return right.kind === 'project' && sameProject(left.hosting, right.hosting);
    case 'script':
      return right.kind === 'script' && right.script === left.script;
    case 'none':
      return false;
  }
}

/** The package.json scripts publishing a destination runs besides its deploy script. */
function supportingScripts(destination: Destination): readonly string[] {
  const build = destinationBuildsLocally(destination.target) ? [destination.buildScript] : [];
  return [...destination.beforePublish, ...build, ...destination.afterPublish];
}

function deployScript(destination: Destination): string | undefined {
  return destination.target.kind === 'script' ? destination.target.script : undefined;
}

/** A hook or build that is another place's deploy script would deploy that place too. */
function runsAnotherDeploy(production: PublishConfig, destination: Destination, others: readonly Destination[]): Described | undefined {
  assert(
    others.every((other) => other.id !== destination.id),
    'A destination is not its own neighbour',
  );
  const run = supportingScripts(destination).map((script) => script.toLowerCase());
  const productionScript = production.customHosting?.deploy === 'script' ? production.customHosting.script.toLowerCase() : undefined;
  if (run.some((script) => PRODUCTION_SCRIPTS.includes(script) || script === productionScript)) {
    return described('publish.destination.error.productionScript', { label: destination.label });
  }
  const other = others.find((entry) => {
    const script = deployScript(entry)?.toLowerCase();
    return script !== undefined && run.includes(script);
  });
  return other === undefined ? undefined : shared(destination, other);
}

function siteHost(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) {
    return undefined;
  }
  return new URL(url).hostname.toLowerCase();
}

/** The hostnames production is known to serve from its own settings. */
export function productionSiteHosts(production: PublishConfig): readonly string[] {
  const urls = [savedPublishedSite(production)?.url, production.customHosting?.siteUrl];
  return urls.flatMap((url) => {
    const host = siteHost(url);
    return host === undefined ? [] : [host];
  });
}

/** The hostnames the other destinations say they are served at. */
export function destinationSiteHosts(destinations: readonly Destination[]): readonly string[] {
  return destinations.flatMap((destination) => {
    const host = siteHost(destination.siteUrl);
    return host === undefined ? [] : [host];
  });
}

/**
 * Whether the target is a form of a provider production no longer uses. Unlike the conflict checks, it can be asked of a
 * destination that is still being typed.
 */
export function borrowsAnotherProvider(production: PublishConfig, target: DestinationTarget): boolean {
  const { provider } = production.hosting;
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      return provider !== 'cloudflare-workers';
    case 'cloudflare-pages':
      return provider !== 'cloudflare';
    case 'vercel':
    case 'netlify':
      return provider !== target.kind;
    case 'host':
    case 'github-branch':
    case 'script':
    case 'link':
      return false;
  }
}

/** Why `destination` would change production, judged from the settings alone. */
function productionRefusal(production: PublishConfig, destination: Destination): Described | undefined {
  const { target, label } = destination;
  const { hosting } = production;
  const same = () => described('publish.destination.error.sameAsProduction', { label });
  if (borrowsAnotherProvider(production, target)) {
    return described('publish.destination.error.providerChanged', { label });
  }
  const host = siteHost(destination.siteUrl);
  if (host !== undefined && productionSiteHosts(production).includes(host)) {
    return described('publish.destination.error.productionAddress', { label });
  }
  switch (target.kind) {
    case 'cloudflare-environment':
      return PRODUCTION_ENVIRONMENTS.includes(target.environment.toLowerCase()) ? same() : undefined;
    case 'cloudflare-worker':
      assert(hosting.provider === 'cloudflare-workers', 'A separate Worker borrows Worker production');
      return target.project.toLowerCase() === hosting.project.toLowerCase() ? same() : undefined;
    case 'cloudflare-pages':
      assert(hosting.provider === 'cloudflare', 'A Pages preview borrows Pages production');
      return isProductionBranchName(target.branch, [hosting.branch]) || previewName(target.branch) === previewName(hosting.branch) ? same() : undefined;
    case 'vercel':
      return undefined;
    case 'netlify':
      return PRODUCTION_BRANCHES.includes(target.alias) ? same() : undefined;
    case 'host':
      return sameProject(target.hosting, hosting) ? described('publish.destination.error.productionProject', { label }) : undefined;
    case 'github-branch':
    case 'link':
      return isProductionBranchName(target.branch, hosting.provider === 'cloudflare' ? [hosting.branch] : []) ? same() : undefined;
    case 'script': {
      const productionScript = production.customHosting?.deploy === 'script' ? production.customHosting.script : undefined;
      const named = PRODUCTION_SCRIPTS.includes(target.script.toLowerCase()) || target.script.toLowerCase() === productionScript?.toLowerCase();
      return named ? same() : undefined;
    }
  }
}

function shared(destination: Destination, other: Destination): Described {
  assert(destination.id !== other.id, 'A destination is compared with another one');
  return described('publish.destination.error.shared', { label: destination.label, other: other.label });
}

/**
 * Whether publishing `destination` could change production or one of `others`, judged from the settings alone. Two
 * destinations that name the same place are both refused: neither can be published without changing the other.
 */
export function destinationConflict(production: PublishConfig, destination: Destination, others: readonly Destination[]): Result<undefined, Described> {
  const rest = others.filter((other) => other.id !== destination.id);
  assert(rest.length < DESTINATION_LIMITS.destinationsMax, 'The other destinations stay bounded');
  assert(production.customHosting === undefined || production.hosting.provider === 'none', 'A custom host leaves the provider at none');
  const refusal = productionRefusal(production, destination) ?? runsAnotherDeploy(production, destination, rest);
  if (refusal !== undefined) {
    return err(refusal);
  }
  const claim = claimOf(production, destination);
  const host = siteHost(destination.siteUrl);
  const taken = rest.find((other) => claimsOverlap(claim, claimOf(production, other)) || (host !== undefined && siteHost(other.siteUrl) === host));
  return taken === undefined ? ok(undefined) : err(shared(destination, taken));
}
