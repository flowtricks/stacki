// What a new destination starts as. The simple default is production's own host in its preview, branch or environment
// form, preselected from what the project already declares; each added destination gets values no other one uses.
import { assert } from '../core/assert';
import type { PublishConfig } from './publishConfig';
import { destinationConflict } from './publishDestinationConflicts';
import { DESTINATION_LIMITS, destinationLabelKey, type Destination, type DestinationId, type DestinationTarget } from './publishDestinations';

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

/** Production's own host in its safe form, or Custom where production has no host Stacki deploys to. */
export type SuggestionHost = 'same' | 'custom';

export interface Suggestion {
  readonly id: DestinationId;
  readonly label: string;
}

/** The destination a project most likely wants next. Fields nothing suggests are left for the person. */
export function suggestDestination(
  production: PublishConfig,
  detected: DetectedProject,
  identity: Suggestion,
  others: readonly Destination[],
  host: SuggestionHost = 'same',
): Destination {
  assert(detected.environments.length <= DESTINATION_LIMITS.environmentsMax, 'Detected environments stay bounded');
  assert(others.length < DESTINATION_LIMITS.destinationsMax, 'There is room for the destination being suggested');
  const name = suggestedName(identity.label, others);
  const from: PublishConfig = host === 'custom' ? { ...production, hosting: { provider: 'none' } } : production;
  const target = suggestTarget(from, detected, name, others);
  // `build:staging` is staging's convention; another destination gets a build of its own name only if there is one.
  const own = [`build:${name}`, `build-${name}`].find((script) => detected.scripts.includes(script));
  const buildScript = own ?? (production.buildScript === '' ? 'build' : production.buildScript);
  const siteUrl = target.kind === 'cloudflare-environment' ? detected.environments.find((entry) => entry.name === target.environment)?.siteUrl : undefined;
  return {
    ...identity,
    target,
    buildScript,
    beforePublish: [],
    afterPublish: [],
    ...(siteUrl === undefined ? {} : { siteUrl }),
  };
}

/** The label as a branch, alias or Worker suffix could be written. A label with no Latin letters or digits (it may be
 * in any language) still gets a usable name. */
export function destinationSlug(label: string): string {
  const slug = destinationLabelKey(label)
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '');
  const name = slug === '' ? 'staging' : slug;
  assert(!name.startsWith('-'), 'A name never reads as a command-line option');
  return name;
}

/** A short name from the label, free of every other destination's. */
function suggestedName(label: string, others: readonly Destination[]): string {
  const used = new Set(
    others.flatMap((other) => {
      const { target } = other;
      switch (target.kind) {
        case 'cloudflare-environment':
          return [target.environment.toLowerCase()];
        case 'cloudflare-pages':
        case 'github-branch':
        case 'link':
          return [target.branch.toLowerCase()];
        case 'netlify':
          return [target.alias];
        case 'cloudflare-worker':
        case 'vercel':
        case 'host':
        case 'script':
          return [];
      }
    }),
  );
  const base = destinationSlug(label);
  const candidates = [base, ...Array.from({ length: DESTINATION_LIMITS.destinationsMax }, (_, index) => `${base}-${index + 2}`)];
  const free = candidates.find((candidate) => !used.has(candidate) && !['main', 'master', 'production', 'prod', 'live'].includes(candidate));
  assert(free !== undefined, 'There are more candidates than other destinations');
  return free;
}

function suggestTarget(production: PublishConfig, detected: DetectedProject, name: string, others: readonly Destination[]): DestinationTarget {
  switch (production.hosting.provider) {
    case 'cloudflare-workers':
      return suggestWorker(production, detected, name, others);
    case 'cloudflare':
      return { kind: 'cloudflare-pages', branch: name };
    case 'vercel':
      return { kind: 'vercel' };
    case 'netlify':
      return { kind: 'netlify', alias: name };
    case 'none': {
      const script = [`deploy:${name}`].find((entry) => detected.scripts.includes(entry) && !others.some((other) => scriptOf(other) === entry));
      return script === undefined ? { kind: 'github-branch', branch: name } : { kind: 'script', script };
    }
    default: {
      const exhaustive: never = production.hosting;
      return exhaustive;
    }
  }
}

function scriptOf(destination: Destination): string | undefined {
  return destination.target.kind === 'script' ? destination.target.script : undefined;
}

/** An environment the config declares and no other destination uses, preferring one of the same name; else a Worker. */
function suggestWorker(production: PublishConfig, detected: DetectedProject, name: string, others: readonly Destination[]): DestinationTarget {
  assert(production.hosting.provider === 'cloudflare-workers', 'A Worker form belongs to Worker production');
  const project = production.hosting.project;
  const ordered = [...detected.environments].sort((left, right) => Number(right.name === name) - Number(left.name === name));
  const environment = ordered.find((entry) => {
    const candidate: Destination = {
      id: 'candidate',
      label: 'Candidate',
      target: { kind: 'cloudflare-environment', environment: entry.name },
      buildScript: 'build',
      beforePublish: [],
      afterPublish: [],
    };
    return destinationConflict(production, candidate, others).ok;
  });
  return environment === undefined
    ? { kind: 'cloudflare-worker', project: suggestedWorkerName(project, name) }
    : { kind: 'cloudflare-environment', environment: environment.name };
}

export function suggestedWorkerName(project: string, name: string): string {
  assert(name.length > 0, 'A Worker is named for its destination');
  const suffix = `-${name}`.slice(0, 25);
  const base = project
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, DESTINATION_LIMITS.workerNameCharsMax - suffix.length);
  const worker = `${base}${suffix}`.replace(/^-+/, '').replace(/-+$/, '');
  assert(worker.length <= DESTINATION_LIMITS.workerNameCharsMax, 'A suggested Worker name stays within Cloudflare’s limit');
  assert(!worker.startsWith('-'), 'A Worker name never reads as a command-line option');
  return worker;
}
