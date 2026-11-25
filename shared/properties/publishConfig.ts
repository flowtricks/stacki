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
    };
export interface PublishConfig {
  readonly publishedSite?: PublishedSite;
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
export const PUBLISH_LIMITS = {
  sourceCharsMax: 16_384,
  hooksMax: 8,
  identifierCharsMax: 100,
  commandTimeoutMs: 600_000,
  outputBytesMax: 1_048_576,
  filesMax: 10_000,
  snapshotBytesMax: 268_435_456,
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
    hosting: parseHosting(value['hosting']),
    buildScript: identifier(value['buildScript']),
    beforePublish: scripts(value['beforePublish']),
    afterPublish: scripts(value['afterPublish']),
  };
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

function parseHosting(input: unknown): Hosting {
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
    default:
      throw new Error('Choose Cloudflare Pages, Cloudflare Workers, Vercel, or no hosting.');
  }
}

function identifier(input: unknown): string {
  const value = text(input);
  if (value.length > PUBLISH_LIMITS.identifierCharsMax) {
    throw new Error('Publish identifier exceeds 100 characters.');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$/.test(value)) {
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
