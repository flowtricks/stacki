import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';
import { parsePublishedSiteURL } from './publishSite';
import { parseGitHubWorkflow, type GitHubWorkflow } from './publishReview';

export type PublishTarget = 'all' | 'github' | 'hosting';
export type Hosting =
  | { readonly provider: 'none' }
  | {
      readonly provider: 'cloudflare';
      readonly accountId: string;
      readonly project: string;
      readonly branch: string;
      readonly directory: string;
    }
  | {
      readonly provider: 'cloudflare-workers';
      readonly accountId: string;
      readonly project: string;
    }
  | {
      readonly provider: 'vercel';
      readonly organizationId: string;
      readonly projectId: string;
    }
  | {
      readonly provider: 'netlify';
      readonly siteId: string;
    };
export const CUSTOM_DEPLOYS = ['github', 'script', 'link'] as const;
export type CustomDeploy = (typeof CUSTOM_DEPLOYS)[number];
interface CustomHostingDetails {
  readonly hostName?: string;
  readonly siteUrl?: string;
}
/**
 * A host Stacki has no integration for. `github`: the host deploys by itself when GitHub changes, so Stacki only pushes.
 * `script`: Stacki builds, then runs a package.json script. `link`: Stacki pushes, then sends a request to the host's
 * private deploy link. The link is a secret: it is never a key of this file (electron/project/deployLinkStore.ts).
 */
export type CustomHosting = CustomHostingDetails &
  ({ readonly deploy: 'github' } | { readonly deploy: 'script'; readonly script: string } | { readonly deploy: 'link' });
export interface PublishConfig {
  readonly publishedSite?: PublishedSite;
  /**
   * Stored beside `hosting`, which stays `none`, never as a provider of its own: Stacki 1.4.21 throws on a provider it
   * does not know, but ignores a key it does not know, so a teammate on it sees "GitHub only" and deploys nowhere.
   */
  readonly customHosting?: CustomHosting;
  readonly githubWorkflow?: GitHubWorkflow;
  readonly version: 1;
  readonly defaultTarget: PublishTarget;
  readonly githubAccount: string;
  readonly hosting: Hosting;
  readonly buildScript: string;
  readonly beforePublish: readonly string[];
  readonly afterPublish: readonly string[];
}
export interface PublishedSite {
  readonly hosting: Exclude<Hosting, { readonly provider: 'none' }>;
  readonly url: string;
  readonly source: 'manual' | 'discovered';
}
export const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
  version: 1,
  defaultTarget: 'all',
  githubAccount: '',
  hosting: { provider: 'none' },
  buildScript: 'build',
  beforePublish: [],
  afterPublish: [],
};
const PUBLISH_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$/;
export const PUBLISH_LIMITS = {
  sourceCharsMax: 16_384,
  hooksMax: 8,
  identifierCharsMax: 100,
  commandTimeoutMs: 600_000,
  outputBytesMax: 1_048_576,
  filesMax: 10_000,
  snapshotBytesMax: 268_435_456,
  hostNameCharsMax: 60,
} as const;

export function parsePublishTarget(input: unknown): PublishTarget {
  if (input === 'all' || input === 'github' || input === 'hosting') {
    return input;
  }
  throw new Error('Choose all, github, or hosting as the publish target.');
}

export function parsePublishCommitMessage(input: unknown): string {
  const message = text(input).trim();
  if (message.length === 0 || message.length > 4000) {
    throw new Error('Enter a commit message between 1 and 4000 characters.');
  }
  return message;
}

export function parsePublishConfig(input: unknown): PublishConfig {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported publish settings version.');
  }
  const githubAccount = text(value['githubAccount']);
  if (githubAccount !== '') {
    identifier(githubAccount);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(githubAccount)) {
      throw new Error('Enter a GitHub username, not a token or email.');
    }
  }
  const hosting = parseHosting(value['hosting']);
  const customHosting = value['customHosting'] === undefined ? undefined : parseCustomHosting(value['customHosting']);
  if (customHosting !== undefined && hosting.provider !== 'none') {
    // Two destinations in one file (a bad merge) must never be resolved by guessing which one to deploy to.
    throw new Error('Custom hosting requires the hosting provider to be none.');
  }
  return {
    version: 1,
    ...(value['publishedSite'] === undefined ? {} : { publishedSite: parsePublishedSite(value['publishedSite']) }),
    ...(value['githubWorkflow'] === undefined
      ? {}
      : {
          githubWorkflow: parseGitHubWorkflow(value['githubWorkflow']),
        }),
    defaultTarget: value['defaultTarget'] === undefined ? 'all' : parsePublishTarget(value['defaultTarget']),
    githubAccount,
    hosting,
    ...(customHosting === undefined ? {} : { customHosting }),
    buildScript: identifier(value['buildScript']),
    beforePublish: scripts(value['beforePublish']),
    afterPublish: scripts(value['afterPublish']),
  };
}

/** Strict: an unknown key is refused, so a deploy link written into this tracked file never passes as a setting. */
export function parseCustomHosting(input: unknown): CustomHosting {
  const value = record(input);
  const deploy = CUSTOM_DEPLOYS.find((entry) => entry === value['deploy']);
  if (deploy === undefined) {
    throw new Error('Choose GitHub auto-deploy, a deploy script, or a deploy link.');
  }
  const allowed = ['deploy', 'hostName', 'siteUrl', ...(deploy === 'script' ? ['script'] : [])];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    // The key is not echoed: a pasted link could be the key itself.
    throw new Error('Custom hosting has a setting Stacki does not know. A deploy link is never saved in this file.');
  }
  const details = {
    ...(value['hostName'] === undefined ? {} : { hostName: parseHostName(value['hostName']) }),
    ...(value['siteUrl'] === undefined ? {} : { siteUrl: parseCustomSiteURL(value['siteUrl']) }),
  };
  const custom: CustomHosting = deploy === 'script' ? { deploy, script: identifier(value['script']), ...details } : { deploy, ...details };
  assert(custom.deploy === deploy, 'A custom host keeps the way it was said to deploy');
  return custom;
}

export function parseHostName(input: unknown): string {
  const value = text(input).trim();
  if (value.length === 0 || value.length > PUBLISH_LIMITS.hostNameCharsMax) {
    throw new Error('A host name has 1 to 60 characters.');
  }
  // No slashes or control characters: a name is a name, and a link pasted here would be committed.
  if (/[/\\\p{Cc}]/u.test(value)) {
    throw new Error('A host name cannot be a link or contain slashes.');
  }
  return value;
}

/** The published-site address rules (an https origin, no path), with a refusal that never repeats the input. */
function parseCustomSiteURL(input: unknown): string {
  try {
    return parsePublishedSiteURL(input);
  } catch {
    throw new Error('The site address must be like https://example.com, with no path.');
  }
}

/** Whether publishing has anything to do after GitHub: a connected provider, a deploy script or a deploy link. */
export function deploysFromStacki(config: Pick<PublishConfig, 'hosting' | 'customHosting'>): boolean {
  if (config.hosting.provider !== 'none') {
    return true;
  }
  return config.customHosting !== undefined && config.customHosting.deploy !== 'github';
}

/** What the main Publish button does. A host that deploys from GitHub has only one thing to publish to: GitHub. */
export function publishDefaultTarget(config: Pick<PublishConfig, 'defaultTarget' | 'customHosting'>): PublishTarget {
  const target = config.customHosting?.deploy === 'github' ? 'github' : config.defaultTarget;
  assert(target.length > 0, 'Publish always has a default destination');
  return target;
}

/** The config with a provider chosen: any custom host the file held is replaced, never kept beside it. */
export function withHosting(config: PublishConfig, hosting: Hosting): PublishConfig {
  const { customHosting: replaced, ...rest } = config;
  void replaced;
  const next: PublishConfig = { ...rest, hosting };
  assert(next.customHosting === undefined, 'A chosen provider never sits beside a custom host');
  return next;
}

export function isPublishScriptName(input: string): boolean {
  return input.length <= PUBLISH_LIMITS.identifierCharsMax && PUBLISH_IDENTIFIER.test(input);
}

function parsePublishedSite(input: unknown): PublishedSite {
  const value = record(input);
  const hosting = parseHosting(value['hosting']);
  if (hosting.provider === 'none') {
    throw new Error('Published site must belong to a hosting destination.');
  }
  const source = value['source'];
  if (source !== 'manual') {
    if (source !== 'discovered') {
      throw new Error('Invalid published site source.');
    }
  }
  return { hosting, source, url: parsePublishedSiteURL(value['url']) };
}

export function parsePublishSource(source: string | undefined): PublishConfig {
  if (source === undefined) {
    return DEFAULT_PUBLISH_CONFIG;
  }
  if (source.length > PUBLISH_LIMITS.sourceCharsMax) {
    throw new Error('Publish settings exceed 16 KiB.');
  }
  const value: unknown = JSON.parse(source);
  return parsePublishConfig(value);
}

export function parseHosting(input: unknown): Hosting {
  const value = record(input);
  switch (value['provider']) {
    case 'none':
      return { provider: 'none' };
    case 'cloudflare':
      return {
        provider: 'cloudflare',
        accountId: identifier(value['accountId']),
        project: identifier(value['project']),
        branch: branchName(value['branch']),
        directory: outputDirectory(value['directory']),
      };
    case 'cloudflare-workers':
      return {
        provider: 'cloudflare-workers',
        accountId: identifier(value['accountId']),
        project: identifier(value['project']),
      };
    case 'vercel':
      return {
        provider: 'vercel',
        organizationId: identifier(value['organizationId']),
        projectId: identifier(value['projectId']),
      };
    case 'netlify':
      return { provider: 'netlify', siteId: identifier(value['siteId']) };
    default:
      throw new Error('Choose Cloudflare Pages, Cloudflare Workers, Vercel, Netlify, or no hosting.');
  }
}

function identifier(input: unknown): string {
  const value = text(input);
  if (value.length > PUBLISH_LIMITS.identifierCharsMax) {
    throw new Error('Publish identifier exceeds 100 characters.');
  }
  if (!PUBLISH_IDENTIFIER.test(value)) {
    throw new Error('Publish identifiers must be nonempty names, not commands.');
  }
  return value;
}

function scripts(input: unknown): readonly string[] {
  const values = list(identifier)(input);
  if (values.length > PUBLISH_LIMITS.hooksMax) {
    throw new Error('Use at most eight scripts per publish hook.');
  }
  return values;
}

function branchName(input: unknown): string {
  const value = text(input);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,99}$/.test(value)) {
    throw new Error('Invalid hosting production branch.');
  }
  return value;
}

function outputDirectory(input: unknown): string {
  const value = text(input);
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value)) {
    throw new Error('Build output must be a relative project directory.');
  }
  if (value.length > 256 || value.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Build output must stay inside the project.');
  }
  return value;
}
