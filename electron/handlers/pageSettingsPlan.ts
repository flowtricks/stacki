// Planning one Page settings step from the disk, without writing: a rename (the page rename planner, reused), making
// a page the homepage (a swap of two files), a duplicate, or a deletion. The plan holds every byte it will write and
// every byte it read, so pageRelocationWrite.ts can refuse a file changed since, and the summary is what the dialog's
// confirm step says. Every text that changes must still parse afterwards, or nothing is planned at all.
import path from 'node:path';
import fs from 'node:fs';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import { parsePageOrder } from '../../shared/properties/pageOrder';
import { pageURLPath, type PageRename } from '../../shared/properties/pageRename';
import { pageRenameConflicts } from '../../shared/properties/pageRenameConflicts';
import {
  homeSwapPlan,
  homeSwapRefusalText,
  isHomePage,
  PAGE_SETTINGS_LIMITS,
  type PageSettingsRequest,
  type PageSettingsReview,
  type PageSettingsSummary,
} from '../../shared/properties/pageSettings';
import { runSliced, runSync, type SlicedWork } from '../lib/slicedWork';
import { reparses } from './componentRemovalPlan';
import { isRenameTextCandidate, pageRenameInventoryWork, readRenameText, type PageRenameInventory } from '../project/pageRenameInventory';
import { planPageRenameWork, renameOrigins, type RenameText } from '../project/pageRenamePlan';
import { renamePageImports, renamePageLinks } from '../project/pageRenameLinks';
import { swapPageLinks, type SwapRoutes } from '../project/pageSwapLinks';
import type { FileChange, RelocationStep } from '../project/pageRelocationWrite';

export interface RelocationPlan {
  readonly step: RelocationStep;
  readonly summary: PageSettingsSummary;
  /** Where the page the request named is afterwards, relative to src/pages. */
  readonly page: string;
}

type Aliases = readonly (readonly [string, readonly string[]])[];

/** What astro.config says that a swap must respect. Read as text: the config is project JavaScript, never run here. */
export interface SiteSettings {
  readonly base: string;
  readonly trailing: 'always' | 'as-written';
  readonly locales: readonly string[];
}

export function planRelocation(root: string, request: PageSettingsRequest, aliases: Aliases = []): Result<RelocationPlan> {
  return runSync(planRelocationWork(root, request, aliases));
}

export function planRelocationSliced(root: string, request: PageSettingsRequest, aliases: Aliases = []): Promise<Result<RelocationPlan>> {
  return runSliced(planRelocationWork(root, request, aliases));
}

export function* planRelocationWork(root: string, request: PageSettingsRequest, aliases: Aliases): SlicedWork<Result<RelocationPlan>> {
  assert(path.isAbsolute(root), 'A page settings plan reads an absolute project root');
  switch (request.kind) {
    case 'rename':
      return yield* planRename(root, { kind: 'page', from: request.from, to: request.to }, aliases);
    case 'home':
      return yield* planHomeSwap(root, request.page, aliases);
    case 'duplicate':
      return yield* planDuplicate(root, request.page);
    case 'remove':
      return yield* planRemove(root, request.page);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

// A rename is the page rename's own plan (links, imports, page order), with the page's file as a move.
function* planRename(root: string, change: PageRename, aliases: Aliases): SlicedWork<Result<RelocationPlan>> {
  const planned = yield* planPageRenameWork(root, change, aliases);
  if (!planned.ok) {
    return planned;
  }
  const from = 'src/pages/' + change.from;
  const to = 'src/pages/' + change.to;
  const read = readRenameText(root, from);
  if (read === undefined) {
    return err({ code: 'encoding', ...described('pages.settings.error.notText', { file: from }) });
  }
  const own = planned.value.texts.find((entry) => entry.file === from);
  const texts = planned.value.texts.filter((entry) => entry.file !== from);
  const files: readonly FileChange[] = [{ kind: 'move', from, to, before: read.source, after: own?.after ?? read.source }];
  const unparsable = firstUnparsable(texts, files);
  if (unparsable !== undefined) {
    return err({ code: 'parse', ...described('pages.settings.error.unparsable', { file: unparsable }) });
  }
  const before = pageURLPath(change.from);
  const links = texts.reduce((sum, entry) => sum + Math.max(0, routeMentions(entry.before, before) - routeMentions(entry.after, before)), 0);
  const summary = summaryOf({ texts, files, links, reviews: [] });
  return ok({ step: { root, texts, files }, summary, page: change.to });
}

function* planHomeSwap(root: string, page: string, aliases: Aliases): SlicedWork<Result<RelocationPlan>> {
  const inventory = yield* pageRenameInventoryWork(root);
  const site = readSiteSettings(root);
  const swap = homeSwapPlan(page, { pages: inventory.pages, locales: site.locales });
  if (!swap.ok) {
    return err({ code: 'refused', ...homeSwapRefusalText(swap.error) });
  }
  const { home, page: moving } = swap.value;
  const homeFrom = 'src/pages/' + home.from;
  const pageFrom = 'src/pages/' + moving.from;
  const homeText = readRenameText(root, homeFrom);
  const pageText = readRenameText(root, pageFrom);
  if (homeText === undefined || pageText === undefined) {
    return err({ code: 'encoding', ...described('pages.settings.error.notText', { file: homeText === undefined ? homeFrom : pageFrom }) });
  }
  // A page that lists its own paths answers many URLs; the homepage is one.
  if (/\bgetStaticPaths\b/.test(pageText.source)) {
    return err({ code: 'refused', ...homeSwapRefusalText('dynamic') });
  }
  const other = pageURLPath(moving.from);
  const routes: SwapRoutes = { other, base: site.base, trailing: site.trailing, origins: renameOrigins(root, inventory.files.filter(isConfigFile)) };
  const relocated = new Map([
    [homeFrom, 'src/pages/' + home.to],
    [pageFrom, 'src/pages/' + moving.to],
  ]);
  const owners = new Map([
    [homeFrom, { before: '/', after: other }],
    [pageFrom, { before: other, after: '/' }],
  ]);
  const texts: RenameText[] = [];
  const reviews: PageSettingsReview[] = [];
  const moved = new Map<string, string>();
  let links = 0;
  for (const file of inventory.files.filter(isRenameTextCandidate)) {
    const read = readRenameText(root, file);
    if (read === undefined) {
      yield;
      continue;
    }
    const outcome = swapFile(read.source, { file, routes, relocated, aliases, owner: owners.get(file), home, moving });
    links += outcome.links;
    reviews.push(...outcome.reviews);
    if (relocated.has(file)) {
      moved.set(file, outcome.after);
    } else if (outcome.after !== read.source) {
      texts.push({ file, before: read.source, after: outcome.after });
    }
    yield;
  }
  const files: readonly FileChange[] = [
    { kind: 'move', from: homeFrom, to: 'src/pages/' + home.to, before: homeText.source, after: moved.get(homeFrom) ?? homeText.source },
    { kind: 'move', from: pageFrom, to: 'src/pages/' + moving.to, before: pageText.source, after: moved.get(pageFrom) ?? pageText.source },
  ];
  const unparsable = firstUnparsable(texts, files);
  if (unparsable !== undefined) {
    return err({ code: 'parse', ...described('pages.settings.error.unparsable', { file: unparsable }) });
  }
  assert(files.length === 2, 'A swap moves exactly two files');
  return ok({ step: { root, texts, files }, summary: summaryOf({ texts, files, links, reviews }), page: moving.to });
}

interface SwapFileContext {
  readonly file: string;
  readonly routes: SwapRoutes;
  readonly relocated: ReadonlyMap<string, string>;
  readonly aliases: Aliases;
  readonly owner: { readonly before: string; readonly after: string } | undefined;
  readonly home: { readonly from: string; readonly to: string };
  readonly moving: { readonly from: string; readonly to: string };
}

interface SwapFileOutcome {
  readonly after: string;
  readonly links: number;
  readonly reviews: readonly PageSettingsReview[];
}

// One file's share of a swap. The config files are only read for review: their strings are routes of a different
// kind (a redirect's source, the site's own address), and rewriting one would change what the site serves.
function swapFile(source: string, context: SwapFileContext): SwapFileOutcome {
  const { file } = context;
  if (isConfigFile(file)) {
    const reviews = /\bredirects\b/.test(source)
      ? reviewLines(file, source, (line) => mentionsRoute(line, context.routes.other) || /(["'])\/\1/.test(line))
      : [];
    return { after: source, links: 0, reviews };
  }
  if (file === '.stacki/pages.json') {
    return { after: swapOrder(source, context), links: 0, reviews: [] };
  }
  const linked = swapPageLinks(source, { routes: context.routes, file, owner: context.owner });
  const imported = renamePageImports(linked.text, file, context.relocated, context.aliases);
  const after = file.startsWith('.stacki/') && file.endsWith('.json') ? swapSettingsPaths(imported, context) : imported;
  // Lines that compare against the current URL decide what a page shows (an active nav link); their bare '/' is not
  // rewritten, so a person checks them. Feeds and sitemaps list pages by hand, so they are checked too.
  const feed = /(^|\/)(rss|feed|sitemap)[^/]*$/i.test(file);
  const reviews = reviewLines(file, after, (line) => {
    if (feed) {
      return mentionsRoute(line, context.routes.other) || /(["'])\/\1/.test(line);
    }
    return /\bAstro\.url\b/.test(line) && /(["'])\/\1/.test(line);
  });
  return { after, links: linked.links, reviews };
}

// The page order keeps its places: the new homepage takes the old homepage's row, the old homepage the page's row.
function swapOrder(source: string, context: SwapFileContext): string {
  const input: unknown = JSON.parse(source);
  const order = parsePageOrder(input);
  const entries = order.entries.map((key) => {
    if (key === context.home.from) {
      return context.moving.to;
    }
    if (key === context.moving.from) {
      return context.home.to;
    }
    return key;
  });
  if (entries.every((key, index) => key === order.entries[index])) {
    return source;
  }
  return JSON.stringify(parsePageOrder({ ...order, entries }), undefined, 2) + (source.includes('\r\n') ? '\r\n' : '\n');
}

// Settings keyed by a page's file follow the file: `src/pages/index.astro` becomes `src/pages/about.astro`.
function swapSettingsPaths(source: string, context: SwapFileContext): string {
  const map = new Map([
    ['src/pages/' + context.home.from, 'src/pages/' + context.home.to],
    ['src/pages/' + context.moving.from, 'src/pages/' + context.moving.to],
  ]);
  return source.replace(/"((?:\\.|[^"\\])*)"/g, (match: string, value: string) => {
    const next = map.get(value);
    return next === undefined ? match : JSON.stringify(next);
  });
}

function* planDuplicate(root: string, page: string): SlicedWork<Result<RelocationPlan>> {
  const inventory = yield* pageRenameInventoryWork(root);
  const missing = requirePage(page, inventory);
  if (missing !== undefined) {
    return missing;
  }
  const from = 'src/pages/' + page;
  const read = readRenameText(root, from);
  if (read === undefined) {
    return err({ code: 'encoding', ...described('pages.settings.error.notText', { file: from }) });
  }
  const copy = copyName(page, inventory);
  if (copy === undefined) {
    return err({ code: 'conflict', ...described('pages.settings.error.noCopyName') });
  }
  // Beside the original, so every relative import still resolves without a rewrite.
  assert(path.posix.dirname(copy) === path.posix.dirname(page), 'A copy sits beside its page');
  const files: readonly FileChange[] = [{ kind: 'create', to: 'src/pages/' + copy, after: read.source }];
  return ok({ step: { root, texts: [], files }, summary: summaryOf({ texts: [], files, links: 0, reviews: [] }), page: copy });
}

function copyName(page: string, inventory: PageRenameInventory): string | undefined {
  const extension = /\.(astro|mdx?)$/i.exec(page)?.[0] ?? '';
  const stem = page.slice(0, page.length - extension.length);
  const folder = stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/') + 1) : '';
  // `index` copies as `index-copy`, a page of its own, never a second homepage.
  const base = stem.slice(folder.length);
  for (let index = 1; index <= PAGE_SETTINGS_LIMITS.copyNamesMax; index++) {
    const candidate = folder + base + (index === 1 ? '-copy' : `-copy-${index}`) + extension;
    const change: PageRename = { kind: 'page', from: page, to: candidate };
    const free = pageRenameConflicts(change, { pages: inventory.pages, folders: inventory.folders });
    const taken = inventory.pages.some((other) => other.toLowerCase() === candidate.toLowerCase());
    if (free.ok && !taken) {
      return candidate;
    }
  }
  return undefined;
}

// A deletion lists the links that would point nowhere: every place a rename of this page would have changed.
function* planRemove(root: string, page: string): SlicedWork<Result<RelocationPlan>> {
  const inventory = yield* pageRenameInventoryWork(root);
  const missing = requirePage(page, inventory);
  if (missing !== undefined) {
    return missing;
  }
  if (isHomePage(page)) {
    return err({ code: 'refused', ...described('pages.settings.delete.homeRefused') });
  }
  const from = 'src/pages/' + page;
  const read = readRenameText(root, from);
  if (read === undefined) {
    return err({ code: 'encoding', ...described('pages.settings.error.notText', { file: from }) });
  }
  const extension = /\.(astro|mdx?)$/i.exec(page)?.[0] ?? '.astro';
  const folder = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
  const sentinel = folder + 'stacki-removed-page' + extension;
  const sentinelRoute = pageURLPath(sentinel);
  const origins = renameOrigins(root, inventory.files.filter(isConfigFile));
  const reviews: PageSettingsReview[] = [];
  let links = 0;
  for (const file of inventory.files.filter(isRenameTextCandidate)) {
    if (file === from || isConfigFile(file) || file.startsWith('.stacki/')) {
      yield;
      continue;
    }
    const text = readRenameText(root, file);
    if (text !== undefined) {
      const probed = renamePageLinks(text.source, { change: { kind: 'page', from: page, to: sentinel }, origins, file });
      if (probed !== text.source) {
        links += routeMentions(probed, sentinelRoute);
        reviews.push(...changedLines(file, text.source, probed));
      }
    }
    yield;
  }
  const files: readonly FileChange[] = [{ kind: 'delete', from, before: read.source }];
  return ok({ step: { root, texts: [], files }, summary: summaryOf({ texts: [], files, links, reviews }), page });
}

function requirePage(page: string, inventory: PageRenameInventory): Result<never> | undefined {
  return inventory.pages.includes(page) ? undefined : err({ code: 'missing', ...described('pages.rename.error.missing') });
}

/** astro.config's base, trailingSlash and i18n locales, read from its text; defaults when it has none. */
export function readSiteSettings(root: string): SiteSettings {
  const config = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs']
    .map((name) => path.join(root, name))
    .find((file) => fs.existsSync(file));
  if (config === undefined) {
    return { base: '', trailing: 'as-written', locales: [] };
  }
  const source = fs.readFileSync(config, 'utf8');
  return siteSettingsOf(source);
}

export function siteSettingsOf(source: string): SiteSettings {
  assert(source.length <= 5_000_000, 'A config read is bounded');
  const baseMatch = /\bbase\s*:\s*['"]([^'"]*)['"]/.exec(source);
  const rawBase = baseMatch?.[1] ?? '';
  const trimmedBase = rawBase.replace(/\/+$/, '');
  const base = trimmedBase === '' ? '' : trimmedBase.replace(/^(?!\/)/, '/');
  const trailing = /\btrailingSlash\s*:\s*['"]always['"]/.test(source) ? 'always' : 'as-written';
  const locales: string[] = [];
  const localization = /\bi18n\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(source);
  const list = localization?.[1] === undefined ? undefined : bracketed(localization[1], /\blocales\s*:\s*\[/);
  if (list !== undefined) {
    // An object entry is `{ path, codes }`: its folder is the path, and its codes are not folders.
    const block = list.replace(/\{[^}]*?\bpath\s*:\s*['"]([\w-]+)['"][^}]*\}/g, "'$1'");
    for (const match of block.matchAll(/['"]([\w-]+)['"]/g)) {
      const locale = match[1];
      if (locale !== undefined && locales.length < PAGE_SETTINGS_LIMITS.localesMax && !locales.includes(locale)) {
        locales.push(locale);
      }
    }
  }
  const defaultLocale = /\bdefaultLocale\s*:\s*['"]([\w-]+)['"]/.exec(source)?.[1];
  // The default locale's pages sit at the root unless the project prefixes it, so its folder is a locale too.
  assert(locales.length <= PAGE_SETTINGS_LIMITS.localesMax, 'The locale list is bounded');
  return {
    base,
    trailing,
    locales: defaultLocale === undefined ? locales : locales.filter((locale) => locale !== defaultLocale || source.includes('prefixDefaultLocale')),
  };
}

// The text between `[` (where `opening` ends) and its matching `]`, nested brackets included; bounded by the text.
function bracketed(source: string, opening: RegExp): string | undefined {
  const start = opening.exec(source);
  if (start === null) {
    return undefined;
  }
  const from = start.index + start[0].length;
  let depth = 1;
  for (let index = from; index < source.length; index++) {
    const character = source[index];
    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(from, index);
      }
    }
  }
  return undefined;
}

function isConfigFile(file: string): boolean {
  return /^astro\.config\.[cm]?[jt]s$/.test(file) || file === '.stacki/publish.json';
}

function firstUnparsable(texts: readonly RenameText[], files: readonly FileChange[]): string | undefined {
  const text = texts.find((entry) => !reparses(entry.file, entry.after));
  if (text !== undefined) {
    return text.file;
  }
  const file = files.find((change) => change.kind !== 'delete' && !reparses(change.to, change.after));
  return file === undefined || file.kind === 'delete' ? undefined : file.to;
}

function summaryOf(input: {
  readonly texts: readonly RenameText[];
  readonly files: readonly FileChange[];
  readonly links: number;
  readonly reviews: readonly PageSettingsReview[];
}): PageSettingsSummary {
  const moves = input.files.flatMap((change) => (change.kind === 'move' ? [{ from: change.from, to: change.to }] : []));
  const listed = input.reviews.slice(0, PAGE_SETTINGS_LIMITS.reviewsMax);
  assert(moves.length <= PAGE_SETTINGS_LIMITS.movesMax, 'A summary lists at most two moves');
  return { files: input.texts.length, links: input.links, moves, reviews: listed, reviewsMore: input.reviews.length - listed.length };
}

// How often a route appears as a whole path in a text: `/about` in "/about", "/about/", "/about#x", not "/about-us".
function routeMentions(source: string, route: string): number {
  if (route === '/') {
    return 0;
  }
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(escaped + '(?=$|[/"\'`)?#\\s<>\\\\])', 'g'))].length;
}

function mentionsRoute(line: string, route: string): boolean {
  return routeMentions(line, route) > 0;
}

function reviewLines(file: string, source: string, wanted: (line: string) => boolean): readonly PageSettingsReview[] {
  const found: PageSettingsReview[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (found.length >= PAGE_SETTINGS_LIMITS.reviewsMax) {
      break;
    }
    if (wanted(line)) {
      found.push({ file, line: index + 1, text: line.trim().slice(0, PAGE_SETTINGS_LIMITS.reviewLineCharsMax) });
    }
  }
  return found;
}

function changedLines(file: string, before: string, after: string): readonly PageSettingsReview[] {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  assert(left.length === right.length, 'A link probe changes no line count');
  const found: PageSettingsReview[] = [];
  for (const [index, line] of left.entries()) {
    if (found.length >= PAGE_SETTINGS_LIMITS.reviewsMax) {
      break;
    }
    if (line !== right[index]) {
      found.push({ file, line: index + 1, text: line.trim().slice(0, PAGE_SETTINGS_LIMITS.reviewLineCharsMax) });
    }
  }
  return found;
}
