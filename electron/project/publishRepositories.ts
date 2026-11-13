import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { git, run } from '../lib/nodeTools';
import { sameFilesystemPath } from '../lib/platform';
import { record, list } from '../../shared/core/boundary';
import { parseGitHubRepository } from '../../shared/ipc/githubRepository';
import {
  parseRepositoryRequest,
  REPOSITORIES_MAX,
  type RepositoryRequest,
  type RepositoryResult,
  type PublishingRepositories,
} from '../../shared/ipc/publishRepository';
import { DEFAULT_PUBLISH_CONFIG } from '../../shared/properties/publishConfig';
import { described, type Described, type MessageKey } from '../../shared/properties/i18n/messageRef';
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
      const repository = parseGitHubRepository(`${request.account}/${request.name}`);
      await repositoryCommand(root, ['repo', 'create', repository, request.private ? '--private' : '--public'], environment);
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
function failure(key: MessageKey): Extract<RepositoryResult, { readonly ok: false }> {
  const problem: Described = described(key);
  return problem.messageRef === undefined ? { ok: false, error: problem.message } : { ok: false, error: problem.message, errorRef: problem.messageRef };
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
    return { ...state, repositories: await listRepositories(root, account, environment) };
  } catch {
    const notice = described('publish.repositories.error.listFailed');
    return { ...state, notice: notice.message, noticeRef: notice.messageRef };
  }
}
