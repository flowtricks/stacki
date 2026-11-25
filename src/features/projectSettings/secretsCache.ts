// The last listing per project and env file, kept in memory so the Secrets tab opens on the names it
// showed before and refreshes in the background (stale-while-revalidate), instead of waiting on a read.
//
// A listing is names, flags and a revision digest: `SecretsListing` has no field for a value, and a value
// is only ever read through `readSecret` into a component's own state. So this cache can never hold one.
// It is bounded by `createPanelCache` (the eight most recent entries) and lives for the session only.
import { assert } from '../../../shared/core/assert';
import type { Result } from '../../../shared/core/result';
import { SECRETS_FILE_DEFAULT, type SecretsFileName, type SecretsListing } from '../../../shared/properties/secrets';
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { SecretsUnavailableError, listSecrets } from './secretsBridge';

export const secretsListingCache = createPanelCache<SecretsListing>();

/** The cache key of one file in one project. A newline cannot be in either, so two pairs never share a key. */
export function secretsCacheKey(projectPath: string, file: SecretsFileName): string {
  assert(!projectPath.includes('\n'), 'secretsCacheKey: a project path holds no newline');
  return `${projectPath}\n${file}`;
}

/** The cached listing for a file, or undefined when the tab has not read it this session. */
export function cachedSecretsListing(projectPath: string, file: SecretsFileName): SecretsListing | undefined {
  const entry = secretsListingCache.get(secretsCacheKey(projectPath, file));
  return entry?.kind === 'ready' ? entry.value : undefined;
}

/** Reads the file the tab opens on ahead of the first open (run by the project-open prefetch). A failure leaves the tab to read and report for itself. */
export function prewarmSecretsListing(projectPath: string): Promise<void> {
  return prewarmPanelCache(secretsListingCache, secretsCacheKey(projectPath, SECRETS_FILE_DEFAULT), readListing(projectPath, SECRETS_FILE_DEFAULT));
}

function readListing(projectPath: string, file: SecretsFileName): () => Promise<Result<SecretsListing, string>> {
  return async () => {
    try {
      const result = await listSecrets(projectPath, file);
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
