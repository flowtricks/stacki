// Staging on Cloudflare Workers, and the Wrangler rules that make it safe. Verified against wrangler's source:
//
// - `--name` wins over everything, verbatim, even with `--env` (getScriptName: `args.name ?? config.name`). So
//   production's `--name <worker>` beside `--env staging` would put staging on the production Worker. Staging
//   always passes its own resolved name, which is checked to differ from production's.
// - `routes`, `route` and `triggers` are inherited by an `env.*` section that does not set its own, so an
//   environment without routes takes the top-level custom domains. A staging Worker that claims a hostname
//   production serves is refused.
// - Workflows, queue consumers and containers are named account-wide: deploying one under production's name moves
//   it to the staging Worker. Refused.
// - `WRANGLER_CI_OVERRIDE_NAME` replaces even `--name`, and `CLOUDFLARE_ENV` picks an environment when `--env`
//   is absent, so neither is inherited by a staging command.
//
// Wrangler files are the site's own data: parsed with the same bounded parsers as production's, never executed.
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { toArray, toRecord } from '../../shared/core/record';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import { DESTINATION_LIMITS, parseStagingTarget, type StagingTarget, type WorkerEnvironment } from '../../shared/properties/publishDestinations';
import { parsePublishedSiteURL } from '../../shared/properties/publishSite';
import { readAuthoredWorkerConfig, readWorkerConfig, WORKER_CONFIG_NAMES, type WorkerConfig } from './publishWorkerConfig';

export type WorkerStagingTarget = Extract<StagingTarget, { readonly kind: 'cloudflare-environment' | 'cloudflare-worker' }>;
type Table = Readonly<Record<string, unknown>>;

/** What staging must stay away from: production's Worker and every hostname it serves. */
export interface WorkerProduction {
  readonly project: string;
  /** Hostnames known to be production's beyond the Wrangler file: the saved published site. */
  readonly hosts: readonly string[];
}

const ROUTES_MAX = 100;

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
    parseStagingTarget({ kind: 'cloudflare-environment', environment: name });
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

/** Whether a staging route takes something production serves. A production wildcard over a staging subdomain does not. */
export function claimsProductionHost(staging: string, production: string): boolean {
  if (staging === production) {
    return true;
  }
  if (!staging.includes('*')) {
    return false;
  }
  const literal = staging.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('.*')}$`).test(production);
}

function productionHosts(authored: Table, production: WorkerProduction): readonly string[] | undefined {
  const named = toRecord(toRecord(authored['env'])?.['production']);
  const top = routeHosts(authored);
  const environment = named === undefined ? [] : routeHosts(named);
  return top === undefined || environment === undefined ? undefined : [...top, ...environment, ...production.hosts];
}

function productionNames(authored: Table, production: WorkerProduction): readonly string[] {
  const named = toRecord(toRecord(authored['env'])?.['production']);
  const names = [production.project, authored['name'], named === undefined ? undefined : environmentWorker(authored, named, 'production')];
  return names.flatMap((name) => (typeof name === 'string' ? [name.toLowerCase()] : []));
}

function routeRefusal(effective: Table, hosts: readonly string[] | undefined): Described | undefined {
  const claimed = routeHosts(effective);
  if (claimed === undefined || hosts === undefined) {
    return described('publish.staging.error.routesUnreadable');
  }
  const taken = claimed.find((host) => hosts.some((other) => claimsProductionHost(host, other)));
  return taken === undefined ? undefined : described('publish.staging.error.productionRoute', { host: taken });
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

function sharedResourceRefusal(effective: Table, authored: Table): Described | undefined {
  const named = toRecord(toRecord(authored['env'])?.['production']) ?? {};
  const production = new Set([...accountWideNames(authored), ...accountWideNames(named)]);
  return accountWideNames(effective).some((name) => production.has(name)) ? described('publish.staging.error.sharedResource') : undefined;
}

/** A second Worker would declare these again from the same top-level settings, taking them from production. */
function declaresSharedWork(table: Table): boolean {
  return (toArray(table['workflows']) ?? []).length > 0 || (toArray(table['containers']) ?? []).length > 0;
}

/**
 * The checks the authored Wrangler file answers, run before anything is built and again on the snapshot. Answers the
 * Worker staging deploys to, which is never one of production's.
 */
export async function checkWorkerStaging(
  root: string,
  target: WorkerStagingTarget,
  production: WorkerProduction,
): Promise<Result<{ readonly worker: string; readonly authored: WorkerConfig | undefined }, Described>> {
  const authored = await readAuthoredWorkerConfig(root).catch((failure: unknown) => {
    if (failure instanceof DescribedError) {
      return failure;
    }
    throw failure;
  });
  if (authored instanceof DescribedError) {
    return err(authored.problem);
  }
  const value = authored?.value ?? {};
  if (target.kind === 'cloudflare-worker') {
    if (productionNames(value, production).includes(target.project.toLowerCase())) {
      return err(described('publish.staging.error.sameAsProduction'));
    }
    return declaresSharedWork(value) ? err(described('publish.staging.error.separateShared')) : ok({ worker: target.project, authored });
  }
  const section = toRecord(toRecord(value['env'])?.[target.environment]);
  if (authored === undefined || section === undefined) {
    return err(described('publish.staging.error.noEnvironment', { environment: target.environment }));
  }
  const worker = environmentWorker(value, section, target.environment);
  if (worker === undefined || productionNames(value, production).includes(worker.toLowerCase())) {
    return err(described('publish.staging.error.sameAsProduction'));
  }
  // What Wrangler will use: the environment's own routes, or the top-level ones it inherits when it has none.
  const effective = { ...section, ...(routeEntries(section) === undefined ? { routes: value['routes'], route: value['route'] } : {}) };
  const refusal = routeRefusal(effective, productionHosts(value, production)) ?? sharedResourceRefusal(section, value);
  return refusal === undefined ? ok({ worker, authored }) : err(refusal);
}

export interface WorkerStagingDeploy {
  readonly arguments: readonly string[];
  /** The settings written to the temporary config the deploy reads. */
  readonly config: Table;
  readonly filename: string;
}

/**
 * The exact staging deploy for the built snapshot. A build may have replaced the config with a generated one (the
 * Cloudflare Vite adapter), which is already flattened for one environment: it must say it is staging's.
 */
export async function planWorkerStaging(
  root: string,
  target: WorkerStagingTarget,
  production: WorkerProduction,
  accountId: string,
): Promise<Result<WorkerStagingDeploy, Described>> {
  const checked = await checkWorkerStaging(root, target, production);
  if (!checked.ok) {
    return checked;
  }
  const config = await readWorkerConfig(root);
  if (!config.ok) {
    return config;
  }
  const { filename, value } = config.value;
  const generated = !WORKER_CONFIG_NAMES.some((name) => path.resolve(root, name) === path.resolve(filename));
  const authored = checked.value.authored?.value ?? {};
  const worker = checked.value.worker;
  const base = ['deploy', '--name', worker];
  if (target.kind === 'cloudflare-worker') {
    return planSeparateWorker({ filename, value, authored, worker, accountId, arguments: base });
  }
  if (generated) {
    if (value['targetEnvironment'] !== target.environment || value['name'] !== worker) {
      return err(described('publish.staging.error.builtForProduction', { environment: target.environment }));
    }
    const refusal = routeRefusal(value, productionHosts(authored, production)) ?? sharedResourceRefusal(value, authored);
    return refusal === undefined ? ok({ filename, arguments: base, config: { ...value, account_id: accountId } }) : err(refusal);
  }
  const environments = toRecord(value['env']) ?? {};
  const section = toRecord(environments[target.environment]);
  if (section === undefined) {
    return err(described('publish.staging.error.noEnvironment', { environment: target.environment }));
  }
  return ok({
    filename,
    arguments: [...base, '--env', target.environment],
    // The account is pinned in both places, so an environment cannot send staging to another account.
    config: { ...value, account_id: accountId, env: { ...environments, [target.environment]: { ...section, account_id: accountId } } },
  });
}

/** A separate Worker takes the top-level config without anything that would reach production's traffic or jobs. */
function planSeparateWorker(input: {
  readonly filename: string;
  readonly value: Table;
  readonly authored: Table;
  readonly worker: string;
  readonly accountId: string;
  readonly arguments: readonly string[];
}): Result<WorkerStagingDeploy, Described> {
  // The config being deployed may be a generated one the earlier check never saw.
  if (declaresSharedWork(input.value)) {
    return err(described('publish.staging.error.separateShared'));
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
    account_id: input.accountId,
    workers_dev: true,
  };
  return ok({ filename: input.filename, arguments: input.arguments, config });
}
