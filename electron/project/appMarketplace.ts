// The official marketplace's index and its approved downloads, for one host
// process: Desktop's main process and the Studio server, never a renderer.
// The index is one public JSON file that stacki.build's Worker serves
// (shared/properties/appMarketplace.ts); an
// approved version downloads from the app's own GitHub release, read as public,
// and is accepted only when its SHA-256 equals the one the index approved.
//
// The index address is a constant. A development build may point it elsewhere
// with `STACKI_MARKETPLACE_INDEX_URL`, to test an index (a local Worker, say) before it is deployed; a
// released build ignores the variable, so nobody can be steered to another index
// by their environment. There is no setting for it in the UI.
import { assert } from '../../shared/core/assert';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import {
  MARKETPLACE_INDEX_URL,
  MARKETPLACE_LIMITS,
  MARKETPLACE_CHECK_URL,
  MARKETPLACE_SUBMISSIONS_URL,
  parseMarketplaceIndexSource,
  type MarketplaceApp,
  type MarketplaceIndex,
  type MarketplaceVersion,
} from '../../shared/properties/appMarketplace';
import { downloadReleaseAsset, readBounded, releaseAsset, type DownloadedAsset, type GitHubFetch } from './appGitHub';

/** The development-only variable that points the marketplace at another index. */
export const MARKETPLACE_INDEX_URL_VARIABLE = 'STACKI_MARKETPLACE_INDEX_URL';
/** The development-only variable that posts submissions to another Worker (a local one, before it is deployed). */
export const MARKETPLACE_SUBMISSIONS_URL_VARIABLE = 'STACKI_MARKETPLACE_SUBMISSIONS_URL';
/** The development-only variable that asks another Worker's check before Submit. */
export const MARKETPLACE_CHECK_URL_VARIABLE = 'STACKI_MARKETPLACE_CHECK_URL';

export const APP_MARKETPLACE_LIMITS = {
  requestMsMax: 30_000,
} as const satisfies Record<string, number>;

/** Which build reads the index: only a development build honours the override. */
export type MarketplaceBuild = 'development' | 'release';

/** The index address for `build`: the constant, or in development the override when it is set. */
export function marketplaceIndexURL(environment: Readonly<Record<string, string | undefined>>, build: MarketplaceBuild): string {
  return developmentOverride(environment, build, MARKETPLACE_INDEX_URL_VARIABLE, MARKETPLACE_INDEX_URL);
}

/** The submissions address for `build`: the constant, or in development the override when it is set. */
export function marketplaceSubmissionsURL(environment: Readonly<Record<string, string | undefined>>, build: MarketplaceBuild): string {
  return developmentOverride(environment, build, MARKETPLACE_SUBMISSIONS_URL_VARIABLE, MARKETPLACE_SUBMISSIONS_URL);
}

/** The pre-submission check's address for `build`: the constant, or in development the override when it is set. */
export function marketplaceCheckURL(environment: Readonly<Record<string, string | undefined>>, build: MarketplaceBuild): string {
  return developmentOverride(environment, build, MARKETPLACE_CHECK_URL_VARIABLE, MARKETPLACE_CHECK_URL);
}

function developmentOverride(environment: Readonly<Record<string, string | undefined>>, build: MarketplaceBuild, variable: string, official: string): string {
  const override = environment[variable];
  if (build === 'release' || override === undefined || override.trim() === '') {
    return official;
  }
  const url = new URL(override.trim());
  // A local test server, or any HTTPS host: never plain HTTP across the network.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'https:') {
    return url.toString();
  }
  if (url.protocol === 'http:' && local) {
    return url.toString();
  }
  // i18n-ignore: a development-only environment variable is misconfigured; release builds never read it.
  throw new Error(`${variable} must be an https: address, or http: on localhost`);
}

/** Reads and parses the index at `url`. Throws with a reason a person can act on. */
export async function fetchMarketplaceIndex(fetcher: GitHubFetch, url: string): Promise<MarketplaceIndex> {
  assert(url.length > 0, 'The marketplace has an address');
  const response = await fetcher(url, {
    // i18n-ignore: HTTP header value or request path, protocol text.
    headers: { Accept: 'application/json', 'User-Agent': 'Stacki' },
    redirect: 'error',
    signal: AbortSignal.timeout(APP_MARKETPLACE_LIMITS.requestMsMax),
  });
  if (!response.ok) {
    // The panel shows its own calm wording; this detail is for the small print and the logs.
    throw new ReferencedError('apps.error.marketplaceIndexStatus', { status: response.status });
  }
  const body = await readBounded(response, MARKETPLACE_LIMITS.indexBytesMax);
  const index = parseMarketplaceIndexSource(new TextDecoder().decode(body));
  assert(index.apps.length <= MARKETPLACE_LIMITS.appsMax, 'A parsed index is bounded');
  return index;
}

/**
 * Downloads one approved version of a marketplace app from its GitHub release,
 * as public, and refuses it unless its SHA-256 is the one the index approved.
 */
export async function downloadApprovedVersion(fetcher: GitHubFetch, app: MarketplaceApp, approved: MarketplaceVersion): Promise<DownloadedAsset> {
  assert(app.versions.includes(approved), 'Only an approved version of this app downloads');
  assert(app.source.account === undefined, 'A marketplace app is read without credentials');
  const asset = await releaseAsset(fetcher, app.source, { tag: approved.tag, token: undefined });
  const downloaded = await downloadReleaseAsset(fetcher, asset, undefined);
  if (downloaded.sha256 !== approved.sha256) {
    throw new ReferencedError('apps.error.marketplaceDigestMismatch', { name: app.name, version: approved.version });
  }
  assert(downloaded.sha256 === approved.sha256, 'An approved download carries the approved digest');
  return downloaded;
}
