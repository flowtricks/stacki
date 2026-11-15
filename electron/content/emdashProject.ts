// Finding out whether a project uses EmDash and what its content types are, from the project's own files.
// Reads only: the files EmDash itself writes (`package.json`, the Astro config, `src/live.config.ts`,
// `.emdash/schema.json` from `emdash types`, a seed file) and the local database, opened read-only
// (emdashDatabase.ts). The project is never changed, and no credential is read or needed.
//
// Detection is by what EmDash documents as its setup: the `emdash` package, the `emdash()` integration
// imported from `emdash/astro` in the Astro config, and the `_emdash` live collection registered with
// `emdashLoader()` in `src/live.config.ts`. A project with only some of these is reported with what is
// missing, so the settings card can say what to add.

import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import {
  EMDASH_LIMITS,
  headingFieldOf,
  isEmDashCollectionSlug,
  parseEmDashSchema,
  type EmDashCollection,
  type EmDashEntrySummary,
  type EmDashProblem,
  type EmDashProject,
  type EmDashSchemaSource,
} from '../../shared/properties/emdash';
import { isEmDashDatabase, readEmDashEntries, readEmDashSchemaRows } from './emdashDatabase';

const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'] as const;
const LIVE_CONFIG_FILES = ['src/live.config.ts', 'src/live.config.js', 'src/live.config.mjs', 'src/live.config.mts'] as const;
const SCHEMA_FILES = ['.emdash/schema.json'] as const;
const SEED_FILES = ['.emdash/seed.json', 'seed/seed.json'] as const;
const DEFAULT_DATABASE = './data.db';
const DEFAULT_UPLOADS = './uploads';
// Local Cloudflare development keeps a D1 database as a SQLite file under .wrangler; read only to find the
// registry table, so a project that does not use D1 is never affected.
const WRANGLER_DATABASE_FOLDER = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const WRANGLER_FILES_MAX = 16;
const FILE_BYTES_MAX = 4 * 1024 * 1024;

export async function detectEmDash(root: string): Promise<EmDashProject> {
  assert(path.isAbsolute(root), 'EmDash detection starts from an absolute project folder');
  const manifest = readJson(path.join(root, 'package.json'));
  const installed = declaresDependency(manifest);
  const config = readFirst(root, ASTRO_CONFIG_FILES);
  const live = readFirst(root, LIVE_CONFIG_FILES);
  const integration = config !== undefined && /\bemdash\s*\(/.test(config.text) && /['"]emdash\/astro['"]/.test(config.text);
  const liveCollection = live !== undefined && (/\bemdashLoader\b/.test(live.text) || /\b_emdash\b/.test(live.text));
  if (!installed && !integration && !liveCollection) {
    return { kind: 'absent' };
  }
  const problems: EmDashProblem[] = [];
  if (!installed) {
    problems.push('notInstalled');
  }
  if (!integration) {
    problems.push('noIntegration');
  }
  if (!liveCollection) {
    problems.push('noLiveCollection');
  }
  const output = outputOf(config?.text);
  if (output === 'static') {
    problems.push('staticOutput');
  }
  const database = await locateDatabase(root, config?.text);
  if (database === undefined) {
    problems.push('noDatabase');
  }
  problems.push(...ignoreProblems(root, config?.text, database));
  const schema = await readSchema(root, database, manifest);
  if (schema.problem !== undefined) {
    problems.push(schema.problem);
  }
  const collections = schema.collections;
  assert(collections.length <= EMDASH_LIMITS.collectionsMax, 'The collections read stay within the limit');
  assert(problems.length <= EMDASH_LIMITS.problemsMax, 'The problems named stay within the limit');
  return {
    kind: 'present',
    configFile: config?.file,
    output,
    databaseFile: database === undefined ? undefined : path.relative(root, database).split(path.sep).join('/'),
    schemaSource: schema.source,
    collections,
    problems,
  };
}

/** The published entries of a collection from the local database, for the preview picker; none without a database. */
export async function emDashEntries(root: string, collectionSlug: string): Promise<readonly EmDashEntrySummary[]> {
  assert(isEmDashCollectionSlug(collectionSlug), 'Entries are listed for a collection slug');
  const config = readFirst(root, ASTRO_CONFIG_FILES);
  const database = await locateDatabase(root, config?.text);
  if (database === undefined) {
    return [];
  }
  const project = await detectEmDash(root);
  const collection = project.kind === 'present' ? project.collections.find((candidate) => candidate.slug === collectionSlug) : undefined;
  // A collection the schema does not list has no table Stacki should open: the slug is spliced into SQL.
  if (collection === undefined) {
    return [];
  }
  return readEmDashEntries(database, collection.slug, headingFieldOf(collection));
}

interface ReadFile {
  readonly file: string;
  readonly text: string;
}

function readFirst(root: string, names: readonly string[]): ReadFile | undefined {
  for (const name of names) {
    const text = readText(path.join(root, name));
    if (text !== undefined) {
      return { file: name, text };
    }
  }
  return undefined;
}

function readText(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > FILE_BYTES_MAX) {
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  return text === undefined ? undefined : parseJsonText(text);
}

function parseJsonText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function declaresDependency(manifest: unknown): boolean {
  const fields = toRecord(manifest);
  for (const section of ['dependencies', 'devDependencies']) {
    const dependencies = toRecord(fields?.[section]);
    if (dependencies !== undefined && 'emdash' in dependencies) {
      return true;
    }
  }
  return false;
}

function outputOf(config: string | undefined): 'server' | 'static' | 'unknown' {
  if (config === undefined) {
    return 'unknown';
  }
  const match = /\boutput\s*:\s*['"](server|static)['"]/.exec(config);
  const found = match?.[1];
  return found === 'server' || found === 'static' ? found : 'unknown';
}

/** A path from the config, kept inside the project: an absolute or climbing one names something else. */
function insideProject(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

async function locateDatabase(root: string, config: string | undefined): Promise<string | undefined> {
  const named = config === undefined ? undefined : /\bsqlite\s*\(\s*\{[^}]*\burl\s*:\s*['"`]file:([^'"`]+)['"`]/.exec(config)?.[1];
  const candidate = insideProject(root, named ?? DEFAULT_DATABASE);
  if (candidate !== undefined && fs.existsSync(candidate) && (await isEmDashDatabase(candidate))) {
    return candidate;
  }
  return locateWranglerDatabase(root);
}

async function locateWranglerDatabase(root: string): Promise<string | undefined> {
  const folder = path.join(root, ...WRANGLER_DATABASE_FOLDER.split('/'));
  let names: readonly string[];
  try {
    names = fs.readdirSync(folder).filter((name) => name.endsWith('.sqlite'));
  } catch {
    return undefined;
  }
  for (const name of names.slice(0, WRANGLER_FILES_MAX)) {
    const file = path.join(folder, name);
    if (await isEmDashDatabase(file)) {
      return file;
    }
  }
  return undefined;
}

// A local database and the uploads folder hold the designer's copy of content. A deploy that carries them
// would overwrite or expose the customer's, so a project that does not ignore them is told so.
function ignoreProblems(root: string, config: string | undefined, database: string | undefined): readonly EmDashProblem[] {
  const ignored = new Set(
    (readText(path.join(root, '.gitignore')) ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  const found: EmDashProblem[] = [];
  if (database !== undefined && !ignoresPath(ignored, path.relative(root, database).split(path.sep).join('/'))) {
    found.push('databaseTracked');
  }
  const uploads = config === undefined ? undefined : /\blocal\s*\(\s*\{[^}]*\bdirectory\s*:\s*['"`]([^'"`]+)['"`]/.exec(config)?.[1];
  if (uploads !== undefined || fs.existsSync(path.join(root, DEFAULT_UPLOADS))) {
    const folder = path.relative(root, insideProject(root, uploads ?? DEFAULT_UPLOADS) ?? path.join(root, DEFAULT_UPLOADS));
    if (!ignoresPath(ignored, folder.split(path.sep).join('/'))) {
      found.push('uploadsTracked');
    }
  }
  return found;
}

/** Whether a .gitignore line names the file or its folder, or the wildcard pattern that covers it. */
function ignoresPath(ignored: ReadonlySet<string>, relative: string): boolean {
  const name = relative.split('/').pop() ?? relative;
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const first = relative.split('/')[0] ?? relative;
  const patterns = [
    relative,
    `/${relative}`,
    name,
    `/${name}`,
    `${relative}/`,
    `/${relative}/`,
    `${first}/`,
    `/${first}/`,
    first,
    `/${first}`,
    `*${extension}`,
    `${name}*`,
  ];
  return patterns.some((pattern) => ignored.has(pattern));
}

interface SchemaRead {
  readonly collections: readonly EmDashCollection[];
  readonly source: EmDashSchemaSource | undefined;
  readonly problem: EmDashProblem | undefined;
}

// Most exact first: the database is what the site serves; the exported schema is EmDash's own snapshot of it;
// a seed declares what a new site starts with. The first that holds collections wins.
async function readSchema(root: string, database: string | undefined, manifest: unknown): Promise<SchemaRead> {
  let unreadable: EmDashProblem | undefined;
  if (database !== undefined) {
    try {
      const parsed = parseEmDashSchema(await readEmDashSchemaRows(database));
      if (parsed.ok && parsed.value.length > 0) {
        return { collections: parsed.value, source: 'database', problem: undefined };
      }
    } catch {
      unreadable = 'databaseUnreadable';
    }
  }
  const files: readonly [EmDashSchemaSource, readonly string[]][] = [
    ['schema-json', SCHEMA_FILES],
    ['seed', [...SEED_FILES, ...seedFromManifest(manifest)]],
  ];
  for (const [source, names] of files) {
    for (const name of names) {
      const file = insideProject(root, name);
      const text = file === undefined ? undefined : readText(file);
      if (text === undefined) {
        continue;
      }
      const parsed = parseEmDashSchema(parseJsonText(text));
      if (parsed.ok && parsed.value.length > 0) {
        return { collections: parsed.value, source, problem: undefined };
      }
      if (!parsed.ok) {
        unreadable = 'schemaUnreadable';
      }
    }
  }
  return { collections: [], source: undefined, problem: unreadable ?? 'noSchema' };
}

// package.json can name the seed: `"emdash": { "seed": "seed/seed.json" }` (the `emdash seed` command reads it).
function seedFromManifest(manifest: unknown): readonly string[] {
  const seed = toRecord(toRecord(manifest)?.['emdash'])?.['seed'];
  return typeof seed === 'string' && seed.length > 0 && seed.length <= EMDASH_LIMITS.pathCharsMax ? [seed] : [];
}
