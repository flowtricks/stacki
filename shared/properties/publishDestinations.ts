// `.stacki/publish-destinations.json`: the places a project publishes besides production, such as staging and review
// sites. Production stays where it always was (`.stacki/publish.json`, publishConfig.ts); every other destination is
// one entry of this bounded list, with an id that never changes and a label the person can rename at any time.
//
// Why a file of its own: Stacki 1.4.21 rebuilds publish.json from the keys it knows, and rewrites it on its own when
// it learns the published site's address. A destination kept there would be silently erased by a teammate on that
// version. It never reads or writes this file, so it can neither lose a destination nor deploy one's settings anywhere.
//
// The invariant: publishing to a destination can never change production or another destination. This file only says
// what each destination is. What the settings alone prove wrong is in publishDestinationConflicts.ts, and what only
// the site's own files or the host can say is checked by electron/project/publishDestinationCheck.ts before anything
// is built, pushed or deployed.
import { list, record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parsePublishedSiteURL } from './publishSite';
import { isPublishScriptName, parseHosting, type Hosting, type PublishTarget } from './publishConfig';

export const DESTINATION_LIMITS = {
  destinationsMax: 10,
  sourceCharsMax: 65_536,
  hooksMax: 8,
  idCharsMax: 40,
  labelCharsMax: 60,
  branchCharsMax: 100,
  workerNameCharsMax: 63,
  netlifyAliasCharsMax: 37,
  environmentsMax: 20,
} as const satisfies Record<string, number>;

/** A destination's identity: its receipt, deploy link and status follow it, whatever it is renamed to. */
export type DestinationId = string;

/** Lowercase only, so it names the same file on every filesystem. */
export const DESTINATION_ID_PATTERN = '^[a-z][a-z0-9-]{0,39}$';
/** Words a publish request, a receipt or a deploy link already means something else by. */
export const RESERVED_DESTINATION_IDS: readonly string[] = ['production', 'all', 'github', 'hosting', 'default'];
/** The id the one destination of earlier preview builds had. Its receipt and deploy link are kept under it. */
export const LEGACY_DESTINATION_ID = 'staging';
const LEGACY_LABEL = 'Staging';

export function parseDestinationId(input: unknown): DestinationId {
  const value = text(input);
  if (value.length > DESTINATION_LIMITS.idCharsMax || !new RegExp(DESTINATION_ID_PATTERN).test(value)) {
    throw new Error('A destination id is a short lowercase name.');
  }
  if (RESERVED_DESTINATION_IDS.includes(value)) {
    throw new Error('That destination id is reserved.');
  }
  assert(value === value.toLowerCase(), 'An id names the same file on every filesystem');
  return value;
}

/** What a publish request can ask for. A destination is never a default target: 1.4.21 refuses a default it does not know. */
export type PublishRequestTarget = PublishTarget | `destination:${DestinationId}`;

const REQUEST_PREFIX = 'destination:';

export function destinationRequest(id: DestinationId): PublishRequestTarget {
  assert(parseDestinationId(id) === id, 'A publish request names a valid destination');
  return `destination:${id}`;
}

/** The destination a request names; absent for the three production targets. */
export function requestedDestination(target: PublishRequestTarget): DestinationId | undefined {
  if (target === 'all' || target === 'github' || target === 'hosting') {
    return undefined;
  }
  assert(target.startsWith(REQUEST_PREFIX), 'A destination request says that it is one');
  const id = target.slice(REQUEST_PREFIX.length);
  assert(!RESERVED_DESTINATION_IDS.includes(id), 'A destination request never names production');
  return id;
}

export function parsePublishRequestTarget(input: unknown): PublishRequestTarget {
  if (input === 'all' || input === 'github' || input === 'hosting') {
    return input;
  }
  if (typeof input === 'string' && input.startsWith(REQUEST_PREFIX) && input.length <= REQUEST_PREFIX.length + DESTINATION_LIMITS.idCharsMax) {
    return `destination:${parseDestinationId(input.slice(REQUEST_PREFIX.length))}`;
  }
  throw new Error('Choose all, github, hosting, or one saved destination as the publish target.');
}

/** A host account and project of the destination's own, apart from whatever production uses. */
export type OwnHosting = Exclude<Hosting, { readonly provider: 'none' }>;

export type DestinationTarget =
  /** An `env.*` section of the site's Wrangler config, deployed beside production's Worker. */
  | { readonly kind: 'cloudflare-environment'; readonly environment: string }
  /** A separate Worker in production's account, from the top-level Wrangler config without its routes or schedules. */
  | { readonly kind: 'cloudflare-worker'; readonly project: string }
  /** A preview branch of production's Pages project. */
  | { readonly kind: 'cloudflare-pages'; readonly branch: string }
  /** A Vercel preview deployment of production's project. */
  | { readonly kind: 'vercel' }
  /** A Netlify draft deploy of production's site under a fixed alias. */
  | { readonly kind: 'netlify'; readonly alias: string }
  /** An account and project of the destination's own: it is published as that project's live site. */
  | { readonly kind: 'host'; readonly hosting: OwnHosting }
  /** A host that builds a branch by itself: Stacki pushes to that branch only. */
  | { readonly kind: 'github-branch'; readonly branch: string }
  /** Stacki builds, then runs a package.json script. GitHub is not touched. */
  | { readonly kind: 'script'; readonly script: string }
  /** Stacki pushes to the destination's branch only, then sends the destination's own deploy link. */
  | { readonly kind: 'link'; readonly branch: string };

export type DestinationKind = DestinationTarget['kind'];

export interface Destination {
  readonly id: DestinationId;
  /** What the person calls it. Unique in the project, and free to change: nothing is keyed by it. */
  readonly label: string;
  readonly target: DestinationTarget;
  readonly buildScript: string;
  /** This destination's own hooks. Production's hooks and other destinations' never run for it. */
  readonly beforePublish: readonly string[];
  readonly afterPublish: readonly string[];
  readonly siteUrl?: string;
}

export interface PublishDestinations {
  readonly version: 1;
  readonly destinations: readonly Destination[];
}

export const NO_DESTINATIONS: PublishDestinations = { version: 1, destinations: [] };

export function findDestination(destinations: PublishDestinations, id: DestinationId): Destination | undefined {
  return destinations.destinations.find((destination) => destination.id === id);
}

export function otherDestinations(destinations: readonly Destination[], id: DestinationId): readonly Destination[] {
  const others = destinations.filter((destination) => destination.id !== id);
  assert(others.length <= destinations.length, 'Leaving one out never adds one');
  return others;
}

/** Two labels that would read the same: case, width, spacing and invisible characters do not tell them apart. */
export function destinationLabelKey(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Labels that would read as production's own row or GitHub's. */
const RESERVED_LABELS: readonly string[] = ['production', 'github'];

export type LabelProblem = 'blank' | 'invalid' | 'reserved' | 'taken';

/** Why `label` cannot name a destination beside `others`, answered as a value so the form can say which it is. */
export function destinationLabelProblem(label: string, others: readonly string[]): LabelProblem | undefined {
  const key = destinationLabelKey(label);
  if (key === '') {
    return 'blank';
  }
  // No slashes or control characters: a label is committed to Git, and a link pasted here would be too. Characters that
  // reorder text could make one label read as another.
  if (label.trim().length > DESTINATION_LIMITS.labelCharsMax || /[/\\\p{Cc}‪-‮⁦-⁩]/u.test(label)) {
    return 'invalid';
  }
  if (RESERVED_LABELS.includes(key)) {
    return 'reserved';
  }
  return others.some((other) => destinationLabelKey(other) === key) ? 'taken' : undefined;
}

/** A default label no other destination has: the base itself, then the base with the lowest free number. */
export function nextDestinationLabel(base: string, labels: readonly string[]): string {
  assert(destinationLabelKey(base) !== '', 'A default label has words');
  assert(labels.length <= DESTINATION_LIMITS.destinationsMax, 'Labels stay bounded');
  const taken = new Set(labels.map(destinationLabelKey));
  const candidates = Array.from({ length: DESTINATION_LIMITS.destinationsMax + 1 }, (_, index) => (index === 0 ? base : `${base} ${index + 1}`));
  const free = candidates.find((candidate) => !taken.has(destinationLabelKey(candidate)));
  assert(free !== undefined, 'There are more candidates than labels');
  return free;
}

export function parseDestinationsSource(source: string | undefined): PublishDestinations {
  if (source === undefined) {
    return NO_DESTINATIONS;
  }
  if (source.length > DESTINATION_LIMITS.sourceCharsMax) {
    throw new Error('Publish destinations exceed 64 KiB.');
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
  const entries = list((entry) => entry)(value['destinations']);
  if (entries.length > DESTINATION_LIMITS.destinationsMax) {
    throw new Error(`A project has at most ${DESTINATION_LIMITS.destinationsMax} publish destinations.`);
  }
  const destinations = entries.map(parseDestination);
  if (new Set(destinations.map((destination) => destination.id)).size !== destinations.length) {
    throw new Error('Each publish destination has its own id.');
  }
  if (new Set(destinations.map((destination) => destinationLabelKey(destination.label))).size !== destinations.length) {
    throw new Error('Each publish destination has its own label.');
  }
  assert(destinations.length <= DESTINATION_LIMITS.destinationsMax, 'Saved destinations stay bounded');
  return { version: 1, destinations };
}

/** Strict, like custom hosting: an unknown key is refused, so a deploy link cannot be saved in this tracked file. */
function parseDestination(input: unknown): Destination {
  const value = record(input);
  requireKeys(value, ['id', 'label', 'name', 'target', 'buildScript', 'beforePublish', 'afterPublish', 'siteUrl']);
  const id = parseDestinationId(value['id']);
  return {
    id,
    label: parseDestinationLabel(savedLabel(id, value)),
    target: parseDestinationTarget(value['target']),
    buildScript: scriptName(value['buildScript']),
    beforePublish: scriptNames(value['beforePublish']),
    afterPublish: scriptNames(value['afterPublish']),
    ...(value['siteUrl'] === undefined ? {} : { siteUrl: parseDestinationSiteURL(value['siteUrl']) }),
  };
}

/**
 * Preview builds saved one destination, `staging`, with an optional `name` and no label. It is read as it stands, and
 * the next save writes the label: nothing it held is lost, and its receipt and deploy link stay under the same id.
 */
function savedLabel(id: DestinationId, value: Readonly<Record<string, unknown>>): unknown {
  if (value['name'] === undefined) {
    return value['label'] ?? (id === LEGACY_DESTINATION_ID ? LEGACY_LABEL : undefined);
  }
  if (id !== LEGACY_DESTINATION_ID || value['label'] !== undefined) {
    throw new Error('A publish destination is named by its label.');
  }
  // The preview build allowed any name; one that would read as production's row keeps the label it was known by.
  const name = text(value['name']);
  return destinationLabelProblem(name, []) === 'reserved' ? LEGACY_LABEL : name;
}

export function parseDestinationLabel(input: unknown): string {
  const value = text(input).trim();
  if (destinationLabelProblem(value, []) !== undefined) {
    // The label is not echoed: a pasted link could be the label.
    throw new Error('A destination label has 1 to 60 characters, no slashes, and is not Production or GitHub.');
  }
  assert(destinationLabelKey(value) !== '', 'A parsed label has words to show');
  return value;
}

export function parseDestinationTarget(input: unknown): DestinationTarget {
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
      return { kind, branch: parseDestinationBranch(value['branch']) };
    case 'vercel':
      requireKeys(value, ['kind']);
      return { kind };
    case 'netlify':
      requireKeys(value, ['kind', 'alias']);
      return { kind, alias: parseNetlifyAlias(value['alias']) };
    case 'host':
      requireKeys(value, ['kind', 'hosting']);
      return { kind, hosting: parseOwnHosting(value['hosting']) };
    case 'script':
      requireKeys(value, ['kind', 'script']);
      return { kind, script: scriptName(value['script']) };
    default:
      throw new Error('Unknown publish destination kind.');
  }
}

const HOSTING_KEYS = {
  cloudflare: ['provider', 'accountId', 'project', 'branch', 'directory'],
  'cloudflare-workers': ['provider', 'accountId', 'project'],
  vercel: ['provider', 'organizationId', 'projectId'],
  netlify: ['provider', 'siteId'],
} as const satisfies Record<OwnHosting['provider'], readonly string[]>;

function parseOwnHosting(input: unknown): OwnHosting {
  const hosting = parseHosting(input);
  if (hosting.provider === 'none') {
    throw new Error('A destination with its own host names Cloudflare, Vercel or Netlify.');
  }
  requireKeys(record(input), HOSTING_KEYS[hosting.provider]);
  if (hosting.provider === 'cloudflare-workers') {
    // The Worker name is passed to Wrangler as an argument, so it is held to Cloudflare's own rule.
    assert(parseWorkerName(hosting.project) === hosting.project, 'A Worker name is used as it is saved');
  }
  return hosting;
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
export function parseDestinationBranch(input: unknown): string {
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

/** Whether Stacki's own build produces what the destination serves; where the host builds, a build script is not offered. */
export function destinationBuildsLocally(target: DestinationTarget): boolean {
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
    case 'cloudflare-pages':
    case 'netlify':
    case 'script':
      return true;
    case 'host':
      return target.hosting.provider !== 'vercel';
    case 'vercel':
    case 'github-branch':
    case 'link':
      return false;
  }
}

/** Whether publishing the destination pushes its branch to GitHub. No other kind touches GitHub at all. */
export function destinationBranch(target: DestinationTarget): string | undefined {
  return target.kind === 'github-branch' || target.kind === 'link' ? target.branch : undefined;
}

/** The host a destination is on, for its icon and its name: production's for a borrowed form, or its own. */
export function destinationProvider(target: DestinationTarget): OwnHosting['provider'] | 'custom' {
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      return 'cloudflare-workers';
    case 'cloudflare-pages':
      return 'cloudflare';
    case 'vercel':
    case 'netlify':
      return target.kind;
    case 'host':
      return target.hosting.provider;
    case 'github-branch':
    case 'script':
    case 'link':
      return 'custom';
  }
}
