import { GitHubRepository, type GitHubConfig } from '../github/github';
import { throwIfRateLimited } from './githubRateLimit';
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
// An installation token lasts an hour, so minting one per sign-in (a JWT-signed POST) only spends GitHub's limits. Reuse it briefly.
export const installationTokenTtlMs = 600_000;
export const installationTokenEntriesMax = 8;

export function createTokenCache(now: () => number = Date.now) {
  const entries = new Map<string, { token: string; until: number }>();
  return {
    async get(key: string, mint: () => Promise<string>): Promise<string> {
      const cached = entries.get(key);
      if (cached && cached.until > now()) {
        return cached.token;
      }
      const token = await mint();
      if (entries.size >= installationTokenEntriesMax) {
        entries.clear();
      }
      entries.set(key, { token, until: now() + installationTokenTtlMs });
      return token;
    },
    evict(key: string): void {
      entries.delete(key);
    },
  };
}
const tokens = createTokenCache();

export async function collaboratorPermission(config: GitHubConfig, login: string, transport: typeof fetch = (...args) => fetch(...args)): Promise<unknown> {
  const key = `${config.appId}:${config.installationId}:${config.repository}`;
  const token = await tokens.get(key, () => new GitHubRepository(config).installationToken());
  const response = await transport(`https://api.github.com/repos/${config.repository}/collaborators/${encodeURIComponent(login)}/permission`, {
    headers: {
      // i18n-ignore: an HTTP header value sent to GitHub.
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      // i18n-ignore: an HTTP header value sent to GitHub.
      'User-Agent': 'Astro-Studio',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    return null;
  }
  if (response.status === 401) {
    // The cached token was revoked early; the next attempt mints a new one. There is no retry loop here.
    tokens.evict(key);
  }
  if (!response.ok) {
    throwIfRateLimited(response);
    throw new Error('Could not verify repository access. Please retry.');
  }
  const data: unknown = await response.json();
  return data;
}
export const canEdit = createAccessCheck((config, login) => collaboratorPermission(config, login));
