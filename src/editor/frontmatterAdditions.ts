// What a pick from the binding picker adds to a file's frontmatter before it
// binds: the `getCollection` query a project collection is read through, or
// the import of a data file's export (`import { SITE } from '@/consts'`).
//
// Both hosts write it through their own frontmatter edit path — Desktop as a
// frontmatter gesture held for the field's own edit (appPageOps.ts), Studio as
// a source change joined to the field's (studio Settings.tsx) — so the
// addition and the binding are one undo step. This module is the part they
// share: what the model reads after the addition, and the name the binding
// then names.
//
// Imports are added to the model's list, never printed here: the shared
// frontmatter writer (writeFrontmatter) joins a named import to an existing
// `import { … }` of the same module and leaves every other line as written.

import { assert } from '../../shared/core/assert';
import { autoQueryName, namesInScope, queriesInScope, QUERY_MARK } from './dataScope';
import type { ImportNeed } from './dataSample';
import type { EditorModel } from './pageView';

/** The frontmatter part of a page model these additions read and write. */
export type FrontmatterPart = Pick<EditorModel, 'imports' | 'extraFrontmatter'>;

/** A model after an addition, and the name the binding reads the added value by. */
export interface FrontmatterAddition<M extends FrontmatterPart> {
  readonly model: M;
  readonly name: string;
}

// Alias suffixes tried for an import whose name the file already uses (`SITE2`, `SITE3`, and on).
const ALIAS_SUFFIX_MAX = 100;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The model with `collection` read by a marked `getCollection` query, and the
 * name the query is under. A query already reading that collection is reused:
 * one page asking the same content twice is the same work twice.
 */
export function withCollectionQuery<M extends FrontmatterPart>(model: M, collection: string): FrontmatterAddition<M> {
  assert(/^[A-Za-z0-9_$-]+$/.test(collection), 'withCollectionQuery: a collection name');
  const fm = model.extraFrontmatter || '';
  const existing = queriesInScope(fm).get(collection);
  if (existing !== undefined) {
    return { model, name: existing };
  }
  const name = autoQueryName(collection, namesInScope(fm, model.imports));
  const reads = model.imports.some((entry) => entry.name === 'getCollection' && entry.path === 'astro:content');
  const entry = { name: 'getCollection', imported: 'getCollection', path: 'astro:content', quote: "'", named: true };
  const gap = fm && !fm.endsWith('\n') ? '\n' : '';
  // No trailing newline: the printer ends the line, and one added here would
  // be left behind as a blank line when the query is taken back.
  const query = `const ${name} = await getCollection('${collection}'); // ${QUERY_MARK}`;
  const imports = reads ? model.imports : [...model.imports, entry];
  const next = { ...model, imports, extraFrontmatter: `${fm}${gap}${query}` };
  assert(queriesInScope(next.extraFrontmatter).get(collection) === name, 'withCollectionQuery: the query reads the collection under its name');
  return { model: next, name };
}

/**
 * The model with `need` imported, and the name it is read by. An import of
 * the same export from the same module is reused. Otherwise the export is
 * read under `need.name`, or, when the file already uses that name, under the
 * first free `name2`, `name3`… (`import { SITE as SITE2 }`). Quotes follow the
 * module's existing import, else the file's first import.
 */
export function withDataImport<M extends FrontmatterPart>(model: M, need: ImportNeed): FrontmatterAddition<M> {
  assert(need.spec.length > 0, 'withDataImport: the module is named');
  assert(IDENTIFIER.test(need.name), 'withDataImport: the local name is an identifier');
  const named = need.exported !== 'default';
  const existing = model.imports.find((entry) => entry.path === need.spec && sameExport(entry, need.exported));
  if (existing !== undefined) {
    return { model, name: existing.name };
  }
  const taken = namesInScope(model.extraFrontmatter || '', model.imports);
  const name = freeName(need.name, taken);
  const quote = (model.imports.find((entry) => entry.path === need.spec) ?? model.imports[0])?.quote === '"' ? '"' : "'";
  const entry = named ? { name, imported: need.exported, path: need.spec, quote, named: true } : { name, path: need.spec, quote };
  const next = { ...model, imports: [...model.imports, entry] };
  assert(next.imports.length === model.imports.length + 1, 'withDataImport: one import is added');
  return { model: next, name };
}

// Whether `entry` reads `exported`; a JSON file's data is its `default` export.
function sameExport(entry: FrontmatterPart['imports'][number], exported: string): boolean {
  if (entry.typeOnly === true) {
    return false;
  }
  if (exported !== 'default') {
    return entry.named === true && (entry.imported ?? entry.name) === exported;
  }
  return entry.named !== true;
}

/** `wanted` when nothing in `taken` has it, else the first numbered alias that is free. */
export function freeName(wanted: string, taken: ReadonlySet<string>): string {
  assert(IDENTIFIER.test(wanted), 'freeName: the name is an identifier');
  if (!taken.has(wanted)) {
    return wanted;
  }
  for (let suffix = 2; suffix <= ALIAS_SUFFIX_MAX; suffix++) {
    const candidate = `${wanted}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No free name for ${wanted}: ${wanted}2 to ${wanted}${ALIAS_SUFFIX_MAX} are all taken`);
}
