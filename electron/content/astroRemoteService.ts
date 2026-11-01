// A project's Astro content collections, answering the calls the CMS panel's
// connected-CMS views make (cmsRemoteService.ts does the same for Sanity), so
// the panel draws them with the same table and item editor. Desktop calls it
// from its content handlers; Stacki Studio runs those same handlers on its
// server, inside the staging directory its CMS route commits from.
//
// Collections whose entries live in files — a glob loader's one file per entry,
// or a file loader's records in one data file — are listed; one built by a
// loader in the project's code is not, since anything written to it would be
// rebuilt away on the next sync. New entries and deletes are offered for glob
// collections, where an entry is a file of its own.
//
// An entry is named by `<collection>.<hash of its id>`: the remote views key
// their caches by document id across collections, and an Astro id can hold
// slashes and spaces a remote id may not.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { toArray, toRecord } from '../../shared/core/record';
import { createProjectText } from '../documents/documentWrites';
import { cmsDirectoryPath, cmsSourcePath } from '../lib/contentPaths';
import {
  CMS_REMOTE_LIMITS,
  REMOTE_TEMPLATE_ID,
  remoteCell,
  type RemoteCell,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentField,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  type RemoteWrite,
} from '../../shared/properties/cmsRemote';
import {
  REMOTE_SCHEMA_LIMITS,
  parseRemoteValue,
  type RemoteOption,
  type RemoteSchemaField,
  type RemoteValue,
} from '../../shared/properties/cmsRemoteSchema';
import { astroSchemaFields, labelize, referencedCollections } from './astroRemoteSchema';
import { createAstroCollection } from './astroCollectionConfig';
import { addDataRecord, removeDataRecords } from './astroDataRecords';
import {
  entryImage,
  projectImage,
  withInferredReferences,
  type RecordCollection,
} from './astroRecordReferences';

export { projectImage };
import {
  globToRegExp,
  listEntries,
  writeEntry,
  type ContentCollection,
  type Entry,
} from './contentEntries';

export interface AstroRemoteService {
  readonly collections: () => Promise<RemoteCollection[]>;
  /** One collection's entries, each with the `columns` fields' values to show beside it. */
  readonly documents: (
    collection: string,
    columns?: readonly string[],
  ) => Promise<RemoteDocumentList>;
  readonly document: (id: string) => Promise<RemoteDocument>;
  /** A collection's fields with no values, edited before a new entry is created. */
  readonly template: (collection: string) => Promise<RemoteDocument>;
  readonly write: (write: RemoteWrite) => Promise<RemoteDocument>;
  readonly create: (collection: string) => Promise<RemoteDocumentSummary>;
  readonly remove: (ids: readonly string[]) => Promise<number>;
  readonly createCollection: (name: string) => Promise<RemoteCollection>;
}

/**
 * What the host supplies: the content config as its boundary parsed it, read
 * afresh on every call so a config edit shows at once, and what becomes of a
 * deleted entry's file (Desktop moves it to the Trash).
 */
export interface AstroRemoteHost {
  readonly readConfig: () => Promise<AstroContentConfig>;
  readonly trash: (file: string) => Promise<void>;
}

export interface AstroContentConfig {
  readonly collections: readonly ContentCollection[];
  readonly error?: string | undefined;
}

type Collection = ContentCollection;

/** The field a Markdown entry's body is edited as, below its frontmatter. */
export const BODY_FIELD = 'body';
const ENTRY_NAMES_MAX = 100;
// A key the panel can write (parseRemoteFieldName): no system `_` keys.
const FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EXTENSIONS = ['md', 'mdx', 'markdown', 'mdoc', 'json', 'yaml', 'yml', 'toml'] as const;

export function astroRemoteService(projectPath: string, host: AstroRemoteHost): AstroRemoteService {
  assert(path.isAbsolute(projectPath), 'A content service reads a project by its full path');
  const editable = async () => {
    const config = await host.readConfig();
    if (config.error !== undefined) {
      throw new Error(`The content config could not be read — ${config.error}`);
    }
    return config.collections.filter(inFiles);
  };
  const collectionNamed = async (name: string) => {
    const found = (await editable()).find((collection) => collection.name === name);
    if (found === undefined) {
      throw new Error(`${name} is not a content collection in this project.`);
    }
    return found;
  };
  const located = async (id: string) => {
    const collection = await collectionNamed(collectionOfId(id));
    const entry = listEntries(projectPath, collection).entries.find(
      (candidate) => documentId(collection.name, candidate.id) === id,
    );
    if (entry === undefined) {
      throw new Error('This entry is no longer in the project.');
    }
    return { collection, entry };
  };
  const document = async (id: string) => {
    const { collection, entry } = await located(id);
    const collections = await editable();
    const targets = await referenceTargets(projectPath, collection, collections);
    const records = recordsOf(projectPath, collections);
    return documentOf(projectPath, { collection, entry, targets, records });
  };
  return {
    collections: async () => (await editable()).flatMap(collectionSummary(projectPath)),
    documents: async (name, columns = []) =>
      listWithColumns(projectPath, { collection: await collectionNamed(name), columns }, editable),
    document,
    template: async (name) =>
      templateOf(projectPath, await collectionNamed(name), await editable()),
    write: async (write) => {
      const { collection, entry } = await located(write.id);
      writeField(projectPath, { collection, entry, write });
      return document(write.id);
    },
    create: async (name) => createEntry(projectPath, await collectionNamed(name)),
    remove: async (ids) => {
      const found = await Promise.all(ids.map(located));
      // Glob entries are files of their own, to the Trash; records come out of their data file.
      const files = found.filter((each) => each.collection.loader?.kind === 'glob');
      const records = found.filter((each) => each.collection.loader?.kind !== 'glob');
      for (const { entry } of files) {
        assert(entry.locator.length === 0, 'A glob entry is a whole file');
        await host.trash(cmsSourcePath(projectPath, entry.file));
      }
      removeDataRecords(
        projectPath,
        records.map((each) => each.entry),
      );
      return found.length;
    },
    createCollection: async (name) => {
      const config = await host.readConfig();
      if (config.collections.some((collection) => collection.name === name)) {
        throw new Error(`A collection named “${name}” already exists.`);
      }
      createAstroCollection(projectPath, name);
      return { name, count: 0, icon: undefined };
    },
  };
}

/** An entry's remote id: its collection, then a short hash of its Astro id. */
export function documentId(collection: string, entryId: string): string {
  const hash = createHash('sha256').update(entryId).digest('hex').slice(0, 16);
  const id = `${collection}.${hash}`;
  assert(id.length <= 128, 'A document id fits the remote id bound');
  assert(id.endsWith(hash), 'A document id ends with its hash');
  return id;
}

function collectionOfId(id: string): string {
  const dot = id.lastIndexOf('.');
  if (dot <= 0 || !/^[a-f0-9]{16}$/.test(id.slice(dot + 1))) {
    throw new Error('This is not a content collection entry.');
  }
  return id.slice(0, dot);
}

function inFiles(collection: Collection): boolean {
  const kind = collection.loader?.kind;
  if (!/^[A-Za-z_][\w.-]{0,127}$/.test(collection.name)) {
    return false;
  }
  return kind === 'glob' || kind === 'file';
}

function collectionSummary(projectPath: string) {
  return (collection: Collection): RemoteCollection[] => [
    {
      name: collection.name,
      count: Math.min(listEntries(projectPath, collection).entries.length, Number.MAX_SAFE_INTEGER),
      // No Sanity icon: the panel draws its own CMS icon for content collections.
      icon: undefined,
    },
  ];
}

function documentList(
  projectPath: string,
  collection: Collection,
  cellsOf: (entry: Entry) => RemoteDocumentSummary['cells'] | undefined,
): RemoteDocumentList {
  // A collection whose file could not be read says why, rather than listing nothing.
  const listed = listEntries(projectPath, collection);
  if (listed.entries.length === 0 && listed.reason !== undefined) {
    throw new Error(listed.reason);
  }
  // A collection past the bound shows its first entries; the panel lists no more than that.
  const entries = listed.entries.slice(0, CMS_REMOTE_LIMITS.documentsMax);
  // The list's picture is the entry's first image field, as Sanity's list shows its first image.
  const image = firstImageField(collection);
  const documents = entries.map((entry) => {
    const cells = cellsOf(entry);
    const summary = summaryOf(projectPath, collection.name, entry, image);
    return cells === undefined ? summary : { ...summary, cells };
  });
  assert(documents.length <= CMS_REMOTE_LIMITS.documentsMax, 'A list stays within its bound');
  return { documents, orderable: false };
}

async function listWithColumns(
  projectPath: string,
  asked: { readonly collection: Collection; readonly columns: readonly string[] },
  editable: () => Promise<readonly Collection[]>,
): Promise<RemoteDocumentList> {
  const cells = await columnCells(projectPath, asked, await editable());
  return documentList(projectPath, asked.collection, cells);
}

// The columns' values for each entry: a reference by its record's name, as its field offers it.
async function columnCells(
  projectPath: string,
  asked: { readonly collection: Collection; readonly columns: readonly string[] },
  collections: readonly Collection[],
): Promise<(entry: Entry) => RemoteDocumentSummary['cells'] | undefined> {
  const { collection, columns } = asked;
  if (columns.length === 0) {
    return () => undefined;
  }
  const targets = await referenceTargets(projectPath, collection, collections);
  const records = recordsOf(projectPath, collections);
  const own = records.find((each) => each.name === collection.name);
  assert(own !== undefined, 'A list’s own collection is among those read');
  const fields = withInferredReferences(
    astroSchemaFields(collection.schema, targets),
    own,
    records,
  );
  const titles = new Map(columns.map((name) => [name, optionTitles(fields, name)] as const));
  return (entry) => {
    const data = toRecord(entry.data) ?? {};
    const cells: Record<string, RemoteCell> = {};
    for (const name of columns) {
      const named = titles.get(name) ?? new Map<string, string>();
      const raw = data[name];
      const shown = Array.isArray(raw)
        ? raw.map((item: unknown) => (typeof item === 'string' ? (named.get(item) ?? item) : item))
        : typeof raw === 'string'
          ? (named.get(raw) ?? raw)
          : raw;
      const cell = remoteCell(plain(shown, 0));
      if (cell !== undefined) {
        cells[name] = cell;
      }
    }
    return cells;
  };
}

// A choice field's values by the titles its options give them; none for any other field.
function optionTitles(
  fields: readonly RemoteSchemaField[],
  name: string,
): ReadonlyMap<string, string> {
  const type = fields.find((field) => field.name === name)?.type;
  const member = type?.kind === 'array' ? type.of[0] : type;
  const options = member?.kind === 'string' ? member.options : [];
  return new Map(options.map((option) => [option.value, option.title]));
}

function summaryOf(
  projectPath: string,
  collection: string,
  entry: Entry,
  imageField?: string,
): RemoteDocumentSummary {
  const title = preview(entry.title);
  const imageFile = entryImage(entry, imageField);
  return {
    ...(imageFile === undefined ? {} : { imageFile }),
    id: documentId(collection, entry.id),
    title,
    subtitle: entry.id === entry.title ? undefined : preview(entry.id),
    imageURL: undefined,
    status: 'published',
    updatedAt: modified(projectPath, entry.file),
  };
}

function documentOf(
  projectPath: string,
  context: {
    readonly collection: Collection;
    readonly entry: Entry;
    readonly targets: ReadonlyMap<string, readonly RemoteOption[]>;
    readonly records: readonly RecordCollection[];
  },
): RemoteDocument {
  const { collection, entry, targets, records } = context;
  const data = toRecord(entry.data) ?? {};
  const schema = collection.schema === undefined ? undefined : toRecord(collection.schema);
  const own = records.find((each) => each.name === collection.name);
  assert(own !== undefined, 'A document’s own collection is among those read');
  const declared = withInferredReferences(
    schema === undefined ? inferredFields(data) : astroSchemaFields(schema, targets),
    own,
    records,
  );
  const fields: RemoteDocumentField[] = declared.flatMap((field) => {
    const value = representable(data[field.name]);
    return value.ok ? [{ ...field, value: value.value }] : [];
  });
  const body = bodyField(entry, declared);
  const editedAt = modified(projectPath, entry.file);
  assert(fields.length <= CMS_REMOTE_LIMITS.fieldsMax, 'A document has bounded fields');
  return {
    id: documentId(collection.name, entry.id),
    type: collection.name,
    status: 'published',
    fields: body === undefined ? fields : [...fields, body],
    assets: [],
    editedAt,
    publishedAt: undefined,
    editURL: undefined,
    file: entry.file,
  };
}

// An entry with no schema is edited by what it holds: each scalar key, and lists of them.
function inferredFields(data: Readonly<Record<string, unknown>>): RemoteSchemaField[] {
  return Object.entries(data).flatMap(([name, value]): RemoteSchemaField[] => {
    const kind = scalarKind(value) ?? scalarKind(toArray(value)?.[0]);
    if (kind === undefined || !FIELD_NAME.test(name)) {
      return [];
    }
    const scalar = { kind, options: [] } as const;
    const type = Array.isArray(value) ? { kind: 'array' as const, of: [scalar] } : scalar;
    return [{ name, title: labelize(name), description: '', required: false, rules: [], type }];
  });
}

function scalarKind(value: unknown): 'string' | 'number' | 'boolean' | undefined {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return typeof value === 'boolean' ? 'boolean' : undefined;
}

function bodyField(
  entry: Pick<Entry, 'hasBody' | 'body'>,
  declared: readonly RemoteSchemaField[],
): RemoteDocumentField | undefined {
  if (entry.hasBody !== true || declared.some((field) => field.name === BODY_FIELD)) {
    return undefined;
  }
  return {
    name: BODY_FIELD,
    title: 'Body',
    description: 'The entry’s Markdown, below its frontmatter.',
    required: false,
    rules: [],
    type: { kind: 'text', options: [] },
    value: entry.body === undefined || entry.body.length === 0 ? undefined : entry.body,
  };
}

// A collection's fields with no values: a new entry before it is written. A
// Markdown collection's entries have a body, so its template has one too.
async function templateOf(
  projectPath: string,
  collection: Collection,
  collections: readonly Collection[],
): Promise<RemoteDocument> {
  const targets = await referenceTargets(projectPath, collection, collections);
  const records = recordsOf(projectPath, collections);
  const own = records.find((each) => each.name === collection.name);
  assert(own !== undefined, 'A template’s own collection is among those read');
  const schema = collection.schema === undefined ? undefined : toRecord(collection.schema);
  const declared = withInferredReferences(
    schema === undefined ? [] : astroSchemaFields(schema, targets),
    own,
    records,
  );
  const fields = declared.map((field) => ({ ...field, value: undefined }));
  const markdown = own.entries.some((entry) => entry.hasBody === true) || markdownGlob(collection);
  const body = markdown ? bodyField({ hasBody: true }, declared) : undefined;
  assert(fields.length <= CMS_REMOTE_LIMITS.fieldsMax, 'A template has bounded fields');
  return {
    id: REMOTE_TEMPLATE_ID,
    type: collection.name,
    status: 'draft',
    fields: body === undefined ? fields : [...fields, body],
    assets: [],
    editedAt: undefined,
    publishedAt: undefined,
    editURL: undefined,
  };
}

// A glob collection whose files are Markdown (or MDX, Markdoc): its entries have a body.
function markdownGlob(collection: Collection): boolean {
  const loader = collection.loader;
  if (loader?.kind !== 'glob') {
    return false;
  }
  const patterns = typeof loader.pattern === 'string' ? [loader.pattern] : (loader.pattern ?? []);
  const extension = EXTENSIONS.find((candidate) =>
    patterns.some((pattern) => pattern.includes(candidate)),
  );
  return extension === undefined || ['md', 'mdx', 'markdown', 'mdoc'].includes(extension);
}

// A stored value as JSON the panel can hold: dates as ISO text, the rest checked
// against the remote value bounds. A value past them is left out, not cut.
function representable(
  input: unknown,
): { readonly ok: true; readonly value: RemoteValue | undefined } | { readonly ok: false } {
  try {
    return { ok: true, value: parseRemoteValue(plain(input, 0)) };
  } catch {
    return { ok: false };
  }
}

function plain(input: unknown, depth: number): unknown {
  if (depth > REMOTE_SCHEMA_LIMITS.valueDepthMax) {
    throw new Error('The value is nested too deeply.');
  }
  if (input instanceof Date) {
    const iso = input.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  const items = toArray(input);
  if (items !== undefined) {
    return items.map((item) => plain(item, depth + 1));
  }
  const value = toRecord(input);
  if (value === undefined) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plain(item, depth + 1)]),
  );
}

async function referenceTargets(
  projectPath: string,
  collection: Collection,
  collections: readonly Collection[],
): Promise<ReadonlyMap<string, readonly RemoteOption[]>> {
  const targets = new Map<string, readonly RemoteOption[]>();
  for (const name of referencedCollections(collection.schema)) {
    const target = collections.find((candidate) => candidate.name === name);
    const entries = target === undefined ? [] : listEntries(projectPath, target).entries;
    // Past the bound a reference is typed rather than chosen from a list too long to use.
    if (target !== undefined && entries.length <= REMOTE_SCHEMA_LIMITS.optionsMax) {
      const image = firstImageField(target);
      targets.set(
        name,
        entries.map((entry) => {
          const imageFile = entryImage(entry, image);
          return {
            title: preview(entry.title),
            value: entry.id,
            ...(imageFile === undefined ? {} : { imageFile }),
          };
        }),
      );
    }
  }
  assert(targets.size <= REMOTE_SCHEMA_LIMITS.valueNodesMax, 'Targets are bounded');
  return targets;
}

function writeField(
  projectPath: string,
  context: { readonly collection: Collection; readonly entry: Entry; readonly write: RemoteWrite },
): void {
  const { collection, entry, write } = context;
  const schemaBody = astroSchemaFields(collection.schema, new Map()).some(
    (field) => field.name === BODY_FIELD,
  );
  if (write.field === BODY_FIELD && entry.hasBody === true && !schemaBody) {
    if (write.value !== undefined && typeof write.value !== 'string') {
      throw new Error('An entry’s body is text.');
    }
    writeEntry(projectPath, entry, [], { body: write.value ?? '' });
    return;
  }
  writeEntry(projectPath, entry, [{ path: [write.field], value: write.value }]);
}

async function createEntry(
  projectPath: string,
  collection: Collection,
): Promise<RemoteDocumentSummary> {
  const loader = collection.loader;
  if (loader?.kind === 'file') {
    return createRecord(projectPath, collection, String(loader.file ?? ''));
  }
  if (loader?.kind !== 'glob') {
    throw new Error(`${collection.name} is built by code; its entries cannot be added here.`);
  }
  const patterns = typeof loader.pattern === 'string' ? [loader.pattern] : (loader.pattern ?? []);
  const extension =
    EXTENSIONS.find((candidate) => patterns.some((pattern) => pattern.includes(candidate))) ?? 'md';
  const base = cmsDirectoryPath(projectPath, String(loader.base ?? ''));
  const name = freeName(base, extension);
  if (!patterns.some((pattern) => globToRegExp(pattern).test(name))) {
    throw new Error(`Stacki can’t tell where new ${collection.name} entries go.`);
  }
  const titled = astroSchemaFields(collection.schema, new Map()).some(
    (field) => field.name === 'title',
  );
  // A new collection's folder may not exist yet: Studio carries files, not empty folders.
  fs.mkdirSync(base, { recursive: true });
  createProjectText(path.join(base, name), starter(extension, { titled }));
  const entryId = name.replace(/\.[^./]+$/, '');
  const made = listEntries(projectPath, collection).entries.find((entry) => entry.id === entryId);
  assert(made !== undefined, 'A created entry is listed');
  return summaryOf(projectPath, collection.name, made);
}

// Every collection's records, for the references the config leaves undeclared.
function recordsOf(
  projectPath: string,
  collections: readonly Collection[],
): readonly RecordCollection[] {
  return collections.map((each) => ({
    name: each.name,
    entries: listEntries(projectPath, each).entries,
    imageField: firstImageField(each),
  }));
}

/** The collection's first image field: its entries' picture in lists and choices. */
function firstImageField(collection: Collection): string | undefined {
  return astroSchemaFields(collection.schema, new Map()).find(
    (field) => field.type.kind === 'string' && field.type.asset === 'image',
  )?.name;
}

// A record in the collection's data file, listed afterwards as any other.
function createRecord(
  projectPath: string,
  collection: Collection,
  file: string,
): RemoteDocumentSummary {
  const entries = listEntries(projectPath, collection).entries;
  const fields = astroSchemaFields(collection.schema, new Map());
  const added = addDataRecord(projectPath, {
    file: file.replace(/^\.\//, ''),
    entries,
    fields,
  });
  const made = listEntries(projectPath, collection).entries.find((entry) => entry.id === added.id);
  if (made === undefined) {
    throw new Error(`The new record was written but ${collection.name} does not list it.`);
  }
  return summaryOf(projectPath, collection.name, made);
}

function freeName(base: string, extension: string): string {
  for (let index = 1; index <= ENTRY_NAMES_MAX; index += 1) {
    const name = index === 1 ? `untitled.${extension}` : `untitled-${index}.${extension}`;
    if (!fs.existsSync(path.join(base, name))) {
      return name;
    }
  }
  throw new Error('Rename some untitled entries before adding another.');
}

function starter(extension: string, options: { readonly titled: boolean }): string {
  const title = options.titled ? 'Untitled' : undefined;
  switch (extension) {
    case 'json':
      return title === undefined ? '{}\n' : `{\n  "title": "${title}"\n}\n`;
    case 'yaml':
    case 'yml':
      return title === undefined ? '{}\n' : `title: ${title}\n`;
    case 'toml':
      return title === undefined ? '' : `title = "${title}"\n`;
    default:
      return title === undefined ? '---\n---\n' : `---\ntitle: ${title}\n---\n`;
  }
}

function modified(projectPath: string, file: string): string {
  const time = fs.statSync(cmsSourcePath(projectPath, file)).mtime.toISOString();
  assert(!Number.isNaN(Date.parse(time)), 'A file time is a real date');
  return time;
}

function preview(value: string): string {
  return value.slice(0, CMS_REMOTE_LIMITS.previewCharsMax);
}
