import { boolean, list, record, text } from '../core/boundary';
import { parseOptionalMessageRef, type MessageRef } from '../core/i18n/messageReference';
import { parseGitHubRepository } from './githubRepository';

export type RepositoryRequest =
  | { readonly action: 'list'; readonly account: string }
  | {
      readonly action: 'connect';
      readonly account: string;
      readonly repository: string;
      readonly revision: string;
    }
  | {
      readonly action: 'create';
      /** The signed-in GitHub account whose credential makes the request. */
      readonly account: string;
      /** Who owns the new repository: `account` for a personal repository, or an organization login. */
      readonly owner: string;
      readonly name: string;
      readonly private: boolean;
    };
export interface PublishingRepositories {
  readonly connected: string;
  readonly revision: string;
  readonly repositories: readonly string[];
  readonly mode: 'editable' | 'managed';
  /** Organizations the account can create repositories in (logins, sorted); empty until a list asks. */
  readonly organizations: readonly string[];
  /** Whether `organizations` is the whole answer: a missing token scope or a failed read is told apart from "no organizations". */
  readonly organizationAccess: OrganizationAccess;
  readonly notice: string;
  /** The translatable form of `notice` when Stacki wrote the sentence; absent from older producers, which show the English `notice`. */
  readonly noticeRef?: MessageRef | undefined;
}
export type OrganizationAccess = 'available' | 'needsScope' | 'failed';
export type RepositoryResult =
  { readonly ok: true; readonly value: PublishingRepositories } | { readonly ok: false; readonly error: string; readonly errorRef?: MessageRef | undefined };
export const REPOSITORIES_MAX = 500;
/** Most organizations one list carries. GitHub's own memberships page holds 100; three pages cover nearly every account. */
export const ORGANIZATIONS_MAX = 300;
export const ORGANIZATION_PAGE_SIZE = 100;
export const ORGANIZATION_PAGES_MAX = 3;

const OWNER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;

/** A GitHub user or organization login, checked once at the boundary. */
export function parseGitHubOwner(input: unknown): string {
  const value = text(input);
  if (!OWNER_PATTERN.test(value)) {
    throw new Error('Enter a GitHub account or organization name.');
  }
  return value;
}

export function parseRepositoryRequest(input: unknown): RepositoryRequest {
  const value = record(input);
  const account = text(value['account']);
  if (!OWNER_PATTERN.test(account)) {
    throw new Error('Choose a signed-in GitHub account.');
  }
  switch (value['action']) {
    case 'list':
      return { action: 'list', account };
    case 'connect':
      return {
        action: 'connect',
        account,
        repository: parseGitHubRepository(value['repository']),
        revision: revision(value['revision']),
      };
    case 'create': {
      const owner = parseGitHubOwner(value['owner']);
      const name = text(value['name']);
      parseGitHubRepository(`${owner}/${name}`);
      return { action: 'create', account, owner, name, private: boolean(value['private']) };
    }
    default:
      throw new Error('Unknown repository action.');
  }
}

export function parseRepositoryResult(input: unknown): RepositoryResult {
  const result = record(input);
  if (!boolean(result['ok'])) {
    const errorRef = parseOptionalMessageRef(result['errorRef']);
    const error = message(result['error']);
    return errorRef === undefined ? { ok: false, error } : { ok: false, error, errorRef };
  }
  const value = record(result['value']);
  const connected = text(value['connected']);
  const repositories = list(parseGitHubRepository)(value['repositories']);
  if (repositories.length > REPOSITORIES_MAX) {
    throw new Error('Repository list exceeds 500 entries.');
  }
  const mode = value['mode'];
  if (mode !== 'editable' && mode !== 'managed') {
    throw new Error('Invalid repository connection mode.');
  }
  const noticeRef = parseOptionalMessageRef(value['noticeRef']);
  const organizations = list(parseGitHubOwner)(value['organizations']);
  if (organizations.length > ORGANIZATIONS_MAX) {
    throw new Error('Organization list exceeds its limit.');
  }
  const organizationAccess = value['organizationAccess'];
  if (organizationAccess !== 'available' && organizationAccess !== 'needsScope' && organizationAccess !== 'failed') {
    throw new Error('Invalid organization access state.');
  }
  return {
    ok: true,
    value: {
      connected: connected ? parseGitHubRepository(connected) : '',
      revision: revision(value['revision']),
      repositories,
      mode,
      organizations,
      organizationAccess,
      notice: message(value['notice']),
      ...(noticeRef === undefined ? {} : { noticeRef }),
    },
  };
}
function revision(input: unknown): string {
  const value = text(input);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid repository connection revision.');
  }
  return value;
}
function message(input: unknown): string {
  const value = text(input);
  if (value.length > 1000) {
    throw new Error('Repository message exceeds its limit.');
  }
  return value;
}

/**
 * One page of `GET /user/memberships/orgs?state=active`: the organizations the account can create
 * repositories in, by login. A billing manager belongs to an organization but cannot create in it, and
 * a pending invitation is not a membership, so both are left out. Members stay listed: whether an
 * organization lets members create repositories is not in this reply, so GitHub's refusal at creation
 * is the check (see `classifyCreateFailure`).
 */
export function parseOrganizationMemberships(input: unknown): readonly string[] {
  const entries = list(record)(input);
  if (entries.length > ORGANIZATION_PAGE_SIZE) {
    throw new Error('Organization page exceeds its limit.');
  }
  const logins: string[] = [];
  for (const entry of entries) {
    const role = entry['role'];
    if (role !== 'admin' && role !== 'member' && role !== 'billing_manager') {
      throw new Error('Unknown organization role.');
    }
    const state = entry['state'];
    if (state !== 'active' && state !== 'pending') {
      throw new Error('Unknown organization membership state.');
    }
    const login = parseGitHubOwner(record(entry['organization'])['login']);
    if (state === 'active' && role !== 'billing_manager') {
      logins.push(login);
    }
  }
  return logins;
}

/** Merges pages into one list: no duplicates, sorted without regard to case, bounded. */
export function mergeOrganizations(pages: ReadonlyArray<readonly string[]>): readonly string[] {
  const unique = new Set<string>();
  for (const page of pages) {
    for (const login of page) {
      unique.add(login);
    }
  }
  if (unique.size > ORGANIZATIONS_MAX) {
    throw new Error('Too many organizations.');
  }
  return [...unique].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

/**
 * Why listing organizations failed, from `gh`'s error text. `gh` names the scope an endpoint needs
 * (it needs the read:org scope), which is the one state the person can fix, so it is told apart.
 */
export function classifyOrganizationFailure(stderr: string): Exclude<OrganizationAccess, 'available'> {
  return /read:org|admin:org|\bneeds the ".*" scope/i.test(stderr) ? 'needsScope' : 'failed';
}

export type CreateFailure = 'exists' | 'approval' | 'forbidden' | 'other';

/**
 * Why `gh repo create` failed, from its error text. Approval is checked first: a single-sign-on or
 * third-party-application block also answers 403, which would otherwise read as "not allowed".
 */
export function classifyCreateFailure(stderr: string): CreateFailure {
  if (/saml|single sign-on|\bsso\b|oauth app access restrictions|third-party application/i.test(stderr)) {
    return 'approval';
  }
  if (/already exists/i.test(stderr)) {
    return 'exists';
  }
  if (/http 403|http 404|not allowed|permission|must be an owner|resource not accessible|forbidden|not authorized/i.test(stderr)) {
    return 'forbidden';
  }
  return 'other';
}
