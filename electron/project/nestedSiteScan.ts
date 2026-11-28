// Astro sites inside a folder that is not one itself: a monorepo's root, a folder of client sites, a repository
// whose website lives wherever its authors put it. Opening such a root used to answer "isn't a website".
//
// Only what a folder holds decides, never its name or a workspace file's globs: every layout is then found the
// same way. A folder is a site when it has an Astro config, or `.astro` pages in `src/pages`, or its package.json
// uses astro and either has a `src/pages` folder or runs the site itself (`astro dev`, `build` or `preview`, for a
// site with no page yet). Depending on astro alone is not enough: an integration or a component package does that.
//
// The walk never runs for a folder that opens as a project on its own (folderOpen.ts). It reads names, and a
// package.json where there is one. It never follows a link to a folder, so it cannot loop or leave the picked
// folder. It goes level by level, so the sites near the top are found before any bound is reached, and it is
// bounded by depth, folders, entries, results and time (NESTED_SCAN_LIMITS). It yields after each folder, so the
// window keeps responding (lib/slicedWork.ts). A walk that stops early says so (`searched: 'part'`).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import { ASTRO_CONFIG_FILES } from '../../shared/properties/astroSourceDirectory';
import { NESTED_SITE_LIMITS, type NestedSite, type SiteSearchReach } from '../../shared/ipc/astroCopy';
import type { SlicedWork } from '../lib/slicedWork';

export const NESTED_SCAN_LIMITS = {
  /** Folder levels below the picked folder: `clients/2024/acme/sites/marketing/web` is six. */
  depthMax: 8,
  /** Folders opened. */
  foldersMax: 20_000,
  /** Entries seen across all of them. */
  entriesMax: 200_000,
  /** How long the person waits at most, on a folder too large or too slow to read in full. */
  timeMsMax: 2_500,
  /** A package.json larger than this is not read. */
  manifestBytesMax: 1024 * 1024,
  /** Scripts of one package.json looked at for the command that runs the site. */
  scriptsMax: 200,
} as const satisfies Record<string, number>;

export type NestedScanLimits = Readonly<Record<keyof typeof NESTED_SCAN_LIMITS, number>>;

export interface NestedScan {
  /** The sites found, in the order they are offered: likely ones first, then the shallower, then by path. */
  readonly sites: readonly NestedSite[];
  readonly searched: SiteSearchReach;
}

export interface NestedScanOptions {
  readonly limits?: NestedScanLimits;
  readonly now?: () => number;
  readonly homePath?: string;
}

/** Folders never opened: installed packages and caches. Hidden folders (Git data and build caches among them) are skipped by their dot. */
const NEVER_OPENED = new Set(['node_modules', 'bower_components', 'jspm_packages', '__pycache__', 'pods']);
/**
 * Folders that are usually build output or static files. Each is looked at, so a site that happens to carry one of
 * these names is still found, and nothing below it is read.
 */
const LOOKED_AT_ONLY = new Set(['dist', 'build', 'out', 'coverage', 'vendor', 'target', 'public']);
/** Folder names that usually hold sample sites. They only set the order of the list: nothing is ever left out for its name. */
const SAMPLE_FOLDERS = new Set([
  '__fixtures__',
  '__tests__',
  'demo',
  'demos',
  'e2e',
  'example',
  'examples',
  'fixtures',
  'playground',
  'playgrounds',
  'sample',
  'samples',
  'template',
  'templates',
  'test',
  'tests',
]);
/** An `astro` command that runs a site: `astro dev`, also behind `npx`, `cross-env` or `&&`. */
const RUNS_ASTRO = /(?:^|[\s;&|])astro\s+(?:dev|start|build|preview)\b/;
/** `--root` points the command at another folder, so the package that holds it only starts a site elsewhere. */
const ROOT_ELSEWHERE = /--root(?:\s|=)/;

/** What one folder's package.json says, as far as finding a site needs. */
export interface SiteManifest {
  readonly name: string | undefined;
  /** astro in any dependency field. */
  readonly listsAstro: boolean;
  /** astro in `dependencies` or `devDependencies`: what a site declares, where a plugin declares a peer. */
  readonly installsAstro: boolean;
  /** A script runs an Astro site from this very folder. */
  readonly runsAstro: boolean;
}

/** The folder's package.json, or undefined when it has none that can be read. */
export function readSiteManifest(directory: string, bytesMax: number = NESTED_SCAN_LIMITS.manifestBytesMax): SiteManifest | undefined {
  const file = path.join(directory, 'package.json');
  let record: Record<string, unknown> | undefined;
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > bytesMax) {
      return undefined;
    }
    const input: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    record = toRecord(input);
  } catch {
    return undefined; // No package.json, one that cannot be read, or one that is not JSON.
  }
  if (record === undefined) {
    return undefined;
  }
  const lists = (field: string): boolean => typeof toRecord(record[field])?.['astro'] === 'string';
  const installsAstro = lists('dependencies') || lists('devDependencies');
  const scripts = Object.values(toRecord(record['scripts']) ?? {}).slice(0, NESTED_SCAN_LIMITS.scriptsMax);
  const name = record['name'];
  return {
    name: typeof name === 'string' && name.length > 0 && name.length <= NESTED_SITE_LIMITS.nameCharsMax ? name : undefined,
    installsAstro,
    listsAstro: installsAstro || lists('peerDependencies') || lists('optionalDependencies'),
    runsAstro: scripts.some((script) => typeof script === 'string' && RUNS_ASTRO.test(script) && !ROOT_ELSEWHERE.test(script)),
  };
}

interface Pending {
  readonly absolute: string;
  readonly segments: readonly string[];
  readonly lookOnly: boolean;
}

// What the walk has read so far, against its bounds.
function createTally() {
  let folders = 0;
  let entries = 0;
  return {
    folder: (): void => {
      folders += 1;
    },
    entries: (count: number): void => {
      entries += count;
    },
    spent: (limits: NestedScanLimits): boolean => folders >= limits.foldersMax || entries >= limits.entriesMax,
  };
}

/** The Astro sites below `root` (never `root` itself). A site's own folders are not searched for more sites. */
export function* nestedSitesSliced(root: string, options: NestedScanOptions = {}): SlicedWork<NestedScan> {
  assert(path.isAbsolute(root), 'nestedSitesSliced: an absolute folder');
  const limits = options.limits ?? NESTED_SCAN_LIMITS;
  const now = options.now ?? (() => performance.now());
  assert(limits.depthMax > 0, 'nestedSitesSliced: a depth bound');
  // The home folder, or a folder that holds it, is not a project. Reading it all would also walk into the folders
  // the system guards (Photos, Mail), which asks the person for access they have no reason to give.
  if (holdsHome(root, options.homePath ?? os.homedir())) {
    return { sites: [], searched: 'part' };
  }
  const startedAtMs = now();
  const found: Pending[] = [];
  const names = new Map<string, string | undefined>();
  const pending: Pending[] = [{ absolute: root, segments: [], lookOnly: false }];
  const tally = createTally();
  let searched: SiteSearchReach = 'all';
  // `next` walks the queue once; folders join it only below `depthMax` and at most `foldersMax` are opened.
  for (let next = 0; next < pending.length; next += 1) {
    if (tally.spent(limits) || now() - startedAtMs >= limits.timeMsMax) {
      searched = 'part';
      break;
    }
    const folder = pending[next];
    assert(folder !== undefined, 'nestedSitesSliced: a queued folder');
    tally.folder();
    const entries = readFolder(folder.absolute);
    tally.entries(entries?.length ?? 0);
    if (entries === undefined) {
      searched = 'part';
      continue;
    }
    const site = folder.segments.length === 0 ? undefined : siteAt(folder.absolute, entries, limits, tally.entries);
    if (site !== undefined) {
      if (found.length === NESTED_SITE_LIMITS.sitesMax) {
        searched = 'part';
        break;
      }
      found.push(folder);
      names.set(folder.absolute, site.name);
    } else if (!folder.lookOnly) {
      const children = childFolders(folder, entries);
      if (folder.segments.length < limits.depthMax) {
        // Bounded: past `foldersMax` queued folders none would be opened.
        const room = Math.max(0, limits.foldersMax + 1 - pending.length);
        pending.push(...children.slice(0, room));
        if (children.length > room) {
          searched = 'part';
        }
      } else if (children.length > 0) {
        searched = 'part';
      }
    }
    yield;
  }
  const sites = found.sort(inOfferOrder).map((folder) => ({
    projectPath: folder.absolute,
    relative: folder.segments.join('/'),
    name: names.get(folder.absolute),
  }));
  assert(sites.length <= NESTED_SITE_LIMITS.sitesMax, 'nestedSitesSliced: a bounded answer');
  return { sites, searched };
}

function holdsHome(root: string, homePath: string): boolean {
  const relative = path.relative(root, path.resolve(homePath));
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readFolder(directory: string): readonly fs.Dirent[] | undefined {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return undefined; // A folder this account may not read, or one that left since it was listed.
  }
}

// The site a folder is, by what it holds, or undefined. package.json is read only where there is one.
function siteAt(
  directory: string,
  entries: readonly fs.Dirent[],
  limits: NestedScanLimits,
  count: (entries: number) => void,
): { readonly name: string | undefined } | undefined {
  const files = new Set(entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name));
  const configured = ASTRO_CONFIG_FILES.some((file) => files.has(file));
  const manifest = files.has('package.json') ? readSiteManifest(directory, limits.manifestBytesMax) : undefined;
  if (configured) {
    return { name: manifest?.name };
  }
  const hasSource = entries.some((entry) => entry.isDirectory() && entry.name === 'src');
  const pages = hasSource ? readPages(directory) : undefined;
  count(pages?.length ?? 0);
  if (pages !== undefined) {
    if (pages.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.astro'))) {
      return { name: manifest?.name };
    }
    if (manifest?.listsAstro === true) {
      return { name: manifest.name };
    }
  }
  if (manifest?.installsAstro === true && manifest.runsAstro) {
    return { name: manifest.name };
  }
  return undefined;
}

// `src/pages`, reached only through real folders: a linked one is not followed.
function readPages(directory: string): readonly fs.Dirent[] | undefined {
  const pages = path.join(directory, 'src', 'pages');
  try {
    if (!fs.lstatSync(pages).isDirectory()) {
      return undefined;
    }
    return fs.readdirSync(pages, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

// The folders to search next, in name order. A link to a folder is not a folder here, so it is never followed.
function childFolders(folder: Pending, entries: readonly fs.Dirent[]): Pending[] {
  const children: Pending[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    // A Photos library is a folder the system guards, and no site.
    if (NEVER_OPENED.has(lower) || lower.endsWith('.photoslibrary')) {
      continue;
    }
    children.push({
      absolute: path.join(folder.absolute, entry.name),
      segments: [...folder.segments, entry.name],
      lookOnly: LOOKED_AT_ONLY.has(lower),
    });
  }
  return children.sort((left, right) => compareText(left.absolute, right.absolute));
}

function inOfferOrder(left: Pending, right: Pending): number {
  const sample = (folder: Pending): number => Number(folder.segments.some((segment) => SAMPLE_FOLDERS.has(segment.toLowerCase())));
  return sample(left) - sample(right) || left.segments.length - right.segments.length || compareText(left.absolute, right.absolute);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
