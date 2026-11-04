import { cmsDirectoryPath, cmsSourcePath } from '../lib/contentPaths';
import fs from 'fs';
import path from 'path';

import { LIMITS } from '../../shared/core/limits';
import { toRecord, toArray } from '../../shared/core/record';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { writeProjectText } from '../documents/documentWrites';
import { assertContentWitness } from './contentWitness';
import { entryTitleOf, titleFieldsOf } from '../../shared/properties/entryTitle';
import * as frontmatter from './formats/markdownEntry';
import * as jsonFormat from './formats/json';
import * as yamlFormat from './formats/yaml';
import * as tomlFormat from './formats/toml';
import * as csvFormat from './formats/csv';
import * as ndjsonFormat from './formats/ndjson';

// Finding, reading and writing the entries of a content collection.
//
// Where an entry lives depends on the loader (see contentConfig.js): a glob
// collection keeps one file per entry, a file collection keeps all of them
// inside one data file. What an entry *is* depends on the format that file is
// written in, and no two of those are edited the same way — so every write goes
// through ./formats, which patches the file rather than re-serializing it.
//
// The id is the other half of the problem. Astro derives it differently per
// collection — from the file path, from a field, from the key an object sits
// under — and an id is what every reference() in the project points at. So it
// is computed here, once, and the rules are named rather than assumed.

interface FormatEdit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

interface FormatModule {
  readonly parseData: (text: string) => unknown;
  readonly applyEdits: (text: string, edits: readonly FormatEdit[], opts?: { readonly body?: string }) => string;
  readonly DELETE: symbol;
}

const FORMATS: Record<string, FormatModule> = {
  md: frontmatter,
  mdx: frontmatter,
  mdoc: frontmatter,
  markdown: frontmatter,
  json: jsonFormat,
  yaml: yamlFormat,
  yml: yamlFormat,
  toml: tomlFormat,
  csv: csvFormat,
  ndjson: ndjsonFormat,
};

const extensionOf = (file: string): string => (file.split('.').pop() || '').toLowerCase();
const formatFor = (file: string): FormatModule | undefined => FORMATS[extensionOf(file)];
const formatName = (file: string): string => {
  const ext = extensionOf(file);
  return FORMATS[ext] === frontmatter ? 'frontmatter' : ext;
};

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');
const isPlainObject = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);

// A glob pattern as a regular expression: `**` crosses folders, `*` does not,
// and `{a,b}` is a choice. Enough for the patterns a content config writes.
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        out += pattern.charAt(i + 2) === '/' ? '(?:.*\\/)?' : '.*';
        i += pattern.charAt(i + 2) === '/' ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      out += `(?:${pattern
        .slice(i + 1, close)
        .split(',')
        .map((choice) => choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`;
      i = close;
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function walkFiles(directory: string, base = directory, out: string[] = [], depth = 0): string[] {
  // A project's folders are not ours to trust: a tree deeper than any real one stops the walk
  // there, before it can exhaust the stack.
  if (depth > MAIN_LIMITS.directoryDepthMax) {
    return out;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, out, depth + 1);
    } else {
      out.push(toPosix(path.relative(base, full)));
    }
  }
  return out;
}

export interface LoaderInfo {
  readonly kind?: string;
  readonly base?: string;
  readonly pattern?: string | readonly string[];
  readonly file?: string;
  readonly generateId?: unknown;
  readonly parser?: unknown;
}

export interface ContentCollection {
  readonly name: string;
  readonly loader?: LoaderInfo;
  readonly editable?: boolean;
  readonly schema?: unknown;
}

export interface Entry {
  readonly id: string;
  readonly file: string;
  readonly format: string;
  /** The path to the record inside its file; empty for one file per entry. */
  readonly locator: readonly (string | number)[];
  readonly data: unknown;
  readonly title: string;
  readonly body?: string;
  readonly hasBody?: boolean;
  readonly error?: string;
  readonly keyed?: boolean;
}

export interface EntryEdit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

export interface ListResult {
  readonly entries: Entry[];
  readonly readOnly: boolean;
  readonly reason?: string | undefined;
  readonly idsAreGuesses?: boolean;
  readonly idNote?: string | undefined;
  readonly shape?: string;
  readonly parsed?: boolean;
  readonly parserNote?: string | undefined;
}

/**
 * Every entry of one collection, as { id, file, format, locator, data, body }.
 */
function listEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  if (loader.kind === 'glob') {
    return globEntries(projectPath, collection);
  }
  if (loader.kind === 'file') {
    return fileEntries(projectPath, collection);
  }
  return { entries: [], readOnly: true, reason: readOnlyReason(collection) };
}

function readOnlyReason(collection: ContentCollection): string | undefined {
  const loader = collection.loader ?? {};
  if (loader.kind === 'custom') {
    return (
      `${collection.name} is built by a loader in this project, not stored in a file. ` +
      'Its entries are rebuilt from scratch on every sync, so anything written here would be ' +
      'overwritten.'
    );
  }
  return undefined;
}

const patternsOf = (pattern: LoaderInfo['pattern']): RegExp[] => {
  const list = Array.isArray(pattern) ? pattern : pattern !== undefined ? [pattern] : [];
  return list.map(globToRegExp);
};

function globEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  const root = cmsDirectoryPath(projectPath, String(loader.base ?? ''));
  const matchers = patternsOf(loader.pattern);
  const files = walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel)));
  files.sort();

  const titleFields = titleFieldsOf(collection.schema);
  const entries: Entry[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const format = formatFor(rel);
    if (!format) {
      continue;
    }
    let text = '';
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.contentEntryBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Astro's own rule for the id: the path under the base, without its
    // extension.
    const base: Pick<Entry, 'id' | 'file' | 'format' | 'locator'> = {
      id: rel.replace(/\.[^./]+$/, ''),
      file: toPosix(path.relative(projectPath, abs)),
      format: formatName(rel),
      locator: [],
    };
    let entry: Omit<Entry, 'title'>;
    try {
      if (format === frontmatter) {
        const parsed = frontmatter.parse(text);
        entry = { ...base, data: parsed.data || {}, body: parsed.body, hasBody: true };
      } else {
        entry = { ...base, data: format.parseData(text) };
      }
    } catch (error: unknown) {
      entry = { ...base, error: String(error instanceof Error ? error.message : error), data: {} };
    }
    entries.push({ ...entry, title: entryTitleOf(entry.data, { id: entry.id, fields: titleFields }) });
  }

  const generated = loader.generateId;
  return {
    entries,
    readOnly: false,
    // The id is not the file path, and nothing outside the loader knows the
    // rule it uses — so an id shown here is a guess, and renaming the file is
    // not what renames the entry.
    idsAreGuesses: !!generated,
    idNote: generated
      ? `${collection.name} builds its ids in the loader, from the entry's own fields. ` +
        'The ids shown are the file paths, which is not what other collections reference.'
      : undefined,
  };
}

interface RawRecord {
  readonly id: string;
  readonly idKey: string | undefined;
  readonly keyed?: boolean;
  readonly locator: readonly (string | number)[];
  readonly record: Record<string, unknown>;
}

// Where the records are inside a data file, and what identifies each one:
//   [ { id: … } ]        → the id field, addressed by position
//   { key: { … } }       → the key itself
//   anything else        → any object with an id, wherever it sits, which is
//                          what a parser-shaped file looks like.
function locateRecords(data: unknown): { shape: string; records: RawRecord[] } {
  const list = toArray(data);
  if (list) {
    if (!list.length || !list.every(isPlainObject)) {
      return { shape: 'array', records: [] };
    }
    return {
      shape: 'array',
      records: list.map((record, index) => {
        const rec = toRecord(record) ?? {};
        const id = rec['id'];
        return {
          id: typeof id === 'string' ? id : String(index),
          idKey: typeof id === 'string' ? 'id' : undefined,
          locator: [index],
          record: rec,
        };
      }),
    };
  }
  const top = toRecord(data);
  if (!top) {
    return { shape: 'unknown', records: [] };
  }

  const keys = Object.keys(top).filter((key) => key !== '$schema');
  if (keys.length && keys.every((key) => isPlainObject(top[key]))) {
    return {
      shape: 'keyed',
      records: keys.map((key) => ({
        id: key,
        idKey: undefined,
        keyed: true,
        locator: [key],
        record: toRecord(top[key]) ?? {},
      })),
    };
  }

  // Nested: the file groups its records under something. Every object with a
  // string id counts, wherever it is — which is how a grouped file (categories
  // holding questions) comes apart without knowing what the grouping means.
  const records: RawRecord[] = [];
  const visit = (node: unknown, locator: readonly (string | number)[]): void => {
    // The file is the project's data: past the depth any IPC value may have, nothing deeper
    // could reach the editor anyway, so the search stops there.
    const depth = locator.length;
    if (depth > LIMITS.ipcDepthMax) {
      return;
    }
    const items = toArray(node);
    if (items) {
      items.forEach((item, index) => visit(item, [...locator, index]));
      return;
    }
    const record = toRecord(node);
    if (!record) {
      return;
    }
    const id = record['id'];
    if (typeof id === 'string' && locator.length) {
      records.push({ id, idKey: 'id', locator, record });
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      visit(value, [...locator, key]);
    }
  };
  visit(data, []);
  return { shape: records.length ? 'nested' : 'single', records };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function fileEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  const rel = toPosix(String(loader.file ?? '')).replace(/^\.\//, '');
  const abs = cmsSourcePath(projectPath, rel);
  const format = formatFor(rel);
  if (!format) {
    return {
      entries: [],
      readOnly: true,
      reason: `Stacki cannot read ${path.extname(rel)} data files yet.`,
    };
  }
  let text = '';
  try {
    if (fs.statSync(abs).size > MAIN_LIMITS.contentDataFileBytesMax) {
      return { entries: [], readOnly: true, reason: `${rel} is too large to edit here.` };
    }
    text = fs.readFileSync(abs, 'utf8');
  } catch (error: unknown) {
    return {
      entries: [],
      readOnly: true,
      reason: `Could not read ${rel} — ${errorMessage(error)}`,
    };
  }

  let data: unknown;
  try {
    data = format.parseData(text);
  } catch (error: unknown) {
    return {
      entries: [],
      readOnly: true,
      reason: `${rel} could not be parsed — ${errorMessage(error)}`,
    };
  }

  const { shape, records } = locateRecords(data);
  const titleFields = titleFieldsOf(collection.schema);
  const entries: Entry[] = records.map(({ id, locator, record, keyed }) => ({
    id,
    file: rel,
    format: formatName(rel),
    locator,
    keyed: !!keyed,
    data: record,
    title: entryTitleOf(record, { id, fields: titleFields }),
  }));

  return {
    entries,
    readOnly: false,
    shape,
    // A parser stands between the file and the entries, so some of what an
    // entry holds was never in the file — and the fields it invented cannot be
    // written back through it.
    parsed: !!loader.parser,
    parserNote: loader.parser
      ? `${collection.name} is parsed by a function in the content config before Astro sees it. ` +
        'Fields that are not in the file itself were made by that parser: they are shown, ' +
        'but editing one here would have nowhere to go.'
      : undefined,
  };
}

/**
 * Applies edits to one entry. `edits` are { path, value } against the entry's
 * own data — the locator that puts it inside its file is added here — plus an
 * optional `body` for the formats that have one.
 */
function writeEntry(
  projectPath: string,
  entry: { readonly file: string; readonly locator?: readonly (string | number)[] },
  edits: readonly EntryEdit[],
  {
    body,
    expected,
  }: {
    readonly body?: string;
    readonly expected?: { readonly data?: unknown; readonly body?: string | undefined };
  } = {},
): { ok: true; changed: boolean } {
  const abs = cmsSourcePath(projectPath, entry.file);
  const format = formatFor(entry.file);
  if (!format) {
    throw new Error(`Stacki cannot write ${path.extname(entry.file)} files.`);
  }
  // The larger of the readers' bounds (a whole data file): a file can grow between
  // listing and edit, and nothing larger was ever listed to be edited.
  const size = fs.statSync(abs).size;
  if (size > MAIN_LIMITS.contentDataFileBytesMax) {
    throw new Error('This file is too large to edit here.');
  }
  // Every project write goes through the document layer, which holds at most a source file's
  // bound: a data file listed above it reads, but says why it cannot be saved.
  if (size > LIMITS.sourceBytesMax) {
    const sizeMb = Math.ceil((size / (1024 * 1024)) * 10) / 10;
    const limitMb = Math.floor(LIMITS.sourceBytesMax / (1024 * 1024));
    throw new Error(`${entry.file} is ${sizeMb} MB; Stacki saves files up to ${limitMb} MB.`);
  }
  const text = fs.readFileSync(abs, 'utf8');

  const locator = entry.locator ?? [];
  if (expected) {
    assertContentWitness(format.parseData(text), locator, expected.data);
    if (expected.body !== undefined && frontmatter.parse(text).body !== expected.body) {
      throw new Error('Content changed. Reopen the text before saving.');
    }
  }
  const prefixed: FormatEdit[] = edits.map((edit) =>
    // A rename names a key rather than setting a value, so it carries no value
    // at all — and must not be read as one being cleared.
    edit.rename !== undefined
      ? { path: [...locator, ...edit.path], rename: edit.rename }
      : {
          path: [...locator, ...edit.path],
          value: edit.value === undefined ? format.DELETE : edit.value,
        },
  );

  const next = format === frontmatter ? frontmatter.applyEdits(text, prefixed, { body }) : format.applyEdits(text, prefixed);
  if (next === text) {
    return { ok: true, changed: false };
  }
  writeProjectText(abs, next, text);
  return { ok: true, changed: true };
}

/**
 * How many entries a collection has, without reading them. The panel shows a
 * count next to every collection, and parsing a hundred markdown files to draw
 * a number is a cost with nothing to show for it.
 */
function countEntries(projectPath: string, collection: ContentCollection): number {
  const loader = collection.loader ?? {};
  if (loader.kind === 'glob') {
    const root = cmsDirectoryPath(projectPath, String(loader.base ?? ''));
    const matchers = patternsOf(loader.pattern);
    return walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel))).length;
  }
  if (loader.kind === 'file') {
    try {
      return listEntries(projectPath, collection).entries.length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * The files a content collection already owns. They are edited through their
 * schema, not as loose JSON, so the file-based editor leaves them alone rather
 * than offering a second way in with different rules.
 */
function coveredPaths(
  projectPath: string,
  collections: readonly ContentCollection[],
): {
  files: string[];
  dirs: string[];
} {
  const files: string[] = [];
  const directories: string[] = [];
  for (const collection of collections) {
    const loader = collection.loader ?? {};
    if (loader.kind === 'file' && loader.file) {
      files.push(toPosix(loader.file).replace(/^\.\//, ''));
    }
    if (loader.kind === 'glob' && loader.base) {
      const base = toPosix(loader.base).replace(/^\.\//, '').replace(/\/$/, '');
      // src/data commonly mixes content-collection entries with imported TS
      // modules and loose data files. Only the files matching this collection's
      // pattern are owned by it; hiding the whole directory made every sibling
      // disappear from the file-based CMS.
      if (isDataDirectory(base)) {
        const root = cmsDirectoryPath(projectPath, base);
        const matchers = patternsOf(loader.pattern);
        for (const relative of walkFiles(root)) {
          if (matchers.some((matcher) => matcher.test(relative))) {
            files.push(toPosix(path.relative(projectPath, path.join(root, relative))));
          }
        }
      } else {
        directories.push(base);
      }
    }
  }
  return {
    files: [...new Set(files)].sort(),
    dirs: [...new Set(directories)].sort(),
  };
}

function isDataDirectory(directory: string): boolean {
  if (directory === 'src/data') {
    return true;
  }
  return directory.startsWith('src/data/');
}

export { listEntries, writeEntry, countEntries, coveredPaths, locateRecords, globToRegExp, formatFor, formatName };
