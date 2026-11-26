// Add Worker's setup, and the Publish dialog's "Set up Cloudflare": make a site ready to deploy to Cloudflare Workers.
// It writes the site's Worker config when there is none, adds the deploy tool with the site's own package manager when it
// is missing, and then runs checkWorkerReady, the very check Publish runs before it builds. Success is reported only when
// that check passes, so setup and Publish can never disagree. Persisting the chosen Worker in the publish settings is the
// caller's step: it goes through each host's witnessed metadata transport, which this main-side module does not own.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { record } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { problemOf } from '../../shared/properties/describedError';
import { WORKER_NAME_PATTERN, workerHosting, type WorkerSetupRequest, type WorkerSetupResult } from '../../shared/properties/publishWorkerSetup';
import { detectPackageManager } from './packageManager';
import { wranglerInstallArguments } from './publishAccount';
import { runPublishCommand } from './publishCommands';
import type { ExecutableCommand } from './publishExecutable';
import { astroConfigSource, outputDirectory, siteFile } from './publishSiteBuild';
import { WORKER_CONFIG_NAMES, WORKER_READINESS_SEAMS, checkWorkerReady, readWorkerConfig, type WorkerReadinessSeams } from './publishWorkerConfig';

/** Astro adapters that build the site for another host; a site using one cannot deploy as a Worker without changing it. */
const OTHER_HOST_ADAPTERS = ['@astrojs/node', '@astrojs/vercel', '@astrojs/netlify', '@deno/astro-adapter'] as const;
const CLOUDFLARE_ADAPTER = '@astrojs/cloudflare';
/** The config file setup writes: JSONC, so it can say who wrote it and why. */
export const WORKER_CONFIG_WRITTEN = 'wrangler.jsonc';

export interface WorkerSetupSeams extends WorkerReadinessSeams {
  /** Runs a package manager in the site; a test fakes it so no network or process is involved. */
  readonly install: (root: string, command: ExecutableCommand) => Promise<void>;
  /** Today, for the config's compatibility date. */
  readonly today: () => Date;
}

export const WORKER_SETUP_SEAMS: WorkerSetupSeams = {
  ...WORKER_READINESS_SEAMS,
  install: runPublishCommand,
  today: () => new Date(),
};

export async function setUpWorkerHosting(root: string, request: WorkerSetupRequest, seams: WorkerSetupSeams = WORKER_SETUP_SEAMS): Promise<WorkerSetupResult> {
  assert(path.isAbsolute(root), 'Worker setup runs on an absolute site folder');
  assert(WORKER_NAME_PATTERN.test(request.project), 'Worker setup has a valid Worker name');
  const hosting = workerHosting(request);
  const configured = await ensureWorkerConfig(root, request.project, seams.today());
  if (!configured.ok) {
    return failed(configured.error);
  }
  const tool = await ensureWorkerTool(root, seams);
  if (!tool.ok) {
    return failed(tool.error);
  }
  // The same check Publish runs before it builds: setup succeeds only when Publish would go ahead.
  const ready = await checkWorkerReady(root, seams);
  if (!ready.ok) {
    return failed(ready.error);
  }
  return { kind: 'ready', hosting };
}

async function ensureWorkerConfig(root: string, project: string, today: Date): Promise<Result<void, Described>> {
  const existing = await readWorkerConfig(root);
  if (existing.ok) {
    return ok(undefined);
  }
  if (WORKER_CONFIG_NAMES.some((name) => existsSync(path.join(root, name)))) {
    // An authored config is the developer's: setup never rewrites it, only says what it cannot use.
    return existing.error.messageRef?.key === 'publish.worker.setup.needed' ? err(described('publish.worker.setup.existingConfig')) : existing;
  }
  const site = await inspectSite(root);
  if (!site.ok) {
    return site;
  }
  const source = workerConfigSource(project, compatibilityDate(today), site.value);
  try {
    await writeFile(path.join(root, WORKER_CONFIG_WRITTEN), source, { encoding: 'utf8', flag: 'wx' });
  } catch (failure: unknown) {
    console.warn('Worker setup could not write the Worker config.', problemOf(failure).message);
    return err(described('publish.worker.setup.writeFailed'));
  }
  const written = await readWorkerConfig(root);
  assert(written.ok, 'The Worker config setup wrote names what to deploy');
  return ok(undefined);
}

async function ensureWorkerTool(root: string, seams: WorkerSetupSeams): Promise<Result<void, Described>> {
  if (seams.toolInstalled(root)) {
    return ok(undefined);
  }
  if (!existsSync(path.join(root, 'package.json'))) {
    // The tool installs as one of the site's development dependencies, which needs a package.json to hold it.
    return err(described('publish.worker.setup.notSite'));
  }
  const manager = detectPackageManager(root);
  try {
    await seams.install(root, { executable: manager, arguments: wranglerInstallArguments(manager), environment: {} });
  } catch (failure: unknown) {
    // The installer's own words can carry registry credentials; only a sanitized sentence leaves main.
    console.warn('Worker setup could not install the deploy tool.', problemOf(failure).message);
    return err(described('publish.worker.setup.installFailed'));
  }
  if (seams.toolInstalled(root)) {
    return ok(undefined);
  }
  return err(described('publish.worker.setup.installFailed'));
}

/** How a site builds, read as data only: setup never runs site code to find out. */
export type SiteBuild =
  | { readonly kind: 'static'; readonly directory: string }
  | { readonly kind: 'cloudflare-adapter'; readonly directory: string; readonly adapterMajor: number | undefined };

export { outputDirectory };

export async function inspectSite(root: string): Promise<Result<SiteBuild, Described>> {
  const manifest = await siteFile(path.join(root, 'package.json'));
  if (manifest === undefined) {
    return err(described('publish.worker.setup.notSite'));
  }
  let dependencies: Readonly<Record<string, unknown>>;
  try {
    const value = record(JSON.parse(manifest));
    dependencies = { ...optionalRecord(value['devDependencies']), ...optionalRecord(value['dependencies']) };
  } catch {
    return err(described('publish.worker.setup.notSite'));
  }
  const config = await astroConfigSource(root);
  const directory = outputDirectory(config);
  if (directory === undefined) {
    return err(described('publish.worker.setup.outputFolder'));
  }
  const adapter = dependencies[CLOUDFLARE_ADAPTER];
  if (adapter !== undefined) {
    return ok({ kind: 'cloudflare-adapter', directory, adapterMajor: majorVersion(adapter) });
  }
  if (OTHER_HOST_ADAPTERS.some((name) => dependencies[name] !== undefined)) {
    return err(described('publish.worker.setup.otherHost'));
  }
  if (/\boutput\s*:\s*['"`]server['"`]/.test(config ?? '')) {
    return err(described('publish.worker.setup.onDemand'));
  }
  return ok({ kind: 'static', directory });
}

/** The config text for a site: a static site deploys its build folder as assets; an adapter site deploys its server too. */
export function workerConfigSource(project: string, date: string, site: SiteBuild): string {
  assert(WORKER_NAME_PATTERN.test(project), 'The Worker config names a valid Worker');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), 'The compatibility date is a calendar date');
  const base = { name: project, compatibility_date: date };
  const value =
    site.kind === 'static'
      ? { ...base, assets: { directory: site.directory } }
      : {
          // Adapter 13 and later ship their own entry point; earlier versions build one into the output folder.
          main:
            site.adapterMajor !== undefined && site.adapterMajor >= 13 ? `${CLOUDFLARE_ADAPTER}/entrypoints/server` : `${site.directory}/_worker.js/index.js`,
          ...base,
          compatibility_flags: ['nodejs_compat'],
          assets: { binding: 'ASSETS', directory: site.directory },
        };
  return `// Cloudflare Workers settings Stacki wrote when this site was added as a Worker. Edit freely.\n${JSON.stringify(value, undefined, 2)}\n`;
}

export function compatibilityDate(today: Date): string {
  assert(Number.isFinite(today.getTime()), 'Today is a real date');
  return today.toISOString().slice(0, 10);
}

function majorVersion(range: unknown): number | undefined {
  if (typeof range !== 'string') {
    return undefined;
  }
  const match = /(\d+)/.exec(range);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

function optionalRecord(input: unknown): Readonly<Record<string, unknown>> {
  return input === undefined ? {} : record(input);
}

function failed(problem: Described): WorkerSetupResult {
  return problem.messageRef === undefined
    ? { kind: 'failed', message: problem.message }
    : { kind: 'failed', message: problem.message, messageRef: problem.messageRef };
}
