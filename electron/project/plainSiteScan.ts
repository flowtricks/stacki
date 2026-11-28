// What a picked folder is: an Astro project (open it), a plain website (offer an Astro copy) or neither
// (say so). Also the bounded listing the copy itself is made from.
//
// A plain website is a folder with at least one .html or .htm page (any case) in its top two levels,
// that is not an Astro project. Installed packages, Git data, build output, vendored libraries and hidden
// folders do not count: a page there is not one of the site's own.
//
// The listing never follows a link outside the folder and never follows a link to a folder at all, so a
// link cycle cannot make it loop and nothing outside the picked folder is ever read or copied. Every walk
// is bounded by depth and by entries (PLAIN_SITE_LIMITS): the scan runs while the person waits after the
// picker, and a folder past those bounds is decided on what was seen.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { isAstroProject } from './projectFiles';
import { readSiteManifest } from './nestedSiteScan';
import { ASTRO_CONFIG_FILES } from '../../shared/properties/astroSourceDirectory';
import { MAIN_LIMITS } from '../lib/mainLimits';

export const PLAIN_SITE_LIMITS = {
  /** Folder levels the detection reads below the picked folder: the folder itself (0) and its folders (1), "the top two levels". */
  detectDepthMax: 1,
  /** Entries the detection reads. A hand-made site's top two levels hold tens; past this the folder is decided on what was seen, so the answer stays instant. */
  detectEntriesMax: 5_000,
  /** Entries of src/pages read to tell an Astro project that has no config. */
  pagesEntriesMax: 1_000,
} as const satisfies Record<string, number>;

/** Folders that hold no page of the site's own, at any depth. */
const DETECT_SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'bower_components', 'jspm_packages']);
/** Folders the copy leaves out at any depth: installed packages and version-control data. */
const COPY_SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.svn', '.hg']);
/** Folders the copy leaves out at the top only: the original's own build output. A library's nested dist/ is a real asset. */
const COPY_SKIPPED_TOP_FOLDERS = new Set(['dist']);
/** Files no site serves: the operating systems' folder metadata. */
const SKIPPED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
/** Hidden entries a site does serve. Every other hidden entry (editor settings, .env secrets) stays out of public/. */
const SERVED_HIDDEN = new Set(['.well-known', '.htaccess', '.nojekyll']);

export const PAGE_FILE = /\.html?$/i;

export type SiteFolderKind = 'astro' | 'plainWebsite' | 'notWebsite';

export interface SiteFile {
  /** Path below the walked folder, `/`-separated. */
  readonly relative: string;
  /** The file to read: the entry itself, or the file a link inside the folder points at. */
  readonly absolute: string;
  readonly sizeBytes: number;
  /** Permission bits, kept on the copy. */
  readonly mode: number;
}

export type SkipReason =
  'installed-packages' | 'version-control' | 'build-output' | 'hidden' | 'system-file' | 'link-outside' | 'link-to-folder' | 'unreadable' | 'too-deep';

export interface SkippedEntry {
  readonly relative: string;
  readonly reason: SkipReason;
}

export interface SiteListing {
  readonly files: readonly SiteFile[];
  readonly skipped: readonly SkippedEntry[];
  /** Whether the walk stopped at its entry bound with entries unread. */
  readonly truncated: boolean;
}

export interface ListSiteOptions {
  readonly depthMax: number;
  readonly entriesMax: number;
  readonly purpose: 'detect' | 'copy';
}

/** What the folder at `directory` is by itself. Reads names and sizes only, besides the package.json and config check the open path already uses. */
export function classifySiteFolder(directory: string): SiteFolderKind {
  assert(path.isAbsolute(directory), 'classifySiteFolder: an absolute folder');
  return opensAsAstro(directory) ? 'astro' : classifyPlainFolder(directory);
}

/** Whether the folder opens as an Astro project. */
export function opensAsAstro(directory: string): boolean {
  return isAstroProject(directory) || hasAstroPages(directory);
}

/**
 * Whether the only thing that makes this folder open as a project is `astro` among its package.json's dependencies:
 * no config, no `src/pages`, and no script that runs a site from here. A workspace's root looks like this, and so
 * does a package that merely builds on astro; the website is then a folder inside (folderOpen.ts looks for it). A
 * folder with a config or pages answers after one or two existence checks, with nothing more read.
 */
export function onlyListsAstro(directory: string): boolean {
  if (ASTRO_CONFIG_FILES.some((file) => fs.existsSync(path.join(directory, file)))) {
    return false;
  }
  if (fs.existsSync(path.join(directory, 'src', 'pages'))) {
    return false;
  }
  return readSiteManifest(directory)?.runsAstro !== true;
}

/** What a folder that is no Astro project is: a plain website to copy, or neither. */
export function classifyPlainFolder(directory: string): 'plainWebsite' | 'notWebsite' {
  assert(path.isAbsolute(directory), 'classifyPlainFolder: an absolute folder');
  const listing = listSiteFiles(directory, { depthMax: PLAIN_SITE_LIMITS.detectDepthMax, entriesMax: PLAIN_SITE_LIMITS.detectEntriesMax, purpose: 'detect' });
  return classifyListing(listing);
}

/** The pure half of the detection: a listing that holds a page is a plain website. */
export function classifyListing(listing: Pick<SiteListing, 'files'>): 'plainWebsite' | 'notWebsite' {
  const pages = listing.files.filter((file) => PAGE_FILE.test(file.relative));
  return pages.length > 0 ? 'plainWebsite' : 'notWebsite';
}

// An Astro project with no astro dependency or config yet: a src/pages folder holding .astro pages.
function hasAstroPages(directory: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(directory, 'src', 'pages'), { withFileTypes: true });
  } catch {
    return false; // No src/pages, or one that cannot be read: nothing says Astro.
  }
  return entries.slice(0, PLAIN_SITE_LIMITS.pagesEntriesMax).some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.astro'));
}

interface PendingFolder {
  readonly absolute: string;
  readonly relative: string;
  readonly depth: number;
}

/**
 * The files under `root`, in a stable order (each folder's entries sorted by name), and what was left out.
 * Iterative and bounded by `depthMax` and `entriesMax`; links to folders are never followed and links to
 * files only when the file is inside `root`.
 */
export function listSiteFiles(root: string, options: ListSiteOptions): SiteListing {
  assert(options.depthMax >= 0, 'listSiteFiles: a depth bound');
  assert(options.depthMax <= MAIN_LIMITS.directoryDepthMax, 'listSiteFiles: within the walkers depth bound');
  assert(options.entriesMax > 0, 'listSiteFiles: an entry bound');
  const realRoot = fs.realpathSync(root);
  const files: SiteFile[] = [];
  const skipped: SkippedEntry[] = [];
  const pending: PendingFolder[] = [{ absolute: root, relative: '', depth: 0 }];
  let seen = 0;
  // Each turn takes one folder off `pending`; folders are only added below `depthMax` and every entry
  // counts toward `entriesMax`, so the walk ends.
  while (pending.length > 0) {
    const folder = pending.pop();
    assert(folder !== undefined, 'listSiteFiles: a pending folder');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder.absolute, { withFileTypes: true });
    } catch {
      skipped.push({ relative: folder.relative, reason: 'unreadable' });
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const folders: PendingFolder[] = [];
    for (const entry of entries) {
      seen += 1;
      if (seen > options.entriesMax) {
        return { files: sortedByPath(files), skipped, truncated: true };
      }
      const relative = folder.relative === '' ? entry.name : `${folder.relative}/${entry.name}`;
      const absolute = path.join(folder.absolute, entry.name);
      const verdict = entryVerdict(entry, { depth: folder.depth, purpose: options.purpose });
      if (verdict !== undefined) {
        skipped.push({ relative, reason: verdict });
      } else if (entry.isDirectory()) {
        if (folder.depth < options.depthMax) {
          folders.push({ absolute, relative, depth: folder.depth + 1 });
        } else {
          skipped.push({ relative, reason: 'too-deep' });
        }
      } else {
        const file = siteFile(realRoot, absolute, relative, entry);
        if ('reason' in file) {
          skipped.push(file);
        } else {
          files.push(file);
        }
      }
    }
    // Reversed onto the stack so folders are walked in name order.
    pending.push(...folders.reverse());
  }
  assert(
    files.every((file) => !file.relative.startsWith('/')),
    'listSiteFiles: relative paths',
  );
  return { files: sortedByPath(files), skipped, truncated: false };
}

// Files in path order, so a plan built from the listing is the same on every machine.
function sortedByPath(files: readonly SiteFile[]): readonly SiteFile[] {
  return [...files].sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
}

// Why an entry is left out by its name and kind alone, or undefined when it is walked.
function entryVerdict(entry: fs.Dirent, place: { readonly depth: number; readonly purpose: ListSiteOptions['purpose'] }): SkipReason | undefined {
  const lower = entry.name.toLowerCase();
  if (entry.isDirectory()) {
    if (place.purpose === 'detect') {
      if (DETECT_SKIPPED_FOLDERS.has(lower)) {
        return lower === 'node_modules' || lower === 'bower_components' || lower === 'jspm_packages' ? 'installed-packages' : 'build-output';
      }
    } else if (COPY_SKIPPED_FOLDERS.has(lower)) {
      return lower === 'node_modules' ? 'installed-packages' : 'version-control';
    } else if (place.depth === 0 && COPY_SKIPPED_TOP_FOLDERS.has(lower)) {
      return 'build-output';
    }
  }
  if (SKIPPED_FILES.has(lower)) {
    return 'system-file';
  }
  if (entry.name.startsWith('.') && !SERVED_HIDDEN.has(lower)) {
    return lower === '.git' || lower === '.svn' || lower === '.hg' ? 'version-control' : 'hidden';
  }
  return undefined;
}

// A file entry as the copy reads it. A link counts only when it ends at a file inside the walked folder.
function siteFile(realRoot: string, absolute: string, relative: string, entry: fs.Dirent): SiteFile | SkippedEntry {
  let target = absolute;
  if (entry.isSymbolicLink()) {
    try {
      target = fs.realpathSync(absolute);
    } catch {
      return { relative, reason: 'unreadable' };
    }
    const inside = path.relative(realRoot, target);
    if (inside.length === 0) {
      return { relative, reason: 'link-to-folder' }; // The walked folder itself: a loop.
    }
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return { relative, reason: 'link-outside' };
    }
  } else if (!entry.isFile()) {
    return { relative, reason: 'unreadable' }; // A socket, a device or a pipe: nothing a site serves.
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return { relative, reason: 'unreadable' };
  }
  if (stats.isDirectory()) {
    return { relative, reason: 'link-to-folder' };
  }
  if (!stats.isFile()) {
    return { relative, reason: 'unreadable' };
  }
  return { relative, absolute: target, sizeBytes: stats.size, mode: stats.mode & 0o777 };
}
