// Sharing apps to GitHub and publishing them to the marketplace, for one host
// process (Desktop's main process; electron/handlers/appsHandlers.ts). Network,
// clock, tokens, compression and hashing are passed in, so tests drive it with a
// fake GitHub and a fake marketplace.
//
// The secret scan is enforced here, not only shown in the popup: making a
// repository public, sharing an app and submitting one each scan the bundle
// first and refuse unless it is clean (docs/apps.md, "Secret scanning"). A
// submission also checks again that the repository is public, tagged,
// released and MIT licensed, so a stale popup cannot submit what is not ready.
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { described } from '../../shared/properties/i18n/messageRef';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { APP_LIMITS, type AppGitHubSource, type AppLockEntry, type AppSummary, type AppsResult } from '../../shared/properties/apps';
import { readAppBundle, writeDeflatedZip, type AppBundle, type DeflateRaw, type InflateRaw } from '../../shared/properties/appBundle';
import { isScannedFile, scanAppSecrets, type AppSecretScan } from '../../shared/properties/appSecrets';
import {
  APP_PUBLISH_LIMITS,
  marketplaceReadiness,
  shareReleaseTag,
  marketplaceCheckAddress,
  precheckOutcome,
  submissionBody,
  submissionOutcome,
  type AppRepositoryStatus,
  type AppShareOutcome,
  type AppShareRequest,
  type AppShareStep,
  type AppVisibilityOutcome,
  type MarketplacePrecheck,
  type MarketplaceSubmission,
  type MarketplaceSubmissionOutcome,
} from '../../shared/properties/appPublish';
import { downloadReleaseAsset, readBounded, releaseAsset, sha256Hex, type GitHubFetch } from './appGitHub';
import { addMitLicense, makeRepositoryPublic, ownerName, repositoryStatus, shareToGitHub } from './appGitHubWrite';
import { attempt, attemptSync } from './appService';
import { readAppsLock, readInstalledBundle, recordLockEntry, updateLockEntry, listInstalledApps } from './appStore';

export const APP_PUBLISH_SERVICE_LIMITS = {
  /** How long a submission waits for the marketplace. */
  submissionMsMax: 30_000,
} as const satisfies Record<string, number>;

export interface AppPublishServiceOptions {
  readonly fetch: GitHubFetch;
  readonly now: () => number;
  /** The token of a signed-in account; absent where the host holds no GitHub sign-in (Studio). */
  readonly tokenFor: ((account: string) => Promise<string>) | undefined;
  readonly inflateRaw: InflateRaw;
  readonly deflateRaw: DeflateRaw;
  /** The marketplace's submissions address (electron/project/appMarketplace.ts `marketplaceSubmissionsURL`). */
  readonly submissionsURL: string;
  /** The marketplace's pre-submission check (`marketplaceCheckURL`). */
  readonly checkURL: string;
}

export type AppPublishService = ReturnType<typeof createAppPublishService>;

/** Whether an app from this source is shared from Stacki: an uploaded file, or a folder added to the project. */
function shareableSource(source: AppLockEntry['source']): boolean {
  switch (source.kind) {
    case 'file':
    case 'local':
      return true;
    case 'github':
    case 'marketplace':
      return false;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** What a scan reads from a bundle: its text files, decoded, with the manifest's allowlist and placeholders. */
export function scanBundle(bundle: AppBundle): AppSecretScan {
  const decoder = new TextDecoder('utf-8');
  const files = bundle.files.filter((file) => isScannedFile(file.path)).map((file) => ({ path: file.path, text: decoder.decode(file.bytes) }));
  const placeholders = bundle.manifest.settings.flatMap((setting) => (setting.placeholder === undefined ? [] : [setting.placeholder]));
  const scan = scanAppSecrets(files, {
    allowlist: bundle.manifest.secretsAllowlist,
    placeholders,
    lineSha256: (line) => createHash('sha256').update(line, 'utf8').digest('hex'),
  });
  assert(scan.kind !== 'clean' || scan.filesScanned === files.length, 'A clean scan read every text file');
  return scan;
}

export function createAppPublishService(options: AppPublishServiceOptions) {
  // Writes need the account's token; a host without a GitHub sign-in (Studio) cannot make them.
  const token = async (account: string): Promise<string> => {
    if (options.tokenFor === undefined) {
      throw new ReferencedError('apps.error.needsDesktop');
    }
    return options.tokenFor(account);
  };
  // Reads use the token where there is one, and read a public repository without it.
  const readToken = async (account: string): Promise<string | undefined> => (options.tokenFor === undefined ? undefined : options.tokenFor(account));

  // The latest release's bundle of a repository, read with the account's token.
  const releasedBundle = async (
    owner: string,
    repository: string,
    account: string,
  ): Promise<{ readonly bundle: AppBundle; readonly status: AppRepositoryStatus }> => {
    const auth = await readToken(account);
    const status = await repositoryStatus(options.fetch, auth, owner, repository);
    if (status.release === undefined) {
      throw new ReferencedError('apps.error.noReleaseToScan', { repository: `${owner}/${repository}` });
    }
    const source: AppGitHubSource = { kind: 'github', owner, repository, asset: status.release.asset };
    const asset = await releaseAsset(options.fetch, source, { tag: status.release.tag, token: auth });
    const downloaded = await downloadReleaseAsset(options.fetch, asset, auth);
    return { bundle: readAppBundle(downloaded.bytes, options.inflateRaw), status };
  };

  // `refusal` is the outcome the failed scan prevents: the sentence says what did not happen.
  const requireClean = (
    scan: AppSecretScan,
    refusal: { readonly kind: 'stays-private'; readonly repository: string } | { readonly kind: 'nothing-created' | 'not-asked' },
  ): void => {
    if (scan.kind === 'clean') {
      return;
    }
    switch (refusal.kind) {
      case 'stays-private':
        throw new ReferencedError('apps.error.scanFailedPrivate', { repository: refusal.repository });
      case 'nothing-created':
        throw new ReferencedError('apps.error.scanFailedNothingCreated');
      case 'not-asked':
        throw new ReferencedError('apps.error.scanFailedNotAsked');
      default: {
        const exhaustive: never = refusal;
        return exhaustive;
      }
    }
  };

  return {
    /** Scans an installed app's files in `.stacki/apps/<id>/`. */
    scanInstalled: (projectRoot: string, id: string): AppsResult<AppSecretScan> => attemptSync(() => scanBundle(readInstalledBundle(projectRoot, id))),

    /** Scans a repository's latest release bundle. */
    scanRepository: (owner: string, repository: string, account: string): Promise<AppsResult<AppSecretScan>> =>
      attempt(async () => scanBundle((await releasedBundle(owner, repository, account)).bundle)),

    /** What the marketplace checklist shows: visibility, topic, release, license. */
    status: (owner: string, repository: string, account: string): Promise<AppsResult<AppRepositoryStatus>> =>
      attempt(async () => {
        return publicStatus(await repositoryStatus(options.fetch, await readToken(account), owner, repository));
      }),

    /** Makes a repository public: the scan first, then one request. */
    makePublic: (owner: string, repository: string, account: string): Promise<AppsResult<AppVisibilityOutcome>> =>
      attempt(async () => {
        requireClean(scanBundle((await releasedBundle(owner, repository, account)).bundle), { kind: 'stays-private', repository: `${owner}/${repository}` });
        return makeRepositoryPublic(options.fetch, await token(account), owner, repository);
      }),

    /** Commits the standard MIT `LICENSE` (this year, the owner's name or login) and answers the status again. */
    addLicense: (owner: string, repository: string, account: string): Promise<AppsResult<AppRepositoryStatus>> =>
      attempt(async () => {
        const auth = await token(account);
        const before = await repositoryStatus(options.fetch, auth, owner, repository);
        await addMitLicense(options.fetch, auth, {
          owner,
          repository,
          branch: before.branch,
          holder: before.holder,
          year: new Date(options.now()).getUTCFullYear(),
        });
        return publicStatus(await repositoryStatus(options.fetch, auth, owner, repository));
      }),

    /**
     * Shares an app installed from a file, or added to the project folder: scan,
     * zip its folder, then the four steps on GitHub. A failed step is an outcome
     * that names what it created, not an error.
     */
    share: (projectRoot: string, request: AppShareRequest, onStep: (step: AppShareStep) => void): Promise<AppsResult<AppShareOutcome>> =>
      attempt(async () => {
        // The installed list, not the lockfile alone: an app added to the project folder has no lock entry.
        const entry = listInstalledApps(projectRoot).find((app) => app.lock.id === request.id)?.lock;
        if (entry === undefined) {
          throw new ReferencedError('apps.error.notInstalled', { id: request.id });
        }
        if (!shareableSource(entry.source)) {
          throw new ReferencedError('apps.error.onlyUploadedShared');
        }
        const auth = await token(request.account);
        const bundle = readInstalledBundle(projectRoot, request.id);
        requireClean(scanBundle(bundle), { kind: 'nothing-created' });
        const zip = writeDeflatedZip(bundle.files, options.deflateRaw);
        if (zip.byteLength > APP_LIMITS.archiveBytesMax) {
          throw new ReferencedError('apps.error.zipTooBig', { bytes: zip.byteLength, max: APP_LIMITS.archiveBytesMax });
        }
        // The zip must read back as this very app before anything is created.
        const check = readAppBundle(zip, options.inflateRaw);
        assert(check.manifest.id === bundle.manifest.id, 'The released zip holds the app being shared');
        assert(check.files.length === bundle.files.length, 'The released zip holds every file');
        const holder = request.visibility === 'public' ? await ownerName(options.fetch, auth, request.owner) : undefined;
        return shareToGitHub(
          options.fetch,
          auth,
          {
            owner: request.owner,
            ownerKind: request.ownerKind,
            name: request.name,
            visibility: request.visibility,
            // i18n-ignore: text written into the repository description on GitHub, not interface text.
            description: bundle.manifest.description || `${bundle.manifest.name}, a Stacki app`,
            files: bundle.files,
            tag: shareReleaseTag(bundle.manifest.version),
            releaseName: bundle.manifest.name,
            asset: { name: `${bundle.manifest.id}.zip`, bytes: zip, sha256: sha256Hex(zip) },
            licenseHolder: holder,
            year: new Date(options.now()).getUTCFullYear(),
          },
          onStep,
        );
      }),

    /**
     * Switches an app installed from a file, or added to the project folder, to
     * the GitHub release it was shared as, so the project hears of its new
     * releases. The release is downloaded and must hold this app at its installed
     * version; auto-update stays off. A folder app the lockfile did not name gets
     * its entry now; its files stay as they are.
     */
    switchSource: (projectRoot: string, id: string, source: AppGitHubSource & { readonly tag: string }): Promise<AppsResult<AppSummary>> =>
      attempt(async () => {
        const entry = listInstalledApps(projectRoot).find((app) => app.lock.id === id)?.lock;
        if (entry === undefined) {
          throw new ReferencedError('apps.error.notInstalled', { id });
        }
        if (!shareableSource(entry.source)) {
          throw new ReferencedError('apps.error.onlyUploadedSwitch');
        }
        const auth = source.account === undefined ? undefined : await readToken(source.account);
        const asset = await releaseAsset(options.fetch, source, { tag: source.tag, token: auth });
        const downloaded = await downloadReleaseAsset(options.fetch, asset, auth);
        const bundle = readAppBundle(downloaded.bytes, options.inflateRaw);
        if (bundle.manifest.id !== id || bundle.manifest.version !== entry.version) {
          throw new ReferencedError('apps.error.switchWrongRelease', {
            found: `${bundle.manifest.id} ${bundle.manifest.version}`,
            expected: `${id} ${entry.version}`,
          });
        }
        const switched = (current: AppLockEntry): AppLockEntry => ({
          ...current,
          source: { ...source, tag: asset.tag },
          sha256: downloaded.sha256,
          update: undefined,
          autoUpdate: false,
        });
        const recorded = readAppsLock(projectRoot).apps.some((app) => app.id === id);
        const next = recorded ? updateLockEntry(projectRoot, id, switched) : recordLockEntry(projectRoot, switched(entry));
        assert(next.source.kind === 'github', 'The app now comes from GitHub');
        assert(!next.autoUpdate, 'A switched app waits for an admin to choose Update');
        const summary = listInstalledApps(projectRoot).find((app) => app.lock.id === id);
        assert(summary !== undefined, 'A switched app is still installed');
        return summary;
      }),

    /** Asks the marketplace whether it would accept the repository, after the local scan passed. */
    precheck: (owner: string, repository: string, account: string): Promise<AppsResult<MarketplacePrecheck>> =>
      attempt(async () => {
        requireClean(scanBundle((await releasedBundle(owner, repository, account)).bundle), { kind: 'not-asked' });
        let response: Response;
        try {
          response = await options.fetch(marketplaceCheckAddress(options.checkURL, owner, repository), {
            // i18n-ignore: HTTP header value or request path, protocol text.
            headers: { Accept: 'application/json', 'User-Agent': 'Stacki' },
            redirect: 'error',
            signal: AbortSignal.timeout(APP_PUBLISH_SERVICE_LIMITS.submissionMsMax),
          });
        } catch (error: unknown) {
          return { kind: 'unavailable', ...described('apps.error.marketplaceUnreachable', { detail: String(error).slice(0, 200) }) };
        }
        return precheckOutcome(response.status, await boundedText(response));
      }),

    /**
     * Submits a repository's latest release for review: checks it is ready (public,
     * tagged, released, MIT licensed, scanned clean), then posts it. An endpoint
     * that does not answer usefully is `unavailable`, so the popup offers the web form.
     */
    submit: (submission: MarketplaceSubmission): Promise<AppsResult<MarketplaceSubmissionOutcome>> =>
      attempt(async () => {
        const auth = await token(submission.account);
        const { bundle, status } = await releasedBundle(submission.owner, submission.repository, submission.account);
        const readiness = marketplaceReadiness(status, { clean: scanBundle(bundle).kind === 'clean' });
        if (!readiness.ready) {
          const failing = readiness.checks.filter((entry) => !entry.passed).map((entry) => entry.check);
          throw new ReferencedError('apps.error.notReadyForMarketplace', {
            repository: `${submission.owner}/${submission.repository}`,
            failing: failing.join(', '),
          });
        }
        assert(status.release !== undefined, 'A ready repository has a release');
        let response: Response;
        try {
          // The Worker reads the repository as this account to confirm who submits; the token is never kept.
          response = await options.fetch(options.submissionsURL, {
            method: 'POST',
            // i18n-ignore: HTTP header value or request path, protocol text.
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Stacki', Authorization: `Bearer ${auth}` },
            body: submissionBody(submission, status.release),
            redirect: 'error',
            signal: AbortSignal.timeout(APP_PUBLISH_SERVICE_LIMITS.submissionMsMax),
          });
        } catch (error: unknown) {
          return { kind: 'unavailable', ...described('apps.error.marketplaceUnreachable', { detail: String(error).slice(0, 200) }) };
        }
        return submissionOutcome(response.status, await boundedText(response));
      }),
  };
}

// The status the popup sees: what GitHub said, without the branch only this host needs.
function publicStatus(status: AppRepositoryStatus & { readonly branch: string }): AppRepositoryStatus {
  return {
    owner: status.owner,
    repository: status.repository,
    private: status.private,
    topic: status.topic,
    license: status.license,
    release: status.release,
    holder: status.holder,
  };
}

// A marketplace reply's text, bounded; an unreadable body is empty, which reads as unavailable.
async function boundedText(response: Response): Promise<string> {
  try {
    return new TextDecoder().decode(await readBounded(response, APP_PUBLISH_LIMITS.submissionReplyBytesMax));
  } catch {
    return '';
  }
}
