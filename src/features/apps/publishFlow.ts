// The decisions behind the Publish to marketplace and Share app popups, kept
// pure so they are tested without a browser: which sources the publish chooser
// lists, which owners a share offers, what each visibility says, what the
// confirmations and refusals say, and the checklist's wording.
import { assert } from '../../../shared/core/assert';
import { APP_GITHUB_CHOICE_LIMITS, type AppRepository, type AppSummary } from '../../../shared/properties/apps';
import {
  DEFAULT_APP_SHARE_VISIBILITY,
  repositoryNameProblem,
  type AppRepositoryOwnerKind,
  type AppShareVisibility,
  type AppVisibilityOutcome,
  type MarketplaceCheck,
} from '../../../shared/properties/appPublish';
import { LOAD_FROM_GITHUB_LABEL, chooserRows, type ChooserRow } from './repositoryChooser';

/** A row of the publish chooser: the Load chooser's rows, plus apps uploaded to this project. */
export type PublishRow = ChooserRow | { readonly kind: 'uploaded'; readonly key: string; readonly app: AppSummary };

/** The rows Enter and the arrows move over. */
export type PublishPickable = Extract<PublishRow, { readonly kind: 'use' | 'repository' | 'uploaded' }>;

/** Apps installed from a file or added to the project folder: the ones a share puts on GitHub. */
export function uploadedApps(apps: readonly AppSummary[]): readonly AppSummary[] {
  const uploaded = apps.filter((app) => appShareable(app.lock.source));
  assert(uploaded.length <= apps.length, 'Uploaded apps are installed apps');
  return uploaded;
}

/**
 * Whether Share to GitHub applies to an app from this source: an uploaded file,
 * or a folder added to the project. Both have no GitHub release yet; the main
 * process shares exactly these (appPublishService.ts). A GitHub or marketplace
 * app already has one.
 */
export function appShareable(source: AppSummary['lock']['source']): boolean {
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

/**
 * Where an app's "Submit to marketplace" leads: a GitHub app straight to its
 * own repository's checklist; an uploaded one into Share first (the marketplace
 * takes GitHub repositories only), when the role may share; otherwise nowhere,
 * and the item is hidden rather than offered as a dead end. A marketplace app is
 * already listed.
 */
export type MarketplaceSubmitRoute =
  | { readonly kind: 'publish'; readonly owner: string; readonly repository: string; readonly account: string | undefined }
  | { readonly kind: 'share-first' }
  | { readonly kind: 'none' };

export function marketplaceSubmitRoute(source: AppSummary['lock']['source'], options: { readonly mayShare: boolean }): MarketplaceSubmitRoute {
  switch (source.kind) {
    case 'github':
      assert(source.owner.length > 0, 'A GitHub source names its owner');
      assert(source.repository.length > 0, 'A GitHub source names its repository');
      return { kind: 'publish', owner: source.owner, repository: source.repository, account: source.account };
    case 'file':
    case 'local':
      if (appShareable(source) && options.mayShare) {
        return { kind: 'share-first' };
      }
      return { kind: 'none' };
    case 'marketplace':
      return { kind: 'none' };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/**
 * Two sections: "Your GitHub apps" (the account's `stacki-app` repositories, as
 * the Load chooser lists them, with a pasted repository's Use row first) and
 * "Uploaded to this project" (apps installed from a file). Typing filters both.
 */
export function publishChooserRows(input: {
  readonly query: string;
  readonly repositories: readonly AppRepository[] | undefined;
  readonly uploaded: readonly AppSummary[];
}): readonly PublishRow[] {
  const github = chooserRows({ query: input.query, repositories: input.repositories }).map((row): PublishRow =>
    row.kind === 'section' ? { ...row, label: 'Your GitHub apps' } : row,
  );
  const needle = input.query.trim().toLowerCase();
  const uploaded = input.uploaded.filter((app) => needle === '' || `${app.manifest.name} ${app.manifest.id}`.toLowerCase().includes(needle));
  const rows: PublishRow[] = [...github];
  if (uploaded.length > 0) {
    rows.push({ kind: 'section', key: 'section:uploaded', label: 'Uploaded to this project' });
    rows.push(...uploaded.map((app): PublishRow => ({ kind: 'uploaded', key: `uploaded:${app.manifest.id}`, app })));
  }
  assert(rows.length <= github.length + uploaded.length + 1, 'Rows come from the two sources');
  return rows;
}

export function publishPickables(rows: readonly PublishRow[]): readonly PublishPickable[] {
  return rows.filter((row): row is PublishPickable => row.kind === 'use' || row.kind === 'repository' || row.kind === 'uploaded');
}

/** Who a share may create the repository under: the account itself, then the organizations its repositories belong to. */
export function shareOwners(
  account: string,
  repositories: readonly AppRepository[],
): readonly { readonly login: string; readonly kind: AppRepositoryOwnerKind }[] {
  assert(account.length > 0, 'A share has an account');
  const organizations = new Map<string, string>();
  for (const repository of repositories.slice(0, APP_GITHUB_CHOICE_LIMITS.repositoriesMax)) {
    if (repository.organization && repository.owner.toLowerCase() !== account.toLowerCase()) {
      organizations.set(repository.owner.toLowerCase(), repository.owner);
    }
  }
  const owners = [{ login: account, kind: 'user' as const }, ...[...organizations.values()].sort().map((login) => ({ login, kind: 'organization' as const }))];
  assert(owners[0]?.login === account, 'The account itself is offered first');
  return owners;
}

/** An owner a share may create the repository under, with the signed-in account that creates it. */
export interface ShareOwnerChoice {
  /** `account/login`: unique across accounts, because two accounts can belong to one organization. */
  readonly key: string;
  readonly account: string;
  readonly login: string;
  readonly kind: AppRepositoryOwnerKind;
}

/** The most signed-in accounts the owner menu groups; publishing discovers a handful at most. */
export const SHARE_ACCOUNTS_MAX = 16;

/**
 * Every owner the share's owner menu offers: for each signed-in account, in its
 * order, the account itself and then its organizations (shareOwners). The menu
 * groups them by account when there is more than one, so the account choice
 * needs no control of its own.
 */
export function shareOwnerChoices(accounts: readonly string[], repositoriesOf: (account: string) => readonly AppRepository[]): readonly ShareOwnerChoice[] {
  const bounded = accounts.slice(0, SHARE_ACCOUNTS_MAX);
  const choices = bounded.flatMap((account) =>
    shareOwners(account, repositoriesOf(account)).map((owner) => ({ key: `${account}/${owner.login}`, account, login: owner.login, kind: owner.kind })),
  );
  assert(choices.length >= bounded.length, 'Each account offers itself');
  assert(new Set(choices.map((choice) => choice.key)).size === choices.length, 'Owner keys are unique');
  return choices;
}

/** What the share knows about an account's repositories while a name is typed. */
export type ShareListing =
  | { readonly kind: 'loading' }
  /** The listing failed or is not available: existence cannot be told. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ready'; readonly repositories: readonly AppRepository[] };

/** What the destination field says about the typed repository name. */
export type RepositoryNameStatus =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'available' }
  /** Valid, but existence cannot be told (an organization's unseen repositories, a capped or failed listing). */
  | { readonly kind: 'unchecked' };

/**
 * The typed name against GitHub's rules, then against the account's listing.
 * A listed repository of that owner and name (GitHub compares names without
 * case) already exists. "Available" is claimed only for the account's own
 * login with a listing under the cap, which then holds every repository it
 * owns; an organization can have repositories the account cannot see.
 */
export function repositoryNameStatus(input: {
  readonly owner: string;
  readonly ownerKind: AppRepositoryOwnerKind;
  readonly name: string;
  readonly listing: ShareListing;
}): RepositoryNameStatus {
  assert(input.owner.length > 0, 'A name is checked for an owner');
  const problem = repositoryNameProblem(input.name);
  if (problem !== undefined) {
    return { kind: 'invalid', message: problem };
  }
  const { listing } = input;
  switch (listing.kind) {
    case 'loading':
      return { kind: 'checking' };
    case 'unknown':
      return { kind: 'unchecked' };
    case 'ready': {
      const owner = input.owner.toLowerCase();
      const name = input.name.toLowerCase();
      const repositories = listing.repositories.slice(0, APP_GITHUB_CHOICE_LIMITS.repositoriesMax);
      if (repositories.some((repository) => repository.owner.toLowerCase() === owner && repository.name.toLowerCase() === name)) {
        return { kind: 'exists' };
      }
      if (input.ownerKind === 'user') {
        return repositories.length < APP_GITHUB_CHOICE_LIMITS.repositoriesMax ? { kind: 'available' } : { kind: 'unchecked' };
      }
      return { kind: 'unchecked' };
    }
    default: {
      const exhaustive: never = listing;
      return exhaustive;
    }
  }
}

/** Whether a name status lets the share start: any valid name not known to exist. */
export function repositoryNameUsable(status: RepositoryNameStatus): boolean {
  switch (status.kind) {
    case 'available':
    case 'unchecked':
    case 'checking':
      return true;
    case 'invalid':
    case 'exists':
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** The two visibilities, private first and chosen by default, each with what it means for this owner. */
export function visibilityChoices(
  owner: string,
  ownerKind: AppRepositoryOwnerKind,
): readonly { readonly visibility: AppShareVisibility; readonly title: string; readonly detail: string }[] {
  assert(owner.length > 0, 'A visibility describes an owner');
  const choices = [
    {
      visibility: 'private' as const,
      title: 'Private',
      detail:
        ownerKind === 'organization'
          ? `People in ${owner} can install it with ${LOAD_FROM_GITHUB_LABEL}.`
          : `Only you and people you invite can install it with ${LOAD_FROM_GITHUB_LABEL}.`,
    },
    {
      visibility: 'public' as const,
      title: 'Public',
      detail: 'Anyone can install it. Adds an MIT license.',
    },
  ];
  assert(choices[0]?.visibility === DEFAULT_APP_SHARE_VISIBILITY, 'The default visibility is offered first');
  return choices;
}

/** What the confirmation before making a repository public says. */
export function makePublicConfirmation(owner: string, repository: string): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return {
    title: `Make ${owner}/${repository} public?`,
    body: `Everyone on the internet will be able to see ${owner}/${repository}: all of its code and its whole history, not only the app's files. This cannot be undone from Stacki.`,
    confirmLabel: 'Make public',
  };
}

/** What the confirmation before a public share says. */
export function publicShareConfirmation(owner: string, name: string): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return {
    title: `Create the public repository ${owner}/${name}?`,
    body: 'Everyone on the internet will be able to see the app’s files. Stacki adds an MIT license, so others may use and change them.',
    confirmLabel: 'Create public repository',
  };
}

/** What the confirmation before adding the MIT license says. */
export function licenseConfirmation(
  owner: string,
  repository: string,
  holder: string,
  year: number,
): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return {
    title: `Add the MIT license to ${owner}/${repository}?`,
    body: `Stacki commits a standard MIT LICENSE file, “Copyright (c) ${year} ${holder}”, to the default branch. Anyone may then use, change and share the app.`,
    confirmLabel: 'Add MIT license',
  };
}

/** Why GitHub refused to make a repository public, and what to do about it. */
export function visibilityRefusal(outcome: Extract<AppVisibilityOutcome, { readonly kind: 'forbidden' }>): { readonly title: string; readonly detail: string } {
  switch (outcome.reason) {
    case 'scope':
      return {
        title: 'Your GitHub sign-in cannot change repositories',
        detail: 'Sign in to GitHub again with the repo scope, or change the visibility in the repository’s settings.',
      };
    case 'admin':
      return {
        title: 'Only an admin of this repository can make it public',
        detail: 'Ask an admin of the repository, or change the visibility yourself in its settings if you are one.',
      };
    case 'policy':
      return {
        title: 'The organization does not allow public repositories',
        detail: 'An owner of the organization can allow them, or change the visibility in the repository’s settings.',
      };
    default: {
      const exhaustive: never = outcome.reason;
      return exhaustive;
    }
  }
}

/** One checklist line before Submit. */
export function marketplaceCheckLabel(check: MarketplaceCheck): string {
  switch (check) {
    case 'public':
      return 'The repository is public';
    case 'topic':
      return 'It carries the stacki-app topic';
    case 'release':
      return 'It has a release with the app’s .zip';
    case 'license':
      return 'It uses the MIT license';
    case 'scan':
      return 'The secret scan is clean';
    default: {
      const exhaustive: never = check;
      return exhaustive;
    }
  }
}
