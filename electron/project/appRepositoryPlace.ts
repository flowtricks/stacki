// An installed app's GitHub repository and its visibility, for the Apps panel's
// "GitHub · Private" and "GitHub · Public" pills (shared/properties/appPlace.ts).
// Runs in Desktop's main process and on the Studio server, never in a renderer.
//
// A repository installed with an account is read with that account's token (the
// publishing sign-in, as installs and updates are); one without, and every
// repository in Studio, is read anonymously, which can only ever confirm
// "public". Answers are cached per repository and account for
// APP_PLACE_LIMITS.visibilityCacheMsMax, failures for a shorter while, and at
// most APP_PLACE_LIMITS.visibilityReposMax repositories are remembered. A
// failure answers no visibility, never an error: the pill then says "GitHub".
import { assert } from '../../shared/core/assert';
import { described } from '../../shared/properties/i18n/messageRef';
import { appsFailure, type AppSummary, type AppsResult } from '../../shared/properties/apps';
import type { MarketplaceIndex } from '../../shared/properties/appMarketplace';
import {
  APP_PLACE_LIMITS,
  appRepositoryLocation,
  type AppRepositoryLocation,
  type AppRepositoryPlaceReply,
  type AppRepositoryVisibility,
} from '../../shared/properties/appPlace';
import { repositoryVisibility, type GitHubFetch } from './appGitHub';
import { listInstalledApps } from './appStore';

export interface AppRepositoryPlaceOptions {
  readonly fetch: GitHubFetch;
  readonly now: () => number;
  /** The publishing account's token; absent in Studio, which holds no person's sign-in. */
  readonly tokenFor: ((account: string) => Promise<string>) | undefined;
  /** The marketplace index, cached by the app service; undefined when it cannot be read. */
  readonly marketplace: () => Promise<MarketplaceIndex | undefined>;
}

interface CacheEntry {
  readonly answer: Promise<AppRepositoryVisibility | undefined>;
  readonly expiresAtMs: number;
}

export function createAppRepositoryPlaces(options: AppRepositoryPlaceOptions) {
  // Insertion order is age: the first key is the oldest, forgotten first at the bound.
  const cache = new Map<string, CacheEntry>();

  const remember = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    if (cache.size >= APP_PLACE_LIMITS.visibilityReposMax) {
      const now = options.now();
      for (const [stale, held] of cache) {
        if (held.expiresAtMs <= now) {
          cache.delete(stale);
        }
      }
    }
    if (cache.size >= APP_PLACE_LIMITS.visibilityReposMax) {
      const oldest = cache.keys().next();
      assert(oldest.done !== true, 'A full cache has an oldest entry');
      cache.delete(oldest.value);
    }
    cache.set(key, entry);
    assert(cache.size <= APP_PLACE_LIMITS.visibilityReposMax, 'The visibility cache is bounded');
  };

  const ask = async (location: AppRepositoryLocation): Promise<AppRepositoryVisibility | undefined> => {
    let token: string | undefined;
    if (location.account !== undefined && options.tokenFor !== undefined) {
      try {
        token = await options.tokenFor(location.account);
      } catch {
        // Not signed in as that account: an anonymous read still confirms a public repository.
        token = undefined;
      }
    }
    try {
      return await repositoryVisibility(options.fetch, location.owner, location.repository, token);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      return undefined;
    }
  };

  /** The repository's visibility: cached, else asked of GitHub; undefined when GitHub did not say. */
  const visibility = (location: AppRepositoryLocation): Promise<AppRepositoryVisibility | undefined> => {
    assert(location.owner.length > 0, 'A repository has an owner');
    assert(location.repository.length > 0, 'A repository has a name');
    const key = `${location.account ?? ''}:${location.owner}/${location.repository}`.toLowerCase();
    const held = cache.get(key);
    if (held !== undefined) {
      if (options.now() < held.expiresAtMs) {
        return held.answer;
      }
    }
    // Concurrent asks share one request: the pending answer is cached at once.
    const answer = ask(location);
    remember(key, { answer, expiresAtMs: options.now() + APP_PLACE_LIMITS.visibilityCacheMsMax });
    void answer.then((settled) => {
      // A failure is remembered for a shorter while, so a fixed sign-in shows soon.
      if (settled === undefined && cache.get(key)?.answer === answer) {
        remember(key, { answer, expiresAtMs: options.now() + APP_PLACE_LIMITS.visibilityFailureMsMax });
      }
    });
    return answer;
  };

  return {
    visibility,
    /** An installed app's repository and its visibility; `place` is undefined for an app that lives only in the project. */
    place: async (projectRoot: string, id: string): Promise<AppsResult<AppRepositoryPlaceReply>> => {
      assert(id.length > 0, 'An app id to look up is never empty');
      const installed = installedApp(projectRoot, id);
      if (!installed.ok) {
        return installed;
      }
      const app = installed.value;
      const index = app.lock.source.kind === 'marketplace' ? await options.marketplace() : undefined;
      const location = appRepositoryLocation(app.lock.source, index);
      if (location === undefined) {
        return { ok: true, value: { place: undefined } };
      }
      const found = await visibility(location);
      return { ok: true, value: { place: { owner: location.owner, repository: location.repository, visibility: found } } };
    },
  };
}

export type AppRepositoryPlaces = ReturnType<typeof createAppRepositoryPlaces>;

function installedApp(projectRoot: string, id: string): AppsResult<AppSummary> {
  try {
    const app = listInstalledApps(projectRoot).find((summary) => summary.manifest.id === id);
    if (app === undefined) {
      return { ok: false, ...described('apps.error.notInstalled', { id }) };
    }
    assert(app.manifest.id === id, 'The found app is the one asked for');
    return { ok: true, value: app };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, ...appsFailure(error) };
  }
}
