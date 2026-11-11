// Sharing an app and publishing it to the marketplace (docs/apps.md, "Sharing
// an app privately with your org" and "Publishing to the marketplace"). This
// module is the contract between the renderer's popups and the host that does
// the GitHub work (electron/project/appPublishService.ts): what a share asks
// for, its steps and what it reports, what making a repository public can come
// to, what the marketplace needs before a submission, and the submission itself.
//
// Sharing puts an app installed from a file on GitHub under the person's account
// or organization, private by default: create the repository, add the
// `stacki-app` topic, commit the bundle, and release `v<version>` with the zip.
// A public repository also gets an MIT `LICENSE`, the marketplace's one license.
// Publishing to the marketplace is a separate step, once a repository is public.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { APP_LIMITS, parseAppId, parseAppVersion, parseGitHubSource, parseReleaseTag, parseSha256, type AppGitHubSource } from './apps';
import { MARKETPLACE_LICENSE } from './appMarketplace';
import { parseGitHubLogin } from './projectRoles';

export const APP_PUBLISH_LIMITS = {
  /** GitHub's own repository name limit. */
  repositoryNameCharsMax: 100,
  /** The Worker's bound on the repository it is sent (worker/marketplace/rules.ts SUBMISSION_RULES). */
  submissionSourceCharsMax: 300,
  /** The Worker's JSON reply. */
  submissionReplyBytesMax: 16 * 1024,
  /** Things a failed share reports as created. */
  createdMax: 8,
  /** A copyright holder's name in a LICENSE. */
  holderCharsMax: 100,
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Who can see a shared app. Private is the default: a share is for the org until someone chooses otherwise. */
export const APP_SHARE_VISIBILITIES = ['private', 'public'] as const;
export type AppShareVisibility = (typeof APP_SHARE_VISIBILITIES)[number];
export const DEFAULT_APP_SHARE_VISIBILITY: AppShareVisibility = 'private';

/** The steps of a share, in order; a public share adds the license with the files. */
export const APP_SHARE_STEPS = ['create-repository', 'add-topic', 'commit-files', 'create-release'] as const;
export type AppShareStep = (typeof APP_SHARE_STEPS)[number];

/** The steps of adding the MIT license to an existing repository. */
export const APP_LICENSE_STEPS = ['commit-license'] as const;

export type AppStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AppStepState<S extends string> {
  readonly step: S;
  readonly status: AppStepStatus;
}

/** Who owns a new repository: the signed-in account itself, or one of its organizations. */
export type AppRepositoryOwnerKind = 'user' | 'organization';

/** What a share asks for. `account` is the signed-in account whose token does the work. */
export interface AppShareRequest {
  readonly id: string;
  readonly account: string;
  readonly owner: string;
  readonly ownerKind: AppRepositoryOwnerKind;
  readonly name: string;
  readonly visibility: AppShareVisibility;
}

/** A repository a share made, and the release it published. */
export interface AppShared {
  readonly owner: string;
  readonly repository: string;
  readonly visibility: AppShareVisibility;
  readonly tag: string;
  readonly asset: string;
  /** SHA-256 of the released zip: what the lockfile records if the app switches to this release. */
  readonly sha256: string;
}

export type AppShareOutcome =
  | { readonly kind: 'shared'; readonly shared: AppShared }
  /** A step failed: `created` says exactly what exists now, so nothing is left unaccounted for. */
  | { readonly kind: 'failed'; readonly step: AppShareStep; readonly message: string; readonly created: readonly string[] };

const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Why a new repository name is not one GitHub takes, or undefined when it is:
 * 1 to 100 letters, digits, `.`, `-` and `_`, not `.` or `..`, not ending `.git`.
 */
export function repositoryNameProblem(name: string): string | undefined {
  if (name.length === 0) {
    return 'Name the repository.';
  }
  if (name.length > APP_PUBLISH_LIMITS.repositoryNameCharsMax) {
    return `A repository name is at most ${APP_PUBLISH_LIMITS.repositoryNameCharsMax} characters.`;
  }
  if (!REPOSITORY_NAME.test(name)) {
    return 'Use letters, digits, “.”, “-” and “_” only.';
  }
  if (name === '.' || name === '..') {
    return 'That name is reserved by GitHub.';
  }
  if (name.toLowerCase().endsWith('.git')) {
    return 'A repository name cannot end in “.git”.';
  }
  return undefined;
}

export function parseNewRepositoryName(input: unknown): string {
  const name = text(input);
  const problem = repositoryNameProblem(name);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  assert(name.length <= APP_PUBLISH_LIMITS.repositoryNameCharsMax, 'A parsed repository name is within GitHub’s limit');
  return name;
}

/** The name a share suggests: the app id, which already keeps to GitHub's characters. */
export function suggestedRepositoryName(appId: string): string {
  const name = appId.replace(/\.git$/i, '-app');
  assert(repositoryNameProblem(name) === undefined, 'An app id makes a valid repository name');
  return name;
}

export function parseAppShareRequest(input: unknown): AppShareRequest {
  const value = record(input);
  const visibility = APP_SHARE_VISIBILITIES.find((known) => known === value['visibility']);
  if (visibility === undefined) {
    throw new Error('A share is private or public');
  }
  const ownerKind = value['ownerKind'] === 'user' ? 'user' : value['ownerKind'] === 'organization' ? 'organization' : undefined;
  if (ownerKind === undefined) {
    throw new Error('A share’s owner is the account or an organization');
  }
  // The name first: its own rules say what is wrong with it, more plainly than the owner's parser.
  const name = parseNewRepositoryName(value['name']);
  const source = parseGitHubSource({ owner: value['owner'], repository: name, asset: 'app.zip' });
  return {
    id: parseAppId(value['id']),
    account: parseGitHubLogin(value['account']),
    owner: source.owner,
    ownerKind,
    name,
    visibility,
  };
}

export function parseAppShareOutcome(input: unknown): AppShareOutcome {
  const value = record(input);
  if (value['kind'] === 'shared') {
    const shared = record(value['shared']);
    const visibility = APP_SHARE_VISIBILITIES.find((known) => known === shared['visibility']);
    if (visibility === undefined) {
      throw new Error('A shared repository is private or public');
    }
    const source = parseGitHubSource({ owner: shared['owner'], repository: shared['repository'], asset: shared['asset'] });
    return {
      kind: 'shared',
      shared: {
        owner: source.owner,
        repository: source.repository,
        visibility,
        tag: parseReleaseTag(shared['tag']),
        asset: source.asset,
        sha256: parseSha256(shared['sha256']),
      },
    };
  }
  if (value['kind'] === 'failed') {
    const step = APP_SHARE_STEPS.find((known) => known === value['step']);
    if (step === undefined) {
      throw new Error('A failed share names its step');
    }
    const created = toArray(value['created']);
    if (created === undefined || created.length > APP_PUBLISH_LIMITS.createdMax) {
      throw new Error('A failed share lists what it created');
    }
    return { kind: 'failed', step, message: message(value['message']), created: created.map(message) };
  }
  throw new Error('A share outcome is shared or failed');
}

/** The release tag a share publishes for a manifest version. */
export function shareReleaseTag(version: string): string {
  const tag = `v${parseAppVersion(version)}`;
  assert(tag.length <= APP_LIMITS.tagCharsMax, 'A release tag is within its bound');
  return tag;
}

/** What each share step is called while it runs. */
export function shareStepLabel(step: AppShareStep, visibility: AppShareVisibility): string {
  switch (step) {
    case 'create-repository':
      return `Create the ${visibility} repository`;
    case 'add-topic':
      return 'Add the stacki-app topic';
    case 'commit-files':
      return visibility === 'public' ? 'Commit the app’s files and the MIT license' : 'Commit the app’s files';
    case 'create-release':
      return 'Release the app bundle';
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

/** The step states for a progress list: done before `current`, running at it, pending after; failed when the run failed there. */
export function shareStepStates(current: AppShareStep | 'finished', failed: { readonly failed: boolean }): readonly AppStepState<AppShareStep>[] {
  const index = current === 'finished' ? APP_SHARE_STEPS.length : APP_SHARE_STEPS.indexOf(current);
  assert(index >= 0, 'The current step is a share step');
  const states = APP_SHARE_STEPS.map((step, position): AppStepState<AppShareStep> => {
    if (position < index) {
      return { step, status: 'done' };
    }
    if (position === index) {
      return { step, status: failed.failed ? 'failed' : 'running' };
    }
    return { step, status: 'pending' };
  });
  assert(states.length === APP_SHARE_STEPS.length, 'Every step has a state');
  return states;
}

/** A share's progress event: the step now running. */
export function parseAppShareProgress(input: unknown): { readonly id: string; readonly step: AppShareStep } {
  const value = record(input);
  const step = APP_SHARE_STEPS.find((known) => known === value['step']);
  if (step === undefined) {
    throw new Error('A share progress event names a step');
  }
  return { id: parseAppId(value['id']), step };
}

// ---------------------------------------------------------------------------
// The MIT license
// ---------------------------------------------------------------------------

/** The standard MIT license text, for `year` and its copyright holder. */
export function mitLicenseText(year: number, holder: string): string {
  assert(Number.isSafeInteger(year), 'A copyright year is a whole year');
  assert(year >= 2000, 'A copyright year is a recent one');
  const name = holder.trim().slice(0, APP_PUBLISH_LIMITS.holderCharsMax);
  assert(name.length > 0, 'A license names its copyright holder');
  return `MIT License

Copyright (c) ${year} ${name}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// ---------------------------------------------------------------------------
// Making a repository public
// ---------------------------------------------------------------------------

/**
 * What asking GitHub to make a repository public came to. A refusal is a value,
 * not an error: the popup shows why and links to the repository's settings.
 * `scope`: the token cannot change repositories; `admin`: the account is not an
 * admin of the repository; `policy`: the organization forbids public repositories.
 */
export type AppVisibilityOutcome =
  { readonly kind: 'public' } | { readonly kind: 'forbidden'; readonly reason: 'scope' | 'admin' | 'policy'; readonly settingsURL: string };

/** The repository's settings page on GitHub, where its visibility and collaborators are changed. */
export function repositorySettingsURL(owner: string, repository: string): string {
  const source = parseGitHubSource({ owner, repository, asset: 'app.zip' });
  return `https://github.com/${source.owner}/${source.repository}/settings`;
}

/** The repository's page on GitHub. */
export function repositoryURL(owner: string, repository: string): string {
  const source = parseGitHubSource({ owner, repository, asset: 'app.zip' });
  return `https://github.com/${source.owner}/${source.repository}`;
}

/** Where people are invited: an organization's repository is shared with teams, a personal one with collaborators. */
export function repositoryAccessURL(owner: string, repository: string): string {
  return `${repositorySettingsURL(owner, repository)}/access`;
}

export function parseAppVisibilityOutcome(input: unknown): AppVisibilityOutcome {
  const value = record(input);
  if (value['kind'] === 'public') {
    return { kind: 'public' };
  }
  if (value['kind'] !== 'forbidden') {
    throw new Error('A visibility outcome is public or forbidden');
  }
  const reason = value['reason'] === 'scope' ? 'scope' : value['reason'] === 'admin' ? 'admin' : value['reason'] === 'policy' ? 'policy' : undefined;
  if (reason === undefined) {
    throw new Error('A refusal says why');
  }
  const settingsURL = text(value['settingsURL']);
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/settings$/.test(settingsURL)) {
    throw new Error('A refusal links to the repository’s settings on GitHub');
  }
  return { kind: 'forbidden', reason, settingsURL };
}

// ---------------------------------------------------------------------------
// Marketplace readiness and submission
// ---------------------------------------------------------------------------

/** What GitHub says about a repository, as the marketplace checklist needs it. */
export interface AppRepositoryStatus {
  readonly owner: string;
  readonly repository: string;
  readonly private: boolean;
  readonly topic: boolean;
  /** The SPDX id GitHub detected (`MIT`), undefined when it found no license. */
  readonly license: string | undefined;
  /** The latest release with a zip asset, undefined when there is none. */
  readonly release: { readonly tag: string; readonly asset: string } | undefined;
  /** The name or login a LICENSE's copyright line names: the owner's display name, else its login. */
  readonly holder: string;
}

export function parseAppRepositoryStatus(input: unknown): AppRepositoryStatus {
  const value = record(input);
  const source = parseGitHubSource({ owner: value['owner'], repository: value['repository'], asset: 'app.zip' });
  if (typeof value['private'] !== 'boolean' || typeof value['topic'] !== 'boolean') {
    throw new Error('A repository status says whether it is private and tagged');
  }
  const license = value['license'] === undefined ? undefined : text(value['license']).slice(0, 64);
  const release =
    value['release'] === undefined
      ? undefined
      : (() => {
          const fields = record(value['release']);
          const asset = parseGitHubSource({ owner: source.owner, repository: source.repository, asset: fields['asset'] }).asset;
          return { tag: parseReleaseTag(fields['tag']), asset };
        })();
  const holder = text(value['holder']).trim();
  if (holder.length === 0 || holder.length > APP_PUBLISH_LIMITS.holderCharsMax) {
    throw new Error('A repository status names the copyright holder');
  }
  return { owner: source.owner, repository: source.repository, private: value['private'], topic: value['topic'], license, release, holder };
}

/** One line of the checklist the marketplace step shows before Submit. */
export type MarketplaceCheck = 'public' | 'topic' | 'release' | 'license' | 'scan';

export interface MarketplaceReadiness {
  /** Every check, in order, with whether it passes. */
  readonly checks: readonly { readonly check: MarketplaceCheck; readonly passed: boolean }[];
  readonly ready: boolean;
}

/** Whether a repository may be submitted: public, tagged, released, MIT licensed and scanned clean. */
export function marketplaceReadiness(status: AppRepositoryStatus, scan: { readonly clean: boolean }): MarketplaceReadiness {
  const checks: { readonly check: MarketplaceCheck; readonly passed: boolean }[] = [
    { check: 'public', passed: !status.private },
    { check: 'topic', passed: status.topic },
    { check: 'release', passed: status.release !== undefined },
    { check: 'license', passed: status.license === MARKETPLACE_LICENSE },
    { check: 'scan', passed: scan.clean },
  ];
  const ready = checks.every((entry) => entry.passed);
  assert(checks.length === 5, 'Every requirement is checked');
  assert(!ready || status.license === MARKETPLACE_LICENSE, 'A ready repository is MIT licensed');
  return { checks, ready };
}

/** What a person must accept before submitting: the web form's own wording, word for word. */
export const MARKETPLACE_TERMS =
  'I confirm this app is open source under the MIT license, I own the rights to publish it, and I understand Stacki does not review, vet or take responsibility for marketplace apps.';

/** What the in-app submission sends, with the account whose token the Worker confirms the submitter by. */
export interface MarketplaceSubmission {
  readonly owner: string;
  readonly repository: string;
  readonly account: string;
  /** The terms checkbox: a submission without it is refused before anything is sent. */
  readonly acceptedTerms: true;
}

export function parseMarketplaceSubmission(input: unknown): MarketplaceSubmission {
  const value = record(input);
  if (value['acceptedTerms'] !== true) {
    throw new Error('Accept the marketplace terms to submit.');
  }
  const source = parseGitHubSource({ owner: value['owner'], repository: value['repository'], asset: 'app.zip' });
  return {
    owner: source.owner,
    repository: source.repository,
    account: parseGitHubLogin(value['account']),
    acceptedTerms: true,
  };
}

/** The JSON body the Worker reads: the release's address and `accept`, the terms the person ticked. */
export function submissionBody(submission: MarketplaceSubmission, release: { readonly tag: string }): string {
  assert(submission.acceptedTerms, 'Only an accepted submission is sent');
  const repository = `${repositoryURL(submission.owner, submission.repository)}/releases/tag/${encodeURIComponent(release.tag)}`;
  assert(repository.length <= APP_PUBLISH_LIMITS.submissionSourceCharsMax, 'The release address is within the Worker’s bound');
  return JSON.stringify({ repository, accept: true });
}

/**
 * What a submission came to. `updated` is the Worker's answer for an app already
 * pending or listed: its submission was updated. `refused` carries the Worker's
 * message as is. `unavailable` is an endpoint that cannot take submissions yet
 * (`unconfigured`, a 404 before the Worker is deployed, no answer): the web form
 * is the fallback.
 */
export type MarketplaceSubmissionOutcome =
  | { readonly kind: 'submitted'; readonly id: number | undefined; readonly updated: boolean }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The Worker's reply, from its status and body text. */
export function submissionOutcome(status: number, body: string): MarketplaceSubmissionOutcome {
  assert(Number.isSafeInteger(status), 'An HTTP status is a whole number');
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(body.slice(0, APP_PUBLISH_LIMITS.submissionReplyBytesMax));
    parsed = record(value);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { kind: 'unavailable', message: `The marketplace answered HTTP ${status}.` };
  }
  if (status >= 200 && status < 300 && parsed['ok'] === true) {
    const id = parsed['id'];
    return { kind: 'submitted', id: typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined, updated: parsed['updated'] === true };
  }
  const code = typeof parsed['code'] === 'string' ? parsed['code'].slice(0, 40) : '';
  const said = typeof parsed['message'] === 'string' ? parsed['message'].trim().slice(0, APP_LIMITS.messageCharsMax) : '';
  if (code === 'unconfigured' || status === 404 || status >= 500 || code === '' || said === '') {
    return { kind: 'unavailable', message: said === '' ? `The marketplace answered HTTP ${status}.` : said };
  }
  return { kind: 'refused', code, message: said };
}

/**
 * What the Worker's check said about a repository before Submit: the app it
 * would list, or why it would refuse it, or that it cannot answer yet.
 */
export type MarketplacePrecheck =
  | { readonly kind: 'ready'; readonly id: string; readonly name: string; readonly version: string; readonly iconPresent: boolean }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The check's address for a repository: `?repository=owner/repo`. */
export function marketplaceCheckAddress(checkURL: string, owner: string, repository: string): string {
  const source = parseGitHubSource({ owner, repository, asset: 'app.zip' });
  const url = new URL(checkURL);
  url.searchParams.set('repository', `${source.owner}/${source.repository}`);
  return url.toString();
}

/** The check's reply, from its status and body text: `{ ok: true, app }`, `{ ok: false, code, message }`, or anything else. */
export function precheckOutcome(status: number, body: string): MarketplacePrecheck {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(body.slice(0, APP_PUBLISH_LIMITS.submissionReplyBytesMax));
    parsed = record(value);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { kind: 'unavailable', message: `The marketplace answered HTTP ${status}.` };
  }
  if (parsed['ok'] === true) {
    try {
      return parseMarketplacePrecheck({ kind: 'ready', ...record(parsed['app']) });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      return { kind: 'unavailable', message: 'The marketplace’s check answered in a shape Stacki does not read.' };
    }
  }
  const code = typeof parsed['code'] === 'string' ? parsed['code'].slice(0, 40) : '';
  const said = typeof parsed['message'] === 'string' ? parsed['message'].trim().slice(0, APP_LIMITS.messageCharsMax) : '';
  if (code === 'unconfigured' || status === 404 || status >= 500 || code === '' || said === '') {
    return { kind: 'unavailable', message: said === '' ? `The marketplace answered HTTP ${status}.` : said };
  }
  return { kind: 'refused', code, message: said };
}

export function parseMarketplacePrecheck(input: unknown): MarketplacePrecheck {
  const value = record(input);
  switch (value['kind']) {
    case 'ready': {
      const name = text(value['name']).trim();
      if (name.length === 0 || name.length > APP_LIMITS.nameCharsMax) {
        throw new Error('A checked app has a name');
      }
      return {
        kind: 'ready',
        id: parseAppId(value['id']),
        name,
        version: parseAppVersion(value['version']),
        iconPresent: value['iconPresent'] === true,
      };
    }
    case 'refused': {
      const code = text(value['code']);
      if (code.length === 0 || code.length > 40) {
        throw new Error('A refusal names its code');
      }
      return { kind: 'refused', code, message: message(value['message']) };
    }
    case 'unavailable':
      return { kind: 'unavailable', message: message(value['message']) };
    default:
      throw new Error('A marketplace check is ready, refused or unavailable');
  }
}

export function parseSubmissionOutcome(input: unknown): MarketplaceSubmissionOutcome {
  const value = record(input);
  switch (value['kind']) {
    case 'submitted': {
      const id = value['id'];
      if (id !== undefined && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
        throw new Error('A submission id is a whole number');
      }
      return { kind: 'submitted', id, updated: value['updated'] === true };
    }
    case 'refused': {
      const code = text(value['code']);
      if (code.length === 0 || code.length > 40) {
        throw new Error('A refusal names its code');
      }
      return { kind: 'refused', code, message: message(value['message']) };
    }
    case 'unavailable':
      return { kind: 'unavailable', message: message(value['message']) };
    default:
      throw new Error('A submission outcome is submitted, refused or unavailable');
  }
}

function message(input: unknown): string {
  const value = text(input).trim();
  if (value.length === 0 || value.length > APP_LIMITS.messageCharsMax) {
    throw new Error('A message is 1 to 1000 characters');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Wire values the popups send
// ---------------------------------------------------------------------------

/** A repository and the signed-in account that acts on it. */
export interface AppRepositoryRef {
  readonly owner: string;
  readonly repository: string;
  readonly account: string;
}

export function parseAppRepositoryRef(input: unknown): AppRepositoryRef {
  const value = record(input);
  const source = parseGitHubSource({ owner: value['owner'], repository: value['repository'], asset: 'app.zip' });
  return { owner: source.owner, repository: source.repository, account: parseGitHubLogin(value['account']) };
}

/** What a secret scan reads: an installed app's folder, or a repository's latest release. */
export type AppScanTarget = { readonly kind: 'installed'; readonly id: string } | ({ readonly kind: 'repository' } & AppRepositoryRef);

export function parseAppScanTarget(input: unknown): AppScanTarget {
  const value = record(input);
  if (value['kind'] === 'installed') {
    return { kind: 'installed', id: parseAppId(value['id']) };
  }
  if (value['kind'] === 'repository') {
    return { kind: 'repository', ...parseAppRepositoryRef(value) };
  }
  throw new Error('A scan reads an installed app or a repository');
}

/** The release an app switches to after a share: a GitHub source with its tag. */
export function parseSharedReleaseSource(input: unknown): AppGitHubSource & { readonly tag: string } {
  const value = record(input);
  return { ...parseGitHubSource(value), tag: parseReleaseTag(value['tag']) };
}
