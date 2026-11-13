// The Apps platform's install and update flow, for one host process: Desktop's
// main process (electron/handlers/appsHandlers.ts) and the Studio server
// (studio/src/features/apps/appsServer.ts) both build one. Network, clock,
// tokens and inflate are passed in, so tests drive it with a fake GitHub.
//
// Install is two steps. `stage*` reads and checks a bundle and holds it in
// memory under a token; nothing is written. The admin sees its name, icon and
// version, and `commit` installs exactly those bytes. An update check records a
// newer release as available; `applyUpdate` installs it from bytes whose
// SHA-256 must equal the one that was checked.
//
// Update policy (docs/apps.md): nothing installs code unless a person chose it
// (`commit`, `installMarketplace`, `applyUpdate`) or an admin switched on that
// app's auto-update. With it on, a check installs a GitHub app's newer release
// (its SHA-256 recorded as it was checked) or a marketplace app's newest
// approved version (only bytes whose SHA-256 the index approved), but only when
// that version asks for nothing the installed one did not (appManifestAdditions:
// network hosts, sign-in providers, role switches). Otherwise the check records
// it as waiting, with what it adds, and reports `needs-approval`: a person reads
// the additions and chooses Update.
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { assert } from '../../shared/core/assert';
import {
  APP_LIMITS,
  appsFailure,
  compareAppVersions,
  stackiVersionProblem,
  type AppAvailableUpdate,
  appManifestAdditions,
  type AppGitHubSource,
  type AppInstallSource,
  type AppLockEntry,
  type AppManifest,
  type AppRelease,
  type AppRepository,
  type AppStaged,
  type AppSummary,
  type AppUpdateOutcome,
  type AppsResult,
} from '../../shared/properties/apps';
import { described } from '../../shared/properties/i18n/messageRef';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { readAppBundle, type AppBundle, type InflateRaw } from '../../shared/properties/appBundle';
import {
  MARKETPLACE_INDEX_URL,
  approvedUpdate,
  approvedVersion,
  marketplaceApp,
  type MarketplaceApp,
  type MarketplaceIndex,
  type MarketplaceVersion,
} from '../../shared/properties/appMarketplace';
import { downloadReleaseAsset, listReleases, listRepositories, releaseAsset, sha256Hex, type GitHubFetch } from './appGitHub';
import { downloadApprovedVersion, fetchMarketplaceIndex } from './appMarketplace';
import { installAppBundle, listInstalledApps, listInstalledFolders, readAppsLock, uninstallApp, updateLockEntry } from './appStore';
import type { AppFolderBroken } from '../../shared/properties/appFolders';

export const APP_SERVICE_LIMITS = {
  /** Bundles held for confirmation at once; the oldest is dropped past this. */
  stagedMax: 4,
  /** How long a staged bundle waits for confirmation. */
  stagedMsMax: 10 * 60_000,
  /** Automatic update checks of one project are at least this far apart. */
  updateCheckMsMin: 10 * 60_000,
  /** How long a browsed marketplace index is reused; installs and update checks always read it afresh. */
  marketplaceCacheMsMax: 10 * 60_000,
} as const satisfies Record<string, number>;

export interface AppServiceOptions {
  readonly fetch: GitHubFetch;
  readonly now: () => number;
  /** The GitHub token of a signed-in account, for private repositories; undefined reads them as public. */
  readonly tokenFor?: (account: string) => Promise<string>;
  readonly inflateRaw?: InflateRaw;
  /** The marketplace index address (electron/project/appMarketplace.ts `marketplaceIndexURL`); absent is the official one. */
  readonly marketplaceIndexURL?: string;
  /**
   * The running Stacki's version: a bundle whose manifest needs a newer one (`"stacki": ">=1.1.0"`)
   * is refused on install and update. Passed explicitly by every host, so no host forgets the check.
   */
  readonly stackiVersion: string;
}

/** How fresh a marketplace index must be: browsing may reuse a recent one; installing never does. */
export type IndexFreshness = 'cached' | 'fresh';

interface Staged {
  readonly projectRoot: string;
  readonly bundle: AppBundle;
  readonly staged: AppStaged;
  readonly expiresAtMs: number;
}

export type AppService = ReturnType<typeof createAppService>;

/** Node's raw inflate, refusing output past the size the archive states. */
export const nodeInflateRaw: InflateRaw = (data, sizeBytesMax) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, sizeBytesMax) }));

export function createAppService(options: AppServiceOptions) {
  const inflate = options.inflateRaw ?? nodeInflateRaw;
  const staged = new Map<string, Staged>();
  const lastCheckMs = new Map<string, number>();
  let checking: Promise<readonly AppUpdateOutcome[]> | undefined;
  // One index at a time, whatever the project: the index is the same for every one.
  let marketplaceCache: { readonly index: MarketplaceIndex; readonly fetchedAtMs: number } | undefined;
  const indexURL = options.marketplaceIndexURL ?? MARKETPLACE_INDEX_URL;

  const token = async (account: string | undefined): Promise<string | undefined> => {
    if (account === undefined || options.tokenFor === undefined) {
      return undefined;
    }
    return options.tokenFor(account);
  };

  const dropExpired = (): void => {
    const now = options.now();
    for (const [key, entry] of staged) {
      if (entry.expiresAtMs <= now) {
        staged.delete(key);
      }
    }
  };

  // Refuses a bundle this Stacki is too old to run, before it is held or written (docs/apps.md).
  const requireStackiVersion = (manifest: AppManifest): void => {
    if (stackiVersionProblem(manifest.stackiVersionMin, options.stackiVersion) !== undefined) {
      assert(manifest.stackiVersionMin !== undefined, 'A version problem names the version needed');
      throw new ReferencedError('apps.error.versionTooOld', { name: manifest.name, version: manifest.version, minimum: manifest.stackiVersionMin });
    }
  };

  const hold = (projectRoot: string, archive: Uint8Array, source: AppInstallSource, sha256: string): AppStaged => {
    const bundle = readAppBundle(archive, inflate);
    requireStackiVersion(bundle.manifest);
    const lock = readAppsLock(projectRoot);
    const installed = lock.apps.find((app) => app.id === bundle.manifest.id);
    if (installed === undefined && lock.apps.length >= APP_LIMITS.appsMax) {
      throw new ReferencedError('apps.error.appLimit', { count: APP_LIMITS.appsMax });
    }
    const key = randomBytes(16).toString('hex');
    const info: AppStaged = { token: key, manifest: bundle.manifest, sha256, sizeBytes: archive.byteLength, source, replaces: installed?.version };
    dropExpired();
    if (staged.size >= APP_SERVICE_LIMITS.stagedMax) {
      const oldest = staged.keys().next().value;
      if (oldest !== undefined) {
        staged.delete(oldest);
      }
    }
    staged.set(key, { projectRoot, bundle, staged: info, expiresAtMs: options.now() + APP_SERVICE_LIMITS.stagedMsMax });
    assert(staged.size <= APP_SERVICE_LIMITS.stagedMax, 'Staged bundles are bounded');
    return info;
  };

  const install = (
    projectRoot: string,
    bundle: AppBundle,
    source: AppInstallSource,
    sha256: string,
    autoUpdate: { readonly autoUpdate: boolean },
  ): AppSummary => {
    // Every install path ends here (commit, update, auto-update, marketplace), so none skips the check.
    requireStackiVersion(bundle.manifest);
    return installAppBundle(projectRoot, bundle, {
      id: bundle.manifest.id,
      version: bundle.manifest.version,
      sha256,
      installedAt: new Date(options.now()).toISOString(),
      source,
      update: undefined,
      autoUpdate: autoUpdate.autoUpdate,
    });
  };

  const loadIndex = async (freshness: IndexFreshness): Promise<MarketplaceIndex> => {
    const cached = marketplaceCache;
    if (freshness === 'cached' && cached !== undefined && options.now() - cached.fetchedAtMs < APP_SERVICE_LIMITS.marketplaceCacheMsMax) {
      return cached.index;
    }
    const index = await fetchMarketplaceIndex(options.fetch, indexURL);
    marketplaceCache = { index, fetchedAtMs: options.now() };
    return index;
  };

  // An approved version's bundle: downloaded as public, its digest the index's, its manifest the entry's.
  const approvedBundle = async (app: MarketplaceApp, approved: MarketplaceVersion): Promise<{ readonly bundle: AppBundle; readonly sha256: string }> => {
    const downloaded = await downloadApprovedVersion(options.fetch, app, approved);
    const bundle = readAppBundle(downloaded.bytes, inflate);
    if (bundle.manifest.id !== app.id) {
      throw new ReferencedError('apps.error.approvedWrongApp', { found: bundle.manifest.id, id: app.id });
    }
    if (bundle.manifest.version !== approved.version) {
      throw new ReferencedError('apps.error.approvedWrongVersion', { name: app.name, found: bundle.manifest.version, expected: approved.version });
    }
    assert(downloaded.sha256 === approved.sha256, 'A marketplace bundle carries the approved digest');
    return { bundle, sha256: downloaded.sha256 };
  };

  // What a check says of an update that is waiting for a person: held for their OK when auto-update is on
  // but the version asks for more than the installed one did, otherwise simply available.
  const waitingOutcome = (lock: AppLockEntry, update: AppAvailableUpdate): AppUpdateOutcome => {
    if (lock.autoUpdate) {
      assert(update.additions.length > 0, 'With auto-update on, only an update that asks for more waits');
      return { kind: 'needs-approval', id: lock.id, version: update.version, additions: update.additions };
    }
    return { kind: 'available', id: lock.id, version: update.version };
  };

  // Whether the update recorded by an earlier check is still the one to act on, so the bundle is not downloaded again:
  // it stays unless auto-update could install it now (it was recorded with nothing new, before the switch was turned on).
  const recordedStillWaits = (lock: AppLockEntry): boolean => {
    if (lock.update === undefined) {
      return false;
    }
    return !lock.autoUpdate || lock.update.additions.length > 0;
  };

  const checkMarketplace = async (projectRoot: string, summary: AppSummary, index: MarketplaceIndex): Promise<AppUpdateOutcome> => {
    const { lock } = summary;
    const id = lock.id;
    const app = marketplaceApp(index, id);
    if (app === undefined) {
      return { kind: 'failed', id, ...described('apps.error.noLongerListed') };
    }
    const next = approvedUpdate(app, lock.version);
    if (next === undefined) {
      return { kind: 'current', id };
    }
    // The index says which Stacki the version needs, so an update this Stacki cannot run is never offered.
    if (stackiVersionProblem(next.stackiVersionMin, options.stackiVersion) !== undefined && next.stackiVersionMin !== undefined) {
      return { kind: 'failed', id, ...described('apps.error.versionTooOld', { name: app.name, version: next.version, minimum: next.stackiVersionMin }) };
    }
    if (lock.update !== undefined && recordedStillWaits(lock)) {
      if (lock.update.version === next.version && lock.update.sha256 === next.sha256) {
        return waitingOutcome(lock, lock.update);
      }
    }
    // The approved bytes are downloaded (and their digest checked) so the update can say what it adds to the installed version.
    const { bundle, sha256 } = await approvedBundle(app, next);
    const additions = appManifestAdditions(summary.manifest, bundle.manifest);
    if (lock.autoUpdate) {
      if (additions.length === 0) {
        install(projectRoot, bundle, { kind: 'marketplace', id, version: next.version }, sha256, { autoUpdate: true });
        return { kind: 'updated', id, version: next.version };
      }
    }
    const update: AppAvailableUpdate = { version: next.version, tag: next.tag, sha256: next.sha256, additions };
    updateLockEntry(projectRoot, id, (entry) => ({ ...entry, update }));
    return waitingOutcome(lock, update);
  };

  const checkGitHub = async (projectRoot: string, summary: AppSummary, source: AppGitHubSource & { readonly tag: string }): Promise<AppUpdateOutcome> => {
    const { lock } = summary;
    const id = lock.id;
    const auth = await token(source.account);
    const latest = await releaseAsset(options.fetch, source, { token: auth });
    if (latest.tag === source.tag) {
      return { kind: 'current', id };
    }
    if (lock.update !== undefined && recordedStillWaits(lock)) {
      if (lock.update.tag === latest.tag) {
        return waitingOutcome(lock, lock.update);
      }
    }
    const downloaded = await downloadReleaseAsset(options.fetch, latest, auth);
    const bundle = readAppBundle(downloaded.bytes, inflate);
    if (bundle.manifest.id !== id) {
      throw new ReferencedError('apps.error.releaseWrongApp', { found: bundle.manifest.id, id });
    }
    if (compareAppVersions(bundle.manifest.version, lock.version) <= 0) {
      return { kind: 'current', id };
    }
    if (stackiVersionProblem(bundle.manifest.stackiVersionMin, options.stackiVersion) !== undefined && bundle.manifest.stackiVersionMin !== undefined) {
      return {
        kind: 'failed',
        id,
        ...described('apps.error.versionTooOld', {
          name: bundle.manifest.name,
          version: bundle.manifest.version,
          minimum: bundle.manifest.stackiVersionMin,
        }),
      };
    }
    const additions = appManifestAdditions(summary.manifest, bundle.manifest);
    if (lock.autoUpdate) {
      if (additions.length === 0) {
        // The bytes this check downloaded and digested are the ones installed.
        install(projectRoot, bundle, { ...source, tag: latest.tag }, downloaded.sha256, { autoUpdate: true });
        return { kind: 'updated', id, version: bundle.manifest.version };
      }
    }
    const update: AppAvailableUpdate = { version: bundle.manifest.version, tag: latest.tag, sha256: downloaded.sha256, additions };
    updateLockEntry(projectRoot, id, (entry) => ({ ...entry, update }));
    return waitingOutcome(lock, update);
  };

  // Every source kind is handled here, so a new kind is a compile error until it is.
  const checkOne = async (projectRoot: string, summary: AppSummary, marketplace: () => Promise<MarketplaceIndex>): Promise<AppUpdateOutcome> => {
    const { lock } = summary;
    const source = lock.source;
    switch (source.kind) {
      case 'file':
      case 'local':
        return { kind: 'current', id: lock.id };
      case 'github':
        return checkGitHub(projectRoot, summary, source);
      case 'marketplace':
        return checkMarketplace(projectRoot, summary, await marketplace());
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
    }
  };

  return {
    list: (projectRoot: string): AppsResult<readonly AppSummary[]> => attemptSync(() => listInstalledApps(projectRoot)),

    /** The folders under `.stacki/apps/` that do not read as an app, each with the reason (docs/apps.md). */
    folders: (projectRoot: string): AppsResult<readonly AppFolderBroken[]> => attemptSync(() => listInstalledFolders(projectRoot).broken),

    /** Checks an uploaded zip and holds it for confirmation. */
    stageFile: (projectRoot: string, archive: Uint8Array, fileName: string): AppsResult<AppStaged> =>
      attemptSync(() => {
        if (archive.byteLength > APP_LIMITS.archiveBytesMax) {
          throw new ReferencedError('error.apps.fileTooLarge', { bytes: APP_LIMITS.archiveBytesMax });
        }
        const name = fileName.replace(/^.*[\\/]/, '').slice(0, APP_LIMITS.assetNameCharsMax) || 'app.zip';
        return hold(projectRoot, archive, { kind: 'file', fileName: name }, sha256Hex(archive));
      }),

    /** Downloads a release asset (the latest release, or `tag`) and holds it for confirmation. */
    stageGitHub: (projectRoot: string, source: AppGitHubSource, tag: string | undefined): Promise<AppsResult<AppStaged>> =>
      attempt(async () => {
        const auth = await token(source.account);
        const asset = await releaseAsset(options.fetch, source, { tag, token: auth });
        const downloaded = await downloadReleaseAsset(options.fetch, asset, auth);
        return hold(projectRoot, downloaded.bytes, { ...source, tag: asset.tag }, downloaded.sha256);
      }),

    /** The repositories a signed-in account can read, for the chooser. */
    repositories: (account: string): Promise<AppsResult<readonly AppRepository[]>> =>
      attempt(async () => {
        const auth = await token(account);
        if (auth === undefined) {
          throw new ReferencedError('apps.error.signInToListRepositories');
        }
        return listRepositories(options.fetch, auth, account);
      }),

    /** A repository's releases, for the chooser. */
    releases: (owner: string, repository: string, account: string | undefined): Promise<AppsResult<readonly AppRelease[]>> =>
      attempt(async () => listReleases(options.fetch, owner, repository, await token(account))),

    /** Installs a staged bundle once an admin confirmed it. */
    commit: (projectRoot: string, key: string): AppsResult<AppSummary> =>
      attemptSync(() => {
        dropExpired();
        const entry = staged.get(key);
        if (entry === undefined || entry.projectRoot !== projectRoot) {
          throw new ReferencedError('apps.error.noLongerWaiting');
        }
        staged.delete(key);
        const previous = readAppsLock(projectRoot).apps.find((app) => app.id === entry.staged.manifest.id);
        return install(projectRoot, entry.bundle, entry.staged.source, entry.staged.sha256, { autoUpdate: carriedAutoUpdate(previous, entry.staged.source) });
      }),

    discard: (key: string): void => {
      staged.delete(key);
    },

    uninstall: (projectRoot: string, id: string): AppsResult<readonly AppSummary[]> =>
      attemptSync(() => {
        uninstallApp(projectRoot, id);
        return listInstalledApps(projectRoot);
      }),

    /** Checks every GitHub app once; `force` skips the interval between automatic checks. */
    checkUpdates: (projectRoot: string, force: boolean | undefined): Promise<AppsResult<readonly AppUpdateOutcome[]>> =>
      attempt(async () => {
        const last = lastCheckMs.get(projectRoot);
        if (force !== true && last !== undefined && options.now() - last < APP_SERVICE_LIMITS.updateCheckMsMin) {
          return [];
        }
        // One check at a time: a second caller waits for the first's answer.
        if (checking !== undefined) {
          return checking;
        }
        lastCheckMs.set(projectRoot, options.now());
        const run = async (): Promise<readonly AppUpdateOutcome[]> => {
          const outcomes: AppUpdateOutcome[] = [];
          // Read once per check, and only when a marketplace app is installed; always afresh, so a withdrawn approval counts.
          let index: Promise<MarketplaceIndex> | undefined;
          const marketplace = (): Promise<MarketplaceIndex> => {
            index ??= loadIndex('fresh');
            return index;
          };
          for (const summary of listInstalledApps(projectRoot)) {
            try {
              outcomes.push(await checkOne(projectRoot, summary, marketplace));
            } catch (error: unknown) {
              outcomes.push({ kind: 'failed', id: summary.lock.id, ...appsFailure(error) });
            }
          }
          return outcomes;
        };
        checking = run();
        try {
          return await checking;
        } finally {
          checking = undefined;
        }
      }),

    /** Installs the available update an admin chose, from the bytes that were checked. */
    applyUpdate: (projectRoot: string, id: string): Promise<AppsResult<AppSummary>> =>
      attempt(async () => {
        const entry = readAppsLock(projectRoot).apps.find((app) => app.id === id);
        if (entry?.update === undefined) {
          throw new ReferencedError('apps.error.noUpdateWaiting');
        }
        const update = entry.update;
        const source = entry.source;
        if (source.kind === 'marketplace') {
          // The approval is read again: a version withdrawn since the check installs nothing.
          const app = marketplaceApp(await loadIndex('fresh'), id);
          if (app === undefined) {
            throw new ReferencedError('apps.error.noLongerListedNothingInstalled');
          }
          const approved = approvedVersion(app, update.version);
          if (approved === undefined) {
            throw new ReferencedError('apps.error.marketplaceNoLongerApproves');
          }
          if (approved.sha256 !== update.sha256) {
            throw new ReferencedError('apps.error.approvedReleaseChanged');
          }
          const { bundle, sha256 } = await approvedBundle(app, approved);
          return install(projectRoot, bundle, { kind: 'marketplace', id, version: approved.version }, sha256, { autoUpdate: entry.autoUpdate });
        }
        if (source.kind !== 'github') {
          throw new ReferencedError('apps.error.uploadedNoUpdatesUpload');
        }
        const auth = await token(source.account);
        const asset = await releaseAsset(options.fetch, source, { tag: update.tag, token: auth });
        const downloaded = await downloadReleaseAsset(options.fetch, asset, auth);
        if (downloaded.sha256 !== update.sha256) {
          throw new ReferencedError('apps.error.releaseChanged');
        }
        const bundle = readAppBundle(downloaded.bytes, inflate);
        assert(bundle.manifest.id === id, 'An update is for its own app');
        return install(projectRoot, bundle, { ...source, tag: asset.tag }, downloaded.sha256, { autoUpdate: entry.autoUpdate });
      }),

    /** The marketplace index, for browsing: `cached` may reuse a recent copy, `fresh` reads it again. */
    marketplace: (freshness: IndexFreshness): Promise<AppsResult<MarketplaceIndex>> => attempt(() => loadIndex(freshness)),

    /** Installs an approved marketplace version: only if its SHA-256 matches the index read just now. */
    installMarketplace: (projectRoot: string, id: string, version: string): Promise<AppsResult<AppSummary>> =>
      attempt(async () => {
        const app = marketplaceApp(await loadIndex('fresh'), id);
        if (app === undefined) {
          throw new ReferencedError('apps.error.marketplaceDoesNotList', { id });
        }
        const approved = approvedVersion(app, version);
        if (approved === undefined) {
          throw new ReferencedError('apps.error.notApprovedVersion', { name: app.name, version });
        }
        // Refused before the download: the index says which Stacki the version needs.
        if (stackiVersionProblem(approved.stackiVersionMin, options.stackiVersion) !== undefined) {
          assert(approved.stackiVersionMin !== undefined, 'A version problem names the version needed');
          throw new ReferencedError('apps.error.versionTooOld', { name: app.name, version, minimum: approved.stackiVersionMin });
        }
        const previous = readAppsLock(projectRoot).apps.find((entry) => entry.id === id);
        if (previous !== undefined && previous.source.kind !== 'marketplace') {
          throw new ReferencedError('apps.error.installedElsewhere', { id });
        }
        if (previous?.version === version) {
          throw new ReferencedError('apps.error.alreadyInstalled', { name: app.name, version });
        }
        const { bundle, sha256 } = await approvedBundle(app, approved);
        // A new install starts with auto-update off; reinstalling keeps the admin's choice.
        return install(projectRoot, bundle, { kind: 'marketplace', id, version }, sha256, { autoUpdate: previous?.autoUpdate ?? false });
      }),

    /** Switches one app's auto-update; an uploaded app has nothing to update from. */
    setAutoUpdate: (projectRoot: string, id: string, policy: { readonly autoUpdate: boolean }): AppsResult<readonly AppSummary[]> =>
      attemptSync(() => {
        const next = updateLockEntry(projectRoot, id, (entry) => {
          if (entry.source.kind === 'file' || entry.source.kind === 'local') {
            throw new ReferencedError('apps.error.uploadedNoUpdatesToInstall');
          }
          return { ...entry, autoUpdate: policy.autoUpdate };
        });
        assert(next.autoUpdate === policy.autoUpdate, 'The switch is recorded as chosen');
        return listInstalledApps(projectRoot);
      }),
  };
}

/**
 * Whether a reinstall keeps auto-update: only when it comes from the same kind of
 * source as before, so a switch an admin turned on for GitHub releases never
 * starts applying to a different source. An uploaded file never auto-updates.
 */
export function carriedAutoUpdate(previous: AppLockEntry | undefined, source: AppInstallSource): boolean {
  if (previous === undefined) {
    return false;
  }
  if (source.kind === 'file' || source.kind === 'local') {
    return false;
  }
  const carried = previous.source.kind === source.kind && previous.autoUpdate;
  assert(!carried || previous.autoUpdate, 'Only a switch that was on is carried');
  return carried;
}

/** Runs `run`, its expected failures a message (shared with appPublishService.ts). */
export function attemptSync<T>(run: () => T): AppsResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Runs `run`, its expected failures a message (shared with appPublishService.ts). */
export async function attempt<T>(run: () => Promise<T>): Promise<AppsResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    return failure(error);
  }
}

// Expected failures become a message; a broken invariant still crashes (AGENTS.md §3).
function failure(error: unknown): { readonly ok: false } & ReturnType<typeof appsFailure> {
  if (error instanceof Error && error.message.startsWith('Assertion failed')) {
    throw error;
  }
  return { ok: false, ...appsFailure(error) };
}
