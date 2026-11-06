// The template form's decisions, apart from drawing it: what each field defaults
// to, and how a half-filled form becomes a draft or one plain sentence saying
// what to fix. Pure, so every message can be pinned by a test.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { parseAstroCollectionName } from '../../../shared/properties/astroContent';
import type { CmsConnection } from '../../../shared/properties/cmsConnections';
import {
  PAGE_TEMPLATE_LIMITS,
  SANITY_TOKEN_ENV,
  dataPathSegments,
  parseEnvName,
  parsePageTemplateDraft,
  parseSourceURL,
  parseTemplateRoute,
  type ConnectionKeyCopy,
  type DatasetAccess,
  type EnvStatus,
  type HeaderScheme,
  type PageTemplateDraft,
  type SampleField,
  type SampleList,
  type SlugTreatment,
  type SourceHeader,
  type TemplateField,
} from '../../../shared/properties/pageTemplate';

export type SanityConnection = Extract<CmsConnection, { readonly kind: 'sanity' }>;

export const SOURCE_KINDS = ['content-collection', 'sanity', 'http-json'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The collection dropdown's value that opens the new-collection field. */
export const NEW_COLLECTION = '\u0000new';
/** The slug dropdown's value for an entry's own id. */
export const ENTRY_ID = '\u0000id';

/** What a designer reads when something failed that no form value could cause. */
export const UNEXPECTED_FAILURE = 'Something went wrong on Stacki’s side. Restart Stacki and try again.';

export interface HeaderRow {
  readonly name: string;
  readonly env: string;
  readonly scheme: HeaderScheme;
}

export interface TemplateForm {
  readonly kind: SourceKind;
  readonly route: string;
  /** Whether the route was typed, which stops it following the source's name. */
  readonly routeSource: 'suggested' | 'typed';
  readonly layout: string;
  readonly collection: string;
  readonly newCollection: string;
  readonly contentSlug: string;
  readonly projectId: string;
  readonly dataset: string;
  readonly documentType: string;
  /** The Sanity connection the form reads through; its project and dataset fill the two above. */
  readonly connectionId: string;
  readonly sanityAccess: DatasetAccess | 'unknown';
  /** Whether creating copies the connection's key to .env, for a private dataset. */
  readonly connectionKey: 'copy' | 'skip';
  readonly url: string;
  readonly headers: readonly HeaderRow[];
  readonly listPath: string;
  readonly slugPath: string;
  /** How the chosen address field is used, from its sample. */
  readonly slugTreatment: SlugTreatment;
  readonly fields: readonly TemplateField[];
}

export const EMPTY_TEMPLATE_FORM: TemplateForm = {
  kind: 'content-collection',
  route: '',
  routeSource: 'suggested',
  layout: '',
  collection: '',
  newCollection: '',
  contentSlug: ENTRY_ID,
  projectId: '',
  dataset: 'production',
  documentType: '',
  connectionId: '',
  sanityAccess: 'unknown',
  connectionKey: 'copy',
  url: '',
  headers: [],
  listPath: '',
  slugPath: '',
  slugTreatment: 'exact',
  fields: [],
};

const SLUG_PATHS = ['slug.current', 'slug', 'id', '_id', 'handle', 'uid'] as const;

/** The route a source suggests: `/<name>/[slug]`, the name in URL form. */
export function suggestedRoute(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
  const segment = words.join('-').toLowerCase();
  return segment.length === 0 ? '/[slug]' : `/${segment}/[slug]`;
}

/**
 * The form once the project's collections are known: the first one chosen, and
 * the route it suggests, so a project with collections opens ready to create.
 * A choice already made, or a route already typed, stays.
 */
export function withFirstCollection(form: TemplateForm, names: readonly string[]): TemplateForm {
  const [first] = names;
  if (first === undefined || form.collection.length > 0) {
    return form;
  }
  return {
    ...form,
    collection: first,
    contentSlug: ENTRY_ID,
    slugTreatment: 'exact',
    route: form.routeSource === 'suggested' ? suggestedRoute(first) : form.route,
  };
}

/** The form reading through a connection: what was picked from another one no longer applies. */
export function withSanityConnection(form: TemplateForm, connection: Pick<SanityConnection, 'id' | 'projectId' | 'dataset'>): TemplateForm {
  return {
    ...form,
    connectionId: connection.id,
    projectId: connection.projectId,
    dataset: connection.dataset,
    sanityAccess: 'unknown',
    documentType: '',
    slugPath: '',
    slugTreatment: 'exact',
    fields: [],
  };
}

/** The key copy creating needs: for a private dataset whose variable is not set yet, if wanted. */
export function connectionKeyCopy(form: TemplateForm, env: readonly EnvStatus[]): ConnectionKeyCopy | undefined {
  const missing = env.some((item) => item.name === SANITY_TOKEN_ENV && item.state === 'missing');
  if (form.kind === 'sanity' && form.connectionKey === 'copy' && missing) {
    return { connectionId: form.connectionId, env: SANITY_TOKEN_ENV };
  }
  return undefined;
}

/**
 * The field a list's items are most likely addressed by: an id or slug field
 * first, and always one whose values work. As-is beats slugified, so the
 * default never adds a step it does not need.
 */
export function suggestedSlugPath(fields: readonly SampleField[]): string {
  const fitting = (kind: 'exact' | 'slugified') => fields.filter((field) => field.address?.kind === kind);
  for (const kind of ['exact', 'slugified'] as const) {
    const named = SLUG_PATHS.find((path) => fitting(kind).some((field) => field.path === path));
    if (named !== undefined) {
      return named;
    }
  }
  return fitting('exact')[0]?.path ?? fitting('slugified')[0]?.path ?? '';
}

/** How the field at `path` becomes an address. */
export function slugTreatmentOf(fields: readonly SampleField[], path: string): SlugTreatment {
  return fields.find((field) => field.path === path)?.address?.kind === 'slugified' ? 'slugified' : 'exact';
}

export interface AddressOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/** The address a slug makes under a route: `/stats/25` for `/stats/[slug]`. */
export function addressExample(route: string, slug: string): string {
  const address = route.trim().replace(/\[[^\]]*\]/, slug);
  return address.startsWith('/') ? address : `/${slug}`;
}

/** The fields offered as the page address, best first, and why the rest cannot be chosen. */
export function addressOptions(fields: readonly SampleField[], route: string): readonly AddressOption[] {
  const options: { readonly rank: number; readonly option: AddressOption }[] = [];
  for (const { path, address } of fields) {
    if (address?.kind === 'exact') {
      options.push({ rank: 0, option: { value: path, label: path } });
    } else if (address?.kind === 'slugified') {
      options.push({ rank: 1, option: { value: path, label: path, description: `Cleaned up: ${addressExample(route, address.example)}` } });
    } else if (address?.kind === 'unusable') {
      options.push({ rank: 2, option: { value: path, label: path, description: address.reason, disabled: true } });
    }
  }
  return options.sort((left, right) => left.rank - right.rank).map((item) => item.option);
}

/** A list's top-level fields, the ones a template can keep. */
export function templateFields(list: SampleList): readonly TemplateField[] {
  const top = list.fields.filter((field) => !field.path.includes('.'));
  assert(top.length <= PAGE_TEMPLATE_LIMITS.fieldsMax, 'templateFields: fields are bounded by the sample');
  return top.map((field) => ({ path: field.path, kind: field.kind }));
}

/** The one-line summary of a template's fields: `4 fields · 100 items`. */
export function fieldsSummary(fieldCount: number, itemCount: number): string {
  return `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} · ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;
}

/** The form with `path`'s list chosen, its fields and address suggested afresh. */
export function withSampleList(form: TemplateForm, lists: readonly SampleList[], path: string): TemplateForm {
  const list = lists.find((candidate) => candidate.path === path);
  if (list === undefined) {
    return form;
  }
  const slugPath = suggestedSlugPath(list.fields);
  return { ...form, listPath: list.path, slugPath, slugTreatment: slugTreatmentOf(list.fields, slugPath), fields: templateFields(list) };
}

/**
 * The form after a sample arrives. What was chosen survives a refetch while the
 * data still has it, so a Refresh never undoes a person's picks.
 */
export function withSampleLists(form: TemplateForm, lists: readonly SampleList[]): TemplateForm {
  const kept = lists.find((list) => list.path === form.listPath);
  if (kept?.fields.some((field) => field.path === form.slugPath && field.address !== undefined && field.address.kind !== 'unusable') === true) {
    return { ...form, slugTreatment: slugTreatmentOf(kept.fields, form.slugPath) };
  }
  return withSampleList(form, lists, kept?.path ?? lists[0]?.path ?? '');
}

/**
 * Whether the form is simply not finished, in a way its own controls already
 * show: a sample on its way, or a name not typed yet. Nothing is wrong, so
 * nothing shows in red.
 */
export function unfinishedQuietly(form: TemplateForm): boolean {
  switch (form.kind) {
    case 'content-collection':
      return form.collection === NEW_COLLECTION && form.newCollection.trim().length === 0;
    case 'sanity':
      return form.slugPath.length === 0;
    case 'http-json':
      return form.slugPath.length === 0 && parseSourceURL(form.url).ok;
    default: {
      const exhaustive: never = form.kind;
      return exhaustive;
    }
  }
}

export interface PagePreview {
  readonly pages: number;
  /** The first item's title, when the data has one. */
  readonly title: string | undefined;
  readonly address: string;
}

const TITLE_FIELDS = ['title', 'name', 'heading'] as const;

/** What the template will make, in the designer's terms: how many pages, and one of them. */
export function pagePreview(form: TemplateForm, list: SampleList): PagePreview {
  const path = form.kind === 'content-collection' ? form.contentSlug : form.slugPath;
  const field = list.fields.find((candidate) => candidate.path === path);
  const slug = field?.address?.kind === 'slugified' ? field.address.example : field?.address?.kind === 'exact' ? field.example : '…';
  const title = TITLE_FIELDS.flatMap((name) => list.fields.filter((candidate) => candidate.path === name && candidate.kind === 'string'))[0]?.example;
  return { pages: list.count, title, address: `yoursite.com${addressExample(form.route, slug)}` };
}

export interface SampleTreeRow {
  readonly path: string;
  readonly label: string;
  readonly depth: number;
  readonly kind: SampleField['kind'];
  readonly expandable: boolean;
  readonly expanded: boolean;
}

function parentOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : path.slice(0, dot);
}

/**
 * The rows a sample shows: its structure, children under open parents. A search
 * shows matching fields by their whole path instead, wherever they sit.
 */
export function sampleTreeRows(list: SampleList, expanded: ReadonlySet<string>, query: string): readonly SampleTreeRow[] {
  const clean = query.trim().toLowerCase();
  const expandable = (path: string): boolean => list.fields.some((field) => parentOf(field.path) === path);
  const rowOf = (field: SampleField, label: string, depth: number): SampleTreeRow => ({
    path: field.path,
    label,
    depth,
    kind: field.kind,
    expandable: expandable(field.path),
    expanded: expanded.has(field.path),
  });
  if (clean.length > 0) {
    const matching = list.fields.filter((field) => [field.path, field.example, ...(field.examples ?? [])].some((text) => text.toLowerCase().includes(clean)));
    return matching.map((field) => ({ ...rowOf(field, field.path, 0), expandable: false }));
  }
  const rows: SampleTreeRow[] = [];
  const pending = list.fields.filter((field) => parentOf(field.path) === undefined).reverse();
  // Each field is taken once, and only a field's own children are added after it.
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const depth = next.path.split('.').length - 1;
    rows.push(rowOf(next, next.path.split('.').at(-1) ?? next.path, depth));
    if (expanded.has(next.path)) {
      const { path } = next;
      pending.push(...list.fields.filter((field) => parentOf(field.path) === path).reverse());
    }
  }
  assert(rows.length <= list.fields.length, 'sampleTreeRows: each field shows once');
  return rows;
}

/** The item `step` away from `index`, wrapping at both ends as the data picker's arrows do. */
export function steppedItem(index: number, count: number, step: -1 | 1): number {
  assert(count > 0, 'steppedItem: there is an item to step to');
  return (((index + step) % count) + count) % count;
}

/** Whether a field is kept, by itself or inside an object kept whole. */
export function isFieldChosen(chosen: readonly TemplateField[], path: string): boolean {
  return chosen.some((field) => field.path === path || path.startsWith(`${field.path}.`));
}

/** The kept fields with `path` turned over. Unticking part of a kept object keeps the rest of it. */
export function toggledFields(chosen: readonly TemplateField[], list: SampleList, path: string): readonly TemplateField[] {
  const field = list.fields.find((candidate) => candidate.path === path);
  assert(field !== undefined, 'toggledFields: a row is a field of its list');
  const holder = chosen.find((item) => path.startsWith(`${item.path}.`));
  if (holder !== undefined) {
    const rest = list.fields.filter(
      (item) => item.path.startsWith(`${holder.path}.`) && item.kind !== 'object' && item.path !== path && !item.path.startsWith(`${path}.`),
    );
    return [...chosen.filter((item) => item !== holder), ...rest.map((item) => ({ path: item.path, kind: item.kind }))];
  }
  if (chosen.some((item) => item.path === path)) {
    return chosen.filter((item) => item.path !== path);
  }
  return [...chosen.filter((item) => !item.path.startsWith(`${path}.`)), { path, kind: field.kind }];
}

export function allFieldsChosen(chosen: readonly TemplateField[], list: SampleList): boolean {
  return list.fields.every((field) => isFieldChosen(chosen, field.path));
}

/**
 * What Deselect all leaves: the field naming the address, because a template
 * keeps at least one field and that one is sure to have a value on every page.
 */
export function fieldsAfterDeselect(list: SampleList, slugPath: string): readonly TemplateField[] {
  const address = list.fields.find((field) => field.path === slugPath);
  return address === undefined ? [] : [{ path: address.path, kind: address.kind }];
}

/** A blank header row, unless the form already holds as many as a source may send. */
export function withHeaderRow(rows: readonly HeaderRow[]): readonly HeaderRow[] {
  return rows.length < PAGE_TEMPLATE_LIMITS.headersMax ? [...rows, { name: '', env: '', scheme: 'plain' }] : rows;
}

export function templateDraft(form: TemplateForm, layout: PageTemplateDraft['layout']): Result<PageTemplateDraft, string> {
  const route = parseTemplateRoute(form.route);
  if (!route.ok) {
    return route;
  }
  const source = sourceOf(form);
  if (!source.ok) {
    return source;
  }
  // The form's checks say what to fix in words; this one proves they agree with the boundary.
  return ok(parsePageTemplateDraft({ route: form.route, layout, source: source.value }));
}

function sourceOf(form: TemplateForm): Result<unknown, string> {
  switch (form.kind) {
    case 'content-collection':
      return contentSource(form);
    case 'sanity':
      return sanitySource(form);
    case 'http-json':
      return httpSource(form);
    default: {
      const exhaustive: never = form.kind;
      return exhaustive;
    }
  }
}

function contentSource(form: TemplateForm): Result<unknown, string> {
  const slug = form.contentSlug === ENTRY_ID ? { kind: 'entry-id' } : { kind: 'field', name: form.contentSlug, treatment: form.slugTreatment };
  if (form.collection === NEW_COLLECTION) {
    try {
      return ok({ kind: 'content-collection', collection: parseAstroCollectionName(form.newCollection), origin: 'new', slug: { kind: 'entry-id' } });
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : 'Name the collection.');
    }
  }
  if (form.collection.length === 0) {
    return err('Choose a collection.');
  }
  return ok({ kind: 'content-collection', collection: form.collection, origin: 'existing', slug });
}

function sanitySource(form: TemplateForm): Result<unknown, string> {
  if (form.connectionId.length === 0) {
    return err('Connect Sanity to use its content.');
  }
  if (form.sanityAccess === 'unknown') {
    return err('Reading what this Sanity project holds.');
  }
  if (!/^[A-Za-z][\w.-]{0,127}$/.test(form.documentType.trim())) {
    return err('Choose a document type.');
  }
  const picked = pickedFields(form);
  if (!picked.ok) {
    return picked;
  }
  return ok({
    kind: 'sanity',
    projectId: form.projectId,
    dataset: form.dataset,
    documentType: form.documentType.trim(),
    tokenEnv: form.sanityAccess === 'private' ? SANITY_TOKEN_ENV : undefined,
    slugPath: form.slugPath,
    slugTreatment: form.slugTreatment,
    fields: picked.value,
  });
}

function httpSource(form: TemplateForm): Result<unknown, string> {
  const url = parseSourceURL(form.url);
  if (!url.ok) {
    return url;
  }
  const headers = headersOf(form.headers);
  if (!headers.ok) {
    return headers;
  }
  const picked = pickedFields(form);
  if (!picked.ok) {
    return picked;
  }
  return ok({
    kind: 'http-json',
    url: url.value,
    headers: headers.value,
    listPath: form.listPath,
    slugPath: form.slugPath,
    slugTreatment: form.slugTreatment,
    fields: picked.value,
  });
}

function pickedFields(form: TemplateForm): Result<readonly TemplateField[], string> {
  if (form.slugPath.length === 0) {
    return err('Fetch a sample, then choose the field that names each page.');
  }
  const slug = dataPathSegments(form.slugPath);
  if (!slug.ok) {
    return slug;
  }
  return form.fields.length === 0 ? err('Choose at least one field for the template.') : ok(form.fields);
}

/** The header rows as a request sends them, or the first thing wrong with one. */
export function headersOf(rows: readonly HeaderRow[]): Result<readonly SourceHeader[], string> {
  const headers: SourceHeader[] = [];
  for (const row of rows) {
    // A row nothing was typed in says nothing, so it neither sends nor blocks.
    if (row.name.trim().length === 0 && row.env.trim().length === 0) {
      continue;
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(row.name.trim())) {
      return err('A header name uses letters, numbers and dashes, such as Authorization.');
    }
    const env = parseEnvName(row.env);
    if (!env.ok) {
      return env;
    }
    headers.push({ name: row.name.trim(), env: env.value, scheme: row.scheme });
  }
  return ok(headers);
}
