// Where an installed app lives, as the Apps panel's rows and the details' About
// section say it: only in this project (an uploaded file or a folder app), or on
// GitHub (a GitHub release or a marketplace install), and whether the app is
// listed in the official marketplace.
//
// A GitHub repository's visibility is asked of GitHub by the host process
// (electron/project/appRepositoryPlace.ts), with the publishing account's token
// on Desktop and without one in Studio; the renderer parses the reply here. A
// lookup that fails says nothing rather than an error: the pill reads "GitHub"
// alone. The marketplace match is the renderer's, against the index it already
// reads (shared/properties/appMarketplace.ts), so it costs no extra request.
import { assert } from '../core/assert';
import { record } from '../core/boundary';
import { parseGitHubSource, type AppInstallSource } from './apps';
import { marketplaceApp, type MarketplaceIndex } from './appMarketplace';

export const APP_PLACE_LIMITS = {
  /** How long a repository's visibility is reused before GitHub is asked again. */
  visibilityCacheMsMax: 10 * 60_000,
  /** How long a failed lookup is remembered, so a reopened panel does not ask GitHub again at once. */
  visibilityFailureMsMax: 60_000,
  /** Repositories whose visibility is remembered; the oldest is forgotten first. */
  visibilityReposMax: 100,
} as const satisfies Record<string, number>;

export const APP_REPOSITORY_VISIBILITIES = ['private', 'public'] as const;
export type AppRepositoryVisibility = (typeof APP_REPOSITORY_VISIBILITIES)[number];

/** A GitHub repository an installed app updates from, and the account that reads it (Desktop only). */
export interface AppRepositoryLocation {
  readonly owner: string;
  readonly repository: string;
  readonly account: string | undefined;
}

/** An installed app's GitHub repository and, when GitHub answered, whether it is private. */
export interface AppRepositoryPlace {
  readonly owner: string;
  readonly repository: string;
  /** Undefined when the lookup failed or, without a token, could not confirm the repository is public. */
  readonly visibility: AppRepositoryVisibility | undefined;
}

/** The reply of a visibility lookup: undefined `place` for an app that has no GitHub repository. */
export interface AppRepositoryPlaceReply {
  readonly place: AppRepositoryPlace | undefined;
}

/** Where an app lives, as one of the row's pills names it. */
export type AppPillKind = 'local' | 'github' | 'marketplace';

export interface AppPill {
  readonly kind: AppPillKind;
  readonly label: string;
  /** What hovering the pill explains. */
  readonly tooltip: string;
}

/** `{ place: { owner, repository, visibility? } | undefined }`, checked and bounded. */
export function parseAppRepositoryPlaceReply(input: unknown): AppRepositoryPlaceReply {
  const value = record(input);
  if (value['place'] === undefined) {
    return { place: undefined };
  }
  return { place: parseAppRepositoryPlace(value['place']) };
}

export function parseAppRepositoryPlace(input: unknown): AppRepositoryPlace {
  const value = record(input);
  // The same owner and repository rules as an install source.
  const source = parseGitHubSource({ owner: value['owner'], repository: value['repository'], asset: 'app.zip' });
  const visibility = value['visibility'];
  if (visibility === undefined) {
    return { owner: source.owner, repository: source.repository, visibility: undefined };
  }
  const known = APP_REPOSITORY_VISIBILITIES.find((entry) => entry === visibility);
  if (known === undefined) {
    throw new Error('A repository is "private" or "public"');
  }
  return { owner: source.owner, repository: source.repository, visibility: known };
}

/**
 * The GitHub repository an installed app updates from: a GitHub install's own,
 * a marketplace install's from the index (read as public, with no account).
 * Undefined for an app that lives only in the project, or a marketplace app the
 * index no longer lists (or that could not be read).
 */
export function appRepositoryLocation(source: AppInstallSource, index: MarketplaceIndex | undefined): AppRepositoryLocation | undefined {
  switch (source.kind) {
    case 'github':
      return { owner: source.owner, repository: source.repository, account: source.account };
    case 'marketplace': {
      const listed = index === undefined ? undefined : marketplaceApp(index, source.id);
      if (listed === undefined) {
        return undefined;
      }
      assert(listed.source.account === undefined, 'A marketplace repository is read as public');
      return { owner: listed.source.owner, repository: listed.source.repository, account: undefined };
    }
    case 'file':
    case 'local':
      return undefined;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/**
 * Whether the marketplace lists this installed app: the index names its id and,
 * for a GitHub install, the same repository (an app of the same id from another
 * repository is not this one). A marketplace install matches by id; an app that
 * lives only in the project never matches, whatever its id.
 */
export function appListedInMarketplace(index: MarketplaceIndex, app: { readonly id: string; readonly source: AppInstallSource }): boolean {
  assert(app.id.length > 0, 'An installed app has an id');
  const { source } = app;
  switch (source.kind) {
    case 'github': {
      const listed = marketplaceApp(index, app.id);
      if (listed === undefined) {
        return false;
      }
      return sameRepository(listed.source, source);
    }
    case 'marketplace':
      assert(source.id === app.id, 'A marketplace install names its own entry');
      return marketplaceApp(index, source.id) !== undefined;
    case 'file':
    case 'local':
      return false;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/**
 * The pills an installed app's row shows, in order: where it lives ("Local", or
 * "GitHub" with the repository's visibility when known), then "Marketplace" when
 * the index lists it. `place` is the visibility lookup's answer, if any yet.
 */
export function appPlacePills(
  source: AppInstallSource,
  facts: { readonly place: AppRepositoryPlace | undefined; readonly listed: boolean },
): readonly AppPill[] {
  // One origin, three words: Marketplace (installed from it, or listed in it), GitHub, or Local. A marketplace
  // app is also on GitHub and a listed local copy is also in the marketplace; the row says the most specific.
  const pills: readonly AppPill[] =
    source.kind === 'marketplace' || facts.listed
      ? [{ kind: 'marketplace', label: 'Marketplace', tooltip: 'Listed in the Stacki marketplace' }]
      : [appHomePill(source, facts.place)];
  assert(pills.length === 1, 'A row says where the app comes from with one pill');
  return pills;
}

function appHomePill(source: AppInstallSource, place: AppRepositoryPlace | undefined): AppPill {
  switch (source.kind) {
    case 'file':
      return { kind: 'local', label: 'Local', tooltip: `Uploaded as ${source.fileName}; only in this project's .stacki/apps folder` };
    case 'local':
      return { kind: 'local', label: 'Local', tooltip: "Only in this project's .stacki/apps folder" };
    case 'github':
    case 'marketplace':
      return githubPill(place);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function githubPill(place: AppRepositoryPlace | undefined): AppPill {
  if (place === undefined) {
    return { kind: 'github', label: 'GitHub', tooltip: 'Installed from a GitHub release' };
  }
  const repository = `${place.owner}/${place.repository}`;
  switch (place.visibility) {
    case 'private':
      return { kind: 'github', label: 'GitHub · Private', tooltip: `Installed from ${repository}, a private GitHub repository` };
    case 'public':
      return { kind: 'github', label: 'GitHub · Public', tooltip: `Installed from ${repository}, a public GitHub repository` };
    case undefined:
      return { kind: 'github', label: 'GitHub', tooltip: `Installed from ${repository} on GitHub` };
    default: {
      const exhaustive: never = place.visibility;
      return exhaustive;
    }
  }
}

// GitHub owner and repository names are case-insensitive.
function sameRepository(
  left: { readonly owner: string; readonly repository: string },
  right: { readonly owner: string; readonly repository: string },
): boolean {
  if (left.owner.toLowerCase() === right.owner.toLowerCase()) {
    return left.repository.toLowerCase() === right.repository.toLowerCase();
  }
  return false;
}
