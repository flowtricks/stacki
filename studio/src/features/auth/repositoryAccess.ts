import { GitHubRepository, type GitHubConfig } from '../github/github';
import { record } from '../../shared/validation';
import type { Identity } from './session';

export interface AccessConfig {
  readonly EDITOR_ACCESS?: string;
  readonly EDITOR_GITHUB_IDS: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_INSTALLATION_ID: string;
  readonly GITHUB_PRIVATE_KEY: string;
  readonly GITHUB_REPOSITORY: string;
  readonly GITHUB_BRANCH: string;
}
export function hasWritePermission(value: unknown, id: number): boolean {
  const data = record(value);
  const user = record(data['user']);
  return user['id'] === id && ['write', 'admin'].includes(String(data['permission']));
}
export function createAccessCheck(lookup: (config: GitHubConfig, login: string) => Promise<unknown>, now = Date.now) {
  const cache = new Map<string, { allowed: boolean; until: number }>();
  return async (identity: Pick<Identity, 'id' | 'login'>, config: AccessConfig, fresh = false) => {
    // Callers must verify GitHub OAuth or the signed session before checking access.
    // Do not cache this grant: switching back must recheck repository membership.
    if (config.EDITOR_ACCESS === 'github') {
      return true;
    }
    if (config.EDITOR_ACCESS !== 'repository') {
      return config.EDITOR_GITHUB_IDS.split(',').some((id) => id.trim() === String(identity.id));
    }
    const key = [config.GITHUB_APP_ID, config.GITHUB_INSTALLATION_ID, config.GITHUB_REPOSITORY, identity.id, identity.login].join(':');
    const cached = cache.get(key);
    if (!fresh && cached && cached.until > now()) {
      return cached.allowed;
    }
    const result = await lookup(
      {
        appId: config.GITHUB_APP_ID,
        installationId: config.GITHUB_INSTALLATION_ID,
        privateKey: config.GITHUB_PRIVATE_KEY,
        repository: config.GITHUB_REPOSITORY,
        branch: config.GITHUB_BRANCH,
      },
      identity.login,
    );
    const allowed = result !== null && hasWritePermission(result, identity.id);
    if (cache.size >= 500) {
      cache.clear();
    }
    cache.set(key, { allowed, until: now() + (allowed ? 300_000 : 15_000) });
    return allowed;
  };
}
export const canEdit = createAccessCheck(async (config, login) => {
  const token = await new GitHubRepository(config).installationToken();
  const response = await fetch(`https://api.github.com/repos/${config.repository}/collaborators/${encodeURIComponent(login)}/permission`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Astro-Studio',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error('Could not verify repository access. Please retry.');
  }
  const data: unknown = await response.json();
  return data;
});
