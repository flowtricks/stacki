// The disk side of the unused-selector analysis: every text in the project
// that could name a class, and the installed packages that could add one at
// runtime. Both walks are bounded; a walk that hits a bound reports itself
// incomplete, and an incomplete walk can only make verdicts `unknown`.
//
// Packages are searched only for the names and pieces the project's own files
// did not mention, and each answer is cached until the installed packages
// change, so the first check pays for the read and later ones mostly do not.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { isStudioDirectory } from '../lib/studioDirectory';
import { createSliceClock } from '../lib/slicedWork';
import { DEFAULT_PROJECT_FOLDERS, folderHolding } from '../../shared/properties/projectFolders';
import { described, type Described, type MessageRef } from '../../shared/properties/i18n/messageRef';
import type { SelectorNote } from '../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../shared/properties/styleKeepList';
import { emptyHits, scanMentions, type MentionHits, type MentionInterest } from './selectorMentions';
import { readAstroSheet, type AstroSheet } from './selectorSheets';
import { analyzeSelectorUsage, type PackageScan, type ProjectText, type UsageAnalysis, type UsageInput } from './selectorUsage';

// The walks read every file they meet, of any size: a project or a monorepo's node_modules is
// bounded by what is on disk, never by a count or a byte budget, and a walk is never reported
// incomplete for being big.
export const SELECTOR_FILE_LIMITS = {
  /** Ancestor folders searched for node_modules (monorepos hoist packages up). */
  ancestorsMax: 32,
  /** Cached package answers per project before the cache starts over. */
  cachedAnswersMax: 200_000,
  /** Projects whose package answers are cached at once. */
  cachedProjectsMax: 8,
} as const satisfies Record<string, number>;

// Files that cannot name a class, or that only restate others: media, fonts,
// archives, compiled binaries, source maps and lockfiles.
const SKIPPED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.tif',
  '.tiff',
  '.psd',
  '.heic',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.br',
  '.tar',
  '.7z',
  '.rar',
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.wasm',
  '.node',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.map',
  '.lockb',
]);
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']);
// Stylesheets in other languages are neither checked nor mentions: a selector
// naming a class does not make an element carry it.
const OTHER_STYLE_EXTENSIONS = new Set(['.scss', '.sass', '.less', '.styl']);
// The package files that run or render: code, components and the data code reads.
const PACKAGE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.astro', '.svelte', '.vue', '.html', '.json']);
// The top-level folders whose Astro `<style>` blocks are the site's. Files
// elsewhere still count as mentions — a script in scripts/ can add a class —
// but their own selectors are not offered for clean-up. Plain stylesheets are
// the site's when they are in a style folder (.stacki/folders.json), matching
// the style panel (electron/project/styleFiles.ts); by default that is the same three folders.
const SITE_FOLDERS = new Set(['src', 'public', 'styles']);
const PACKAGE_SKIPPED_DIRECTORIES = new Set(['.bin', '.cache', '.vite']);

/** The whole check against a project on disk: read it, then analyse it. */
export async function checkSelectorUsage(
  root: string,
  keepList: StyleKeepList,
  packages: PackageSearch = 'search',
  // The project's style folders (.stacki/folders.json), read by the caller.
  styleFolders: readonly string[] = DEFAULT_PROJECT_FOLDERS.styles,
): Promise<UsageAnalysis> {
  const input = await readSelectorUsageInput(root, keepList, styleFolders);
  return analyzeSelectorUsage(input, (interest) => scanInstalledPackages(root, interest, packages));
}

export async function readSelectorUsageInput(
  root: string,
  keepList: StyleKeepList,
  styleFolders: readonly string[] = DEFAULT_PROJECT_FOLDERS.styles,
): Promise<UsageInput> {
  const stylesheets: ProjectText[] = [];
  const astro: AstroSheet[] = [];
  const others: ProjectText[] = [];
  const unreadable: SelectorNote[] = [];
  const clock = createSliceClock();
  const queue: Array<{ readonly directory: string; readonly rel: string; readonly depth: number; readonly site: boolean }> = [
    { directory: root, rel: '', depth: 0, site: false },
  ];
  while (queue.length > 0) {
    const next = queue.pop();
    assert(next !== undefined, 'readSelectorUsageInput: the queue was not empty');
    assert(next.depth <= MAIN_LIMITS.directoryDepthMax, 'readSelectorUsageInput: depth is checked before queueing');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(next.directory, { withFileTypes: true });
    } catch (error: unknown) {
      unreadable.push({ rel: next.rel || '.', message: errorText(error) });
      continue;
    }
    for (const entry of entries) {
      const rel = next.rel === '' ? entry.name : `${next.rel}/${entry.name}`;
      const full = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        // Hidden folders hold tools' state (.git, .astro, .stacki); dist is this
        // site's own build output, which would mention every class it ever had.
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        // An installed Studio is the editor's code and styles, not the site's.
        if (isStudioDirectory(full, entry.name)) {
          continue;
        }
        if (next.depth + 1 > MAIN_LIMITS.directoryDepthMax) {
          unreadable.push({ rel, ...described('selectors.problem.nesting') });
          continue;
        }
        queue.push({ directory: full, rel, depth: next.depth + 1, site: next.depth === 0 ? SITE_FOLDERS.has(entry.name) : next.site });
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (SKIPPED_EXTENSIONS.has(extension) || OTHER_STYLE_EXTENSIONS.has(extension) || LOCKFILES.has(entry.name)) {
        continue;
      }
      const text = await readText(full);
      if (typeof text !== 'string') {
        if (text.kind === 'failed') {
          unreadable.push({ rel, message: text.message, ...(text.messageRef === undefined ? {} : { messageRef: text.messageRef }) });
        }
        continue;
      }
      // Analysing a file is synchronous work: a project of any size is many short slices.
      await clock.yieldIfDue();
      if (extension === '.css') {
        // A stylesheet outside the site's style folders is neither checked nor a mention.
        if (folderHolding(styleFolders, rel) !== undefined) {
          stylesheets.push({ rel, text });
        }
      } else if (extension === '.astro' && next.site) {
        astro.push(readAstroSheet(rel, text));
      } else {
        others.push({ rel, text });
      }
    }
  }
  return { stylesheets, astro, others, keepList, unreadable };
}

interface PackageCache {
  readonly signature: string;
  readonly answers: Map<string, boolean>;
}
const packageCaches = new Map<string, PackageCache>();

/** How a check treats installed packages: answer from earlier searches only, or search now. */
export type PackageSearch = 'cached' | 'search';

// One package search runs per project at a time. A panel refresh, a delete
// prompt and a clean-up can all ask at once; the later ones wait for the
// running search and then need only what it did not answer.
const runningSearches = new Map<string, Promise<unknown>>();

/** Search installed packages for what the project's files did not mention. */
export async function scanInstalledPackages(root: string, interest: MentionInterest, mode: PackageSearch = 'search'): Promise<PackageScan> {
  const directories = packageDirectories(root);
  if (directories.length === 0) {
    const missing = described('selectors.reason.packagesMissing');
    return { kind: 'incomplete', reason: missing.message, reasonRef: missing.messageRef };
  }
  const running = runningSearches.get(root);
  if (running !== undefined && mode === 'search') {
    await running.catch(() => undefined);
  }
  const cache = cacheFor(root, signatureOf(root, directories));
  const hits = emptyHits();
  const missing = uncached(interest, cache, hits);
  if (missing === undefined) {
    return { kind: 'complete', hits };
  }
  if (mode === 'cached') {
    return { kind: 'pending', hits, unanswered: missing };
  }
  const scanned = emptyHits();
  const search = walkPackages(directories, missing, scanned);
  runningSearches.set(root, search);
  let walk: Described | undefined;
  try {
    walk = await search;
  } finally {
    if (runningSearches.get(root) === search) {
      runningSearches.delete(root);
    }
  }
  if (walk !== undefined) {
    return { kind: 'incomplete', reason: walk.message, reasonRef: walk.messageRef };
  }
  remember(missing, scanned, cache);
  for (const word of scanned.words) {
    hits.words.add(word);
  }
  for (const head of scanned.heads) {
    hits.heads.add(head);
  }
  for (const tail of scanned.tails) {
    hits.tails.add(tail);
  }
  return { kind: 'complete', hits };
}

// Files are read in parallel batches: the search is bound by waiting on the
// disk, not by scanning, so overlapping reads cut its time several-fold.
const PACKAGE_READS_PARALLEL = 32;

async function walkPackages(directories: readonly string[], interest: MentionInterest, hits: MentionHits): Promise<Described | undefined> {
  const clock = createSliceClock();
  const seen = new Set<string>();
  const queue = directories.map((directory) => ({ directory, depth: 0 }));
  let files: string[] = [];
  const drain = async (): Promise<Described | undefined> => {
    const batch = files;
    files = [];
    const texts = await Promise.all(batch.map((file) => readText(file)));
    for (const text of texts) {
      if (typeof text === 'string') {
        scanMentions(text, interest, hits);
        await clock.yieldIfDue();
      } else if (text.kind === 'failed') {
        return described('selectors.reason.packageFile', { detail: text.message });
      }
    }
    return undefined;
  };
  while (queue.length > 0) {
    const next = queue.pop();
    assert(next !== undefined, 'walkPackages: the queue was not empty');
    let real: string;
    let entries: fs.Dirent[];
    try {
      real = await fs.promises.realpath(next.directory);
      if (seen.has(real)) {
        continue;
      }
      seen.add(real);
      entries = await fs.promises.readdir(real, { withFileTypes: true });
    } catch (error: unknown) {
      return described('selectors.reason.packagesUnreadable', { detail: errorText(error) });
    }
    for (const entry of entries) {
      const full = path.join(real, entry.name);
      // Workspace packages and pnpm's store are linked folders; follow them once.
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full));
      if (directory) {
        if (PACKAGE_SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (next.depth + 1 > MAIN_LIMITS.directoryDepthMax) {
          return described('selectors.reason.packagesDeep');
        }
        queue.push({ directory: full, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isPackageCode(entry.name)) {
        continue;
      }
      files.push(full);
      if (files.length >= PACKAGE_READS_PARALLEL) {
        const failure = await drain();
        if (failure !== undefined) {
          return failure;
        }
      }
    }
  }
  return drain();
}

function isPackageCode(name: string): boolean {
  // Type declarations never run, so they cannot add a class.
  if (/\.d\.[cm]?ts$/.test(name)) {
    return false;
  }
  return PACKAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isDirectory(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

type ReadFailure = { readonly kind: 'binary' } | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef };

// Reads one file whole. A NUL byte early on marks a binary file whatever its name says.
async function readText(full: string): Promise<string | ReadFailure> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(full);
  } catch (error: unknown) {
    return { kind: 'failed', message: errorText(error) };
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    return { kind: 'binary' };
  }
  return bytes.toString('utf8');
}

function packageDirectories(root: string): readonly string[] {
  const out: string[] = [];
  let directory = path.resolve(root);
  for (let depth = 0; depth < SELECTOR_FILE_LIMITS.ancestorsMax; depth += 1) {
    const candidate = path.join(directory, 'node_modules');
    if (isDirectory(candidate)) {
      out.push(candidate);
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return out;
}

// Installing, removing or updating a package changes a node_modules folder's
// modification time or a lockfile; either starts the cached answers over.
function signatureOf(root: string, directories: readonly string[]): string {
  const parts: string[] = [];
  for (const directory of [...directories, ...[...LOCKFILES].map((name) => path.join(root, name))]) {
    try {
      parts.push(`${directory}:${fs.statSync(directory).mtimeMs}`);
    } catch {
      parts.push(`${directory}:absent`);
    }
  }
  return parts.join('|');
}

function cacheFor(root: string, signature: string): PackageCache {
  const existing = packageCaches.get(root);
  if (existing !== undefined) {
    if (existing.signature === signature && existing.answers.size < SELECTOR_FILE_LIMITS.cachedAnswersMax) {
      return existing;
    }
  }
  if (packageCaches.size >= SELECTOR_FILE_LIMITS.cachedProjectsMax) {
    packageCaches.clear();
  }
  const created = { signature, answers: new Map<string, boolean>() };
  packageCaches.set(root, created);
  return created;
}

// The cache stores one answer per asked-about word or piece. Bare heads and
// heads share the heads set in hits, so they share the `h:` key space too.
function uncached(interest: MentionInterest, cache: PackageCache, hits: MentionHits): MentionInterest | undefined {
  const words = new Set<string>();
  const odd: string[] = [];
  const heads = new Set<string>();
  const bareHeads = new Set<string>();
  const tails = new Set<string>();
  const sort = (key: string, value: string, found: Set<string>, missing: { add: (value: string) => unknown }): void => {
    const answer = cache.answers.get(key);
    if (answer === undefined) {
      missing.add(value);
    } else if (answer) {
      found.add(value);
    }
  };
  for (const word of interest.words) {
    sort(`w:${word}`, word, hits.words, words);
  }
  for (const name of interest.odd) {
    sort(`w:${name}`, name, hits.words, { add: (value) => odd.push(value) });
  }
  for (const head of interest.heads) {
    sort(`h:${head}`, head, hits.heads, heads);
  }
  for (const head of interest.bareHeads) {
    sort(`b:${head}`, head, hits.heads, bareHeads);
  }
  for (const tail of interest.tails) {
    sort(`t:${tail}`, tail, hits.tails, tails);
  }
  if (words.size + odd.length + heads.size + bareHeads.size + tails.size === 0) {
    return undefined;
  }
  return { words, odd, heads, bareHeads, tails };
}

function remember(asked: MentionInterest, found: MentionHits, cache: PackageCache): void {
  for (const word of asked.words) {
    cache.answers.set(`w:${word}`, found.words.has(word));
  }
  for (const name of asked.odd) {
    cache.answers.set(`w:${name}`, found.words.has(name));
  }
  for (const head of asked.heads) {
    cache.answers.set(`h:${head}`, found.heads.has(head));
  }
  for (const head of asked.bareHeads) {
    cache.answers.set(`b:${head}`, found.heads.has(head));
  }
  for (const tail of asked.tails) {
    cache.answers.set(`t:${tail}`, found.tails.has(tail));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
