// Reading and writing a connected CMS from the CMS panel: its collections (in
// Sanity, document types), the documents in one, and one document's fields.
// Every write is a draft; nothing here publishes. The connection's key stays in
// the main process (or Studio's server): requests name the connection by id.
//
// Every field is editable, by its type (cmsRemoteSchema.ts); a write sets one
// top-level field's whole value, or removes it. Images and files are uploaded
// to the CMS first and written as references to the stored asset.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseConnectionId } from './cmsConnections';
import { parseEntrySlug, type EntrySlug } from './entrySlug';
import { parseProjectFile, parseRemoteSchemaField, parseRemoteValue, type RemoteSchemaField, type RemoteValue } from './cmsRemoteSchema';

export const CMS_REMOTE_LIMITS = {
  collectionsMax: 200,
  documentsMax: 500,
  /** Fields a list shows as columns beside each item's name. */
  columnsMax: 12,
  /** How far into a value a column looks for its line: a list of named things. */
  cellDepthMax: 2,
  fieldsMax: 200,
  assetsMax: 500,
  revisionsMax: 100,
  referenceTypesMax: 24,
  previewCharsMax: 200,
  /** Tabs a document's fields are split into (Sanity's `groups`). */
  fieldGroupsMax: 24,
} as const;

export interface RemoteCollection {
  readonly name: string;
  readonly count: number;
  /** The `@sanity/icons` symbol its schema names (`user`), when it names one. */
  readonly icon: string | undefined;
}

/** A field's value as a list's column shows it: a line of text, a number, or a switch. */
export type RemoteCell = string | number | boolean;

export type RemoteStatus = 'draft' | 'published' | 'changed';

export interface RemoteDocumentSummary {
  /** The published id, which names the document whether or not it has a draft. */
  readonly id: string;
  readonly title: string;
  /** The line under its title in a list, as the CMS's own list shows it. */
  readonly subtitle: string | undefined;
  /** Its picture in a list, when its type shows one. */
  readonly imageURL: string | undefined;
  /** Its picture as a project file (an Astro entry's first image), relative to the project. */
  readonly imageFile?: string;
  /** The fields a list shows as columns, by name, each as a short value to read and sort by. */
  readonly cells?: Readonly<Record<string, RemoteCell>>;
  readonly status: RemoteStatus;
  readonly updatedAt: string;
}

/**
 * One collection's documents, in the CMS's own order where it keeps one. In
 * Sanity that is the orderable-document-list plugin's `orderRank`: a collection
 * whose documents all carry one is `orderable`, listed in that order, and can be
 * dragged into a new one.
 */
export interface RemoteDocumentList {
  readonly documents: readonly RemoteDocumentSummary[];
  readonly orderable: boolean;
}

/** A drag: `id` lands between `after` and `before`; either is absent at an end. */
export interface RemoteMove {
  readonly collection: string;
  readonly id: string;
  readonly after: string | undefined;
  readonly before: string | undefined;
}

/** A document's field: its schema, and the document's value for it, if any. */
export interface RemoteDocumentField extends RemoteSchemaField {
  readonly value: RemoteValue | undefined;
  /** The tabs it shows under besides all fields (its schema's `group`); absent shows it under all fields only. */
  readonly groups?: readonly string[];
}

/** One tab of a document's fields, from its schema's `groups`, as Sanity Studio shows it. */
export interface RemoteFieldGroup {
  readonly name: string;
  readonly title: string;
}

/** A stored image or file a document points at, by its asset id. */
export interface RemoteAsset {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
}

/** One saved change in a document's history, newest first in a list. */
export interface RemoteRevision {
  /** The transaction that made it; the document as it stood after it can be restored. */
  readonly id: string;
  readonly timestamp: string;
  readonly author: string;
}

/**
 * What the item header does to a whole document, as Sanity Studio's own
 * buttons do: publish its draft, discard its draft, or take it off the site.
 */
export type RemoteDocumentAction = 'publish' | 'discard' | 'unpublish';

/** A document a reference field may point at. */
export interface RemoteReferenceOption {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** Its picture, from its type's preview `media`, as the Studio's reference row shows it. */
  readonly imageURL: string | undefined;
}

export interface RemoteDocument {
  readonly id: string;
  readonly type: string;
  readonly status: RemoteStatus;
  readonly fields: readonly RemoteDocumentField[];
  /** The images and files its fields point at, with their addresses. */
  readonly assets: readonly RemoteAsset[];
  /** When its unpublished draft was last edited; absent when it has no draft. */
  readonly editedAt: string | undefined;
  /** When the published document last changed; absent when it was never published. */
  readonly publishedAt: string | undefined;
  /** Where the document opens in the CMS's own editor, when that is known. */
  readonly editURL: string | undefined;
  /**
   * The tabs its fields are split into, when its schema groups them: each
   * group that holds a field, in schema order. All fields always come first.
   */
  readonly fieldGroups?: readonly RemoteFieldGroup[];
  /**
   * The project file it is stored in, relative to the project, when it is one
   * (an Astro content entry): its image paths are relative to that file's folder.
   */
  readonly file?: string;
  /** An Astro content entry's id, as its Slug field edits it (entrySlug.ts); a CMS document has none. */
  readonly slug?: EntrySlug;
}

export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** One top-level field's new value; `undefined` removes the field. */
export interface RemoteWrite {
  readonly id: string;
  readonly field: string;
  readonly value: RemoteValue | undefined;
}

// Letters, digits, `_` and `-`: Astro content keys are often kebab case
// (`campus-description`), and exported ones may start with a digit (`1-logo-svg`).
/**
 * The id of a collection's template: its fields with no values, edited before
 * an item is created. No stored document has it; creating gives the real one.
 */
export const REMOTE_TEMPLATE_ID = 'new-item';

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

export function parseRemoteCollectionName(input: unknown): string {
  const name = text(input);
  if (!/^[A-Za-z_][\w.-]{0,127}$/.test(name)) {
    throw new Error('Invalid CMS collection name.');
  }
  assert(name.length <= 128, 'A collection name is short');
  return name;
}

/** A published document id: never a draft or version id, which the server derives. */
export function parseRemoteDocumentId(input: unknown): string {
  const id = text(input);
  if (!/^[\w][\w.-]{0,127}$/.test(id) || id.startsWith('drafts.') || id.startsWith('versions.')) {
    throw new Error('Invalid CMS document id.');
  }
  assert(!id.startsWith('drafts.'), 'A document is named by its published id');
  return id;
}

export function parseRemoteFieldName(input: unknown): string {
  const name = text(input);
  if (!IDENTIFIER.test(name) || name.startsWith('_')) {
    throw new Error('Invalid field name.');
  }
  assert(name.length <= 64, 'A field name is short');
  return name;
}

export function parseRemoteWrite(input: unknown): RemoteWrite {
  const value = record(input);
  return {
    id: parseRemoteDocumentId(value['id']),
    field: parseRemoteFieldName(value['field']),
    value: parseRemoteValue(value['value']),
  };
}

export const parseRemoteConnection = parseConnectionId;

export function parseRemoteResult<T>(input: unknown, parseValue: (value: unknown) => T): RemoteResult<T> {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, value: parseValue(value['value']) };
  }
  const message = text(value['message']);
  assert(message.length > 0, 'A CMS failure says what went wrong');
  assert(message.length <= 1000, 'A CMS failure message is short');
  return { ok: false, message };
}

export function parseRemoteCollections(input: unknown): RemoteCollection[] {
  return boundedList(input, CMS_REMOTE_LIMITS.collectionsMax).map((entry) => {
    const value = record(entry);
    const count = value['count'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid collection count.');
    }
    const icon = value['icon'];
    if (icon !== undefined && (typeof icon !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(icon))) {
      throw new Error('Invalid collection icon.');
    }
    return { name: parseRemoteCollectionName(value['name']), count, icon };
  });
}

export function parseRemoteDocuments(input: unknown): RemoteDocumentSummary[] {
  return boundedList(input, CMS_REMOTE_LIMITS.documentsMax).map((entry) => {
    const value = record(entry);
    return {
      id: parseRemoteDocumentId(value['id']),
      title: preview(value['title']),
      subtitle: value['subtitle'] === undefined ? undefined : preview(value['subtitle']),
      imageURL: value['imageURL'] === undefined ? undefined : parseHTTPS(value['imageURL']),
      ...(value['imageFile'] === undefined ? {} : { imageFile: parseProjectFile(value['imageFile']) }),
      status: parseStatus(value['status']),
      updatedAt: preview(value['updatedAt']),
      ...(value['cells'] === undefined ? {} : { cells: parseCells(value['cells']) }),
    };
  });
}

/** The fields a list asks to show as columns: field names, a few, no repeats. */
export function parseRemoteColumns(input: unknown): readonly string[] {
  const columns = boundedList(input, CMS_REMOTE_LIMITS.columnsMax).map(parseRemoteFieldName);
  if (new Set(columns).size !== columns.length) {
    throw new Error('A column is named twice.');
  }
  assert(columns.length <= CMS_REMOTE_LIMITS.columnsMax, 'A list shows few columns');
  return columns;
}

function parseCells(input: unknown): Readonly<Record<string, RemoteCell>> {
  const value = record(input);
  const entries = Object.entries(value);
  if (entries.length > CMS_REMOTE_LIMITS.columnsMax) {
    throw new Error('Too many columns.');
  }
  const cells: Record<string, RemoteCell> = {};
  for (const [name, cell] of entries) {
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      cells[parseRemoteFieldName(name)] = cell;
    } else if (typeof cell === 'boolean') {
      cells[parseRemoteFieldName(name)] = cell;
    } else {
      cells[parseRemoteFieldName(name)] = preview(cell);
    }
  }
  assert(Object.keys(cells).length === entries.length, 'Every cell parses');
  return cells;
}

/**
 * A stored value as a column shows it: text and numbers as they are, a switch
 * as one, a slug or a referenced document by its name, a list by its items'
 * names. Anything else — an image, a nested group — has no line to show.
 */
export function remoteCell(value: unknown, depth = 0): RemoteCell | undefined {
  assert(depth <= CMS_REMOTE_LIMITS.cellDepthMax, 'A cell looks into a value boundedly');
  if (typeof value === 'string') {
    return value.length > CMS_REMOTE_LIMITS.previewCharsMax ? value.slice(0, CMS_REMOTE_LIMITS.previewCharsMax) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (depth >= CMS_REMOTE_LIMITS.cellDepthMax) {
      return undefined;
    }
    const names = items
      .slice(0, CMS_REMOTE_LIMITS.columnsMax)
      .map((item) => remoteCell(item, depth + 1))
      .filter((cell) => cell !== undefined);
    return names.length === 0 ? undefined : remoteCell(names.join(', '), depth + 1);
  }
  if (typeof value === 'object' && value !== null && depth < CMS_REMOTE_LIMITS.cellDepthMax) {
    const named = ['current', 'title', 'name', 'label'].map((key): unknown => Reflect.get(value, key));
    const first = named.find((part) => typeof part === 'string');
    return first === undefined ? undefined : remoteCell(first, depth + 1);
  }
  return undefined;
}

export function parseRemoteDocument(input: unknown): RemoteDocument {
  const value = record(input);
  const editURL = value['editURL'];
  return {
    id: parseRemoteDocumentId(value['id']),
    type: parseRemoteCollectionName(value['type']),
    status: parseStatus(value['status']),
    fields: boundedList(value['fields'], CMS_REMOTE_LIMITS.fieldsMax).map(parseField),
    assets: parseRemoteAssets(value['assets']),
    editedAt: optionalTime(value['editedAt']),
    publishedAt: optionalTime(value['publishedAt']),
    editURL: editURL === undefined ? undefined : parseHTTPS(editURL),
    ...(value['fieldGroups'] === undefined ? {} : { fieldGroups: parseRemoteFieldGroups(value['fieldGroups']) }),
    ...(value['file'] === undefined ? {} : { file: parseProjectFile(value['file']) }),
    ...(value['slug'] === undefined ? {} : { slug: parseEntrySlug(value['slug']) }),
  };
}

function parseField(input: unknown): RemoteDocumentField {
  const value = record(input);
  const field = parseRemoteSchemaField(value);
  assert(!field.name.startsWith('_'), 'System keys are not fields');
  const groups = value['groups'];
  return {
    ...field,
    value: parseRemoteValue(value['value']),
    ...(groups === undefined ? {} : { groups: boundedList(groups, CMS_REMOTE_LIMITS.fieldGroupsMax).map(parseGroupName) }),
  };
}

export function parseRemoteFieldGroups(input: unknown): RemoteFieldGroup[] {
  const groups = boundedList(input, CMS_REMOTE_LIMITS.fieldGroupsMax).map((entry) => {
    const group = record(entry);
    const title = text(group['title']);
    if (title.length === 0 || title.length > CMS_REMOTE_LIMITS.previewCharsMax) {
      throw new Error('Invalid field group title.');
    }
    return { name: parseGroupName(group['name']), title };
  });
  const names = groups.map((group) => group.name);
  if (new Set(names).size !== names.length) {
    throw new Error('A field group is named twice.');
  }
  assert(groups.length <= CMS_REMOTE_LIMITS.fieldGroupsMax, 'A document has few field groups');
  assert(new Set(names).size === groups.length, 'Each tab is named once');
  return groups;
}

// A group's name as a schema writes it: `pastor`, `seo`, `main-details`.
function parseGroupName(input: unknown): string {
  const name = text(input);
  if (!/^[A-Za-z_][\w-]{0,63}$/.test(name)) {
    throw new Error('Invalid field group name.');
  }
  assert(name.length <= 64, 'A group name is short');
  return name;
}

export function parseRemoteAsset(input: unknown): RemoteAsset {
  const value = record(input);
  const id = text(value['id']);
  if (!/^(image|file)-[\w-]{1,200}$/.test(id)) {
    throw new Error('Invalid asset id.');
  }
  const filename = text(value['filename']);
  assert(filename.length <= 1000, 'An asset file name is bounded');
  return { id, url: parseHTTPS(value['url']), filename };
}

export function parseRemoteAssets(input: unknown): RemoteAsset[] {
  return boundedList(input, CMS_REMOTE_LIMITS.assetsMax).map(parseRemoteAsset);
}

export function parseRemoteReferenceOptions(input: unknown): RemoteReferenceOption[] {
  return boundedList(input, CMS_REMOTE_LIMITS.documentsMax).map((entry) => {
    const value = record(entry);
    return {
      id: parseRemoteDocumentId(value['id']),
      type: parseRemoteCollectionName(value['type']),
      title: preview(value['title']),
      imageURL: value['imageURL'] === undefined ? undefined : parseHTTPS(value['imageURL']),
    };
  });
}

/** The document types a reference may point at: a few names, at least one. */
export function parseRemoteTypes(input: unknown): readonly string[] {
  const types = boundedList(input, CMS_REMOTE_LIMITS.referenceTypesMax).map(parseRemoteCollectionName);
  assert(types.length <= CMS_REMOTE_LIMITS.referenceTypesMax, 'Reference types are bounded');
  return types;
}

export type RemoteAssetKind = 'image' | 'file';

export function parseRemoteDocumentAction(input: unknown): RemoteDocumentAction {
  if (input === 'publish' || input === 'discard' || input === 'unpublish') {
    return input;
  }
  throw new Error('Unknown document action.');
}

/** A history transaction id: Sanity's are short, letters, digits and dashes. */
export function parseRemoteRevisionId(input: unknown): string {
  const id = text(input);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    throw new Error('Invalid revision id.');
  }
  assert(id.length <= 64, 'A revision id is short');
  return id;
}

export function parseRemoteRevisions(input: unknown): RemoteRevision[] {
  return boundedList(input, CMS_REMOTE_LIMITS.revisionsMax).map((entry) => {
    const value = record(entry);
    return {
      id: parseRemoteRevisionId(value['id']),
      timestamp: preview(value['timestamp']),
      author: preview(value['author']),
    };
  });
}

/** An action's result: the document as it now stands, or none when the action removed it. */
export function parseRemoteActedDocument(input: unknown): RemoteDocument | undefined {
  return input === undefined ? undefined : parseRemoteDocument(input);
}

export function parseRemoteAssetKind(input: unknown): RemoteAssetKind {
  if (input === 'image' || input === 'file') {
    return input;
  }
  throw new Error('Expected an image or a file.');
}

// An ISO time, or absent; anything else is refused rather than shown as a date.
function optionalTime(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = text(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || value.length > 40) {
    throw new Error('Invalid CMS time.');
  }
  assert(!Number.isNaN(Date.parse(value)), 'A CMS time is a real date');
  return value;
}

function parseStatus(input: unknown): RemoteStatus {
  if (input === 'draft' || input === 'published' || input === 'changed') {
    return input;
  }
  throw new Error('Invalid document status.');
}

function parseHTTPS(input: unknown): string {
  const url = new URL(text(input));
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Invalid CMS editor address.');
  }
  assert(url.protocol === 'https:', 'A CMS editor opens over https');
  return url.toString();
}

function preview(input: unknown): string {
  const value = text(input);
  const shown = value.length > CMS_REMOTE_LIMITS.previewCharsMax ? value.slice(0, CMS_REMOTE_LIMITS.previewCharsMax) : value;
  assert(shown.length <= CMS_REMOTE_LIMITS.previewCharsMax, 'A preview is cut to its bound');
  return shown;
}

function boundedList(input: unknown, max: number): unknown[] {
  assert(Number.isSafeInteger(max), 'A list bound is a whole number');
  assert(max > 0, 'A list bound allows at least one item');
  if (!Array.isArray(input)) {
    throw new Error('Expected a list.');
  }
  if (input.length > max) {
    throw new Error('Too many items.');
  }
  return input;
}

export function parseRemoteDocumentList(input: unknown): RemoteDocumentList {
  const value = record(input);
  const orderable = value['orderable'];
  if (typeof orderable !== 'boolean') {
    throw new Error('Expected whether the collection is ordered.');
  }
  const documents = parseRemoteDocuments(value['documents']);
  assert(documents.length <= CMS_REMOTE_LIMITS.documentsMax, 'A document list stays bounded');
  return { documents, orderable };
}

/** The documents a delete names: published ids, at most a page of them, no repeats. */
export function parseRemoteIds(input: unknown): readonly string[] {
  const ids = boundedList(input, CMS_REMOTE_LIMITS.documentsMax).map(parseRemoteDocumentId);
  if (ids.length === 0) {
    throw new Error('Choose at least one document.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('A document is named twice.');
  }
  assert(ids.length <= CMS_REMOTE_LIMITS.documentsMax, 'A delete names at most a page');
  assert(!ids.some((id) => id.startsWith('drafts.')), 'A delete names published ids');
  return ids;
}

export function parseRemoteMove(input: unknown): RemoteMove {
  const value = record(input);
  const id = parseRemoteDocumentId(value['id']);
  const after = value['after'] === undefined ? undefined : parseRemoteDocumentId(value['after']);
  const before = value['before'] === undefined ? undefined : parseRemoteDocumentId(value['before']);
  if (after === id || before === id) {
    throw new Error('A document cannot move next to itself.');
  }
  if (after !== undefined && after === before) {
    throw new Error('A move needs two different neighbours.');
  }
  assert(id !== after, 'A move names a neighbour other than itself');
  assert(id !== before, 'A move names a neighbour other than itself');
  return { collection: parseRemoteCollectionName(value['collection']), id, after, before };
}
