// One audit run: read the files the scope names, gather the facts the checks
// need (routes, public files and their sizes, image dimensions, site constants,
// the Astro config), run the static checks on every file, the rendered checks
// on every page the dev server can render, and the site checks, then drop
// duplicates and ignored findings. Every read goes through `AuditIO`, so a test
// runs the same code on fixtures and the panel runs it on the project.
//
// The open file is read from the editor, not the disk: its findings describe
// what the canvas shows, unsaved edits included, and their fixes go through
// the open page's own edit queue (auditFixes.ts).
import { assert } from '../../../shared/core/assert';
import type { Result } from '../../../shared/core/result';
import { AUDIT_LIMITS, uniqueFindings, type AuditFinding } from '../../../shared/page/auditFindings';
import { auditRenderedPage, type RenderedElement } from '../../../shared/page/auditRendered';
import {
  SITE_FILE_ENDPOINTS,
  SITE_FILE_URLS,
  auditSite,
  configHasAnalytics,
  configMakes,
  exportedString,
  noindexRoutesIn,
  type SitePage,
} from '../../../shared/page/auditSite';
import { lintCss, tokenGroup, variablesFor } from '../../../shared/page/auditTokens';
import { lineOf, lineStarts } from '../../../shared/page/auditMarkup';
import { swapped } from '../../../shared/page/auditStatic';
import type { AuditFile } from '../../../shared/properties/auditIgnores';
import type { RenderedElement as RenderedNodeElement } from '../../../shared/page/auditRendered';
import {
  auditFile,
  localPath,
  urlPath,
  type AuditFacts,
  type AuditFileInput,
  type AuditFileSummary,
  type SiteConstants,
} from '../../../shared/page/auditStatic';
import { HEADING_TAG_PROPS, headingPromotionFix, instanceIdFix } from '../../../shared/page/auditRepairs';
import { nodeAt, traceAuthored } from '../../../shared/page/auditTrace';
import { auditFinding } from '../../../shared/page/auditFindings';
import type { ImportDecl, PageNode } from '../../../shared/page/pageNode';
import type { ScanResult } from '../../../shared/properties/projectScan';
import type { WireAssetEntry } from '../../../shared/ipc/ipcResults';
import { auditPlan, importedTargets, IMPORT_DEPTH_MAX, relativeTo, type AuditScope, type AuditTarget } from './auditScope';
import type { RenderedHtml } from './auditsBridge';

/** A file as the runner reads it: its tree, imports and text, or why it has none. */
export type AuditRead =
  | { readonly editable: true; readonly nodes: readonly PageNode[]; readonly imports: readonly ImportDecl[]; readonly source: string }
  | { readonly editable: false };

export interface AuditIO {
  readonly readFile: (path: string) => Promise<AuditRead>;
  /** A project file's text, or undefined when it does not exist. */
  readonly readText: (rel: string) => Promise<string | undefined>;
  readonly listAssets: () => Promise<Result<readonly WireAssetEntry[], string>>;
  readonly imageSize: (rel: string) => Promise<{ readonly width: number; readonly height: number } | undefined>;
  /** Undefined when no dev server is running. */
  readonly renderPage: ((route: string) => Promise<RenderedHtml>) | undefined;
  /** The rendered HTML as a tree; `styled` lays it out for contrast. */
  readonly tree: (html: string, file: string, route: string, options: { readonly styled: boolean }) => Promise<RenderedElement>;
  /** The project's CSS variables, by name, with their values. */
  readonly variables: () => Promise<ReadonlyMap<string, string>>;
  /** The stylesheets the project owns: project-relative and absolute paths. */
  readonly styleFiles: () => Promise<readonly { readonly rel: string; readonly path: string }[]>;
  readonly readStyle: (path: string) => Promise<string | undefined>;
}

export interface AuditRunInput {
  readonly scope: AuditScope;
  readonly projectPath: string;
  readonly scan: ScanResult;
  /** The open file, read from the editor when it is editable. */
  readonly open: { readonly path: string; readonly kind: 'page' | 'component'; readonly read: AuditRead | undefined } | undefined;
  /** The project's audit settings (`.stacki/audits.json`). */
  readonly settings: AuditFile;
  /** What earlier runs read and rendered; reused for files that have not changed since. */
  readonly cache?: AuditCache;
  /** Called as files are read and pages rendered, for the panel's progress line. */
  readonly onProgress?: (progress: AuditProgress) => void;
}

export interface AuditProgress {
  readonly stage: 'files' | 'pages';
  readonly done: number;
  readonly total: number;
}

/**
 * Reads and renders kept between runs, so a whole-site audit re-reads only the files that
 * changed. The runner hook owns it: it marks the files a change event names, and drops it all
 * on Re-audit or a new project. Rendered pages are fetched on every run (a change to one
 * component can change every page); a page whose HTML is unchanged reuses its earlier checks.
 */
export interface AuditCache {
  readonly reads: Map<string, AuditRead>;
  readonly rendered: Map<string, { readonly html: string; readonly placeholders: string; readonly audit: ReturnType<typeof auditRenderedPage> }>;
}

/** Entries an audit cache holds at most of each kind; past it, the oldest are dropped. */
export const AUDIT_CACHE_ENTRIES_MAX = AUDIT_LIMITS.filesMax;

export function auditCache(): AuditCache {
  return { reads: new Map(), rendered: new Map() };
}

// Keeps a cache map inside its bound, oldest first (a Map iterates in insertion order).
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= AUDIT_CACHE_ENTRIES_MAX) {
      break;
    }
    map.delete(oldest);
  }
  assert(map.size <= AUDIT_CACHE_ENTRIES_MAX, 'remember: the cache is bounded');
}

/** What the rendered pass managed. */
export type RenderedStatus =
  { readonly tag: 'done'; readonly pages: number } | { readonly tag: 'offline' } | { readonly tag: 'failed'; readonly message: string };

export interface AuditReport {
  readonly scope: AuditScope;
  readonly findings: readonly AuditFinding[];
  readonly files: number;
  /** Files the run could not read as markup, and files past the bound. */
  readonly unreadable: number;
  readonly skipped: number;
  readonly rendered: RenderedStatus;
  /** When the run finished, in epoch milliseconds. */
  readonly checkedAt: number;
  /** Each read file's tree, so an occurrence row names its element as the Navigator does. */
  readonly trees: ReadonlyMap<string, readonly PageNode[]>;
}

/** Candidate modules for the site constants a fix may write, in the order Astro starters use them. */
export const SITE_CONSTANT_FILES = ['src/consts.ts', 'src/consts.js', 'src/consts.mjs', 'src/config.ts', 'src/config/site.ts', 'src/site.ts'] as const;
const IMAGE_SIZES_MAX = 400;

export async function runAudit(input: AuditRunInput, io: AuditIO): Promise<AuditReport> {
  const plan = auditPlan({ scope: input.scope, projectPath: input.projectPath, scan: input.scan, open: input.open });
  const reads = await readTargets(input, plan.targets, io);
  const facts = await gatherFacts(input, reads, io);
  const findings: AuditFinding[] = [];
  const summaries: AuditFileSummary[] = [];
  const inputs = new Map<string, AuditFileInput>();
  let unreadable = 0;
  for (const { target, read } of reads) {
    if (!read.editable) {
      unreadable += 1;
      continue;
    }
    const fileInput: AuditFileInput = {
      file: target.file,
      kind: target.kind,
      nodes: read.nodes,
      imports: read.imports,
      frontmatter: frontmatterOf(read.source),
      source: read.source,
      route: target.route,
    };
    inputs.set(target.file, fileInput);
    const audit = auditFile(fileInput, facts);
    findings.push(...audit.findings);
    summaries.push(audit.summary);
  }
  const rendered = await renderedPass(input, plan.routes, facts, io, (finding, pageFile) => relocated(finding, { pageFile, inputs, input, io }));
  const headings = headingComponents(input.scan);
  findings.push(...renderedPlaceholdersNew(rendered.findings, findings).map((finding) => retagged(repaired(finding, inputs, headings), inputs)));
  if (plan.site || input.scope === 'pages') {
    const config = plan.site ? await configFacts(input, io) : undefined;
    const siteFindings = auditSite({
      astroConfig: config === undefined ? undefined : { file: config.file },
      sitemap: plan.site ? await siteFileMade('sitemap', config?.text, facts, io) : true,
      robots: plan.site ? await siteFileMade('robots', config?.text, facts, io) : true,
      pages: rendered.pages,
      summaries: plan.site ? summaries : [],
      launch: plan.site ? await launchFacts(input, rendered.pages, config?.text, facts) : undefined,
    });
    findings.push(...siteFindings);
  }
  if (plan.site || input.scope === 'components') {
    findings.push(...(await stylesheetFindings(input, facts, io)));
  }
  if (plan.site || input.scope === 'pages') {
    findings.push(...(await socialImageFindings(rendered.pages, io)));
  }
  const unique = configured(uniqueFindings(findings), input.settings).slice(0, AUDIT_LIMITS.findingsMax);
  assert(unique.length <= AUDIT_LIMITS.findingsMax, 'runAudit: the findings are bounded');
  const trees = new Map([...inputs].map(([file, fileInput]) => [file, fileInput.nodes] as const));
  assert(trees.size <= AUDIT_LIMITS.filesMax, 'runAudit: the trees are bounded');
  return {
    scope: input.scope,
    findings: unique,
    files: reads.length,
    unreadable,
    skipped: plan.skipped,
    rendered: rendered.status,
    checkedAt: Date.now(),
    trees,
  };
}

/** The frontmatter's code: the text between the opening and closing `---` fences. */
export function frontmatterOf(source: string): string {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return match?.[1] ?? '';
}

// The plan's files, the open one from the editor; for the current page, the
// components it imports join, breadth first, to IMPORT_DEPTH_MAX.
async function readTargets(
  input: AuditRunInput,
  targets: readonly AuditTarget[],
  io: AuditIO,
): Promise<readonly { readonly target: AuditTarget; readonly read: AuditRead }[]> {
  const read = async (target: AuditTarget): Promise<AuditRead> => {
    if (input.open?.path === target.path && input.open.read !== undefined) {
      return input.open.read;
    }
    const cached = input.cache?.reads.get(target.path);
    if (cached !== undefined) {
      return cached;
    }
    const fresh = await io.readFile(target.path).catch((): AuditRead => ({ editable: false }));
    if (input.cache !== undefined) {
      remember(input.cache.reads, target.path, fresh);
    }
    return fresh;
  };
  const done: { target: AuditTarget; read: AuditRead }[] = [];
  const seen = new Set<string>();
  let level = [...targets];
  for (let depth = 0; level.length > 0 && done.length < AUDIT_LIMITS.filesMax; depth++) {
    const next: AuditTarget[] = [];
    for (const target of level) {
      if (seen.has(target.path) || done.length >= AUDIT_LIMITS.filesMax) {
        continue;
      }
      seen.add(target.path);
      const result = await read(target);
      done.push({ target, read: result });
      input.onProgress?.({ stage: 'files', done: done.length, total: Math.max(targets.length, done.length) });
      if (input.scope === 'page' && depth < IMPORT_DEPTH_MAX && result.editable) {
        next.push(...importedTargets(result.imports, input.projectPath, input.scan));
      }
    }
    level = next;
  }
  assert(done.length <= AUDIT_LIMITS.filesMax, 'readTargets: the files are bounded');
  return done;
}

async function gatherFacts(input: AuditRunInput, reads: readonly { readonly read: AuditRead }[], io: AuditIO): Promise<AuditFacts> {
  const publicFiles = new Map<string, number>();
  const assets = await io.listAssets();
  if (assets.ok) {
    for (const entry of assets.value) {
      if (!entry.isDir && entry.rel.startsWith('public/')) {
        publicFiles.set(`/${entry.rel.slice('public/'.length)}`, entry.size);
      }
    }
  }
  const imageSizes = new Map<string, { readonly width: number; readonly height: number }>();
  for (const url of imageSources(reads).slice(0, IMAGE_SIZES_MAX)) {
    if (publicFiles.has(url)) {
      const size = await io.imageSize(`public${url}`).catch(() => undefined);
      if (size !== undefined) {
        imageSizes.set(url, size);
      }
    }
  }
  const constants = await siteConstants(io);
  return {
    routes: input.scan.pages.map((page) => page.route),
    publicFiles,
    imageSizes,
    site: constants.site,
    noindexRoutes: constants.noindexRoutes,
    tokens: input.settings.tokens,
    variables: await io.variables().catch(() => new Map<string, string>()),
    placeholders: input.settings.placeholders,
  };
}

// Every same-site `<img src>` the files write, so their sizes are read once, before the checks.
function imageSources(reads: readonly { readonly read: AuditRead }[]): readonly string[] {
  const found = new Set<string>();
  for (const { read } of reads) {
    if (!read.editable) {
      continue;
    }
    const pending = [...read.nodes];
    for (let visited = 0; pending.length > 0 && visited < AUDIT_LIMITS.elementsPerFileMax; visited++) {
      const node = pending.pop();
      if (node === undefined) {
        break;
      }
      if (node.kind === 'element' && node.name.toLowerCase() === 'img') {
        const source = node.props?.['src'];
        if (source?.type === 'string' && localPath(source.value)) {
          found.add(urlPath(source.value));
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        const children: readonly PageNode[] = node.children;
        pending.push(...children);
      }
    }
  }
  return [...found];
}

async function siteConstants(io: AuditIO): Promise<{ readonly site: SiteConstants; readonly noindexRoutes: readonly string[] }> {
  for (const rel of SITE_CONSTANT_FILES) {
    const source = await io.readText(rel).catch(() => undefined);
    if (source === undefined) {
      continue;
    }
    const module = rel.replace(/\.(ts|js|mjs)$/, '');
    const title = exportedString(source, ['SITE_TITLE', 'SITE_NAME', 'TITLE']);
    const description = exportedString(source, ['SITE_DESCRIPTION', 'DESCRIPTION']);
    const lang = exportedString(source, ['SITE_LANG', 'SITE_LOCALE', 'LANG', 'LOCALE']);
    return {
      site: {
        title: title === undefined ? undefined : { ...title, module },
        description: description === undefined ? undefined : { ...description, module },
        lang: lang?.value,
      },
      noindexRoutes: noindexRoutesIn(source),
    };
  }
  return { site: { title: undefined, description: undefined, lang: undefined }, noindexRoutes: [] };
}

async function configFacts(input: AuditRunInput, io: AuditIO): Promise<{ readonly file: string; readonly text: string } | undefined> {
  const file = input.scan.astroConfig;
  if (file === undefined) {
    return undefined;
  }
  const text = await io.readText(file).catch(() => undefined);
  return text === undefined ? undefined : { file, text };
}

// Each route the dev server renders, through the shared rendered checks. Contrast
// needs layout, which costs a frame per page: only the current page's audit lays it out.
async function renderedPass(
  input: AuditRunInput,
  routes: readonly { readonly route: string; readonly file: string }[],
  facts: AuditFacts,
  io: AuditIO,
  relocate: (finding: AuditFinding, pageFile: string) => Promise<AuditFinding>,
): Promise<{ readonly findings: readonly AuditFinding[]; readonly pages: readonly SitePage[]; readonly status: RenderedStatus }> {
  const pagesFromScan = input.scan.pages.map((page): SitePage => ({
    file: relativeTo(input.projectPath, page.path),
    route: page.route,
    title: page.title,
    description: undefined,
  }));
  const render = io.renderPage;
  if (render === undefined) {
    return { findings: [], pages: pagesFromScan, status: { tag: 'offline' } };
  }
  const findings: AuditFinding[] = [];
  const pages: SitePage[] = [];
  let failure: string | undefined;
  for (const { route, file } of routes) {
    const html = await render(route).catch((error: unknown): RenderedHtml => ({ ok: false, message: String(error) }));
    if (!html.ok || html.status >= 400) {
      failure = html.ok ? `${route} answered ${html.status}` : html.message;
      continue;
    }
    // The dev server's HTML, parsed as served, is the truth for what the page holds: its head
    // (title, description, canonical), outline, names and ids. The laid-out frame only adds
    // colours for contrast; a frame that loaded late or not at all can never report a head missing.
    input.onProgress?.({ stage: 'pages', done: pages.length + 1, total: routes.length });
    const audit = await renderedAudit(input, { file, route, html: html.html }, facts, io);
    if (audit === undefined) {
      continue;
    }
    for (const finding of audit.findings) {
      findings.push(await relocate(finding, file));
    }
    if (input.scope === 'page') {
      findings.push(...(await contrastFindings(html.html, { file, route }, facts, io)));
    }
    pages.push({
      file,
      route,
      title: audit.title,
      description: audit.description,
      structuredData: audit.structuredData,
      icon: audit.icon,
      analytics: audit.analytics,
      socialImage:
        audit.socialImage === undefined
          ? undefined
          : { url: audit.socialImage.url, finding: await relocate(socialFinding(file, route, audit.socialImage.element, audit.socialImage.url), file) },
    });
  }
  const status: RenderedStatus =
    failure !== undefined && pages.length === 0 && routes.length > 0 ? { tag: 'failed', message: failure } : { tag: 'done', pages: pages.length };
  return { findings, pages: pages.length > 0 ? pages : pagesFromScan, status };
}

// The static pass already reports placeholder copy written inline, at the node that holds it; the
// rendered pass adds what only rendering shows (constants, prop defaults, loops). The same text
// found by both is reported once, where the static pass put it.
function renderedPlaceholdersNew(rendered: readonly AuditFinding[], statics: readonly AuditFinding[]): readonly AuditFinding[] {
  // The quoted text alone: a prop finding writes `name="…"`, a rendered one may add where it was written.
  const quoted = (detail: string): string => detail.slice(detail.indexOf('"'), detail.lastIndexOf('"') + 1);
  const known = new Set(statics.filter((finding) => finding.check === 'placeholder-text').map((finding) => `${quoted(finding.detail)}`));
  const kept = rendered.filter((finding) => finding.check !== 'placeholder-text' || !known.has(quoted(finding.detail)));
  assert(kept.length <= rendered.length, 'renderedPlaceholdersNew: only removes');
  return kept;
}

// A rendered finding moved onto a node of a file names that node's own tag (a component
// instance, not the element it renders), so its occurrence reads as the Navigator does.
function retagged(finding: AuditFinding, inputs: ReadonlyMap<string, AuditFileInput>): AuditFinding {
  const element = finding.element;
  const file = inputs.get(finding.file);
  if (element === undefined || file === undefined || finding.source !== 'rendered' || !finding.check.startsWith('placeholder-')) {
    return finding;
  }
  const node = nodeAt(file.nodes, element.path);
  if (node === undefined || (node.kind !== 'element' && node.kind !== 'component')) {
    return finding;
  }
  assert(node.name.length > 0, 'retagged: a tag has a name');
  return node.name === element.tag ? finding : { ...finding, element: { ...element, tag: node.name } };
}

/** Heading components and the prop they take their level by: a component named like a heading whose props include a tag prop. */
export function headingComponents(scan: ScanResult): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const component of scan.components) {
    const prop = component.schema?.find((field) => HEADING_TAG_PROPS.includes(field.name));
    if (prop !== undefined && /heading|title/i.test(component.name)) {
      found.set(component.name, prop.name);
    }
  }
  return found;
}

// A rendered finding gains the fix only its source file can plan: a per-instance id in a
// component, or the page's most prominent heading component made an h1.
function repaired(finding: AuditFinding, inputs: ReadonlyMap<string, AuditFileInput>, headings: ReadonlyMap<string, string>): AuditFinding {
  const input = inputs.get(finding.file);
  if (input === undefined || finding.fix !== undefined) {
    return finding;
  }
  if (finding.check === 'duplicate-id' && finding.element !== undefined) {
    const fix = instanceIdFix(input, finding.element.path, /id="([^"]+)"/.exec(finding.detail)?.[1]);
    return fix === undefined ? finding : { ...finding, fix };
  }
  if (finding.check === 'h1-count' && finding.element === undefined && input.kind === 'page' && headings.size > 0) {
    const fix = headingPromotionFix(input, headings);
    return fix === undefined ? finding : { ...finding, fix };
  }
  return finding;
}

// One page's rendered checks, reused from the cache when its HTML and phrases are the same as last time.
async function renderedAudit(
  input: AuditRunInput,
  page: { readonly file: string; readonly route: string; readonly html: string },
  facts: AuditFacts,
  io: AuditIO,
): Promise<ReturnType<typeof auditRenderedPage> | undefined> {
  const placeholders = `${facts.placeholders.join('\n')}\n|${facts.noindexRoutes.join('\n')}`;
  const key = `${page.file}\n${page.route}`;
  const cached = input.cache?.rendered.get(key);
  if (cached !== undefined && cached.html === page.html && cached.placeholders === placeholders) {
    return cached.audit;
  }
  const root = await io.tree(page.html, page.file, page.route, { styled: false });
  if (root.tag !== 'html') {
    return undefined;
  }
  const audit = auditRenderedPage({ file: page.file, route: page.route, root }, { noindexRoutes: facts.noindexRoutes, placeholders: facts.placeholders });
  if (input.cache !== undefined) {
    remember(input.cache.rendered, key, { html: page.html, placeholders, audit });
  }
  return audit;
}

// Contrast, from the page laid out in a frame: only its contrast findings are kept.
async function contrastFindings(
  html: string,
  page: { readonly file: string; readonly route: string },
  facts: AuditFacts,
  io: AuditIO,
): Promise<readonly AuditFinding[]> {
  const styled = await io.tree(html, page.file, page.route, { styled: true });
  if (styled.tag !== 'html') {
    return [];
  }
  return auditRenderedPage({ ...page, root: styled }, { noindexRoutes: facts.noindexRoutes, placeholders: [] }).findings.filter(
    (finding) => finding.check === 'contrast',
  );
}

// Whether the site makes a sitemap (or robots.txt): the dev server's answer first, then a public
// file, an endpoint under src/pages, or an integration in the config.
async function siteFileMade(kind: 'sitemap' | 'robots', configText: string | undefined, facts: AuditFacts, io: AuditIO): Promise<boolean> {
  const render = io.renderPage;
  if (render !== undefined) {
    for (const url of SITE_FILE_URLS[kind]) {
      const served = await render(url).catch((): RenderedHtml => ({ ok: false, message: '' }));
      if (served.ok && served.status < 400) {
        return true;
      }
    }
  }
  if (SITE_FILE_URLS[kind].some((url) => facts.publicFiles.has(url))) {
    return true;
  }
  for (const rel of SITE_FILE_ENDPOINTS[kind]) {
    if ((await io.readText(rel).catch(() => undefined)) !== undefined) {
      return true;
    }
  }
  return configText !== undefined && configMakes(configText, kind);
}

/** Head values traced to where they are written, and the attribute that holds each (none: the element's text). */
const TRACED: ReadonlyMap<AuditFinding['check'], string | undefined> = new Map<AuditFinding['check'], string | undefined>([
  ['description-short', 'content'],
  ['description-long', 'content'],
  ['canonical', 'href'],
  ['noindex', 'content'],
  ['title-missing', undefined],
  ['placeholder-text', undefined],
  ['placeholder-image', 'src'],
]);
const CONSTANT_EXTENSIONS = ['.ts', '.js', '.mjs', ''] as const;

// A rendered head finding moved to where its value is written: the page's instance with the
// prop to edit, a component's default, or the constants file. Presence was decided by the
// rendered head; this only says where to go.
async function relocated(
  finding: AuditFinding,
  context: { readonly pageFile: string; readonly inputs: ReadonlyMap<string, AuditFileInput>; readonly input: AuditRunInput; readonly io: AuditIO },
): Promise<AuditFinding> {
  const element = finding.element;
  const page = context.inputs.get(context.pageFile);
  if (!TRACED.has(finding.check) || element === undefined || page === undefined) {
    return finding;
  }
  const authored = traceAuthored({
    page,
    files: context.inputs,
    resolve: (from, tag) => {
      const decl = from.imports.find((entry) => entry.name === tag);
      return decl === undefined ? undefined : importedTargets([decl], context.input.projectPath, context.input.scan)[0]?.file;
    },
    leaf: { file: finding.file, path: element.path, attr: TRACED.get(finding.check) },
  });
  const base = {
    check: finding.check,
    detail: finding.detail,
    source: finding.source,
    fix: finding.fix,
    ...(finding.excerpt === undefined ? {} : { excerpt: finding.excerpt }),
    ...(finding.measure === undefined ? {} : { measure: finding.measure }),
  };
  switch (authored?.kind) {
    case undefined:
      return finding;
    case 'node':
      return auditFinding({
        ...base,
        file: authored.file,
        fileKind: authored.file === context.pageFile ? 'page' : authored.file.includes('/layouts/') ? 'layout' : 'component',
        element: { path: authored.path, tag: authored.tag, line: undefined },
        ...(authored.prop === undefined ? {} : { prop: authored.prop }),
        ...(authored.file === context.pageFile || finding.routes === undefined ? {} : { routes: finding.routes }),
      });
    case 'file':
      return auditFinding({
        ...base,
        file: authored.file,
        fileKind: 'component',
        element: undefined,
        ...(finding.routes === undefined ? {} : { routes: finding.routes }),
      });
    case 'constant': {
      const file = await constantFile(authored.module, authored.from, context.io);
      return file === undefined
        ? finding
        : auditFinding({ ...base, file, fileKind: 'site', element: undefined, detail: `${finding.detail} (${authored.name})` });
    }
    default: {
      const exhaustive: never = authored;
      return exhaustive;
    }
  }
}

/** The project file a module spec names: `@/consts` or `~/consts` under src, or relative to the importing file. */
async function constantFile(module: string, from: string, io: AuditIO): Promise<string | undefined> {
  const base = /^[@~]\//.test(module)
    ? `src/${module.slice(2)}`
    : module.startsWith('.')
      ? normalized(`${from.split('/').slice(0, -1).join('/')}/${module}`)
      : undefined;
  if (base === undefined) {
    return undefined;
  }
  for (const extension of CONSTANT_EXTENSIONS) {
    if ((await io.readText(`${base}${extension}`).catch(() => undefined)) !== undefined) {
      return `${base}${extension}`;
    }
  }
  return undefined;
}

function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Stylesheets one run lints, and the bytes of each it reads. */
const STYLESHEETS_MAX = 200;
const STYLESHEET_CHARS_MAX = 2_000_000;

// The project's own stylesheets through the token rules: a finding per raw value, with "Use
// variable" when a variable holds exactly that value. Only the value is ever swapped.
async function stylesheetFindings(input: AuditRunInput, facts: AuditFacts, io: AuditIO): Promise<readonly AuditFinding[]> {
  const files = (await io.styleFiles().catch(() => []))
    .filter((entry) => !/(^|\/)(node_modules|dist|\.astro|\.stacki)\//.test(entry.rel))
    .slice(0, STYLESHEETS_MAX);
  const findings: AuditFinding[] = [];
  for (const entry of files) {
    const text = await io.readStyle(entry.path).catch(() => undefined);
    if (text === undefined || text.length > STYLESHEET_CHARS_MAX) {
      continue;
    }
    const lines = lineStarts(text);
    for (const issue of lintCss(text, facts.tokens).slice(0, AUDIT_LIMITS.findingsPerFileMax)) {
      const fixes = variablesFor(issue.token, facts.variables).map((name) => ({
        label: `Use var(${name})`,
        before: `${issue.property}: ${issue.value};`,
        after: `${issue.property}: ${swapped(issue, name)};`,
        file: entry.rel,
        edits: [{ tag: 'file-text' as const, offset: issue.offset, before: issue.token, after: `var(${name})` }],
      }));
      const [first] = fixes;
      findings.push(
        auditFinding({
          check: issue.kind,
          file: entry.rel,
          fileKind: 'site',
          element: undefined,
          detail: `${issue.selector} { ${issue.property}: ${issue.token} }`,
          css: {
            selector: issue.selector,
            property: issue.property,
            value: issue.value,
            token: issue.token,
            line: lineOf(lines, issue.offset),
            group: tokenGroup(issue),
          },
          source: 'static',
          fix: first,
          ...(fixes.length > 1 ? { choices: fixes } : {}),
        }),
      );
    }
  }
  assert(input.projectPath.length > 0, 'stylesheetFindings: a project');
  return findings;
}

// The launch checklist's facts: what the rendered pages link and run, the public folder, the pages, the config.
async function launchFacts(
  input: AuditRunInput,
  pages: readonly SitePage[],
  configText: string | undefined,
  facts: AuditFacts,
): Promise<{ readonly favicon: boolean; readonly notFound: boolean; readonly analytics: boolean; readonly headFile: string }> {
  const rendered = pages.filter((page) => page.icon !== undefined);
  const favicon =
    rendered.some((page) => page.icon === true) ||
    [...facts.publicFiles.keys()].some((url) => /^\/(favicon|icon|apple-touch-icon)[^/]*\.(ico|svg|png)$/i.test(url));
  const notFound = input.scan.pages.some((page) => page.route === '/404' || /(^|\/)404\.(astro|md|mdx|html)$/.test(page.name));
  const analytics = rendered.some((page) => page.analytics === true) || (configText !== undefined && configHasAnalytics(configText));
  const layout = input.scan.layouts[0];
  const headFile = layout === undefined ? (input.scan.astroConfig ?? 'src') : relativeTo(input.projectPath, layout.path);
  assert(headFile.length > 0, 'launchFacts: a place to fix it');
  return { favicon, notFound, analytics, headFile };
}

function socialFinding(file: string, route: string, element: RenderedNodeElement, url: string): AuditFinding {
  return auditFinding({
    check: 'launch-social-image',
    file: element.source?.file ?? file,
    fileKind: element.source === undefined || element.source.file === file ? 'page' : 'component',
    element: element.source === undefined ? undefined : { path: element.source.path, tag: element.tag, line: undefined },
    detail: `${url} does not load (on ${route})`,
    source: 'rendered',
    fix: undefined,
  });
}

// A page with no social image, and a social image that does not load: the dev server is asked for it.
async function socialImageFindings(pages: readonly SitePage[], io: AuditIO): Promise<readonly AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const checked = new Map<string, boolean>();
  for (const page of pages) {
    if (page.icon === undefined) {
      continue; // Not rendered: nothing to judge.
    }
    if (page.socialImage === undefined) {
      findings.push(
        auditFinding({
          check: 'launch-social-image',
          file: page.file,
          fileKind: 'page',
          element: undefined,
          detail: `No og:image on ${page.route}`,
          source: 'rendered',
          fix: undefined,
        }),
      );
      continue;
    }
    const path = localImagePath(page.socialImage.url);
    if (path === undefined || io.renderPage === undefined) {
      continue; // On another origin: not this site's to serve.
    }
    if (!checked.has(path)) {
      const answer = await io.renderPage(path).catch((): RenderedHtml => ({ ok: false, message: '' }));
      checked.set(path, answer.ok && answer.status < 400);
    }
    if (checked.get(path) === false) {
      findings.push(page.socialImage.finding);
    }
  }
  return findings;
}

/** The site path a social image names: a relative path, or the path of an absolute URL (its production origin is this site). */
function localImagePath(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'http://site.invalid');
    return parsed.pathname.startsWith('/') ? parsed.pathname : undefined;
  } catch {
    return undefined;
  }
}

// The project's settings over the findings: checks turned off are dropped, re-prioritised ones carry their priority.
function configured(findings: readonly AuditFinding[], settings: AuditFile): readonly AuditFinding[] {
  const kept = findings.filter((finding) => settings.checks[finding.check]?.enabled !== false);
  return kept.map((finding) => {
    const priority = settings.checks[finding.check]?.priority;
    return priority === undefined ? finding : { ...finding, priority };
  });
}
