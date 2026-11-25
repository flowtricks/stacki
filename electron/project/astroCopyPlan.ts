// Where every file of a plain website goes in its Astro copy, decided before anything is written. Pure:
// a listing in, a plan or a refusal out, so the rules are tested on exact paths.
//
// The rules, and why:
// - Every .html/.htm page becomes `src/pages/<same path>.astro` (index.html → src/pages/index.astro,
//   about/index.html → src/pages/about/index.astro). Astro serves a page at the address its file names,
//   and the copy's astro.config.mjs builds with `format: 'preserve'`, so `/about.html` and
//   `/about/index.html` are the same addresses they were, in `astro dev` and in the built site.
// - Everything else goes to `public/<same path>`. Astro serves public/ at the site's root, so a page at
//   src/pages/x/y.astro and an asset at public/x/z.png are `/x/y.html` and `/x/z.png`: every relative
//   and root-relative URL in a page resolves exactly as it did.
// - A page Astro cannot route as itself stays a plain file in public/, where its address still works:
//   a name or folder starting with `_` (Astro skips those) or holding `[`/`]` (a dynamic route), and the
//   loser of two pages Astro would serve at one route (`about.html` beside `about/index.html`,
//   `x.htm` beside `x.html`). The folder's own index page wins, then .html over .htm, then name order.
// - A .htm page is served by Astro as .html. A two-line page left at its old `.htm` address forwards
//   there, so links to it keep working without touching any page's text.
// - The original's own project files (package.json, lockfiles, tsconfig) would describe a project that
//   no longer exists; the copy gets its own and those are left out.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { ASTRO_COPY_LIMITS, type AstroCopyFailure } from '../../shared/ipc/astroCopy';
import { PAGE_FILE, type SiteFile, type SiteListing } from './plainSiteScan';

export const ASTRO_COPY_FILE_LIMITS = {
  /** Files one copy makes. A hand-made site holds hundreds; a folder with more is an archive or a vendored tree, and copying it would hold the dialog for minutes. */
  filesMax: 20_000,
  /** Entries the copy's walk reads (files, folders and what it leaves out), so a folder far past `filesMax` is refused without being read to the end. */
  entriesMax: 40_000,
  /** Bytes one copy writes: it doubles the folder on disk, and a site past this is a media library. */
  totalBytesMax: 4 * 1024 ** 3,
  /** Bytes of one file: a long video. */
  fileBytesMax: 2 * 1024 ** 3,
  /** Bytes of one page, which is converted as one string in the main process. No hand-made page comes near it. */
  pageBytesMax: Math.min(64 * 1024 ** 2, LIMITS.sourceBytesMax),
} as const satisfies Record<string, number>;

/**
 * The astro range a copy's package.json names. New sites from "Start from Astro" get create-astro's
 * latest; a copy is written here, so it names the major Stacki's own Studio builds against
 * (studio/package.json's devDependencies, held equal by test/electron/project/astroCopyPlan.test.ts).
 */
export const ASTRO_COPY_ASTRO_RANGE = '^7.3.8';

export type PlanEntry =
  | { readonly kind: 'page'; readonly source: SiteFile; readonly target: string }
  | { readonly kind: 'asset'; readonly source: SiteFile; readonly target: string }
  | { readonly kind: 'generated'; readonly target: string; readonly text: string };

export interface AstroCopyPlan {
  readonly entries: readonly PlanEntry[];
  readonly pageCount: number;
  readonly assetCount: number;
  /** Pages kept as plain files under public/, by their path in the original. */
  readonly keptAsFiles: readonly string[];
  /** Entries of the original the copy leaves out. */
  readonly skippedCount: number;
}

// The original's project files: the copy writes its own.
const PROJECT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
]);

/** The plan for copying `listing` as the Astro project `projectName`, or the bound it breaks. */
export function planAstroCopy(listing: SiteListing, projectName: string): Result<AstroCopyPlan, AstroCopyFailure> {
  assert(projectName.length > 0, 'planAstroCopy: the project has a name');
  if (listing.truncated) {
    return err({ code: 'too-many-files', limit: ASTRO_COPY_FILE_LIMITS.filesMax });
  }
  const files = listing.files.filter((file) => !PROJECT_FILES.has(file.relative.toLowerCase()));
  const bounds = checkBounds(files);
  if (bounds !== undefined) {
    return err(bounds);
  }
  const pages = files.filter((file) => PAGE_FILE.test(file.relative));
  if (pages.length === 0) {
    return err({ code: 'not-plain-website' });
  }
  const routed = routePages(pages);
  const entries: PlanEntry[] = [...scaffoldEntries(projectName)];
  for (const file of files) {
    const decision = routed.get(file.relative);
    if (decision === 'page') {
      entries.push({ kind: 'page', source: file, target: `src/pages/${file.relative.replace(PAGE_FILE, '.astro')}` });
      if (/\.htm$/i.test(file.relative)) {
        entries.push({ kind: 'generated', target: `public/${file.relative}`, text: forwardingPage(file.relative) });
      }
    } else {
      entries.push({ kind: 'asset', source: file, target: `public/${file.relative}` });
    }
  }
  const targets = new Set(entries.map((entry) => entry.target));
  assert(targets.size === entries.length, 'planAstroCopy: every target is written once');
  const pageCount = entries.filter((entry) => entry.kind === 'page').length;
  const keptAsFiles = pages.filter((page) => routed.get(page.relative) === 'kept').map((page) => page.relative);
  assert(pageCount + keptAsFiles.length === pages.length, 'planAstroCopy: every page is routed or kept');
  return ok({
    entries,
    pageCount,
    assetCount: entries.filter((entry) => entry.kind === 'asset').length,
    keptAsFiles,
    skippedCount: listing.skipped.length + (listing.files.length - files.length),
  });
}

function checkBounds(files: readonly SiteFile[]): AstroCopyFailure | undefined {
  if (files.length > ASTRO_COPY_FILE_LIMITS.filesMax) {
    return { code: 'too-many-files', limit: ASTRO_COPY_FILE_LIMITS.filesMax };
  }
  let totalBytes = 0;
  for (const file of files) {
    const limit = PAGE_FILE.test(file.relative) ? ASTRO_COPY_FILE_LIMITS.pageBytesMax : ASTRO_COPY_FILE_LIMITS.fileBytesMax;
    if (file.sizeBytes > limit) {
      return { code: 'file-too-large', limit, file: file.relative };
    }
    totalBytes += file.sizeBytes;
    if (totalBytes > ASTRO_COPY_FILE_LIMITS.totalBytesMax) {
      return { code: 'too-many-bytes', limit: ASTRO_COPY_FILE_LIMITS.totalBytesMax };
    }
  }
  return undefined;
}

/** For each page path, whether it becomes an Astro page or stays a plain file. */
export function routePages(pages: readonly Pick<SiteFile, 'relative'>[]): ReadonlyMap<string, 'page' | 'kept'> {
  const decisions = new Map<string, 'page' | 'kept'>();
  const byRoute = new Map<string, string[]>();
  for (const page of pages) {
    assert(PAGE_FILE.test(page.relative), 'routePages: only pages');
    if (astroSkipsName(page.relative)) {
      decisions.set(page.relative, 'kept');
      continue;
    }
    const route = routeOf(page.relative);
    byRoute.set(route, [...(byRoute.get(route) ?? []), page.relative]);
  }
  for (const contenders of byRoute.values()) {
    const [winner, ...losers] = [...contenders].sort(comparePageClaims);
    assert(winner !== undefined, 'routePages: a route has a page');
    decisions.set(winner, 'page');
    for (const loser of losers) {
      decisions.set(loser, 'kept');
    }
  }
  assert(decisions.size === pages.length, 'routePages: every page decided');
  return decisions;
}

// The route Astro gives a page file: its path without the extension, a folder's index as the folder.
function routeOf(relative: string): string {
  const stem = relative.replace(PAGE_FILE, '');
  if (stem === 'index') {
    return '';
  }
  return stem.endsWith('/index') ? stem.slice(0, -'/index'.length) : stem;
}

// Astro routes neither a file or folder whose name starts with `_` nor one holding brackets as itself.
function astroSkipsName(relative: string): boolean {
  return relative.split('/').some((segment) => segment.startsWith('_') || segment.includes('[') || segment.includes(']'));
}

// The order two pages claim one route: a folder's index page, then .html over .htm, then name order.
function comparePageClaims(left: string, right: string): number {
  const leftIndex = /(^|\/)index\.html?$/i.test(left) ? 0 : 1;
  const rightIndex = /(^|\/)index\.html?$/i.test(right) ? 0 : 1;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  const leftHtm = /\.htm$/i.test(left) ? 1 : 0;
  const rightHtm = /\.htm$/i.test(right) ? 1 : 0;
  if (leftHtm !== rightHtm) {
    return leftHtm - rightHtm;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The page left at a .htm page's old address, forwarding to the .html address Astro serves it at, with its query and fragment. */
export function forwardingPage(relative: string): string {
  assert(/\.htm$/i.test(relative), 'forwardingPage: a .htm page');
  const base = relative.split('/').pop() ?? relative;
  const target = encodeURIComponent(base.replace(/\.htm$/i, '.html'));
  assert(!/["<>&']/.test(target), 'forwardingPage: the address needs no escaping');
  return [
    '<!doctype html>',
    `<meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}">`,
    `<script>location.replace('${target}' + location.search + location.hash);</script>`,
    `<a href="${target}">${target}</a>`,
    '',
  ].join('\n');
}

/** The npm package name for a folder name: lowercase, with anything npm refuses as a dash. */
export function packageNameFor(folderName: string): string {
  const name = folderName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 214);
  return name.length > 0 ? name : 'site';
}

/** The files that make the copy an Astro project, as create-astro's minimal template writes them. */
export function scaffoldEntries(projectName: string): readonly PlanEntry[] {
  const manifest = {
    name: packageNameFor(projectName),
    type: 'module',
    version: '0.0.1',
    private: true,
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview', astro: 'astro' },
    dependencies: { astro: ASTRO_COPY_ASTRO_RANGE },
  };
  const entries: readonly PlanEntry[] = [
    { kind: 'generated', target: 'package.json', text: `${JSON.stringify(manifest, undefined, 2)}\n` },
    { kind: 'generated', target: 'astro.config.mjs', text: ASTRO_CONFIG },
    { kind: 'generated', target: 'tsconfig.json', text: TSCONFIG },
    { kind: 'generated', target: '.gitignore', text: GITIGNORE },
  ];
  assert(
    entries.every((entry) => !entry.target.includes('/')),
    'scaffoldEntries: scaffold files sit at the root',
  );
  assert(ASTRO_COPY_LIMITS.reportPathsMax > 0, 'scaffoldEntries: the report lists some paths');
  return entries;
}

const ASTRO_CONFIG = `// @ts-check
import { defineConfig } from 'astro/config';

// This site was copied from a plain HTML folder by Stacki.
// - build.format 'preserve' builds every page to the file name it had, so about.html stays
//   /about.html and blog/index.html stays /blog/index.html: old links and relative URLs keep working.
// - build.inlineStylesheets 'always' keeps each page's <style> inside the page, so its relative
//   url()s resolve against the page as they did.
export default defineConfig({
  build: { format: 'preserve', inlineStylesheets: 'always' },
  trailingSlash: 'ignore',
});
`;

const TSCONFIG = `${JSON.stringify({ extends: 'astro/tsconfigs/base', include: ['.astro/types.d.ts', '**/*'], exclude: ['dist'] }, undefined, 2)}\n`;

const GITIGNORE = `# build output
dist/

# generated types
.astro/

# dependencies
node_modules/

# logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# environment variables
.env
.env.production

# macOS-specific files
.DS_Store
`;
