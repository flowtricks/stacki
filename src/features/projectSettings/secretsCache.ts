// The last `.env` listing per project, kept in memory so the Secrets tab opens on the names it showed
// before and refreshes in the background (stale-while-revalidate), instead of waiting on a read.
//
// A listing is names, flags and a revision digest: `SecretsListing` has no field for a value, and a value
// is only ever read through `readSecret` into a component's own state. So this cache can never hold one.
// It is bounded by `createPanelCache` (the eight most recent projects) and lives for the session only.
import type { Result } from '../../../shared/core/result';
import type { SecretsListing } from '../../../shared/properties/secrets';
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { SecretsUnavailableError, listSecrets } from './secretsBridge';

export const secretsListingCache = createPanelCache<SecretsListing>();

/** The cached listing for a project, or undefined when the tab has not read one this session. */
export function cachedSecretsListing(projectPath: string): SecretsListing | undefined {
  const entry = secretsListingCache.get(projectPath);
  return entry?.kind === 'ready' ? entry.value : undefined;
}

/** Reads the listing ahead of the first open (run by the project-open prefetch). A failure leaves the tab to read and report for itself. */
export function prewarmSecretsListing(projectPath: string): Promise<void> {
  return prewarmPanelCache(secretsListingCache, projectPath, readListing(projectPath));
}

function readListing(projectPath: string): () => Promise<Result<SecretsListing, string>> {
  return async () => {
    try {
      const result = await listSecrets(projectPath);
      return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.code };
    } catch (error: unknown) {
      // An app that predates the channels is an expected state (the tab says to restart); anything else is a broken boundary and surfaces.
      if (error instanceof SecretsUnavailableError) {
        return { ok: false, error: 'unavailable' };
      }
      throw error;
    }
  };
}
