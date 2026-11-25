// The decisions behind the Publish to marketplace and Share app popups, kept
// pure so they are tested without a browser: which sources the publish chooser
// lists, which owners a share offers, what each visibility says, what the
// confirmations and refusals say, and the checklist's wording.
import { assert } from '../../../shared/core/assert';
import { APP_GITHUB_CHOICE_LIMITS, type AppRepository, type AppSummary } from '../../../shared/properties/apps';
import {
  DEFAULT_APP_SHARE_VISIBILITY,
  repositoryNameProblemDescribed,
  type AppRepositoryOwnerKind,
  type AppShareVisibility,
  type AppVisibilityOutcome,
  type MarketplaceCheck,
} from '../../../shared/properties/appPublish';
import { marketplaceApp, type MarketplaceIndex } from '../../../shared/properties/appMarketplace';
import { appListedInMarketplace } from '../../../shared/properties/appPlace';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import type { Translator, TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import { chooserRows, type ChooserRow } from './repositoryChooser';

/** A row of the publish chooser: the Load chooser's rows, plus apps uploaded to this project. */
export type PublishRow = ChooserRow | { readonly kind: 'uploaded'; readonly key: string; readonly app: AppSummary };

/** The rows Enter and the arrows move over. */
export type PublishPickable = Extract<PublishRow, { readonly kind: 'use' | 'repository' | 'uploaded' }>;

/**
 * The GitHub repository an installed app is already published to, and whether the marketplace lists
 * it. An app installed from a file or the project folder is "already shared" when the marketplace
 * lists its id (the listing names the repository, so a copy of a published app is not shared a
 * second time) or its manifest names the repository it updates from. A GitHub install is published
 * to its own repository; a marketplace install is the listing's and has nothing to submit.
 */
export interface AppPublication {
  readonly owner: string;
  readonly repository: string;
  /** The signed-in account that reads the repository, when the source names one. */
  readonly account: string | undefined;
  /** Whether the marketplace lists the app: it then follows the repository's releases by itself, so there is nothing to submit. */
  readonly listed: boolean;
}

/**
 * Where `app` is already published, or undefined when it lives only in this project (or is a
 * marketplace install). `index` is the marketplace index the Marketplace tab reads, undefined where
 * it could not be read or the role may not see it.
 *
 * Security: a listed id yields the listing's own repository, never the manifest's, so a manifest cannot
 * steer a submission to another repository under a listed id. An unlisted app's manifest is checked
 * by the publish checklist and the marketplace like any repository a person picks.
 */
export function appPublication(app: Pick<AppSummary, 'manifest' | 'lock'>, index: MarketplaceIndex | undefined): AppPublication | undefined {
  const { source } = app.lock;
  const { id } = app.manifest;
  assert(id.length > 0, 'An installed app has an id');
  switch (source.kind) {
    case 'github': {
      assert(source.owner.length > 0, 'A GitHub source names its owner');
      const listed = index !== undefined && appListedInMarketplace(index, { id, source });
      return { owner: source.owner, repository: source.repository, account: source.account, listed };
    }
    case 'file':
    case 'local': {
      const listing = index === undefined ? undefined : marketplaceApp(index, id);
      if (listing !== undefined) {
        assert(listing.source.owner.length > 0, 'A listing names its repository owner');
        return { owner: listing.source.owner, repository: listing.source.repository, account: undefined, listed: true };
      }
      const named = app.manifest.source;
      if (named !== undefined) {
        return { owner: named.owner, repository: named.repository, account: named.account, listed: false };
      }
      return undefined;
    }
    case 'marketplace':
      return undefined;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Whether Share to GitHub applies to this app now: it has no repository yet (appShareable) and is not already published. */
export function appNeedsShare(source: AppSummary['lock']['source'], publication: AppPublication | undefined): boolean {
  return appShareable(source) && publication === undefined;
}

/**
 * Apps installed from a file or added to the project folder that no repository holds yet: the ones a
 * share puts on GitHub. An app already published is reached through its repository instead.
 */
export function uploadedApps(apps: readonly AppSummary[], options: { readonly published: (app: AppSummary) => boolean }): readonly AppSummary[] {
  const uploaded = apps.filter((app) => appShareable(app.lock.source) && !options.published(app));
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
 * Where an app's "Submit to marketplace" leads: a GitHub app that is not listed yet straight to its
 * own repository's checklist, as does an uploaded or folder app that is already
 * published (appPublication); any other uploaded one into Share first (the marketplace
 * takes GitHub repositories only), when the role may share; otherwise nowhere,
 * and the item is hidden rather than offered as a dead end. An app the marketplace
 * lists has nothing to submit, whatever its source: the marketplace follows the
 * repository's releases (a new version is a new GitHub release, never a submission),
 * so the item is hidden for it too.
 */
export type MarketplaceSubmitRoute =
  | { readonly kind: 'publish'; readonly owner: string; readonly repository: string; readonly account: string | undefined }
  | { readonly kind: 'share-first' }
  | { readonly kind: 'none' };

export function marketplaceSubmitRoute(
  source: AppSummary['lock']['source'],
  options: { readonly mayShare: boolean; readonly publication: AppPublication | undefined },
): MarketplaceSubmitRoute {
  switch (source.kind) {
    case 'github':
      assert(source.owner.length > 0, 'A GitHub source names its owner');
      assert(source.repository.length > 0, 'A GitHub source names its repository');
      if (options.publication?.listed === true) {
        return { kind: 'none' };
      }
      return { kind: 'publish', owner: source.owner, repository: source.repository, account: source.account };
    case 'file':
    case 'local': {
      const { publication } = options;
      if (publication?.listed === true) {
        return { kind: 'none' };
      }
      if (publication !== undefined) {
        // Already on GitHub: the checklist opens on that repository, with no share in between.
        return { kind: 'publish', owner: publication.owner, repository: publication.repository, account: publication.account };
      }
      if (appShareable(source) && options.mayShare) {
        return { kind: 'share-first' };
      }
      return { kind: 'none' };
    }
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
  const github = chooserRows({ query: input.query, repositories: input.repositories }).map(
    (row): PublishRow => (row.kind === 'section' ? { ...row, label: 'Your GitHub apps', labelRef: messageRef('apps.chooser.sectionYours') } : row), // i18n-ignore: English identity of the section; the heading drawn is `labelRef` translated.
  );
  const needle = input.query.trim().toLowerCase();
  const uploaded = input.uploaded.filter((app) => needle === '' || `${app.manifest.name} ${app.manifest.id}`.toLowerCase().includes(needle));
  const rows: PublishRow[] = [...github];
  if (uploaded.length > 0) {
    rows.push({ kind: 'section', key: 'section:uploaded', label: 'Uploaded to this project', labelRef: messageRef('apps.chooser.sectionUploaded') }); // i18n-ignore: English identity of the section; the heading drawn is `labelRef` translated.
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
  | { readonly kind: 'invalid'; readonly message: string; readonly messageRef?: TypedMessageRef | undefined }
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
  const problem = repositoryNameProblemDescribed(input.name);
  if (problem !== undefined) {
    return { kind: 'invalid', ...problem };
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
  translate: Translator,
): readonly { readonly visibility: AppShareVisibility; readonly title: string; readonly detail: string }[] {
  assert(owner.length > 0, 'A visibility describes an owner');
  const action = translate('apps.loadFromGitHub');
  const choices = [
    {
      visibility: 'private' as const,
      title: translate('apps.visibility.private'),
      detail:
        ownerKind === 'organization'
          ? translate('apps.visibility.privateOrganization', { owner, action })
          : translate('apps.visibility.privateUser', { action }),
    },
    {
      visibility: 'public' as const,
      title: translate('apps.visibility.public'),
      detail: translate('apps.visibility.publicDetail'),
    },
  ];
  assert(choices[0]?.visibility === DEFAULT_APP_SHARE_VISIBILITY, 'The default visibility is offered first');
  return choices;
}

/** What the confirmation before making a repository public says. */
export function makePublicConfirmation(
  owner: string,
  repository: string,
  translate: Translator,
): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  const name = `${owner}/${repository}`;
  return {
    title: translate('apps.makePublic.title', { name }),
    body: translate('apps.makePublic.body', { name }),
    confirmLabel: translate('apps.makePublic.confirm'),
  };
}

/** What the confirmation before a public share says. */
export function publicShareConfirmation(
  owner: string,
  name: string,
  translate: Translator,
): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return {
    title: translate('apps.publicShare.title', { name: `${owner}/${name}` }),
    body: translate('apps.publicShare.body'),
    confirmLabel: translate('apps.publicShare.confirm'),
  };
}

/** What the confirmation before adding the MIT license says. */
export function licenseConfirmation(
  owner: string,
  repository: string,
  holder: string,
  year: number,
  translate: Translator,
): { readonly title: string; readonly body: string; readonly confirmLabel: string } {
  return {
    title: translate('apps.license.title', { name: `${owner}/${repository}` }),
    body: translate('apps.license.body', { year, holder }),
    confirmLabel: translate('apps.license.confirm'),
  };
}

/** Why GitHub refused to make a repository public, and what to do about it. */
export function visibilityRefusal(
  outcome: Extract<AppVisibilityOutcome, { readonly kind: 'forbidden' }>,
  translate: Translator,
): { readonly title: string; readonly detail: string } {
  switch (outcome.reason) {
    case 'scope':
      return { title: translate('apps.refusal.scope.title'), detail: translate('apps.refusal.scope.detail') };
    case 'admin':
      return { title: translate('apps.refusal.admin.title'), detail: translate('apps.refusal.admin.detail') };
    case 'policy':
      return { title: translate('apps.refusal.policy.title'), detail: translate('apps.refusal.policy.detail') };
    default: {
      const exhaustive: never = outcome.reason;
      return exhaustive;
    }
  }
}

/** One checklist line before Submit. */
export function marketplaceCheckLabel(check: MarketplaceCheck, translate: Translator): string {
  switch (check) {
    case 'public':
      return translate('apps.check.public');
    case 'topic':
      return translate('apps.check.topic');
    case 'release':
      return translate('apps.check.release');
    case 'license':
      return translate('apps.check.license');
    case 'scan':
      return translate('apps.check.scan');
    default: {
      const exhaustive: never = check;
      return exhaustive;
    }
  }
}
