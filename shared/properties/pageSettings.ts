// The Page settings dialog's contract: which page is the homepage, whether another page may become it, what a URL
// name may be, and the requests and replies that cross the IPC boundary for renaming, making a page the homepage,
// duplicating and deleting it (electron/handlers/pageSettingsPlan.ts plans them, electron/project/pageRelocationWrite.ts writes them; src/features/pages/PageSettingsDialog.tsx
// asks for them). Pure: the dialog answers instantly from the scan, and main asks the same questions again of the disk.
import { assert } from '../core/assert';
import { count, list, object, pathText, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { problemOf } from './describedError';
import { described, type Described } from './i18n/messageRef';
import { pageURLPath, parsePageRename, renamePath, type PageRename } from './pageRename';
import { pageRenameConflicts, type RenameInventory } from './pageRenameConflicts';

export const PAGE_SETTINGS_LIMITS = {
  /** Places listed for review in one reply; the count beyond them is still reported. */
  reviewsMax: 200,
  /** Characters of one listed line: enough to recognise it, never a whole minified file. */
  reviewLineCharsMax: 160,
  /** Moves one step makes: a rename moves one file, a homepage swap two. */
  movesMax: 2,
  /** Undo steps main keeps for page settings, oldest forgotten first. */
  undoEntriesMax: 32,
  /** Copies tried for a free duplicate name (`about-copy`, `about-copy-2`, …) before refusing. */
  copyNamesMax: 1000,
  /** Locales read from an astro.config i18n block. */
  localesMax: 64,
} as const satisfies Record<string, number>;

const PAGE_EXTENSION = /\.(astro|mdx?)$/i;
const HOME_PAGE = /^index\.(astro|mdx?)$/i;
const ERROR_PAGE = /^(404|500)\.(astro|mdx?)$/i;

/** The root `index.astro`, `index.md` or `index.mdx`: the page at `/`. A folder's own `blog/index.astro` is not the homepage. */
export function isHomePage(name: string): boolean {
  return HOME_PAGE.test(name);
}

/** The homepages a project has: one normally, none in a project without `/`, two when both index.astro and index.md exist. */
export function homePagesOf(pages: readonly string[]): readonly string[] {
  assert(pages.length <= 100_000, 'A page inventory is bounded');
  const homes = pages.filter(isHomePage);
  assert(homes.length <= 3, 'At most one homepage per page extension');
  return homes;
}

/** Why a page cannot be made the homepage, each a sentence the dialog shows on the disabled button. */
export type HomeSwapRefusal = 'already-home' | 'dynamic' | 'error-page' | 'locale' | 'no-home' | 'two-homes' | 'collision' | 'not-a-page';

export interface HomeSwapInventory {
  readonly pages: readonly string[];
  /** Locale folders of an Astro i18n config; empty when the project has none (or the host cannot tell). */
  readonly locales: readonly string[];
}

/** The two files a swap moves: the current homepage to this page's place, this page to the root `index`. */
export interface HomeSwapMoves {
  readonly home: { readonly from: string; readonly to: string };
  readonly page: { readonly from: string; readonly to: string };
}

/**
 * Whether `page` may become the homepage, and if so the two moves. Each file keeps its own extension: `about.md`
 * becomes `index.md` and `index.astro` becomes `about.astro`. A page in a folder sends the homepage into that folder.
 */
export function homeSwapPlan(page: string, inventory: HomeSwapInventory): Result<HomeSwapMoves, HomeSwapRefusal> {
  assert(inventory.locales.length <= PAGE_SETTINGS_LIMITS.localesMax, 'A locale list is bounded');
  if (!PAGE_EXTENSION.test(page)) {
    return err('not-a-page');
  }
  if (isHomePage(page)) {
    return err('already-home');
  }
  if (page.includes('[')) {
    return err('dynamic');
  }
  const segments = page.split('/');
  if (segments.length === 1) {
    if (ERROR_PAGE.test(page)) {
      return err('error-page');
    }
  }
  const first = segments[0] ?? '';
  if (segments.length > 1) {
    if (inventory.locales.some((locale) => locale.toLowerCase() === first.toLowerCase())) {
      return err('locale');
    }
  }
  const homes = homePagesOf(inventory.pages);
  const home = homes[0];
  if (home === undefined) {
    return err('no-home');
  }
  if (homes.length > 1) {
    return err('two-homes');
  }
  const directory = segments.slice(0, -1).join('/');
  const stem = (segments.at(-1) ?? '').replace(PAGE_EXTENSION, '');
  const homeTarget = (directory ? directory + '/' : '') + stem + extensionOf(home);
  const pageTarget = 'index' + extensionOf(page);
  // Another file at the route this page leaves (about.md beside about/index.astro) would answer `/about` with the
  // old homepage beside it: Astro picks between them by a rule nobody sees here.
  const leaving = pageURLPath(page).toLowerCase();
  const rival = inventory.pages.find((other) => other !== page && other !== home && pageURLPath(other).toLowerCase() === leaving);
  if (rival !== undefined) {
    return err('collision');
  }
  const taken = inventory.pages.find((other) => other !== page && other !== home && other.toLowerCase() === homeTarget.toLowerCase());
  if (taken !== undefined) {
    return err('collision');
  }
  assert(isHomePage(pageTarget), 'The page lands at the root index');
  assert(pageURLPath(homeTarget) === pageURLPath(page), 'The homepage takes the route the page leaves');
  return ok({ home: { from: home, to: homeTarget }, page: { from: page, to: pageTarget } });
}

/** The sentence a refusal shows, in the catalog so every language has it. */
export function homeSwapRefusalText(refusal: HomeSwapRefusal): Described {
  switch (refusal) {
    case 'already-home':
      return described('pages.settings.home.refusal.alreadyHome');
    case 'dynamic':
      return described('pages.settings.home.refusal.dynamic');
    case 'error-page':
      return described('pages.settings.home.refusal.errorPage');
    case 'locale':
      return described('pages.settings.home.refusal.locale');
    case 'no-home':
      return described('pages.settings.home.refusal.noHome');
    case 'two-homes':
      return described('pages.settings.home.refusal.twoHomes');
    case 'collision':
      return described('pages.settings.home.refusal.collision');
    case 'not-a-page':
      return described('pages.settings.home.refusal.notAPage');
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

export type UrlNameCheck =
  { readonly kind: 'unchanged' } | { readonly kind: 'valid'; readonly change: PageRename } | { readonly kind: 'invalid'; readonly problem: Described };

/**
 * What a typed URL name means for `page`: unchanged, a valid rename, or why not. The same checks main makes
 * (parsePageRename, pageRenameConflicts), plus the one only a person needs explained: `index` beside the homepage.
 */
export function checkUrlName(page: string, typed: string, inventory: RenameInventory): UrlNameCheck {
  assert(PAGE_EXTENSION.test(page), 'A URL name belongs to a page file');
  const name = typed.trim().replace(PAGE_EXTENSION, '');
  if (name.length === 0) {
    return { kind: 'invalid', problem: described('pages.settings.slug.empty') };
  }
  if (name.includes('/')) {
    return { kind: 'invalid', problem: described('pages.rename.separators') };
  }
  if (name.includes('\\')) {
    return { kind: 'invalid', problem: described('pages.rename.separators') };
  }
  if (name === '.' || name === '..') {
    return { kind: 'invalid', problem: described('pages.rename.error.outsidePages') };
  }
  const slash = page.lastIndexOf('/');
  const directory = page.slice(0, slash + 1);
  if (directory === '') {
    if (name.toLowerCase() === 'index') {
      return { kind: 'invalid', problem: described('pages.settings.slug.reservedIndex') };
    }
  }
  const target = directory + name + extensionOf(page);
  if (target === page) {
    return { kind: 'unchanged' };
  }
  let change: PageRename;
  try {
    renamePath(target);
    change = parsePageRename({ kind: 'page', from: page, to: target });
  } catch (problem: unknown) {
    return { kind: 'invalid', problem: problemOf(problem) };
  }
  const conflict = pageRenameConflicts(change, inventory);
  return conflict.ok ? { kind: 'valid', change } : { kind: 'invalid', problem: conflict.error };
}

/** A page's URL name as the dialog's field shows it: the file name without its extension. */
export function urlNameOf(page: string): string {
  return (page.split('/').at(-1) ?? page).replace(PAGE_EXTENSION, '');
}

function extensionOf(page: string): string {
  const match = PAGE_EXTENSION.exec(page);
  assert(match !== null, 'A page has a page extension');
  return match[0];
}

// The wire contract. Pages are named relative to src/pages, never by absolute path, so a request cannot leave it.

export type PageSettingsRequest =
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'home'; readonly page: string }
  | { readonly kind: 'duplicate'; readonly page: string }
  | { readonly kind: 'remove'; readonly page: string };

export function parsePageSettingsRequest(input: unknown): PageSettingsRequest {
  const value = record(input);
  const kind = value['kind'];
  switch (kind) {
    case 'rename': {
      const change = parsePageRename({ kind: 'page', from: value['from'], to: value['to'] });
      return { kind, from: change.from, to: change.to };
    }
    case 'home':
    case 'duplicate':
    case 'remove': {
      const page = renamePath(value['page']);
      if (!PAGE_EXTENSION.test(page)) {
        throw new Error('Page settings: expected a page file');
      }
      return { kind, page };
    }
    default:
      throw new Error('Page settings: unknown request kind');
  }
}

/** One place a person should look at: a line the swap could not safely change, or a link a deletion would break. */
export interface PageSettingsReview {
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

export interface PageSettingsSummary {
  /** Files other than the moved pages whose text changes. */
  readonly files: number;
  /** Links rewritten (or, for a deletion, links that would break). */
  readonly links: number;
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  readonly reviews: readonly PageSettingsReview[];
  /** Reviews found beyond the listed ones. */
  readonly reviewsMore: number;
}

const parseMove = object({ from: pathText, to: pathText });
const parseReview = object({ file: pathText, line: count, text });

export function parsePageSettingsSummary(input: unknown): PageSettingsSummary {
  const value = record(input);
  const moves = list(parseMove)(value['moves']);
  if (moves.length > PAGE_SETTINGS_LIMITS.movesMax) {
    throw new Error('Page settings: too many moves');
  }
  const reviews = list(parseReview)(value['reviews']);
  if (reviews.length > PAGE_SETTINGS_LIMITS.reviewsMax) {
    throw new Error('Page settings: too many reviews');
  }
  for (const review of reviews) {
    if (review.line < 1) {
      throw new Error('Page settings: review lines are 1-based');
    }
    if (review.text.length > PAGE_SETTINGS_LIMITS.reviewLineCharsMax) {
      throw new Error('Page settings: review line exceeds limit');
    }
  }
  return { files: count(value['files']), links: count(value['links']), moves, reviews, reviewsMore: count(value['reviewsMore']) };
}

export interface PageSettingsApplied {
  readonly summary: PageSettingsSummary;
  /** Handed back to `page:revertSettings` by Undo and Redo. */
  readonly undo: string;
  /** Where the page the request named is now, relative to src/pages: the copy for a duplicate. */
  readonly page: string;
}

export function parsePageSettingsApplied(input: unknown): PageSettingsApplied {
  const value = record(input);
  const undo = text(value['undo']);
  if (undo.length === 0 || undo.length > 64) {
    throw new Error('Page settings: invalid undo token');
  }
  return { summary: parsePageSettingsSummary(value['summary']), undo, page: renamePath(value['page']) };
}

export type PageSettingsDirection = 'undo' | 'redo';

export function parsePageSettingsDirection(input: unknown): PageSettingsDirection {
  if (input === 'undo' || input === 'redo') {
    return input;
  }
  throw new Error('Page settings: direction is undo or redo');
}
