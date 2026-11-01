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
import type { SelectorNote } from '../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../shared/properties/styleKeepList';
import { emptyHits, scanMentions, type MentionHits, type MentionInterest } from './selectorMentions';
import { readAstroSheet, type AstroSheet } from './selectorSheets';
import { analyzeSelectorUsage, type PackageScan, type ProjectText, type UsageAnalysis, type UsageInput } from './selectorUsage';

export const SELECTOR_FILE_LIMITS = {
  /** Files one project walk reads. */
  projectFilesMax: 50_000,
  /** Bytes one project walk reads. */
  projectBytesMax: 256 * 1024 * 1024,
  /** Files one package walk reads: a large monorepo's node_modules fits. */
  packageFilesMax: 600_000,
  /** Bytes one package walk reads. */
  packageBytesMax: 3 * 1024 * 1024 * 1024,
  /** One file read by either walk; a larger one makes the walk incomplete. */
  fileBytesMax: 64 * 1024 * 1024,
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
// The top-level folders whose stylesheets are the site's, matching the style
// panel (electron/project/styleFiles.ts). Files elsewhere still count as
// mentions — a script in scripts/ can add a class — but their own selectors
// are not offered for clean-up.
const SITE_FOLDERS = new Set(['src', 'public', 'styles']);
const PACKAGE_SKIPPED_DIRECTORIES = new Set(['.bin', '.cache', '.vite']);

/** The whole check against a project on disk: read it, then analyse it. */
export async function checkSelectorUsage(root: string, keepList: StyleKeepList, packages: PackageSearch = 'search'): Promise<UsageAnalysis> {
  const input = await readSelectorUsageInput(root, keepList);
  return analyzeSelectorUsage(input, (interest) => scanInstalledPackages(root, interest, packages));
}

export async function readSelectorUsageInput(root: string, keepList: StyleKeepList): Promise<UsageInput> {
  const stylesheets: ProjectText[] = [];
  const astro: AstroSheet[] = [];
  const others: ProjectText[] = [];
  const unreadable: SelectorNote[] = [];
  const budget = new ReadBudget(SELECTOR_FILE_LIMITS.projectFilesMax, SELECTOR_FILE_LIMITS.projectBytesMax);
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
          unreadable.push({ rel, message: 'Folder nesting exceeds the limit' });
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
      if (budget.full()) {
        unreadable.push({ rel, message: `The project has more than ${SELECTOR_FILE_LIMITS.projectFilesMax} files to check` });
        return { stylesheets, astro, others, keepList, unreadable };
      }
      const text = await budget.read(full);
      if (typeof text !== 'string') {
        if (text.kind === 'failed') {
          unreadable.push({ rel, message: text.message });
        }
        continue;
      }
      if (extension === '.css') {
        // A stylesheet outside the site's folders is neither checked nor a mention.
        if (next.site) {
          stylesheets.push({ rel, text });
        }
      } else if (extension === '.astro' && next.site) {
        astro.push(readAstroSheet(rel, text));
      } else {
        others.push({ rel, text });
      }
    }
  }
  assert(!budget.over(), 'readSelectorUsageInput: the walk stops at its file bound');
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
    return { kind: 'incomplete', reason: 'Dependencies are not installed, so packages could not be checked' };
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
  let walk: string | undefined;
  try {
    walk = await search;
  } finally {
    if (runningSearches.get(root) === search) {
      runningSearches.delete(root);
    }
  }
  if (walk !== undefined) {
    return { kind: 'incomplete', reason: walk };
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
// disk, not by scanning, so overlapping reads cut its time several-fold. A
// batch can pass the byte budget by at most its own size.
const PACKAGE_READS_PARALLEL = 32;

async function walkPackages(directories: readonly string[], interest: MentionInterest, hits: MentionHits): Promise<string | undefined> {
  const budget = new ReadBudget(SELECTOR_FILE_LIMITS.packageFilesMax, SELECTOR_FILE_LIMITS.packageBytesMax);
  const seen = new Set<string>();
  const queue = directories.map((directory) => ({ directory, depth: 0 }));
  let files: string[] = [];
  const drain = async (): Promise<string | undefined> => {
    const batch = files;
    files = [];
    const texts = await Promise.all(batch.map((file) => budget.read(file)));
    for (const text of texts) {
      if (typeof text === 'string') {
        scanMentions(text, interest, hits);
      } else if (text.kind === 'failed') {
        return `An installed package file could not be read: ${text.message}`;
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
      return `Installed packages could not be read: ${errorText(error)}`;
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
          return 'Installed packages are nested too deeply to check';
        }
        queue.push({ directory: full, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isPackageCode(entry.name)) {
        continue;
      }
      if (budget.full(files.length)) {
        return `Installed packages hold more than ${SELECTOR_FILE_LIMITS.packageFilesMax} files to check`;
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

type ReadFailure = { readonly kind: 'binary' } | { readonly kind: 'failed'; readonly message: string };

// One walk's reading allowance. The counters are private so only read() can
// spend them, and every read is checked against both bounds before it happens.
class ReadBudget {
  private files = 0;
  private bytes = 0;

  constructor(
    private readonly filesMax: number,
    private readonly bytesMax: number,
  ) {
    assert(filesMax > 0, 'ReadBudget: a walk may read at least one file');
    assert(bytesMax > 0, 'ReadBudget: a walk may read at least one byte');
  }

  /** Whether one more read would pass the file bound, counting `queued` reads not yet started. */
  full(queued = 0): boolean {
    return this.files + queued >= this.filesMax;
  }

  over(): boolean {
    return this.files > this.filesMax || this.bytes > this.bytesMax;
  }

  async read(full: string): Promise<string | ReadFailure> {
    assert(!this.full(), 'ReadBudget.read: callers check full() first');
    this.files += 1;
    let bytes: Buffer;
    try {
      const stat = await fs.promises.stat(full);
      if (stat.size > SELECTOR_FILE_LIMITS.fileBytesMax) {
        return { kind: 'failed', message: `${path.basename(full)} is larger than ${Math.floor(SELECTOR_FILE_LIMITS.fileBytesMax / 1024 / 1024)} MB` };
      }
      if (this.bytes + stat.size > this.bytesMax) {
        return { kind: 'failed', message: `There is more than ${Math.floor(this.bytesMax / 1024 / 1024)} MB to check` };
      }
      bytes = await fs.promises.readFile(full);
    } catch (error: unknown) {
      return { kind: 'failed', message: errorText(error) };
    }
    this.bytes += bytes.length;
    // A NUL byte early on marks a binary file whatever its name says.
    if (bytes.subarray(0, 8192).includes(0)) {
      return { kind: 'binary' };
    }
    return bytes.toString('utf8');
  }
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
