// Making an Astro copy of a plain website folder: the contract of `project:openSiteDialog` (pick a
// folder and say what it is), `project:checkAstroCopy` (may a copy go here, under this name) and
// `project:createAstroCopy` (make it). The Welcome screen's "Open from folder" uses all three.
//
// Why a copy: a folder of .html, .css and .js files is not an Astro project, and turning it into one
// in place would move every page. The original stays untouched; the copy is a sibling by default,
// named `<folder>-astro`.
//
// Both sides parse with these functions: main checks every request before it touches the disk, and
// the renderer checks every reply before a component sees it. A path is absolute and normalized; a
// name is one folder name, never a path.
import { assert } from '../core/assert';
import { boolean, count, list, pathText, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { PACKAGE_MANAGERS, type PackageManager } from '../properties/packageManager';

export const ASTRO_COPY_LIMITS = {
  /** UTF-8 bytes in one folder name: the name limit of APFS, ext4 and NTFS alike. */
  nameBytesMax: 255,
  /** Paths a reply lists by name (pages kept as plain files, entries left out); the rest are only counted. */
  reportPathsMax: 50,
} as const satisfies Record<string, number>;

export const NESTED_SITE_LIMITS = {
  /** Astro sites one answer names. A longer list is not one to choose from; the answer then says it covers part of the folder. */
  sitesMax: 24,
  /** Characters of a site's `package.json` name, npm's own limit. */
  nameCharsMax: 214,
} as const satisfies Record<string, number>;

/** What the default name adds to the picked folder's name. */
export const ASTRO_COPY_SUFFIX = '-astro';

/** Why a name or a place cannot hold the copy. Each code is a field's error look and, on submit, one toast. */
export const ASTRO_COPY_TARGET_PROBLEMS = [
  'name-empty',
  'name-invalid',
  'target-exists',
  'location-missing',
  'location-unwritable',
  'inside-original',
] as const;
export type AstroCopyTargetProblem = (typeof ASTRO_COPY_TARGET_PROBLEMS)[number];

/** A copy that could not be made. The original folder is untouched in every case, and nothing is left at the target. */
export type AstroCopyFailure =
  | { readonly code: AstroCopyTargetProblem }
  | { readonly code: 'not-plain-website' }
  | { readonly code: 'too-many-files'; readonly limit: number }
  | { readonly code: 'too-many-bytes'; readonly limit: number }
  | { readonly code: 'file-too-large'; readonly limit: number; readonly file: string }
  | { readonly code: 'package-manager-missing'; readonly manager: PackageManager }
  | { readonly code: 'copy-failed'; readonly detail: string };

export interface AstroCopyRequest {
  /** The plain website folder, which is only read. */
  readonly sourcePath: string;
  /** The folder the copy goes in. */
  readonly parentPath: string;
  /** The copy's own folder name. */
  readonly name: string;
}

/** What the "Make an Astro copy" dialog starts from. */
export interface AstroCopyOffer {
  readonly sourcePath: string;
  /** The picked folder's parent: where the copy goes unless the person chooses elsewhere. */
  readonly parentPath: string;
  /** `<folder>-astro`, the suggested name. */
  readonly name: string;
  /** The home folder, so a location can be shown as `~/…`. */
  readonly homePath: string;
}

/** Whether the search for sites inside a folder read all of it, or stopped at one of its bounds. */
export const SITE_SEARCH_REACHES = ['all', 'part'] as const;
export type SiteSearchReach = (typeof SITE_SEARCH_REACHES)[number];

/** An Astro site found inside the picked folder. */
export interface NestedSite {
  readonly projectPath: string;
  /** The site's folder below the picked one, `/`-separated. */
  readonly relative: string;
  /** Its `package.json` name, when it has one. */
  readonly name: string | undefined;
}

/**
 * What the picked folder itself would have been without the sites inside it, still on offer so nothing the folder
 * could do before is lost: open it as it is, copy it as a plain website, or nothing.
 */
export type NestedSitesInstead =
  { readonly kind: 'openFolder' } | { readonly kind: 'plainWebsite'; readonly offer: AstroCopyOffer } | { readonly kind: 'nothing' };

/** The picked folder is not a website's own folder, but Astro sites sit inside it. The person chooses; nothing opens unasked. */
export interface NestedSitesChoice {
  readonly kind: 'nestedSites';
  readonly folderPath: string;
  /** At least one, at most `NESTED_SITE_LIMITS.sitesMax`, in the order they are offered. */
  readonly sites: readonly NestedSite[];
  readonly searched: SiteSearchReach;
  readonly instead: NestedSitesInstead;
}

/** What the picked folder turned out to be. */
export type SiteFolderChoice =
  | { readonly kind: 'canceled' }
  | { readonly kind: 'astro'; readonly projectPath: string }
  | ({ readonly kind: 'plainWebsite' } & AstroCopyOffer)
  | NestedSitesChoice
  | { readonly kind: 'notWebsite'; readonly folderPath: string; readonly searched: SiteSearchReach };

export type AstroCopyCheck = Result<{ readonly targetPath: string }, AstroCopyTargetProblem>;

/** How the new project's install went. A failed install keeps the copy: opening it installs again. */
export type AstroCopyInstall = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly detail: string };

export interface AstroCopyCreated {
  readonly projectPath: string;
  /** Pages that became .astro files under src/pages. */
  readonly pageCount: number;
  /** Files that went under public/. */
  readonly assetCount: number;
  /** Pages that stay plain .html files under public/ so their addresses keep working (Astro cannot route them), relative to the original. */
  readonly keptAsFiles: readonly string[];
  readonly keptAsFilesCount: number;
  /** Entries of the original left out of the copy (installed packages, Git data, hidden files, links outside the folder). */
  readonly skippedCount: number;
  readonly install: AstroCopyInstall;
}

export type AstroCopyReply = Result<AstroCopyCreated, AstroCopyFailure>;

// Characters no folder name may hold on at least one of macOS, Windows and Linux: separators, the
// Windows-reserved set and control characters. A name that is valid everywhere moves between machines.
const NAME_FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
// Windows refuses these as names whatever the extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const UTF8 = new TextEncoder();

/** Why `name` cannot be the copy's folder name, or undefined when it can. The renderer and main both decide with this. */
export function astroCopyNameProblem(name: string): 'name-empty' | 'name-invalid' | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'name-empty';
  }
  if (trimmed !== name) {
    // A leading or trailing space is invisible in the field and in Finder; refuse it rather than strip it silently.
    return 'name-invalid';
  }
  if (NAME_FORBIDDEN.test(name)) {
    return 'name-invalid';
  }
  // A leading dot hides the folder; a trailing one is dropped by Windows.
  if (name.startsWith('.') || name.endsWith('.')) {
    return 'name-invalid';
  }
  if (WINDOWS_RESERVED.test(name)) {
    return 'name-invalid';
  }
  if (UTF8.encode(name).length > ASTRO_COPY_LIMITS.nameBytesMax) {
    return 'name-invalid';
  }
  return undefined;
}

/** `<folder>-astro`, shortened (never mid-character) so it stays within the name limit. */
export function defaultAstroCopyName(folderName: string): string {
  assert(folderName.length > 0, 'defaultAstroCopyName: the folder has a name');
  const characters = [...folderName];
  const suffixBytes = UTF8.encode(ASTRO_COPY_SUFFIX).length;
  let stem = '';
  for (const character of characters) {
    if (UTF8.encode(stem + character).length + suffixBytes > ASTRO_COPY_LIMITS.nameBytesMax) {
      break;
    }
    stem += character;
  }
  const name = stem + ASTRO_COPY_SUFFIX;
  assert(UTF8.encode(name).length <= ASTRO_COPY_LIMITS.nameBytesMax, 'defaultAstroCopyName: the name fits');
  assert(name.endsWith(ASTRO_COPY_SUFFIX), 'defaultAstroCopyName: the suffix is kept');
  return name;
}

/**
 * A location as the dialog shows it: the home folder as `~`, and only the last few folders of a long
 * path behind `…`. The full path is the row's tooltip.
 */
export function shortenLocation(location: string, homePath: string, segmentsMax = 3): string {
  assert(segmentsMax > 0, 'shortenLocation: at least one folder is shown');
  const separator = location.includes('\\') && !location.includes('/') ? '\\' : '/';
  let shown = location;
  let prefix = '';
  if (homePath.length > 0 && (location === homePath || location.startsWith(homePath + separator))) {
    shown = location.slice(homePath.length);
    prefix = '~';
  }
  const segments = shown.split(separator).filter((segment) => segment.length > 0);
  if (segments.length <= segmentsMax) {
    return prefix === '' ? location : prefix + shown;
  }
  return `…${separator}${segments.slice(-segmentsMax).join(separator)}`;
}

/**
 * An absolute, normalized path: rooted (`/…`, `C:\…` or `\\server\share\…`), no `.` or `..` folder, no
 * empty folder between separators and no separator at the end (other than a root's own).
 */
export function parseAbsolutePath(input: unknown): string {
  const value = pathText(input);
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const unc = value.startsWith('\\\\');
  if (!value.startsWith('/') && !windowsDrive && !unc) {
    throw new Error('Path: expected an absolute path');
  }
  const rest = unc ? value.slice(2) : windowsDrive ? value.slice(3) : value.slice(1);
  if (rest.length === 0) {
    if (unc) {
      throw new Error('Path: expected a server and share');
    }
    return value;
  }
  const segments = rest.split(/[\\/]/);
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error('Path: expected a normalized path');
    }
    if (segment === '.' || segment === '..') {
      throw new Error('Path: expected no . or .. folders');
    }
  }
  return value;
}

/** One folder name: what `astroCopyNameProblem` judges, bounded here so a huge string never reaches it. */
export function parseAstroCopyName(input: unknown): string {
  const value = text(input);
  if (value.length > ASTRO_COPY_LIMITS.nameBytesMax * 4) {
    throw new Error('Name: exceeds limit');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('Name: expected a folder name, not a path');
  }
  return value;
}

export function parseAstroCopyRequest(input: unknown): AstroCopyRequest {
  const fields = record(input);
  return {
    sourcePath: parseAbsolutePath(fields['sourcePath']),
    parentPath: parseAbsolutePath(fields['parentPath']),
    name: parseAstroCopyName(fields['name']),
  };
}

function parseAstroCopyOffer(fields: Readonly<Record<string, unknown>>): AstroCopyOffer {
  const name = parseAstroCopyName(fields['name']);
  const homePath = pathText(fields['homePath']);
  return { sourcePath: parseAbsolutePath(fields['sourcePath']), parentPath: parseAbsolutePath(fields['parentPath']), name, homePath };
}

function parseSiteSearchReach(input: unknown): SiteSearchReach {
  const reach = SITE_SEARCH_REACHES.find((known) => known === input);
  if (reach === undefined) {
    throw new Error('SiteSearchReach: unknown value');
  }
  return reach;
}

export function parseNestedSitesChoice(input: unknown): NestedSitesChoice {
  const fields = record(input);
  if (fields['kind'] !== 'nestedSites') {
    throw new Error('NestedSitesChoice.kind: unknown value');
  }
  const folderPath = parseAbsolutePath(fields['folderPath']);
  const sites = list(parseNestedSite)(fields['sites']);
  if (sites.length === 0) {
    throw new Error('NestedSitesChoice.sites: expected at least one site');
  }
  if (sites.length > NESTED_SITE_LIMITS.sitesMax) {
    throw new Error('NestedSitesChoice.sites: exceeds limit');
  }
  if (sites.some((site) => !isBelow(folderPath, site.projectPath))) {
    throw new Error('NestedSitesChoice.sites: expected folders inside the picked folder');
  }
  return {
    kind: 'nestedSites',
    folderPath,
    sites,
    searched: parseSiteSearchReach(fields['searched']),
    instead: parseNestedSitesInstead(fields['instead']),
  };
}

// Both paths are absolute and normalized already, so "below" is a prefix that ends at a separator.
function isBelow(folder: string, candidate: string): boolean {
  assert(folder.length > 0, 'isBelow: the picked folder is a parsed absolute path');
  assert(candidate.length > 0, 'isBelow: the site folder is a parsed absolute path');
  if (candidate.length <= folder.length) {
    return false;
  }
  if (!candidate.startsWith(folder)) {
    return false;
  }
  const boundary = folder.endsWith('/') || folder.endsWith('\\') ? folder.charAt(folder.length - 1) : candidate.charAt(folder.length);
  return boundary === '/' || boundary === '\\';
}

function parseNestedSite(input: unknown): NestedSite {
  const fields = record(input);
  const relative = pathText(fields['relative']);
  if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('NestedSite.relative: expected a folder below the picked one');
  }
  const name = fields['name'] === undefined ? undefined : text(fields['name']);
  if (name !== undefined) {
    if (name.length === 0 || name.length > NESTED_SITE_LIMITS.nameCharsMax) {
      throw new Error('NestedSite.name: expected a package name');
    }
  }
  return { projectPath: parseAbsolutePath(fields['projectPath']), relative, name };
}

function parseNestedSitesInstead(input: unknown): NestedSitesInstead {
  const fields = record(input);
  const kind = fields['kind'];
  switch (kind) {
    case 'openFolder':
    case 'nothing':
      return { kind };
    case 'plainWebsite':
      return { kind, offer: parseAstroCopyOffer(record(fields['offer'])) };
    default:
      throw new Error('NestedSitesChoice.instead: unknown value');
  }
}

export function parseSiteFolderChoice(input: unknown): SiteFolderChoice {
  const fields = record(input);
  const kind = fields['kind'];
  switch (kind) {
    case 'canceled':
      return { kind };
    case 'astro':
      return { kind, projectPath: parseAbsolutePath(fields['projectPath']) };
    case 'plainWebsite':
      return { kind, ...parseAstroCopyOffer(fields) };
    case 'nestedSites':
      return parseNestedSitesChoice(fields);
    case 'notWebsite':
      return { kind, folderPath: parseAbsolutePath(fields['folderPath']), searched: parseSiteSearchReach(fields['searched']) };
    default:
      throw new Error('SiteFolderChoice.kind: unknown value');
  }
}

export function parseAstroCopyTargetProblem(input: unknown): AstroCopyTargetProblem {
  const problem = ASTRO_COPY_TARGET_PROBLEMS.find((known) => known === input);
  if (problem === undefined) {
    throw new Error('AstroCopy problem: unknown value');
  }
  return problem;
}

export function parseAstroCopyCheck(input: unknown): AstroCopyCheck {
  const fields = record(input);
  if (fields['ok'] === true) {
    const value = record(fields['value']);
    return ok({ targetPath: parseAbsolutePath(value['targetPath']) });
  }
  if (fields['ok'] !== false) {
    throw new Error('AstroCopyCheck.ok: expected a boolean');
  }
  return err(parseAstroCopyTargetProblem(fields['error']));
}

export function parseAstroCopyFailure(input: unknown): AstroCopyFailure {
  const fields = record(input);
  const code = fields['code'];
  switch (code) {
    case 'not-plain-website':
      return { code };
    case 'too-many-files':
    case 'too-many-bytes':
      return { code, limit: count(fields['limit']) };
    case 'file-too-large':
      return { code, limit: count(fields['limit']), file: pathText(fields['file']) };
    case 'package-manager-missing': {
      const manager = PACKAGE_MANAGERS.find((known) => known === fields['manager']);
      if (manager === undefined) {
        throw new Error('AstroCopyFailure.manager: unknown value');
      }
      return { code, manager };
    }
    case 'copy-failed':
      return { code, detail: text(fields['detail']) };
    default:
      return { code: parseAstroCopyTargetProblem(code) };
  }
}

function parseReportPaths(input: unknown): readonly string[] {
  const paths = list(pathText)(input);
  if (paths.length > ASTRO_COPY_LIMITS.reportPathsMax) {
    throw new Error('AstroCopyCreated: too many listed paths');
  }
  return paths;
}

function parseAstroCopyInstall(input: unknown): AstroCopyInstall {
  const fields = record(input);
  if (fields['kind'] === 'done') {
    return { kind: 'done' };
  }
  if (fields['kind'] === 'failed') {
    return { kind: 'failed', detail: text(fields['detail']) };
  }
  throw new Error('AstroCopyInstall.kind: unknown value');
}

export function parseAstroCopyCreated(input: unknown): AstroCopyCreated {
  const fields = record(input);
  const keptAsFiles = parseReportPaths(fields['keptAsFiles']);
  const keptAsFilesCount = count(fields['keptAsFilesCount']);
  if (keptAsFilesCount < keptAsFiles.length) {
    throw new Error('AstroCopyCreated.keptAsFilesCount: fewer than listed');
  }
  return {
    projectPath: parseAbsolutePath(fields['projectPath']),
    pageCount: count(fields['pageCount']),
    assetCount: count(fields['assetCount']),
    keptAsFiles,
    keptAsFilesCount,
    skippedCount: count(fields['skippedCount']),
    install: parseAstroCopyInstall(fields['install']),
  };
}

export function parseAstroCopyReply(input: unknown): AstroCopyReply {
  const fields = record(input);
  if (boolean(fields['ok'])) {
    return ok(parseAstroCopyCreated(fields['value']));
  }
  return err(parseAstroCopyFailure(fields['error']));
}
