// A content collection's settings, carried through the project: the schema in
// the content config (astroSchemaEdit.ts), the entries that hold its fields,
// and the code that names it.
//
//   rename a field       its key in the config, in every entry, and where code
//                        that reads this collection reads it (`.data.old`,
//                        `data["old"]`, `["old"]`)
//   remove a field       from the config, and its value from every entry
//   rename a collection  its key in the config; a glob collection whose folder
//                        bears its name moves with it; and every
//                        `getCollection('old')`, `getEntry`, `getEntries`,
//                        `reference('old')` and `CollectionEntry<'old'>` in src
//
// Code is matched by those forms, not understood: a field read through a
// variable the matcher cannot see keeps its old name, and the count of files
// changed is reported so the person can check.

import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import type {
  CollectionSettings,
  SettingsChange,
} from '../../shared/properties/collectionSettings';
import { createProjectText, writeProjectText } from '../documents/documentWrites';
import { cmsSourcePath } from '../lib/contentPaths';
import type { AstroRemoteHost } from './astroRemoteService';
import { editCollectionSchema, readCollectionSchema } from './astroSchemaEdit';
import { configPathOf } from './contentConfig';
import { listEntries, writeEntry, type ContentCollection, type Entry } from './contentEntries';

const SOURCE_FILES_MAX = 5000;
const SOURCE_FILE_BYTES_MAX = 2 * 1024 * 1024;
const SOURCE_DEPTH_MAX = 24;
const CODE_FILE = /\.(astro|[cm]?[jt]sx?)$/i;

/** A collection's settings as the config states them. */
export function readCollectionSettings(projectPath: string, name: string): CollectionSettings {
  const { text } = configText(projectPath);
  const read = readCollectionSchema(text, name);
  if (!read.ok) {
    throw new Error(read.error);
  }
  return { name, source: read.value.source, fields: read.value.fields };
}

/** Makes `change` to the collection, its entries and the code that names it. */
export async function changeCollectionSettings(
  projectPath: string,
  host: AstroRemoteHost,
  request: { readonly name: string; readonly change: SettingsChange },
): Promise<CollectionSettings> {
  const { name, change } = request;
  const config = configText(projectPath);
  if (change.kind === 'deleteCollection') {
    return deleteCollection(projectPath, host, { name, config });
  }
  const edit = editCollectionSchema(config.text, name, change);
  if (!edit.ok) {
    throw new Error(edit.error);
  }
  const collection = (await host.readConfig()).collections.find((each) => each.name === name);
  // Entries first: a failure there leaves the config naming what the entries still hold.
  if (collection !== undefined && change.kind === 'renameField') {
    migrateEntries(projectPath, collection, { from: change.from, to: change.to });
  }
  if (collection !== undefined && change.kind === 'removeField') {
    migrateEntries(projectPath, collection, { from: change.name, to: undefined });
  }
  writeProjectText(config.abs, edit.value.text, config.text);
  if (edit.value.move !== undefined) {
    await moveFolder(projectPath, host, edit.value.move);
  }
  const renamed = change.kind === 'renameCollection' ? change.to : name;
  if (change.kind === 'renameCollection') {
    rewriteSources(projectPath, config.rel, (source) => renameCollectionIn(source, name, renamed));
  }
  if (change.kind === 'renameField') {
    rewriteSources(projectPath, config.rel, (source) =>
      namesCollection(source, name) ? renameFieldIn(source, change.from, change.to) : source,
    );
  }
  return readCollectionSettings(projectPath, renamed);
}

// A collection removed: the fields of other collections that point at it, with their
// values; its entries, to the Trash; and code that reads it, given nothing to read.
async function deleteCollection(
  projectPath: string,
  host: AstroRemoteHost,
  request: { readonly name: string; readonly config: ReturnType<typeof configText> },
): Promise<CollectionSettings> {
  const { name, config } = request;
  const edit = editCollectionSchema(config.text, name, { kind: 'deleteCollection' });
  if (!edit.ok) {
    throw new Error(edit.error);
  }
  const collections = (await host.readConfig()).collections;
  for (const other of collections.filter((each) => each.name !== name)) {
    const read = readCollectionSchema(config.text, other.name);
    const pointing = read.ok ? read.value.fields.filter((field) => field.target === name) : [];
    for (const field of pointing) {
      migrateEntries(projectPath, other, { from: field.name, to: undefined });
    }
  }
  writeProjectText(config.abs, edit.value.text, config.text);
  const deleted = collections.find((each) => each.name === name);
  for (const file of deleted === undefined ? [] : entryFiles(projectPath, deleted)) {
    await host.trash(file);
  }
  rewriteSources(projectPath, config.rel, (source) => unlinkCollectionIn(source, name));
  return { name, source: undefined, fields: [] };
}

// The files a collection's entries live in: a glob's own files, or a loader's data file.
function entryFiles(projectPath: string, collection: ContentCollection): readonly string[] {
  const loader = collection.loader;
  if (loader?.kind === 'glob') {
    const files = new Set(listEntries(projectPath, collection).entries.map((entry) => entry.file));
    return [...files].map((file) => cmsSourcePath(projectPath, file));
  }
  if (loader?.kind === 'file' && typeof loader.file === 'string') {
    const file = cmsSourcePath(projectPath, loader.file.replace(/^\.\//, ''));
    return fs.existsSync(file) ? [file] : [];
  }
  return [];
}

/**
 * Code reading a deleted collection given nothing to read, so the site still
 * builds: its list calls an empty list, an entry call no entry, its entry type any.
 * A call whose arguments hold parentheses (a filter function) is left as written.
 */
export function unlinkCollectionIn(source: string, name: string): string {
  const quoted = `(['"\`])${escape(name)}\\1`;
  return source
    .replace(
      new RegExp(`getCollection\\(\\s*${quoted}\\s*(?:,[^()]*)?\\)`, 'g'),
      'Promise.resolve([])',
    )
    .replace(new RegExp(`getEntries\\(\\s*${quoted}[^()]*\\)`, 'g'), 'Promise.resolve([])')
    .replace(
      new RegExp(`getEntry\\(\\s*${quoted}\\s*,[^()]*\\)`, 'g'),
      'Promise.resolve(undefined)',
    )
    .replace(new RegExp(`CollectionEntry<\\s*${quoted}\\s*>`, 'g'), 'any');
}

function configText(projectPath: string): {
  readonly rel: string;
  readonly abs: string;
  readonly text: string;
} {
  const found = configPathOf(projectPath);
  if (found === undefined) {
    throw new Error('This project has no content config.');
  }
  const abs = cmsSourcePath(projectPath, found.rel);
  return { rel: found.rel, abs, text: fs.readFileSync(abs, 'utf8') };
}

// Renames (or, with no `to`, removes) a key in every entry holding it, one write per file.
function migrateEntries(
  projectPath: string,
  collection: ContentCollection,
  key: { readonly from: string; readonly to: string | undefined },
): void {
  const byFile = new Map<string, Entry[]>();
  for (const entry of listEntries(projectPath, collection).entries) {
    const data = entry.data;
    if (typeof data === 'object' && data !== null && Object.hasOwn(data, key.from)) {
      byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    }
  }
  for (const [file, entries] of byFile) {
    const edits = entries.map((entry) =>
      key.to === undefined
        ? { path: [...entry.locator, key.from], value: undefined }
        : { path: [...entry.locator, key.from], rename: key.to },
    );
    writeEntry(projectPath, { file, locator: [] }, edits);
  }
  assert(byFile.size <= SOURCE_FILES_MAX * 10, 'A migration writes bounded files');
}

// A glob collection's files, moved to its renamed folder; the old ones go to the Trash.
async function moveFolder(
  projectPath: string,
  host: AstroRemoteHost,
  move: { readonly from: string; readonly to: string },
): Promise<void> {
  const from = cmsSourcePath(projectPath, move.from);
  const to = cmsSourcePath(projectPath, move.to);
  if (fs.existsSync(to)) {
    throw new Error(`${move.to} already exists; the entries were left in ${move.from}.`);
  }
  for (const rel of filesUnder(from)) {
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    createProjectText(target, fs.readFileSync(path.join(from, rel), 'utf8'));
    await host.trash(path.join(from, rel));
  }
  fs.mkdirSync(to, { recursive: true });
}

// Every code file under src, bounded; the config itself is edited on its own.
function rewriteSources(
  projectPath: string,
  configRel: string,
  rewrite: (source: string) => string,
): number {
  let changed = 0;
  const root = cmsSourcePath(projectPath, 'src');
  for (const rel of filesUnder(root).filter((file) => CODE_FILE.test(file))) {
    const abs = path.join(root, rel);
    if (path.relative(projectPath, abs).split(path.sep).join('/') === configRel) {
      continue;
    }
    if (fs.statSync(abs).size > SOURCE_FILE_BYTES_MAX) {
      continue;
    }
    const before = fs.readFileSync(abs, 'utf8');
    const after = rewrite(before);
    if (after !== before) {
      writeProjectText(abs, after, before);
      changed += 1;
    }
  }
  return changed;
}

// The calls that name a collection by its first argument.
const COLLECTION_CALLS = `(${[
  'getCollection',
  'getEntry',
  'getEntries',
  'getEntryBySlug',
  'getDataEntryById',
  'getLiveCollection',
  'getLiveEntry',
  'reference',
].join('|')})`;

/** Code naming collection `from` by its name, renamed to `to`. */
export function renameCollectionIn(source: string, from: string, to: string): string {
  const name = escape(from);
  return source
    .replace(new RegExp(`(${COLLECTION_CALLS}\\(\\s*)(['"\`])${name}\\3`, 'g'), `$1$3${to}$3`)
    .replace(new RegExp(`(collection:\\s*)(['"\`])${name}\\2`, 'g'), `$1$2${to}$2`)
    .replace(new RegExp(`(CollectionEntry<\\s*)(['"])${name}\\2`, 'g'), `$1$2${to}$2`);
}

/** Whether code reads collection `name`, so its field reads can be renamed. */
export function namesCollection(source: string, name: string): boolean {
  // The calls' pattern holds the first group, so the quote is the second there, the first here.
  const escaped = escape(name);
  return (
    new RegExp(`${COLLECTION_CALLS}\\(\\s*(['"\`])${escaped}\\2`).test(source) ||
    new RegExp(`CollectionEntry<\\s*(['"\`])${escaped}\\1`).test(source)
  );
}

/** A field's reads renamed: `.data.old`, `data["old"]`, and `["old"]` where it is quoted. */
export function renameFieldIn(source: string, from: string, to: string): string {
  const name = escape(from);
  const identifier = /^[A-Za-z_$][\w$]*$/;
  const dotted = identifier.test(to) ? `.data.${to}` : `.data[${JSON.stringify(to)}]`;
  const renamedDots = identifier.test(from)
    ? source.replace(new RegExp(`\\.data\\.${name}(?![\\w$])`, 'g'), dotted)
    : source;
  return renamedDots.replace(new RegExp(`\\[(['"\`])${name}\\1\\]`, 'g'), `[$1${to}$1]`);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Files below `root`, as relative paths, without dot folders or node_modules; bounded.
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const pending: { readonly directory: string; readonly depth: number }[] = [
    { directory: root, depth: 0 },
  ];
  while (pending.length > 0 && out.length < SOURCE_FILES_MAX) {
    const next = pending.pop();
    if (next === undefined || next.depth > SOURCE_DEPTH_MAX || !fs.existsSync(next.directory)) {
      continue;
    }
    for (const entry of fs.readdirSync(next.directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: full, depth: next.depth + 1 });
      } else if (out.length < SOURCE_FILES_MAX) {
        out.push(path.relative(root, full));
      }
    }
  }
  assert(out.length <= SOURCE_FILES_MAX, 'A scan reads bounded files');
  return out;
}
