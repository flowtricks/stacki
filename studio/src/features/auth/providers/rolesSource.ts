// Goal: `.stacki/roles.json` as the Worker sees it, for the built-in providers' edit policy.
// The file lives in Git, so the Worker reads the published branch through the GitHub App (the same credentials publishing
// uses). It is cached briefly: `cached` checks (every request) reuse an answer for `cacheMs`, `fresh` checks (sign-in) read
// again. If GitHub is unreachable an older answer serves for `staleMs`, so an outage does not lock every editor out; with
// no answer at all the policy fails closed.
import { parseProjectRolesSource, type ProjectRoles } from '../../../../vendor/stacki/shared/properties/projectRoles';
import { GitHubRepository, type GitHubConfig } from '../../github/github';
import { GitHubRequestError } from '../../github/githubErrors';

export const ROLES_SOURCE_LIMITS = { cacheMs: 60_000, staleMs: 3_600_000 } as const satisfies Record<string, number>;

/** `none`: the repository has no roles file. `invalid`: it exists but does not parse, so it grants nobody anything. */
export type RolesState = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'roles'; readonly roles: ProjectRoles };

export interface RolesSource {
  /** Throws when GitHub cannot be reached and no recent answer exists. */
  readonly read: (freshness: 'cached' | 'fresh') => Promise<RolesState>;
}

export function parseRolesState(source: string | undefined): RolesState {
  if (source === undefined) {
    return { kind: 'none' };
  }
  try {
    return { kind: 'roles', roles: parseProjectRolesSource(source) };
  } catch {
    return { kind: 'invalid' };
  }
}

/** A source that loads the file text (undefined when absent) and caches the parsed answer. */
export function createRolesSource(load: () => Promise<string | undefined>, now: () => number = Date.now): RolesSource {
  let answer: { readonly state: RolesState; readonly at: number } | undefined;
  let loading: Promise<RolesState> | undefined;
  const refresh = (): Promise<RolesState> => {
    loading ??= load().then(
      (text) => {
        loading = undefined;
        const state = parseRolesState(text);
        answer = { state, at: now() };
        return state;
      },
      (error: unknown) => {
        loading = undefined;
        if (answer !== undefined && now() - answer.at < ROLES_SOURCE_LIMITS.staleMs) {
          return answer.state;
        }
        throw error;
      },
    );
    return loading;
  };
  return {
    read: async (freshness) => {
      if (freshness === 'cached' && answer !== undefined && now() - answer.at < ROLES_SOURCE_LIMITS.cacheMs) {
        return answer.state;
      }
      return refresh();
    },
  };
}

export function createGitHubRolesSource(config: GitHubConfig): RolesSource {
  return createRolesSource(async () => {
    const repository = new GitHubRepository(config);
    const token = await repository.installationToken();
    try {
      return await repository.read('.stacki/roles.json', config.branch, token);
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  });
}
