// Reading a project's local EmDash database, and only reading it. EmDash keeps its content types and its
// entries in SQLite for a local site (`data.db`); the person's customer content lives in a different,
// production database that Stacki never sees. The file is opened with `readOnly: true`, so SQLite itself
// refuses a write, and every statement here is a fixed SELECT: the only text spliced into SQL is a table or
// column name that `identifier` has proved is a plain EmDash slug.
//
// `node:sqlite` is Node's own module (EmDash itself uses it), loaded on first use so a project without
// EmDash never pays for it.

import { assert } from '../../shared/core/assert';
import { EMDASH_LIMITS, isEmDashCollectionSlug, type EmDashEntrySummary } from '../../shared/properties/emdash';
import { toRecord } from '../../shared/core/record';

const ROWS_MAX = 5_000;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

async function withDatabase<T>(file: string, read: (query: (sql: string, parameters?: readonly (string | number)[]) => unknown[]) => T): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return read((sql, parameters = []) => {
      assert(/^\s*SELECT\b/i.test(sql), 'The EmDash database is only read');
      const rows = database.prepare(sql).all(...parameters);
      assert(rows.length <= ROWS_MAX, 'A read of the EmDash database is bounded');
      return rows;
    });
  } finally {
    database.close();
  }
}

/** Whether the file is an EmDash database: it holds the schema registry table. */
export async function isEmDashDatabase(file: string): Promise<boolean> {
  try {
    return await withDatabase(
      file,
      (query) => query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_emdash_collections' LIMIT 1").length === 1,
    );
  } catch {
    return false;
  }
}

/**
 * The content types EmDash stores, in the shape of its schema export (`{ collections: [{ slug, fields }] }`),
 * ready for `parseEmDashSchema`. `_emdash_collections` and `_emdash_fields` are EmDash's own registry tables;
 * a field's `validation` is JSON text (select choices, the relation of a reference), parsed here.
 */
export async function readEmDashSchemaRows(file: string): Promise<unknown> {
  return withDatabase(file, (query) => {
    const collections = query('SELECT * FROM _emdash_collections ORDER BY slug LIMIT 1000');
    const fields = query('SELECT * FROM _emdash_fields ORDER BY collection_id, sort_order LIMIT 5000');
    const byCollection = new Map<string, unknown[]>();
    for (const row of fields) {
      const field = toRecord(row);
      const owner = field?.['collection_id'];
      if (field === undefined || typeof owner !== 'string') {
        continue;
      }
      const bucket = byCollection.get(owner) ?? [];
      bucket.push({ ...field, validation: parseJsonColumn(field['validation']), required: field['required'] === 1 });
      byCollection.set(owner, bucket);
    }
    return {
      collections: collections.map((row) => {
        const collection = toRecord(row) ?? {};
        const id = collection['id'];
        return {
          slug: collection['slug'],
          label: collection['label'],
          labelSingular: collection['label_singular'] ?? undefined,
          urlPattern: collection['url_pattern'] ?? undefined,
          fields: typeof id === 'string' ? (byCollection.get(id) ?? []) : [],
        };
      }),
    };
  });
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function identifier(name: string): string {
  assert(IDENTIFIER.test(name), 'A table or column name is an EmDash slug');
  return name;
}

/**
 * The published entries of a collection, newest first: the ones the live site shows, which is what
 * `getEmDashCollection` returns by default. `titleField` is the field that names an entry in a picker; when
 * the table has no such column the slug names it. Drafts and deleted entries are left out, so the preview
 * list matches the pages EmDash would serve.
 */
export async function readEmDashEntries(file: string, collection: string, titleField: string | undefined): Promise<readonly EmDashEntrySummary[]> {
  assert(isEmDashCollectionSlug(collection), 'An entry list names a collection');
  const table = `ec_${identifier(collection)}`;
  return withDatabase(file, (query) => {
    const columns = query(`SELECT name FROM pragma_table_info('${table}')`)
      .map((row) => toRecord(row)?.['name'])
      .filter((name): name is string => typeof name === 'string');
    if (!columns.includes('slug')) {
      return [];
    }
    const title = titleField !== undefined && columns.includes(titleField) ? identifier(titleField) : 'slug';
    const filters = [columns.includes('status') ? "status = 'published'" : '1 = 1', columns.includes('deleted_at') ? 'deleted_at IS NULL' : '1 = 1'];
    const order = columns.includes('created_at') ? 'created_at DESC' : 'rowid DESC';
    const rows = query(`SELECT slug, ${title} AS title FROM ${table} WHERE ${filters.join(' AND ')} ORDER BY ${order} LIMIT ?`, [EMDASH_LIMITS.entriesMax]);
    const seen = new Set<string>();
    const entries: EmDashEntrySummary[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      const slug = record?.['slug'];
      const named = record?.['title'];
      if (typeof slug !== 'string' || slug.length === 0 || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      entries.push({ slug, title: typeof named === 'string' && named.length > 0 ? named.slice(0, EMDASH_LIMITS.labelCharsMax) : slug });
    }
    return entries;
  });
}
