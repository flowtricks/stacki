// What creating a page template will do to a project, and doing it. The plan is
// computed from the disk each time, so what the form shows and what is written
// come from one place; the renderer sends a draft, never file text.

import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import {
  parseTemplateRoute,
  type DataSource,
  type EnvStatus,
  type PageTemplateChange,
  type PageTemplateDraft,
  type PageTemplatePlan,
  type RouteParts,
} from '../../shared/properties/pageTemplate';
import { createProjectText } from '../documents/documentWrites';
import { cmsSourcePath } from '../lib/contentPaths';
import { toPosix } from '../lib/mainHelpers';
import { CONTENT_CONFIG_PATH, addCollectionToConfig, createAstroCollection } from './astroCollectionConfig';
import { configPathOf } from './contentConfig';
import { headingField, pageTemplateText, type CollectionFacts } from './pageTemplateSource';

/** What a template needs to know of the content config. */
export interface TemplateConfig {
  readonly error?: string;
  readonly collections: readonly {
    readonly name: string;
    readonly schema?: unknown;
    readonly hasBody?: boolean;
  }[];
}

export interface PageTemplateHost {
  readonly projectPath: string;
  readonly readConfig: () => Promise<TemplateConfig>;
  /** The project's env variables (projectEnv.ts). */
  readonly env: ReadonlyMap<string, string>;
}

const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'] as const;
const FIRST_ENTRY_NAME = 'first-entry.md';
const FIRST_ENTRY_TEXT = '---\ntitle: First entry\n---\n\nWrite this entry in the CMS panel.\n';

export async function planPageTemplate(draft: PageTemplateDraft, host: PageTemplateHost): Promise<PageTemplatePlan> {
  const route = routeOf(draft.route);
  const pageRel = `src/pages/${route.file}`;
  refuseTakenRoute(host.projectPath, route);
  const collection = await collectionPlan(draft.source, host);
  const text = pageTemplateText({
    route,
    source: draft.source,
    layout: layoutOf(draft, host.projectPath, pageRel),
    collection: collection?.facts,
    prerender: serverOutput(host.projectPath) ? 'explicit' : 'inherited',
  });
  const changes: readonly PageTemplateChange[] = [{ path: pageRel, action: 'create', text }, ...(collection?.changes ?? [])];
  assert(changes.length > 0, 'A plan writes the page');
  return { route: draft.route, changes, env: envStatus(draft.source, host.env) };
}

/** Writes what the plan says: the collection first, the page last, so the page never names a missing collection. */
export async function applyPageTemplate(draft: PageTemplateDraft, host: PageTemplateHost): Promise<{ readonly pagePath: string }> {
  const plan = await planPageTemplate(draft, host);
  const [page, , firstEntry] = plan.changes;
  assert(page !== undefined, 'A plan leads with the page');
  const { source } = draft;
  if (source.kind === 'content-collection') {
    if (source.origin === 'new') {
      assert(firstEntry !== undefined, 'A new collection is planned with its first entry');
      createAstroCollection(host.projectPath, source.collection);
      createProjectText(cmsSourcePath(host.projectPath, firstEntry.path), firstEntry.text);
    }
  }
  const pagePath = path.join(host.projectPath, ...page.path.split('/'));
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  createProjectText(pagePath, page.text);
  assert(fs.existsSync(pagePath), 'A created template exists');
  return { pagePath };
}

function routeOf(input: string): RouteParts {
  const route = parseTemplateRoute(input);
  assert(route.ok, 'A route was parsed at the boundary');
  return route.value;
}

// One file per URL pattern: a second dynamic page in a folder would answer the
// same URLs, and Astro would pick between them by a rule nobody sees here.
function refuseTakenRoute(projectPath: string, route: RouteParts): void {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  const target = path.join(pagesDirectory, ...route.file.split('/'));
  if (fs.existsSync(target)) {
    throw new Error(`A page already exists at src/pages/${route.file}.`);
  }
  const folder = path.dirname(target);
  const names = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  const sibling = names.find((name) => /^\[.*\]\.(?:astro|mdx?|ts|js)$/.test(name));
  if (sibling !== undefined) {
    throw new Error(`${sibling} in that folder already generates these URLs. Choose another route.`);
  }
}

function layoutOf(draft: PageTemplateDraft, projectPath: string, pageRel: string) {
  const layout = draft.layout;
  if (layout === undefined) {
    return undefined;
  }
  const relative = toPosix(path.relative(path.dirname(path.join(projectPath, pageRel)), layout.path));
  return { name: layout.name, importPath: relative.startsWith('.') ? relative : `./${relative}` };
}

function serverOutput(projectPath: string): boolean {
  for (const name of ASTRO_CONFIG_FILES) {
    const file = path.join(projectPath, name);
    if (fs.existsSync(file)) {
      return /\boutput\s*:\s*['"]server['"]/.test(fs.readFileSync(file, 'utf8'));
    }
  }
  return false;
}

interface CollectionPlan {
  readonly facts: CollectionFacts;
  readonly changes: readonly PageTemplateChange[];
}

async function collectionPlan(source: DataSource, host: PageTemplateHost): Promise<CollectionPlan | undefined> {
  if (source.kind !== 'content-collection') {
    return undefined;
  }
  const config = await host.readConfig();
  if (config.error !== undefined) {
    throw new Error(config.error);
  }
  const found = config.collections.find((collection) => collection.name === source.collection);
  const api = astroMajor(host.projectPath) < 5 ? 'legacy' : 'current';
  if (source.origin === 'new') {
    if (found !== undefined) {
      throw new Error(`A collection named “${source.collection}” already exists.`);
    }
    return { facts: { body: 'rendered', heading: 'title', api }, changes: newCollectionChanges(host.projectPath, source.collection) };
  }
  if (found === undefined) {
    throw new Error(`The content config has no collection named “${source.collection}”.`);
  }
  const fields = Object.keys(toRecord(toRecord(found.schema)?.['properties']) ?? {});
  if (source.slug.kind === 'field') {
    if (!fields.includes(source.slug.name)) {
      throw new Error(`The collection “${source.collection}” has no field named “${source.slug.name}”.`);
    }
  }
  return { facts: { body: found.hasBody === true ? 'rendered' : 'none', heading: headingField(fields), api }, changes: [] };
}

function newCollectionChanges(projectPath: string, name: string): readonly PageTemplateChange[] {
  const located = configPathOf(projectPath);
  const rel = located?.rel ?? CONTENT_CONFIG_PATH;
  const before = located === undefined ? undefined : fs.readFileSync(cmsSourcePath(projectPath, rel), 'utf8');
  const patch = addCollectionToConfig(before, name);
  if (!patch.ok) {
    throw new Error(patch.error);
  }
  return [
    { path: rel, action: before === undefined ? 'create' : 'edit', text: patch.value.text },
    { path: `${patch.value.folder}/${FIRST_ENTRY_NAME}`, action: 'create', text: FIRST_ENTRY_TEXT },
  ];
}

// The installed Astro's major version; the current API when it cannot be read,
// since Stacki's own new content configs already need it.
function astroMajor(projectPath: string): number {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(projectPath, 'node_modules', 'astro', 'package.json'), 'utf8'));
    const version = toRecord(manifest)?.['version'];
    const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
    return Number.isSafeInteger(major) ? major : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function envStatus(source: DataSource, env: ReadonlyMap<string, string>): readonly EnvStatus[] {
  return envNames(source).map((name) => ({ name, state: (env.get(name) ?? '').length > 0 ? 'set' : 'missing' }));
}

function envNames(source: DataSource): readonly string[] {
  switch (source.kind) {
    case 'content-collection':
      return [];
    case 'sanity':
      return source.tokenEnv === undefined ? [] : [source.tokenEnv];
    case 'http-json':
      return [...new Set(source.headers.map((header) => header.env))];
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
