// Publishing a destination to Cloudflare Workers, and the Wrangler rules that make it safe. Verified against
// wrangler's source:
//
// - `--name` wins over everything, verbatim, even with `--env` (getScriptName: `args.name ?? config.name`). So
//   production's `--name <worker>` beside `--env staging` would put staging on the production Worker. A destination
//   always passes its own resolved name, which is checked to differ from production's and every other destination's.
// - `routes`, `route` and `triggers` are inherited by an `env.*` section that does not set its own, so an
//   environment without routes takes the top-level custom domains. A destination that claims a hostname production or
//   another destination serves is refused.
// - Workflows, queue consumers and containers are named account-wide: deploying one under a name production or another
//   destination uses moves it to this Worker. Refused.
// - `WRANGLER_CI_OVERRIDE_NAME` replaces even `--name`, and `CLOUDFLARE_ENV` picks an environment when `--env`
//   is absent, so neither is inherited by a destination's command.
//
// Wrangler files are the site's own data: parsed with the same bounded parsers as production's, never executed. The
// project's own file and the built copy's are both read, so a build cannot rename what production is.
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { toArray, toRecord } from '../../shared/core/record';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import type { PublishConfig } from '../../shared/properties/publishConfig';
import { DESTINATION_LIMITS, parseDestinationTarget, type Destination } from '../../shared/properties/publishDestinations';
import type { WorkerEnvironment } from '../../shared/properties/publishDestinationDefaults';
import { destinationSiteHosts, productionSiteHosts } from '../../shared/properties/publishDestinationConflicts';
import { parsePublishedSiteURL } from '../../shared/properties/publishSite';
import { readAuthoredWorkerConfig, readWorkerConfig, WORKER_CONFIG_NAMES, type WorkerConfig } from './publishWorkerConfig';

type Table = Readonly<Record<string, unknown>>;

/** Where a Worker destination deploys: an `env.*` section, or a Worker of its own built from the top-level settings. */
export type WorkerPlace =
  | { readonly kind: 'environment'; readonly account: string; readonly environment: string }
  | { readonly kind: 'worker'; readonly account: string; readonly project: string };

/** The place a destination's target names; absent for a target that is not a Worker. */
export function workerPlace(production: PublishConfig, destination: Destination): WorkerPlace | undefined {
  const { target } = destination;
  if (target.kind === 'host') {
    const { hosting } = target;
    return hosting.provider === 'cloudflare-workers' ? { kind: 'worker', account: hosting.accountId, project: hosting.project } : undefined;
  }
  if (target.kind !== 'cloudflare-environment') {
    if (target.kind !== 'cloudflare-worker') {
      return undefined;
    }
  }
  if (production.hosting.provider !== 'cloudflare-workers') {
    return undefined;
  }
  const account = production.hosting.accountId;
  return target.kind === 'cloudflare-environment'
    ? { kind: 'environment', account, environment: target.environment }
    : { kind: 'worker', account, project: target.project };
}

export interface WorkerCheck {
  readonly production: PublishConfig;
  readonly destination: Destination;
  readonly others: readonly Destination[];
  readonly place: WorkerPlace;
  /** Folders whose authored Wrangler file says what production is: the project's, and the copy being deployed. */
  readonly roots: readonly string[];
}

export interface CheckedWorker {
  readonly worker: string;
  /** Hostnames the Worker must not be serving: production's and the other destinations'. */
  readonly protectedHosts: readonly string[];
}

const ROUTES_MAX = 100;
const ROOTS_MAX = 2;

/** The Wrangler environments the settings can offer. Names that could not be passed to `--env` are left out. */
export async function readWorkerEnvironments(root: string): Promise<readonly WorkerEnvironment[]> {
  const authored = await readAuthoredWorkerConfig(root).catch(() => undefined);
  if (authored === undefined) {
    return [];
  }
  const environments = toRecord(authored.value['env']) ?? {};
  return Object.entries(environments)
    .flatMap(([name, input]) => {
      const section = toRecord(input);
      if (section === undefined || !isEnvironmentName(name)) {
        return [];
      }
      const worker = environmentWorker(authored.value, section, name);
      const siteUrl = ownSiteURL(section);
      return worker === undefined ? [] : [{ name, worker, ...(siteUrl === undefined ? {} : { siteUrl }) }];
    })
    .slice(0, DESTINATION_LIMITS.environmentsMax);
}

function isEnvironmentName(name: string): boolean {
  try {
    parseDestinationTarget({ kind: 'cloudflare-environment', environment: name });
    return true;
  } catch {
    return false;
  }
}

/** The Worker name Wrangler gives an environment: its own `name`, else the top-level name with the environment appended. */
function environmentWorker(config: Table, section: Table, environment: string): string | undefined {
  const own = section['name'];
  if (typeof own === 'string' && own !== '') {
    return own;
  }
  const top = config['name'];
  return typeof top === 'string' && top !== '' ? `${top}-${environment}` : undefined;
}

// An address is suggested only from a literal custom domain the environment declares itself.
function ownSiteURL(section: Table): string | undefined {
  for (const route of routeEntries(section) ?? []) {
    const entry = toRecord(route);
    const pattern = entry?.['pattern'];
    if (entry?.['custom_domain'] === true && typeof pattern === 'string') {
      try {
        return parsePublishedSiteURL(`https://${pattern.toLowerCase()}`);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function routeEntries(table: Table): readonly unknown[] | undefined {
  if (table['routes'] !== undefined) {
    return toArray(table['routes']) ?? [table['routes']];
  }
  return table['route'] === undefined ? undefined : [table['route']];
}

/** The hostname each route claims; undefined when any route cannot be read, because then nothing can be ruled out. */
function routeHosts(table: Table): readonly string[] | undefined {
  const entries = routeEntries(table) ?? [];
  if (entries.length > ROUTES_MAX) {
    return undefined;
  }
  const hosts = entries.map((route) => {
    const pattern = typeof route === 'string' ? route : toRecord(route)?.['pattern'];
    return typeof pattern === 'string' && pattern !== ''
      ? pattern
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .split('/')[0]
      : undefined;
  });
  return hosts.every((host): host is string => host !== undefined && host !== '') ? hosts : undefined;
}

/** Whether a destination's route takes a hostname served elsewhere. A wildcard over its subdomain does not take it. */
export function claimsHost(claim: string, served: string): boolean {
  if (claim === served) {
    return true;
  }
  if (!claim.includes('*')) {
    return false;
  }
  const literal = claim.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('.*')}$`).test(served);
}

function productionSection(authored: Table): Table | undefined {
  return toRecord(toRecord(authored['env'])?.['production']);
}

/**
 * Whether the Wrangler file's top level may be production's. It is when production is a Worker, and when production is
 * GitHub or a custom host, where Cloudflare may be building it from this file. It is not when Stacki deploys production
 * to another provider.
 */
function topLevelIsProduction(production: PublishConfig): boolean {
  return production.hosting.provider === 'cloudflare-workers' || production.hosting.provider === 'none';
}

/** Production's hostnames as the Wrangler files list them; undefined when a route cannot be read. */
function wranglerProductionHosts(production: PublishConfig, files: readonly Table[]): readonly string[] | undefined {
  const lists = files.flatMap((authored) => {
    const named = productionSection(authored);
    return [...(topLevelIsProduction(production) ? [routeHosts(authored)] : []), ...(named === undefined ? [] : [routeHosts(named)])];
  });
  return lists.every((hosts): hosts is readonly string[] => hosts !== undefined) ? lists.flat() : undefined;
}

/**
 * Production's hostnames as far as the project's own settings and Wrangler file name them, for a destination that is not
 * a Worker. A route that cannot be read names nothing here; such a destination cannot take a Cloudflare route.
 */
export async function knownProductionHosts(production: PublishConfig, root: string): Promise<readonly string[]> {
  const authored = await authoredConfig(root);
  const routed = authored.ok && authored.value !== undefined ? wranglerProductionHosts(production, [authored.value.value]) : undefined;
  const hosts = [...productionSiteHosts(production), ...(routed ?? [])];
  assert(
    hosts.every((host) => host !== ''),
    'A production hostname is never empty',
  );
  return hosts;
}

/** Whether `worker` in `account` is one of production's Workers. */
function isProductionWorker(production: PublishConfig, files: readonly Table[], place: { readonly account: string; readonly worker: string }): boolean {
  const worker = place.worker.toLowerCase();
  const { hosting } = production;
  if (hosting.provider === 'cloudflare-workers' && hosting.accountId.toLowerCase() === place.account.toLowerCase()) {
    if (hosting.project.toLowerCase() === worker) {
      return true;
    }
  }
  return files.some((authored) => {
    const named = productionSection(authored);
    const names = [
      topLevelIsProduction(production) ? authored['name'] : undefined,
      named === undefined ? undefined : environmentWorker(authored, named, 'production'),
    ];
    // The account the file's Workers live in, when it is known: the file's own, else production's.
    const account = authored['account_id'] ?? (hosting.provider === 'cloudflare-workers' ? hosting.accountId : undefined);
    const sameAccount = typeof account !== 'string' || account.toLowerCase() === place.account.toLowerCase();
    return sameAccount && names.some((name) => typeof name === 'string' && name.toLowerCase() === worker);
  });
}

/** Names Cloudflare holds account-wide: deploying one again moves it to the Worker that deployed it last. */
function accountWideNames(table: Table): readonly string[] {
  const entries = (input: unknown): readonly Table[] =>
    (toArray(input) ?? []).flatMap((entry) => {
      const table = toRecord(entry);
      return table === undefined ? [] : [table];
    });
  const named = (kind: string, list: readonly Table[], key: string): readonly string[] =>
    list.flatMap((entry) => {
      const value = entry[key];
      return typeof value === 'string' ? [`${kind}:${value}`] : [];
    });
  // A workflow with a script_name only calls another Worker's workflow; it does not declare one.
  const workflows = entries(table['workflows']).filter((entry) => entry['script_name'] === undefined);
  return [
    ...named('workflow', workflows, 'name'),
    ...named('queue', entries(toRecord(table['queues'])?.['consumers']), 'queue'),
    ...named('container', entries(table['containers']), 'name'),
  ];
}

/** A second Worker would declare these again from the same top-level settings, taking them from whoever has them. */
function declaresSharedWork(table: Table): boolean {
  return (toArray(table['workflows']) ?? []).length > 0 || (toArray(table['containers']) ?? []).length > 0;
}

/** What another destination holds on Cloudflare, as far as the Wrangler file can say. */
interface Held {
  readonly destination: Destination;
  readonly account: string;
  readonly worker: string | undefined;
  readonly hosts: readonly string[];
  readonly names: readonly string[];
}

function heldByOthers(check: WorkerCheck, files: readonly Table[]): readonly Held[] {
  return check.others.flatMap((destination) => {
    const place = workerPlace(check.production, destination);
    if (place === undefined) {
      return [];
    }
    const account = place.account.toLowerCase();
    if (place.kind === 'worker') {
      return [{ destination, account, worker: place.project.toLowerCase(), hosts: [], names: [] }];
    }
    return files.flatMap((authored) => {
      const section = toRecord(toRecord(authored['env'])?.[place.environment]);
      if (section === undefined) {
        return [];
      }
      const worker = environmentWorker(authored, section, place.environment)?.toLowerCase();
      // Only its own routes are its own: inherited ones are production's, and refuse that destination itself.
      return [{ destination, account, worker, hosts: routeHosts(section) ?? [], names: accountWideNames(section) }];
    });
  });
}

function sharedWith(check: WorkerCheck, other: Destination): Described {
  return described('publish.destination.error.shared', { label: check.destination.label, other: other.label });
}

interface Guard {
  readonly files: readonly Table[];
  readonly held: readonly Held[];
  readonly productionHosts: readonly string[] | undefined;
  readonly protectedHosts: readonly string[];
}

async function readGuard(check: WorkerCheck): Promise<Result<Guard, Described>> {
  assert(check.roots.length > 0, 'Production is judged from at least the project’s own files');
  assert(check.roots.length <= ROOTS_MAX, 'Only the project and its built copy are read');
  const files: Table[] = [];
  for (const root of check.roots) {
    const authored = await authoredConfig(root);
    if (!authored.ok) {
      return authored;
    }
    if (authored.value !== undefined) {
      files.push(authored.value.value);
    }
  }
  const held = heldByOthers(check, files);
  const routed = wranglerProductionHosts(check.production, files);
  const productionHosts = routed === undefined ? undefined : [...routed, ...productionSiteHosts(check.production)];
  const protectedHosts = [
    ...(productionHosts ?? productionSiteHosts(check.production)),
    ...destinationSiteHosts(check.others),
    ...held.flatMap((entry) => entry.hosts),
  ];
  return ok({ files, held, productionHosts, protectedHosts: [...new Set(protectedHosts)] });
}

async function authoredConfig(root: string): Promise<Result<WorkerConfig | undefined, Described>> {
  try {
    return ok(await readAuthoredWorkerConfig(root));
  } catch (failure: unknown) {
    if (failure instanceof DescribedError) {
      return err(failure.problem);
    }
    throw failure;
  }
}

function workerRefusal(check: WorkerCheck, guard: Guard, worker: string): Described | undefined {
  if (isProductionWorker(check.production, guard.files, { account: check.place.account, worker })) {
    return described('publish.destination.error.sameAsProduction', { label: check.destination.label });
  }
  const account = check.place.account.toLowerCase();
  const other = guard.held.find((entry) => entry.account === account && entry.worker === worker.toLowerCase());
  return other === undefined ? undefined : sharedWith(check, other.destination);
}

/** What the routes and account-wide names a deploy would use take from production or another destination. */
function claimRefusal(check: WorkerCheck, guard: Guard, effective: Table, authored: Table): Described | undefined {
  const { label } = check.destination;
  const claimed = routeHosts(effective);
  if (claimed === undefined || guard.productionHosts === undefined) {
    return described('publish.destination.error.routesUnreadable', { label });
  }
  const production = [...guard.productionHosts];
  const taken = claimed.find((host) => production.some((served) => claimsHost(host, served)));
  if (taken !== undefined) {
    return described('publish.destination.error.productionRoute', { label, host: taken });
  }
  for (const other of check.others) {
    const hosts = [...destinationSiteHosts([other]), ...guard.held.filter((entry) => entry.destination.id === other.id).flatMap((entry) => entry.hosts)];
    const shared = claimed.find((host) => hosts.some((served) => claimsHost(host, served)));
    if (shared !== undefined) {
      return described('publish.destination.error.sharedRoute', { label, other: other.label, host: shared });
    }
  }
  const names = accountWideNames(effective);
  const productionNames = new Set([...accountWideNames(authored), ...accountWideNames(productionSection(authored) ?? {})]);
  if (names.some((name) => productionNames.has(name))) {
    return described('publish.destination.error.sharedResource', { label });
  }
  const account = check.place.account.toLowerCase();
  const other = guard.held.find((entry) => entry.account === account && entry.names.some((name) => names.includes(name)));
  return other === undefined ? undefined : sharedWith(check, other.destination);
}

/**
 * The checks the authored Wrangler files answer, run before anything is built and again on the built copy. Answers the
 * Worker the destination deploys to, which is never production's or another destination's, and the hostnames the
 * caller must see the Worker is not serving.
 */
export async function checkWorkerDestination(check: WorkerCheck): Promise<Result<CheckedWorker, Described>> {
  const guard = await readGuard(check);
  if (!guard.ok) {
    return guard;
  }
  const { place, destination } = check;
  const deployed = check.roots.at(-1);
  assert(deployed !== undefined, 'There is a folder being deployed');
  const read = await authoredConfig(deployed);
  if (!read.ok) {
    return read;
  }
  const value = read.value?.value ?? {};
  const { protectedHosts } = guard.value;
  if (place.kind === 'worker') {
    const refusal = workerRefusal(check, guard.value, place.project);
    if (refusal !== undefined) {
      return err(refusal);
    }
    return declaresSharedWork(value)
      ? err(described('publish.destination.error.separateShared', { label: destination.label }))
      : ok({ worker: place.project, protectedHosts });
  }
  const section = toRecord(toRecord(value['env'])?.[place.environment]);
  if (section === undefined) {
    return err(described('publish.destination.error.noEnvironment', { label: destination.label, environment: place.environment }));
  }
  const worker = environmentWorker(value, section, place.environment);
  if (worker === undefined) {
    return err(described('publish.destination.error.sameAsProduction', { label: destination.label }));
  }
  // What Wrangler will use: the environment's own routes, or the top-level ones it inherits when it has none.
  const effective = { ...section, ...(routeEntries(section) === undefined ? { routes: value['routes'], route: value['route'] } : {}) };
  const refusal = workerRefusal(check, guard.value, worker) ?? claimRefusal(check, guard.value, effective, value);
  return refusal === undefined ? ok({ worker, protectedHosts }) : err(refusal);
}

export interface WorkerDeploy {
  readonly arguments: readonly string[];
  /** The settings written to the temporary config the deploy reads. */
  readonly config: Table;
  readonly filename: string;
  readonly worker: string;
}

/**
 * The exact deploy for the built copy. A build may have replaced the config with a generated one (the Cloudflare Vite
 * adapter), which is already flattened for one environment: it must say it is this destination's.
 */
export async function planWorkerDestination(check: WorkerCheck): Promise<Result<WorkerDeploy, Described>> {
  const checked = await checkWorkerDestination(check);
  if (!checked.ok) {
    return checked;
  }
  const root = check.roots.at(-1);
  assert(root !== undefined, 'There is a folder being deployed');
  const config = await readWorkerConfig(root);
  if (!config.ok) {
    return config;
  }
  const { filename, value } = config.value;
  const generated = !WORKER_CONFIG_NAMES.some((name) => path.resolve(root, name) === path.resolve(filename));
  const { worker } = checked.value;
  const { place } = check;
  const base = ['deploy', '--name', worker];
  if (place.kind === 'worker') {
    return planSeparateWorker(check, { filename, value, worker, arguments: base });
  }
  if (generated) {
    const { label } = check.destination;
    if (value['targetEnvironment'] !== place.environment || value['name'] !== worker) {
      return err(described('publish.destination.error.builtForProduction', { label, environment: place.environment }));
    }
    const guard = await readGuard(check);
    if (!guard.ok) {
      return guard;
    }
    const authored = guard.value.files.at(-1) ?? {};
    const refusal = claimRefusal(check, guard.value, value, authored);
    return refusal === undefined ? ok({ filename, worker, arguments: base, config: { ...value, account_id: place.account } }) : err(refusal);
  }
  const environments = toRecord(value['env']) ?? {};
  const section = toRecord(environments[place.environment]);
  if (section === undefined) {
    return err(described('publish.destination.error.noEnvironment', { label: check.destination.label, environment: place.environment }));
  }
  return ok({
    filename,
    worker,
    arguments: [...base, '--env', place.environment],
    // The account is pinned in both places, so an environment cannot send a destination to another account.
    config: { ...value, account_id: place.account, env: { ...environments, [place.environment]: { ...section, account_id: place.account } } },
  });
}

/** A separate Worker takes the top-level config without anything that would reach production's traffic or jobs. */
function planSeparateWorker(
  check: WorkerCheck,
  input: { readonly filename: string; readonly value: Table; readonly worker: string; readonly arguments: readonly string[] },
): Result<WorkerDeploy, Described> {
  // The config being deployed may be a generated one the earlier check never saw.
  if (declaresSharedWork(input.value)) {
    return err(described('publish.destination.error.separateShared', { label: check.destination.label }));
  }
  const { routes, route, triggers, env, queues, ...kept } = input.value;
  void routes;
  void route;
  void triggers;
  void env;
  const producers = toRecord(queues)?.['producers'];
  const config = {
    ...kept,
    ...(producers === undefined ? {} : { queues: { producers } }),
    name: input.worker,
    account_id: check.place.account,
    workers_dev: true,
  };
  return ok({ filename: input.filename, worker: input.worker, arguments: input.arguments, config });
}
