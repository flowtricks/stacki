import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { git, run } from '../lib/nodeTools';
import { sameFilesystemPath } from '../lib/platform';
import { record, list } from '../../shared/core/boundary';
import { parseGitHubRepository } from '../../shared/ipc/githubRepository';
import {
  classifyCreateFailure,
  classifyOrganizationFailure,
  mergeOrganizations,
  ORGANIZATION_PAGE_SIZE,
  ORGANIZATION_PAGES_MAX,
  parseOrganizationMemberships,
  parseRepositoryRequest,
  REPOSITORIES_MAX,
  type OrganizationAccess,
  type RepositoryRequest,
  type RepositoryResult,
  type PublishingRepositories,
} from '../../shared/ipc/publishRepository';
import { DEFAULT_PUBLISH_CONFIG } from '../../shared/properties/publishConfig';
import { described, type Described, type MessageKey } from '../../shared/properties/i18n/messageRef';
import type { MessageParams } from '../../shared/core/i18n/catalog';
import { publishingGitEnvironment } from './publishGitHub';

/** Repository setup never commits, pulls, or pushes project files. */
export async function publishingRepositories(root: string, input: RepositoryRequest): Promise<RepositoryResult> {
  const request = parseRepositoryRequest(input);
  try {
    const state = await repositoryState(root);
    if (request.action === 'list') {
      return { ok: true, value: await repositoryList(root, request.account, state) };
    }
    const environment = await publishingGitEnvironment(root, {
      ...DEFAULT_PUBLISH_CONFIG,
      githubAccount: request.account,
    });
    if (request.action === 'create') {
      // The owner is the person's choice (their account or an organization); the credential stays the account's.
      const repository = parseGitHubRepository(`${request.owner}/${request.name}`);
      try {
        await repositoryCommand(root, ['repo', 'create', repository, request.private ? '--private' : '--public'], environment);
      } catch (failure: unknown) {
        return createFailure(failure, request.owner, repository);
      }
      return { ok: true, value: { ...state, repositories: [repository] } };
    }
    const access = record(await repositoryJSON(root, ['api', `repos/${request.repository}`], environment));
    if (record(access['permissions'])['push'] !== true) {
      return failure('publish.repositories.error.noWriteAccess');
    }
    return connectPublishingRepository(root, request);
  } catch {
    return failure(request.action === 'create' ? 'publish.repositories.error.createFailed' : 'publish.repositories.error.accessFailed');
  }
}

// The English sentence stays in `error`; the reference beside it lets the screen show the person's language.
function failure(key: MessageKey, params?: MessageParams): Extract<RepositoryResult, { readonly ok: false }> {
  const problem: Described = described(key, params);
  return problem.messageRef === undefined ? { ok: false, error: problem.message } : { ok: false, error: problem.message, errorRef: problem.messageRef };
}

// Expected refusals (name taken, organization approval, no permission) are told apart so the person knows what to change.
function createFailure(failureValue: unknown, owner: string, repository: string): Extract<RepositoryResult, { readonly ok: false }> {
  const kind = classifyCreateFailure(commandErrorText(failureValue));
  switch (kind) {
    case 'exists':
      return failure('publish.repositories.error.exists', { repository });
    case 'approval':
      return failure('publish.repositories.error.organizationApproval', { owner });
    case 'forbidden':
      return failure('publish.repositories.error.organizationForbids', { owner });
    case 'other':
      return failure('publish.repositories.error.createFailed');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function commandErrorText(failureValue: unknown): string {
  if (typeof failureValue !== 'object' || failureValue === null) {
    return '';
  }
  const stderr: unknown = Reflect.get(failureValue, 'stderr');
  const message: unknown = Reflect.get(failureValue, 'message');
  return `${typeof stderr === 'string' ? stderr : ''}\n${typeof message === 'string' ? message : ''}`;
}

export async function repositoryState(root: string): Promise<PublishingRepositories> {
  const top = await repositoryRoot(root);
  if (top && !sameFilesystemPath(realpathSync.native(top), realpathSync.native(root))) {
    throw new Error('Open the repository root to change its connection.');
  }
  let remote = '';
  if (top) {
    const remotes = (await git(root, ['remote'])).stdout.trim().split('\n');
    if (remotes.includes('origin')) {
      remote = (await git(root, ['remote', 'get-url', 'origin'])).stdout.trim();
    }
  }
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  const connected = match?.[1] ? parseGitHubRepository(match[1]) : '';
  return {
    connected,
    revision: createHash('sha256').update(remote).digest('hex'),
    repositories: connected ? [connected] : [],
    mode: 'editable',
    organizations: [],
    organizationAccess: 'available',
    notice: '',
  };
}

export async function connectPublishingRepository(
  root: string,
  request: Extract<RepositoryRequest, { readonly action: 'connect' }>,
): Promise<RepositoryResult> {
  const current = await repositoryState(root);
  if (current.revision !== request.revision) {
    return failure('publish.repositories.error.changed');
  }
  if (!(await repositoryRoot(root))) {
    await git(root, ['init', '--initial-branch=main']);
  }
  const remotes = (await git(root, ['remote'])).stdout.trim().split('\n');
  await git(root, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', `https://github.com/${request.repository}.git`]);
  const saved = await repositoryState(root);
  if (saved.connected !== request.repository) {
    return failure('publish.repositories.error.changedWhileSaving');
  }
  return { ok: true, value: saved };
}

async function repositoryRoot(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch {
    return undefined;
  }
}
async function listRepositories(root: string, account: string, environment: NodeJS.ProcessEnv) {
  const repositories: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const values = list(record)(
      await repositoryJSON(
        root,
        ['api', `user/repos?per_page=100&page=${page}&sort=pushed&` + 'affiliation=owner,collaborator,organization_member'],
        environment,
      ),
    );
    if (values.length > 100) {
      throw new Error('GitHub repository page exceeds its limit.');
    }
    for (const value of values) {
      if (record(value['permissions'])['push'] === true) {
        repositories.push(parseGitHubRepository(value['full_name']));
      }
    }
    if (repositories.length > REPOSITORIES_MAX) {
      throw new Error('Too many repositories.');
    }
    if (values.length < 100) {
      // Owned repositories come first; accessible organization repositories remain selectable.
      return repositories.sort((left, right) => Number(right.startsWith(`${account}/`)) - Number(left.startsWith(`${account}/`)));
    }
  }
  throw new Error('More than 500 repositories are available. Narrow repository access first.');
}
/**
 * The organizations the account can create in. A failure here never fails the repository list: the
 * result says why the organizations are missing, so the screen can offer the fix instead of hiding them.
 */
async function listOrganizations(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly organizations: readonly string[]; readonly organizationAccess: OrganizationAccess }> {
  const pages: Array<readonly string[]> = [];
  try {
    for (let page = 1; page <= ORGANIZATION_PAGES_MAX; page++) {
      const query = `user/memberships/orgs?state=active&per_page=${ORGANIZATION_PAGE_SIZE}&page=${page}`;
      const memberships = await repositoryJSON(root, ['api', query], environment);
      const entries = list(record)(memberships).length;
      pages.push(parseOrganizationMemberships(memberships));
      if (entries < ORGANIZATION_PAGE_SIZE) {
        break;
      }
    }
    return { organizations: mergeOrganizations(pages), organizationAccess: 'available' };
  } catch (failureValue: unknown) {
    return { organizations: [], organizationAccess: classifyOrganizationFailure(commandErrorText(failureValue)) };
  }
}
async function repositoryJSON(root: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
  const output = await repositoryCommand(root, args, environment);
  const value: unknown = JSON.parse(output);
  return value;
}
async function repositoryCommand(root: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
  const result = await run('gh', args, root, { env: environment, timeout: 30_000 });
  return result.stdout;
}

async function repositoryList(root: string, account: string, state: PublishingRepositories): Promise<PublishingRepositories> {
  try {
    const environment = await publishingGitEnvironment(root, {
      ...DEFAULT_PUBLISH_CONFIG,
      githubAccount: account,
    });
    const [repositories, organizations] = await Promise.all([listRepositories(root, account, environment), listOrganizations(root, environment)]);
    return { ...state, repositories, ...organizations };
  } catch {
    const notice = described('publish.repositories.error.listFailed');
    return { ...state, notice: notice.message, noticeRef: notice.messageRef };
  }
}
