// What a folder holds as an Astro project: its page, layout and component
// files, the route a page serves, and whether its dependencies are installed.

import { toRecord } from '../../shared/core/record';
import * as path from 'path';
import { PAGE_MD_RE } from '../documents/pageRequests';
import * as fs from 'fs';
import { isWin, toPosix, readJson, parseRecord, parseOptionalString } from '../lib/mainHelpers';
import { ASTRO_CONFIG_FILES } from '../../shared/properties/astroSourceDirectory';
import { walkFolderSliced, type WalkProblem } from './projectWalk';
import { runSync, type SlicedWork } from '../lib/slicedWork';
import { isAtomicTemporary } from '../documents/atomicWrite';
import { ancestorsOf } from './packageManager';

export interface AstroFileListing {
  readonly files: readonly string[];
  /** Folders and links the walk could not read; the files beyond them are missing from `files`. */
  readonly problems: readonly WalkProblem[];
}

export interface ListAstroFilesOptions {
  /**
   * The pages folder, when it lies under the folder being listed. Markdown counts as a page only
   * there (a .md under src/components is a README, not a component), and a file or folder
   * whose name starts with `_` is not a route (Astro's rule), so it is left out.
   */
  readonly pagesDirectory?: string | undefined;
}

/** The `.astro` files under `directory` (and pages' Markdown), skipping installed packages and Stacki's save folders. */
export function* astroListingSliced(directory: string, options: ListAstroFilesOptions): SlicedWork<AstroFileListing> {
  const files: string[] = [];
  const { pagesDirectory } = options;
  const problems = yield* walkFolderSliced(directory, (entry) => {
    if (entry.kind === 'directory') {
      return entry.name === 'node_modules' || entry.name === '.stacki' ? 'skip' : 'descend';
    }
    const inPages = pagesDirectory !== undefined && isInside(pagesDirectory, entry.path);
    if (inPages && pagesDirectory !== undefined && hasUnderscoreSegment(path.relative(pagesDirectory, entry.path))) {
      return undefined;
    }
    if (entry.name.endsWith('.astro') || (inPages && PAGE_MD_RE.test(entry.name))) {
      files.push(entry.path);
    }
    return undefined;
  });
  return { files, problems };
}

/** Just the files of `astroListingSliced`, for callers with nowhere to put a warning. */
export function* astroFilesSliced(directory: string, options: ListAstroFilesOptions = {}): SlicedWork<string[]> {
  const listing = yield* astroListingSliced(directory, options);
  return [...listing.files];
}

export function listAstroFiles(directory: string, options: ListAstroFilesOptions = {}): string[] {
  return runSync(astroFilesSliced(directory, options));
}

/** The folders under `directory` (empty ones included), relative to it, in walk order. */
export function* foldersSliced(directory: string): SlicedWork<{ readonly folders: readonly string[]; readonly problems: readonly WalkProblem[] }> {
  const folders: string[] = [];
  const problems = yield* walkFolderSliced(directory, (entry) => {
    if (entry.kind !== 'directory') {
      return undefined;
    }
    // Internal save folders, including old staging, are never page folders.
    if (entry.name === '.stacki' || entry.name === 'node_modules' || isAtomicTemporary(entry.path)) {
      return 'skip';
    }
    folders.push(toPosix(path.relative(directory, entry.path)));
    return 'descend';
  });
  return { folders, problems };
}

function isInside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function hasUnderscoreSegment(relative: string): boolean {
  return toPosix(relative)
    .split('/')
    .some((segment) => segment.startsWith('_'));
}

/**
 * The URL pattern a page file serves: `blog/[slug].astro` is `/blog/[slug]`, an `index` is its
 * folder. `pagesDirectory` is the absolute pages folder (`<srcDir>/pages`).
 */
export function routeForPage(pagesDirectory: string, pagePath: string): string {
  let rel = toPosix(path.relative(pagesDirectory, pagePath)).replace(/\.(astro|mdx?)$/i, '');
  if (rel === 'index') {
    return '/';
  }
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -'/index'.length);
  }
  return '/' + rel;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

function listsAstro(directory: string): boolean {
  try {
    const manifest = parseRecord(readJson(path.join(directory, 'package.json')));
    return DEPENDENCY_FIELDS.some((field) => parseOptionalString(toRecord(manifest[field])?.['astro']) !== undefined);
  } catch {
    // No package.json, or one that is not JSON: the config files decide.
    return false;
  }
}

export function isAstroProject(directory: string): boolean {
  if (listsAstro(directory)) {
    return true;
  }
  if (ASTRO_CONFIG_FILES.some((file) => fs.existsSync(path.join(directory, file)))) {
    return true;
  }
  // A package inside a workspace whose root lists astro and has no config of its own yet.
  if (fs.existsSync(path.join(directory, 'src', 'pages'))) {
    return ancestorsOf(directory).slice(1).some(listsAstro);
  }
  return false;
}

// Astro has to be installed for a page to be rendered at all; without it the
// card can only offer to open the project. A workspace hoists node_modules to its root, so each parent counts.
export function hasDependencies(projectPath: string): boolean {
  const binName = isWin ? 'astro.cmd' : 'astro';
  return ancestorsOf(projectPath).some(
    (directory) =>
      fs.existsSync(path.join(directory, 'node_modules', '.bin', binName)) ||
      fs.existsSync(path.join(directory, 'node_modules', 'astro', 'package.json')) ||
      // Yarn Plug'n'Play keeps packages in a cache and no node_modules at all.
      fs.existsSync(path.join(directory, '.pnp.cjs')),
  );
}
