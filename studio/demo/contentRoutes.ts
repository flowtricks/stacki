// `/studio/api/cms` for a baked site's content collections. The collections and their
// entries are what Studio's own handlers answered at bake time (bakeContent.ts); an
// entry edited since reads back from its room, parsed by the same format modules the
// server writes through, and a save is those modules' edit applied to the room's text,
// so the file changes exactly as it would on disk. What needs the project's own code
// — validating against its zod schema, renaming an id every reference holds, Stacki's
// JSON data files — answers plainly instead of pretending.
import type { SnapshotContent } from '../src/features/bake/bakeSnapshot';
import * as frontmatter from '../vendor/stacki/electron/content/formats/markdownEntry';
import * as jsonFormat from '../vendor/stacki/electron/content/formats/json';
import * as yamlFormat from '../vendor/stacki/electron/content/formats/yaml';
import { entryTitleOf, titleFieldsOf } from '../vendor/stacki/shared/properties/entryTitle';
import { assert } from '../vendor/stacki/shared/core/assert';
import { record, sourcePath, string } from '../src/shared/validation';

export const CONTENT_ROUTE_REASONS = {
  rename: 'Renaming an entry changes every reference to it, so it is in the full Stacki app.',
  create: 'New entries and files are in the full Stacki app.',
  other: 'This needs the full Stacki app.',
} as const;

const EDITS_MAX = 500;
const LOCATOR_STEPS_MAX = 16;

interface FormatEdit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

interface Format {
  readonly parseData: (text: string) => unknown;
  readonly applyEdits: (text: string, edits: readonly FormatEdit[], options?: { readonly body?: string }) => string;
  readonly DELETE: symbol;
}

const FORMATS: Readonly<Record<string, Format>> = {
  md: frontmatter,
  mdx: frontmatter,
  mdoc: frontmatter,
  markdown: frontmatter,
  json: jsonFormat,
  yaml: yamlFormat,
  yml: yamlFormat,
};

export function formatOf(file: string): Format | undefined {
  return FORMATS[(file.split('.').pop() ?? '').toLowerCase()];
}

export interface ContentFiles {
  /** The file as edited, or as baked. */
  readonly read: (file: string) => string | undefined;
  readonly baked: (file: string) => string | undefined;
  readonly write: (file: string, text: string) => void;
}

/** An entry's data inside its file's data, by its locator. */
function locate(data: unknown, locator: readonly (string | number)[]): unknown {
  let value = data;
  for (const step of locator.slice(0, LOCATOR_STEPS_MAX)) {
    if (Array.isArray(value) && typeof step === 'number') {
      value = value[step];
    } else if (typeof value === 'object' && value !== null && typeof step === 'string') {
      value = Object.entries(value).find(([key]) => key === step)?.[1];
    } else {
      return undefined;
    }
  }
  return value;
}

function locatorOf(input: unknown): readonly (string | number)[] {
  if (!Array.isArray(input) || input.length > LOCATOR_STEPS_MAX) {
    return [];
  }
  return input.filter((step: unknown): step is string | number => typeof step === 'string' || (typeof step === 'number' && Number.isSafeInteger(step)));
}

/** An entry's data and body as its file reads now. */
export function entryNow(
  text: string,
  file: string,
  locator: readonly (string | number)[],
): { readonly data: unknown; readonly body: string | undefined } | undefined {
  const format = formatOf(file);
  if (format === undefined) {
    return undefined;
  }
  try {
    if (format === frontmatter) {
      const parsed = frontmatter.parse(text);
      return { data: locate(parsed.data ?? {}, locator), body: parsed.body };
    }
    return { data: locate(format.parseData(text), locator), body: undefined };
  } catch {
    return undefined; // Mid-edit text that does not parse keeps the last good listing.
  }
}

// A listing from the bake, with each entry whose file has changed read again.
function entriesNow(listing: unknown, files: ContentFiles): unknown {
  const data = record(listing);
  const collection = record(data['collection'] ?? {});
  const fields = titleFieldsOf(collection['schema']);
  const entries = Array.isArray(data['entries']) ? data['entries'] : [];
  return {
    ...data,
    entries: entries.map((input: unknown) => {
      const entry = record(input);
      const file = typeof entry['file'] === 'string' ? entry['file'] : undefined;
      const text = file === undefined ? undefined : files.read(file);
      if (file === undefined || text === undefined || text === files.baked(file)) {
        return entry;
      }
      const now = entryNow(text, file, locatorOf(entry['locator']));
      if (now === undefined) {
        return entry;
      }
      const id = typeof entry['id'] === 'string' ? entry['id'] : '';
      return { ...entry, data: now.data, ...(now.body === undefined ? {} : { body: now.body }), title: entryTitleOf(now.data, { id, fields }) };
    }),
  };
}

function writeEntry(payload: Readonly<Record<string, unknown>>, files: ContentFiles): { readonly ok: true; readonly changed: boolean } {
  const entry = record(payload['entry']);
  const file = sourcePath(entry['file']);
  const format = formatOf(file);
  const text = files.read(file);
  if (format === undefined || text === undefined) {
    throw new Error(`${file} is not an entry this demo can save.`);
  }
  const locator = locatorOf(entry['locator']);
  const edits = Array.isArray(payload['edits']) ? payload['edits'] : [];
  if (edits.length > EDITS_MAX) {
    throw new Error('Too many edits in one save.');
  }
  const prefixed: FormatEdit[] = edits.map((input: unknown) => {
    const edit = record(input);
    const path = [...locator, ...locatorOf(edit['path'])];
    // A rename names a key and carries no value; it must not read as a value cleared.
    if (typeof edit['rename'] === 'string') {
      return { path, rename: edit['rename'] };
    }
    return { path, value: 'value' in edit && edit['value'] !== undefined ? edit['value'] : format.DELETE };
  });
  const body = typeof payload['body'] === 'string' ? payload['body'] : undefined;
  const next = format === frontmatter && body !== undefined ? frontmatter.applyEdits(text, prefixed, { body }) : format.applyEdits(text, prefixed);
  if (next === text) {
    return { ok: true, changed: false };
  }
  files.write(file, next);
  assert(files.read(file) === next, 'A saved entry reads back as written');
  return { ok: true, changed: true };
}

/** The handler's answer for one operation, or an error the client shows as it is. */
export function contentOperation(content: SnapshotContent | undefined, operation: string, payload: unknown, files: ContentFiles): unknown {
  const input = typeof payload === 'object' && payload !== null ? record(payload) : {};
  switch (operation) {
    case 'content:collections':
      return content?.collections ?? { collections: [], missing: true };
    case 'content:entries': {
      const listing = content?.entries[string(input['name'], 200)];
      if (listing === undefined) {
        throw new Error('This collection is not part of the demo.');
      }
      return entriesNow(listing, files);
    }
    case 'content:targets': {
      const listing = record(entriesNow(content?.entries[string(input['name'], 200)] ?? {}, files));
      const entries = Array.isArray(listing['entries']) ? listing['entries'] : [];
      return { targets: entries.map((entry: unknown) => ({ id: record(entry)['id'], title: record(entry)['title'] })) };
    }
    case 'content:writeEntry':
      return writeEntry(input, files);
    case 'content:remoteRead':
      return remoteRead(content, record(input['request'] ?? {}), files);
    case 'content:remoteEdit':
      return remoteEdit(content, record(input['request'] ?? {}), files);
    case 'content:validate':
      // The schema is the project's own zod, which only the build can run.
      return { issues: [], unchecked: true };
    case 'cms:list':
      return { files: [] };
    case 'content:renamePlan':
    case 'content:rename':
      throw new Error(CONTENT_ROUTE_REASONS.rename);
    case 'cms:create':
      throw new Error(CONTENT_ROUTE_REASONS.create);
    default:
      throw new Error(CONTENT_ROUTE_REASONS.other);
  }
}

type RemoteResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

function refused(message: string): RemoteResult {
  return { ok: false, message };
}

/** The value inside a baked answer, which the handler wrapped as `{ ok, value }`. */
function valueOf(answer: unknown): unknown {
  const data = typeof answer === 'object' && answer !== null ? record(answer) : {};
  return data['ok'] === true ? data['value'] : undefined;
}

// The data and body an entry has now, when its file has changed since the bake.
function edited(content: SnapshotContent, id: string, files: ContentFiles): { readonly data: unknown; readonly body: string | undefined } | undefined {
  const ref = content.remote.files[id];
  const text = ref === undefined ? undefined : files.read(ref.file);
  if (ref === undefined || text === undefined || text === files.baked(ref.file)) {
    return undefined;
  }
  return entryNow(text, ref.file, ref.locator);
}

function fieldValue(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null ? Object.entries(data).find(([key]) => key === name)?.[1] : undefined;
}

// A baked document with each field's value read again from the entry as it is now.
function documentNow(content: SnapshotContent, id: string, files: ContentFiles): RemoteResult {
  const baked = content.remote.document[id];
  const value = valueOf(baked);
  if (value === undefined) {
    return refused('This entry is not part of the demo.');
  }
  const now = edited(content, id, files);
  if (now === undefined) {
    return { ok: true, value };
  }
  const document = record(value);
  const fields = Array.isArray(document['fields']) ? document['fields'] : [];
  return {
    ok: true,
    value: {
      ...document,
      fields: fields.map((input: unknown) => {
        const field = record(input);
        const name = typeof field['name'] === 'string' ? field['name'] : '';
        const own = fieldValue(now.data, name);
        const next = own === undefined && name === BODY_FIELD ? now.body : own;
        const { value: _old, ...rest } = field;
        return next === undefined ? rest : { ...rest, value: next };
      }),
    },
  };
}

const BODY_FIELD = 'body';

function documentsNow(content: SnapshotContent, collection: string, files: ContentFiles): RemoteResult {
  const value = valueOf(content.remote.documents[collection]);
  if (value === undefined) {
    return refused(`${collection} is not a collection in this demo.`);
  }
  const listing = record(content.entries[collection] ?? {});
  const fields = titleFieldsOf(record(listing['collection'] ?? {})['schema']);
  const list = record(value);
  const documents = Array.isArray(list['documents']) ? list['documents'] : [];
  return {
    ok: true,
    value: {
      ...list,
      documents: documents.map((input: unknown) => {
        const summary = record(input);
        const id = typeof summary['id'] === 'string' ? summary['id'] : '';
        const now = edited(content, id, files);
        const slug = typeof summary['subtitle'] === 'string' ? summary['subtitle'] : id;
        return now === undefined ? summary : { ...summary, title: entryTitleOf(now.data, { id: slug, fields }) };
      }),
    },
  };
}

function remoteRead(content: SnapshotContent | undefined, request: Readonly<Record<string, unknown>>, files: ContentFiles): RemoteResult {
  if (content === undefined) {
    return refused('This site has no content collections the demo could read.');
  }
  const collection = typeof request['collection'] === 'string' ? request['collection'] : '';
  switch (request['operation']) {
    case 'collections':
      return { ok: true, value: valueOf(content.remote.collections) ?? [] };
    case 'documents':
      return documentsNow(content, collection, files);
    case 'document':
      return documentNow(content, string(request['id'], 128), files);
    case 'template':
      return { ok: true, value: valueOf(content.remote.templates[collection]) };
    case 'settings':
      return { ok: true, value: valueOf(content.remote.settings[collection]) };
    default:
      return refused(CONTENT_ROUTE_REASONS.other);
  }
}

function remoteEdit(content: SnapshotContent | undefined, request: Readonly<Record<string, unknown>>, files: ContentFiles): RemoteResult {
  if (content === undefined) {
    return refused('This site has no content collections the demo could read.');
  }
  switch (request['operation']) {
    case 'write': {
      const write = record(request['write']);
      const id = string(write['id'], 128);
      const field = string(write['field'], 64);
      const ref = content.remote.files[id];
      if (ref === undefined) {
        return refused('This entry is not part of the demo.');
      }
      const text = files.read(ref.file);
      const isBody =
        field === BODY_FIELD &&
        formatOf(ref.file) === frontmatter &&
        text !== undefined &&
        fieldValue(entryNow(text, ref.file, ref.locator)?.data, BODY_FIELD) === undefined;
      const value = write['value'];
      writeEntry(
        isBody
          ? { entry: { file: ref.file, locator: ref.locator }, edits: [], body: typeof value === 'string' ? value : '' }
          : { entry: { file: ref.file, locator: ref.locator }, edits: [{ path: [field], value }] },
        files,
      );
      return documentNow(content, id, files);
    }
    case 'rename':
      return refused(CONTENT_ROUTE_REASONS.rename);
    case 'create':
    case 'createCollection':
      return refused(CONTENT_ROUTE_REASONS.create);
    default:
      return refused(CONTENT_ROUTE_REASONS.other);
  }
}
