// i18n-ignore-file: the bake is the `astro-studio build-demo` command line tool; its messages are developer diagnostics in a terminal, not Studio interface text.
// `astro-studio build-demo`: builds a project into a static site Studio can edit
// with no server. It runs the project's own `astro build` with markers and section
// fences added in memory, so no project file changes, and writes the snapshot the
// browser answers Studio's requests from. Scanning is Studio's own, not a copy.
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { METADATA_FILES } from '../../../vendor/stacki/shared/properties/projectMetadata';
import { assetCatalog } from '../assets/assetCatalog';
import { scanProjectVariables } from '../variables/variableServer';
import { scanProject, walk } from '../project/projectServer';
import { routeFor } from '../project/projectClient';
import { MAX_SOURCE, sourcePath } from '../../shared/validation';
import { astroEntry, runBuild, type BakeError, type BuildRequest } from './bakeBuild';
import { bakePage } from './bakeHtml';
import { componentProbePlan } from './bakeComponents';
import { isTemplateRoute, matchTemplateRoute } from '../pages/templateRoutes';
import { extractEntryProps, templateEntryPages, type TemplateEntryPages, type TemplateOutput } from './bakeTemplates';
import { contentEntries, contentFieldPages, type BakedContent } from './bakeContent';
import { escapeHTML } from './componentTemplates';
import { CatalogBuilder, extractProbes, type ProbePlan } from './bakeProbes';
import { BAKE_PROTOCOL, BAKE_RUNTIME_DIRECTORY, BAKE_SNAPSHOT_FILE, splitStyleSections } from './bakeProtocol';
import { BAKE_LIMITS, parseBakeSnapshot, type BakePage, type BakeSection, type BakeSnapshot } from './bakeSnapshot';

export interface BakeOptions {
  /** The Astro project, absolute. */
  readonly root: string;
  /** Where the baked site goes, absolute. It must be empty or an earlier bake. */
  readonly out: string;
  /** The URL prefix the site is served under, with leading and trailing slashes. */
  readonly base: string;
  /** The folder holding `morph.js` and `preview-static.js`. */
  readonly runtime: string;
  readonly studioVersion: string;
}

export type { BakeError } from './bakeBuild';

export interface BakeReport {
  readonly pages: readonly string[];
  readonly sections: number;
  readonly snapshotBytes: number;
  /** Component templates baked: what renders component edits without Astro. */
  readonly templates: number;
  /** Why the build ran again without component probes, when it had to. */
  readonly probeFailure: string | undefined;
  /** Template entries past BAKE_LIMITS.templateEntriesMax, left on the site as built. */
  readonly templateEntriesDropped: number;
}

interface BuildProbes {
  readonly plan: ProbePlan;
  /** Each recipe page's route and the file Astro compiles it from. */
  readonly recipes: ReadonlyMap<string, string>;
}

function buildRequest(options: BakeOptions, probes: BuildProbes | undefined, outDir: string): BuildRequest {
  return {
    root: options.root,
    base: options.base,
    outDir,
    probes: [...(probes?.plan.pages ?? [])].map(([file, page]) => [file, page.markup] as const),
    recipes: [...(probes?.recipes ?? [])].map(([pattern, entrypoint]) => ({ pattern, entrypoint })),
    content: outDir === options.out,
  };
}

export async function bakeSite(options: BakeOptions): Promise<Result<BakeReport, BakeError>> {
  assert(path.isAbsolute(options.root), 'The project path is absolute');
  assert(path.isAbsolute(options.out), 'The output path is absolute');
  assert(path.isAbsolute(options.runtime), 'The runtime path is absolute');
  if (!/^\/([\w-]+\/)*$/.test(options.base)) {
    return err({ code: 'invalid-base', message: `The base must look like /demo/site/, not ${options.base}` });
  }
  const prepared = await prepareOutput(options.out);
  if (!prepared.ok) {
    return prepared;
  }
  const astro = astroEntry(options.root);
  if (!astro.ok) {
    return astro;
  }
  // Component probes are an extra the site does not need to bake. A component that
  // throws for a probe's values fails the whole build, so the build runs again without
  // the page that failed, a bounded number of times, and last without any probes.
  const { planned, failure: planFailure } = await planComponentProbes(options.root, componentProbePlan);
  const pageProbes = planned === undefined ? undefined : { plan: planned.plan, recipes: new Map<string, string>() };
  const main = await buildWithProbes(options, pageProbes, options.out);
  if (!main.ok) {
    return main;
  }
  const recipes = planned === undefined ? undefined : await buildRecipes(options, planned.plan, planned.recipePages);
  return finishBake(
    options,
    main.value.probes,
    [planFailure, main.value.failure, recipes?.failure].filter((failure) => failure !== undefined).join('; ') || undefined,
    recipes,
    main.value.content,
    main.value.templates,
  );
}

/** The probe plan, or why there is none. Planning is the bake's own code, not the
 * site's: a failure there is a bug, so it is logged and reported, never mistaken for a
 * site with no components (an empty catalog locks every prop in the demo). */
export async function planComponentProbes<T>(
  root: string,
  plan: (root: string) => Promise<T>,
): Promise<{ readonly planned: T | undefined; readonly failure: string | undefined }> {
  try {
    return { planned: await plan(root), failure: undefined };
  } catch (error: unknown) {
    const failure = `planning component probes failed: ${String(error)}`;
    console.error(`[stacki bake] ${failure}`);
    return { planned: undefined, failure };
  }
}

interface ProbedBuild {
  readonly probes: BuildProbes | undefined;
  readonly failure: string | undefined;
  readonly content: BakedContent | undefined;
  readonly templates: readonly TemplateOutput[];
}

async function buildWithProbes(options: BakeOptions, initial: BuildProbes | undefined, outDir: string): Promise<Result<ProbedBuild, BakeError>> {
  let probes = initial;
  let failure: string | undefined;
  for (let attempt = 0; attempt <= PROBE_RETRIES_MAX; attempt++) {
    if (attempt === PROBE_RETRIES_MAX) {
      probes = undefined; // The last attempt is the plain build.
    }
    const built = await runBuild(buildRequest(options, probes, outDir));
    if (built.ok) {
      return ok({ probes, failure, content: built.value.content, templates: built.value.templates });
    }
    if (probes === undefined) {
      return built;
    }
    failure = built.error.message;
    // Said out loud: a bake that quietly loses its probes ships a demo that refuses
    // every component prop edit, and the site's build log is the one place to see why.
    console.error(`[stacki bake] the build with component probes failed: ${failure}`);
    probes = withoutFailedPage(probes, built.error.message);
    await rm(outDir, { recursive: true, force: true });
  }
  return err({ code: 'build-failed', message: failure ?? 'astro build failed' });
}

/** What the recipe build adds to the bake. */
export interface RecipeBuild {
  readonly outputs: ReadonlyMap<string, ReadonlyMap<number, string>>;
  readonly stylesheets: readonly string[];
  readonly failure: string | undefined;
}

// Recipes no page imports render in a build of their own, so the pages the visitor sees
// come from a build that never heard of them: an extra page changes how Vite splits
// the shared stylesheets, and with it the order of every page's styles. The files the
// recipes load (images, fonts) are copied across; their pages are not.
async function buildRecipes(options: BakeOptions, plan: ProbePlan, pages: ReadonlyMap<string, string>): Promise<RecipeBuild | undefined> {
  if (pages.size === 0) {
    return undefined;
  }
  const folder = path.join(options.root, 'node_modules', '.stacki-bake');
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'stacki-recipes-'));
  try {
    const written = await writeRecipePages(folder, { ...plan, pages: new Map([...plan.pages].filter(([page]) => pages.has(page))) }, pages);
    const built = await buildWithProbes(options, written, outDir);
    const probes = built.ok ? built.value.probes : undefined;
    const outputs = new Map<string, ReadonlyMap<number, string>>();
    for (const route of probes?.recipes.keys() ?? []) {
      const html = await readFile(path.join(outDir, route.slice(1), 'index.html'), 'utf8').catch(() => undefined);
      if (html !== undefined) {
        outputs.set(route, extractProbes(html).outputs);
      }
    }
    const stylesheets: string[] = [];
    const assets = path.join(outDir, '_astro');
    for (const name of await readdir(assets).catch(() => [])) {
      if (name.endsWith('.css')) {
        stylesheets.push(await readFile(path.join(assets, name), 'utf8'));
      }
    }
    // Never over a file the site's own build wrote: same name, same hashed content.
    await cp(assets, path.join(options.out, '_astro'), { recursive: true, force: false, filter: (source) => !source.endsWith('.css') }).catch(() => undefined);
    return { outputs, stylesheets, failure: built.ok ? built.value.failure : built.error.message };
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
}

const PROBE_RETRIES_MAX = 4;

// Astro compiles a recipe page like any other, so it sits where `astro` resolves from:
// the project's own node_modules, in a folder only the bake writes and removes.
async function writeRecipePages(folder: string, plan: ProbePlan, pages: ReadonlyMap<string, string>): Promise<BuildProbes> {
  const recipes = new Map<string, string>();
  for (const [route, source] of pages) {
    const file = path.join(folder, `recipe-${recipes.size}.astro`);
    await mkdir(folder, { recursive: true });
    await writeFile(file, source);
    recipes.set(route, file);
  }
  return { plan, recipes };
}

/** The probes without the page Astro names in its failure, or none when it names none. */
function withoutFailedPage(probes: BuildProbes, message: string): BuildProbes | undefined {
  const route = /rendering (\/\S*?):? /.exec(message)?.[1]?.replace(/\/$/, '');
  if (route === undefined) {
    return undefined;
  }
  const recipes = new Map([...probes.recipes].filter(([pattern]) => pattern !== route));
  const pages = new Map(
    [...probes.plan.pages].filter(([page]) => {
      const pattern = routeFor(page).replace(/\/$/, '') || '/';
      // A template's pages are its entries: the failure names one of them.
      const entry = isTemplateRoute(pattern) && matchTemplateRoute(pattern, route === '' ? '/' : route) !== undefined;
      return page !== route && pattern !== route && !entry;
    }),
  );
  if (recipes.size === probes.recipes.size && pages.size === probes.plan.pages.size) {
    return undefined; // The failure is not a probe page's: probes were not the cause.
  }
  return { plan: { ...probes.plan, pages }, recipes };
}

async function finishBake(
  options: BakeOptions,
  probes: BuildProbes | undefined,
  probeFailure: string | undefined,
  recipes: RecipeBuild | undefined,
  content: BakedContent | undefined,
  templates: readonly TemplateOutput[] = [],
): Promise<Result<BakeReport, BakeError>> {
  const plan = probes?.plan;
  const scan = await scanProject(options.root);
  const fixed = await bakedPages(options.out, scan.pages);
  // Each template entry is a page of its own that shares the template's file (bakeTemplates.ts).
  const entries = await templateEntryPagesIn(options.out, templates, fixed);
  const pages = [...fixed, ...entries.pages];
  if (pages.length === 0) {
    return err({ code: 'no-pages', message: 'The build produced no pages this bake can edit' });
  }
  if (pages.length > BAKE_LIMITS.pagesMax) {
    return err({ code: 'too-many-pages', message: `The site has ${pages.length} pages; a bake holds at most ${BAKE_LIMITS.pagesMax}` });
  }
  const catalog = new CatalogBuilder();
  const styles = await bakeDocuments(options, pages, (page, outputs) => {
    // A template's entries share its file. Its shared probes render with one entry, its
    // per-entry probes with each (bakeProbes.ts onceGuard).
    if (plan !== undefined && outputs.size > 0) {
      catalog.add(plan, page.file, outputs, page.entry === undefined ? undefined : page.document);
    }
  });
  for (const [route, outputs] of recipes?.outputs ?? []) {
    if (plan !== undefined) {
      catalog.add(plan, route, outputs);
    }
  }
  for (const css of recipes?.stylesheets ?? []) {
    for (const piece of splitStyleSections(css)) {
      if (piece.section !== undefined && !styles.compiled.has(piece.section)) {
        styles.compiled.set(piece.section, piece.css);
      }
    }
  }
  await pruneOutput(options.out, pages);
  const sources = await readSources(options.root, content === undefined ? [] : contentEntries(content).map((entry) => entry.file));
  if (!sources.ok) {
    return sources;
  }
  const runtime = path.join(options.out, BAKE_RUNTIME_DIRECTORY);
  await mkdir(runtime, { recursive: true });
  await copyFile(path.join(options.runtime, 'morph.js'), path.join(runtime, 'morph.js'));
  await copyFile(path.join(options.runtime, 'preview-static.js'), path.join(runtime, 'preview.js'));
  const body = {
    protocol: BAKE_PROTOCOL,
    studioVersion: options.studioVersion,
    base: options.base,
    project: bakedProject(scan, pages),
    assets: await assetCatalog(options.root),
    variables: await scanProjectVariables(options.root),
    sources: sources.value,
    pages,
    sections: bakeSections(styles, sources.value),
    components: catalog.catalog(),
    ...(content === undefined ? {} : { content: { ...content, fields: contentFieldPages(content, await pageTexts(options.out, pages), escapeHTML) } }),
  };
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
  const text = JSON.stringify({ ...body, id });
  if (text.length > BAKE_LIMITS.snapshotBytesMax) {
    return err({ code: 'snapshot-too-large', message: `The snapshot is ${text.length} bytes; the limit is ${BAKE_LIMITS.snapshotBytesMax}` });
  }
  // Read back with the browser's parser, so a snapshot it would refuse never ships.
  const snapshot: BakeSnapshot = parseBakeSnapshot(text);
  assert(snapshot.pages.length === pages.length, 'The snapshot keeps every baked page');
  await writeFile(path.join(runtime, BAKE_SNAPSHOT_FILE), text);
  return ok({
    pages: pages.map((page) => page.file),
    sections: snapshot.sections.length,
    snapshotBytes: text.length,
    templates: snapshot.components.templates.length,
    probeFailure,
    templateEntriesDropped: entries.dropped,
  });
}

/** Only what was baked is offered: a listed page with no document could not open. */
function bakedProject(scan: Awaited<ReturnType<typeof scanProject>>, pages: readonly BakePage[]) {
  const files = new Set(pages.map((page) => page.file));
  return {
    ...scan,
    pages: scan.pages.filter((file) => files.has(file)),
    pageMetadata: scan.pageMetadata.filter((page) => files.has(page.path)),
    pageFolders: [],
    collections: [],
  };
}

async function prepareOutput(out: string): Promise<Result<true, BakeError>> {
  const entries = await readdir(out).catch(() => []);
  if (entries.length === 0) {
    return ok(true);
  }
  // Removing a folder is only safe when it is provably a bake. Anything else is
  // someone's work, and the build would otherwise empty it.
  const earlier = await stat(path.join(out, BAKE_RUNTIME_DIRECTORY, BAKE_SNAPSHOT_FILE)).then(
    () => true,
    () => false,
  );
  if (!earlier) {
    return err({ code: 'output-not-empty', message: `${out} is not empty and is not an earlier bake` });
  }
  await rm(out, { recursive: true });
  return ok(true);
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (information) => information.isFile(),
    () => false,
  );
}

/** Pages with one fixed document. A dynamic route has no single file to open. */
async function bakedPages(out: string, files: readonly string[]): Promise<readonly BakePage[]> {
  const pages: BakePage[] = [];
  for (const file of files) {
    if (file.endsWith('.astro') && !file.includes('[')) {
      const route = routeFor(file);
      const directory = route === '/' ? 'index.html' : `${route.slice(1)}/index.html`;
      const flat = route === '/' ? 'index.html' : `${route.slice(1)}.html`;
      for (const document of [directory, flat]) {
        // A page that renders only a redirect (`Astro.redirect`) has no head and nothing
        // to edit; it stays on the site as built, and the editor never opens it.
        if ((await fileExists(path.join(out, document))) && isEditablePage(await readFile(path.join(out, document), 'utf8'))) {
          pages.push({ file, route, document });
          break;
        }
      }
    }
  }
  return pages;
}

async function templateEntryPagesIn(out: string, templates: readonly TemplateOutput[], fixed: readonly BakePage[]): Promise<TemplateEntryPages> {
  const editable = new Set<string>();
  const props = new Map<string, unknown>();
  for (const template of templates) {
    for (const document of template.documents) {
      const file = path.join(out, document);
      if (await fileExists(file)) {
        // Each entry rendered a sample of its props (bakeTemplates.ts): kept for the picker, cut from the page.
        const extracted = extractEntryProps(await readFile(file, 'utf8'));
        await writeFile(file, extracted.html);
        props.set(document, extracted.props);
        if (isEditablePage(extracted.html)) {
          editable.add(document);
        }
      }
    }
  }
  return templateEntryPages(
    templates,
    fixed,
    (document) => editable.has(document),
    (document) => props.get(document),
  );
}

function isEditablePage(html: string): boolean {
  return /<head\b/i.test(html) && html.includes('data-avb-p=');
}

/** A built redirect: kept as the site serves it, with no editor behind it. */
function isRedirectPage(html: string): boolean {
  return /<meta\s+http-equiv="refresh"/i.test(html) && !html.includes('data-avb-p=');
}

interface BakedStyles {
  /** Every section the builds compiled, the recipe build's included. */
  readonly compiled: Map<string, string>;
}

async function bakeDocuments(
  options: BakeOptions,
  pages: readonly BakePage[],
  probed: (page: BakePage, outputs: ReadonlyMap<number, string>) => void,
): Promise<BakedStyles> {
  const stylesheets = await readStylesheets(options);
  const compiled = new Map<string, string>();
  for (const css of stylesheets.values()) {
    for (const piece of splitStyleSections(css)) {
      if (piece.section !== undefined) {
        compiled.set(piece.section, piece.css);
      }
    }
  }
  for (const page of pages) {
    const file = path.join(options.out, page.document);
    const extracted = extractProbes(await readFile(file, 'utf8'));
    probed(page, extracted.outputs);
    const baked = bakePage(extracted.html, (href) => stylesheets.get(href));
    await writeFile(file, baked.html);
  }
  return { compiled };
}

async function readStylesheets(options: BakeOptions): Promise<ReadonlyMap<string, string>> {
  const directory = path.join(options.out, '_astro');
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.css'));
  const stylesheets = new Map<string, string>();
  for (const name of names) {
    stylesheets.set(`${options.base}_astro/${name}`, await readFile(path.join(directory, name), 'utf8'));
  }
  return stylesheets;
}

const AUTHORED_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;

function urlsIn(css: string): readonly string[] {
  return [...css.matchAll(AUTHORED_URL)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function authoredBlock(source: string, section: string): string {
  const [, index] = section.split('#');
  if (index === undefined) {
    return source;
  }
  const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  return blocks[Number(index)]?.[1] ?? '';
}

function bakeSections(styles: BakedStyles, sources: Readonly<Record<string, string>>): readonly BakeSection[] {
  const sections: BakeSection[] = [];
  for (const [id, css] of styles.compiled) {
    const file = id.split('#')[0] ?? id;
    const source = sources[file];
    if (source !== undefined) {
      const authored = urlsIn(authoredBlock(source, id));
      const built = urlsIn(css);
      // Paired by position: the build keeps authored order and rewrites only the text.
      const urls = authored.length === built.length ? Object.fromEntries(authored.map((url, index) => [url, built[index] ?? url])) : {};
      const scope = /\[data-astro-cid-([a-z0-9]+)\]/.exec(css)?.[1];
      sections.push({ id, file, scope, urls });
    }
  }
  return sections;
}

/** Each baked page's own markup, without the baseline copy of it at its end. */
async function pageTexts(out: string, pages: readonly BakePage[]): Promise<ReadonlyMap<string, string>> {
  const texts = new Map<string, string>();
  for (const page of pages) {
    const html = await readFile(path.join(out, page.document), 'utf8');
    const end = html.lastIndexOf('<script id="studio-render-baseline"');
    // A template's entries share its file: a field shows on the template if on any entry.
    texts.set(page.file, (texts.get(page.file) ?? '') + (end < 0 ? html : html.slice(0, end)));
  }
  return texts;
}

async function readSources(root: string, entryFiles: readonly string[]): Promise<Result<Readonly<Record<string, string>>, BakeError>> {
  // Content entries are rooms like any page: a Collections edit is a source edit.
  const entries = [...new Set(entryFiles)].filter((file) => file.startsWith('src/') && /\.(md|json|ya?ml)$/.test(file));
  const files = [...(await walk(root, 'src')).filter((file) => /\.(astro|css)$/.test(file)), ...entries];
  if (files.length > BAKE_LIMITS.sourceFilesMax) {
    return err({ code: 'too-many-sources', message: `The site has ${files.length} source files; a bake holds at most ${BAKE_LIMITS.sourceFilesMax}` });
  }
  const sources: Record<string, string> = {};
  for (const file of [...files, ...Object.values(METADATA_FILES)]) {
    const absolute = path.join(root, file);
    if (await fileExists(absolute)) {
      const text = await readFile(absolute, 'utf8');
      if (text.length > MAX_SOURCE) {
        return err({ code: 'source-too-large', message: `${file} exceeds the source limit` });
      }
      sources[sourcePath(file)] = text;
    }
  }
  return ok(sources);
}

/** Leaves the baked documents and the files they load. Feeds and unbaked pages would
 * otherwise sit at a public URL as a stale second copy of the site. */
async function pruneOutput(out: string, pages: readonly BakePage[]): Promise<void> {
  const kept = new Set(pages.map((page) => page.document));
  const queue = [''];
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const directory = queue[index] ?? '';
    for (const entry of await readdir(path.join(out, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(file);
      } else if (isPrunable(file, kept) && !(file.endsWith('.html') && isRedirectPage(await readFile(path.join(out, file), 'utf8')))) {
        await rm(path.join(out, file));
      }
    }
  }
}

function isPrunable(file: string, kept: ReadonlySet<string>): boolean {
  if (file.endsWith('.html')) {
    return !kept.has(file);
  }
  if (file.startsWith('_astro/')) {
    return file.endsWith('.css');
  }
  return /\.(txt|xml)$/.test(file) || file === 'search-index.json';
}
