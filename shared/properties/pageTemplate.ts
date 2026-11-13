// A page template: one `[slug].astro` page that Astro generates once per entry
// of a data source. This module is the contract between the Pages panel's form
// and the main process that fetches samples and writes the files.
//
// Everything a person types is checked here, and only here, because the form
// and the IPC boundary must refuse the same values for the same reasons. A
// secret never appears in these types: a request names the environment
// variable holding it, and the value travels once, through `project:setEnv`.

import { object, optional, record, text, list, count } from '../core/boundary';
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { parseConnectionId } from './cmsConnections';
import type { MessageParams } from '../core/i18n/catalog';
import { englishText, messageRef, type MessageKey } from './i18n/messageRef';
import { parseMessageRef, type MessageRef } from '../core/i18n/messageReference';

export const PAGE_TEMPLATE_LIMITS = {
  routeCharsMax: 256,
  routeSegmentsMax: 12,
  dataPathCharsMax: 128,
  dataPathSegmentsMax: 8,
  urlCharsMax: 2048,
  headersMax: 8,
  fieldsMax: 64,
  listsMax: 32,
  /** Items a designer can step through in a sample. */
  itemsPreviewMax: 10,
  typesMax: 256,
  exampleCharsMax: 80,
  changesMax: 6,
  changeCharsMax: 256 * 1024,
  envNamesMax: 16,
  secretCharsMax: 4096,
} as const satisfies Record<string, number>;

/** The variable a generated page reads a private dataset's token from. */
export const SANITY_TOKEN_ENV = 'SANITY_API_TOKEN';

/** The Sanity API version generated code and samples both ask for. */
export const SANITY_API_VERSION = 'v2025-02-19';

/** Whether a field's value is the address as it stands, or after `slugifyAddress`. */
export type SlugTreatment = 'exact' | 'slugified';

export type ContentSlug = { readonly kind: 'entry-id' } | { readonly kind: 'field'; readonly name: string; readonly treatment: SlugTreatment };

export type SampleFieldKind = 'string' | 'number' | 'boolean' | 'object' | 'list';
const FIELD_KINDS = ['string', 'number', 'boolean', 'object', 'list'] as const satisfies readonly SampleFieldKind[];

/** A field a template keeps from each item, dotted when it is nested: `author.name`. */
export interface TemplateField {
  readonly path: string;
  readonly kind: SampleFieldKind;
}

export type HeaderScheme = 'plain' | 'bearer';

/** A request header whose value lives in an environment variable. */
export interface SourceHeader {
  readonly name: string;
  readonly env: string;
  readonly scheme: HeaderScheme;
}

export type DataSource =
  | {
      readonly kind: 'content-collection';
      readonly collection: string;
      /** `new` adds the collection to the content config in the same step. */
      readonly origin: 'existing' | 'new';
      readonly slug: ContentSlug;
    }
  | {
      readonly kind: 'sanity';
      readonly projectId: string;
      readonly dataset: string;
      readonly documentType: string;
      readonly tokenEnv: string | undefined;
      readonly slugPath: string;
      readonly slugTreatment: SlugTreatment;
      readonly fields: readonly TemplateField[];
    }
  | {
      readonly kind: 'http-json';
      readonly url: string;
      readonly headers: readonly SourceHeader[];
      /** Where the items sit in the reply; empty when the reply is the list. */
      readonly listPath: string;
      readonly slugPath: string;
      readonly slugTreatment: SlugTreatment;
      readonly fields: readonly TemplateField[];
    };

export const ADDRESS_LIMITS = {
  // Past this a value is prose, not an address: a Description slugified would
  // make a URL nobody could read, and it would change with every edit.
  valueCharsMax: 80,
  /** Values checked per field: every entry of any ordinary list. */
  valuesReadMax: 2000,
  reasonCharsMax: 120,
} as const satisfies Record<string, number>;

/** How a field's values would serve as page addresses, judged from the sample. */
export type AddressFit =
  | { readonly kind: 'exact' }
  | { readonly kind: 'slugified'; readonly example: string }
  | { readonly kind: 'unusable'; readonly reason: string; readonly reasonRef?: MessageRef };

// The English sentence stays in `reason` (logs, older readers); `reasonRef` is what the renderer translates (docs/i18n-playbook.md, section 7).
function unusable(key: MessageKey, params?: MessageParams): AddressFit {
  const reasonRef = messageRef(key, params);
  return { kind: 'unusable', reason: englishText(reasonRef).slice(0, ADDRESS_LIMITS.reasonCharsMax), reasonRef };
}

/** A value in URL form. The generated pages' `toSlug` does the same, and a test holds the two together. */
export function slugifyAddress(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  assert(!slug.startsWith('-'), 'slugifyAddress: a slug has no leading dash');
  assert(!slug.endsWith('-'), 'slugifyAddress: a slug has no trailing dash');
  return slug;
}

/**
 * Whether these values can address pages: as they are when each is non-empty,
 * unique and URL-safe, slugified when that alone makes them so, otherwise not.
 * Uniqueness ignores case, because a site built onto a case-insensitive disk
 * would otherwise lose a page.
 */
export function addressFitOf(values: readonly unknown[]): AddressFit {
  const texts: string[] = [];
  for (const value of values.slice(0, ADDRESS_LIMITS.valuesReadMax)) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (text.length === 0) {
      return unusable('pages.template.address.noValue');
    }
    if (text.length > ADDRESS_LIMITS.valueCharsMax) {
      return unusable('pages.template.address.tooLong');
    }
    texts.push(text);
  }
  if (texts.length === 0) {
    return unusable('pages.template.address.noValue');
  }
  assert(texts.length <= ADDRESS_LIMITS.valuesReadMax, 'addressFitOf: the values read stay within the limit');
  const urlSafe = texts.every((text) => /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(text));
  if (urlSafe && repeatedValue(texts.map((text) => text.toLowerCase())) === undefined) {
    return { kind: 'exact' };
  }
  const slugs = texts.map(slugifyAddress);
  if (slugs.includes('')) {
    return unusable('pages.template.address.noLetters');
  }
  const repeated = repeatedValue(slugs);
  if (repeated !== undefined) {
    return unusable('pages.template.address.repeated', { address: repeated });
  }
  const [example] = slugs;
  assert(example !== undefined, 'addressFitOf: at least one value was read');
  return { kind: 'slugified', example };
}

function repeatedValue(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export interface PageTemplateDraft {
  readonly route: string;
  readonly layout: { readonly name: string; readonly path: string } | undefined;
  readonly source: DataSource;
}

export interface RouteParts {
  /** The page's path under src/pages: `blog/[slug].astro`. */
  readonly file: string;
  /** The placeholder's name, which is the key of `params`. */
  readonly param: string;
}

const LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PARAM_SEGMENT = /^\[(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)\]$/;

/**
 * A route pattern as a file and its placeholder, or what is wrong with it in
 * words a designer can act on. One placeholder only: it is filled from the
 * slug field, and a second one would have no field to come from.
 */
export function parseTemplateRoute(input: string): Result<RouteParts, string> {
  const route = input.trim();
  if (route.length === 0) {
    return err('Enter a route, such as /blog/[slug].');
  }
  if (route.length > PAGE_TEMPLATE_LIMITS.routeCharsMax) {
    return err(`A route is at most ${PAGE_TEMPLATE_LIMITS.routeCharsMax} characters.`);
  }
  if (!route.startsWith('/')) {
    return err('A route starts with /.');
  }
  const segments = route.slice(1).split('/');
  if (segments.length > PAGE_TEMPLATE_LIMITS.routeSegmentsMax) {
    return err(`A route has at most ${PAGE_TEMPLATE_LIMITS.routeSegmentsMax} parts.`);
  }
  const params: { readonly name: string; readonly index: number; readonly rest: boolean }[] = [];
  for (const [index, segment] of segments.entries()) {
    const param = PARAM_SEGMENT.exec(segment);
    if (param?.[1] !== undefined) {
      params.push({ name: param[1], index, rest: segment.startsWith('[...') });
    } else if (segment.length === 0) {
      return err('A route has no empty parts: remove the extra /.');
    } else if (!LITERAL_SEGMENT.test(segment)) {
      return err(`“${segment}” cannot be part of a route. Use letters, numbers, dashes, or one [slug] placeholder.`);
    }
  }
  const [first, second] = params;
  if (first === undefined) {
    return err('A template route needs a placeholder, such as [slug].');
  }
  if (second !== undefined) {
    return err('A template route has one placeholder.');
  }
  if (first.rest) {
    if (first.index !== segments.length - 1) {
      return err('A [...slug] placeholder comes last in the route.');
    }
  }
  const parts = { file: `${segments.join('/')}.astro`, param: first.name };
  assert(!parts.file.startsWith('/'), 'parseTemplateRoute: the file is relative to src/pages');
  assert(parts.file.includes(`${first.name}]`), 'parseTemplateRoute: the file carries the placeholder');
  return ok(parts);
}

/** The steps of a dotted data path; an empty path is the value itself. */
export function dataPathSegments(path: string): Result<readonly string[], string> {
  if (path.length === 0) {
    return ok([]);
  }
  if (path.length > PAGE_TEMPLATE_LIMITS.dataPathCharsMax) {
    return err('That field path is too long.');
  }
  const segments = path.split('.');
  assert(segments.length > 0, 'dataPathSegments: a non-empty path has a step');
  if (segments.length > PAGE_TEMPLATE_LIMITS.dataPathSegmentsMax) {
    return err('That field path is too deep.');
  }
  const wrong = segments.find((segment) => !/^[A-Za-z_$][\w$-]*$/.test(segment));
  return wrong === undefined ? ok(segments) : err(`“${wrong}” is not a field name Stacki can read.`);
}

// Query parameters that carry a credential. A URL is written into the page's
// source, so one of these would publish the credential with the site.
const SECRET_PARAMETER = /key|token|secret|password|passwd|auth|signature|credential/i;

/** An address Stacki may fetch and write into a page, or why it may not. */
export function parseSourceURL(input: string): Result<string, string> {
  const address = input.trim();
  if (address.length === 0) {
    return err('Enter the address of the JSON data.');
  }
  if (address.length > PAGE_TEMPLATE_LIMITS.urlCharsMax) {
    return err('That address is too long.');
  }
  if (!URL.canParse(address)) {
    return err('That is not a complete address. It starts with https://.');
  }
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return err('The address starts with https:// or http://.');
  }
  if (url.username !== '') {
    return err('Remove the user name and password from the address, and send them as a header instead.');
  }
  if (url.password !== '') {
    return err('Remove the user name and password from the address, and send them as a header instead.');
  }
  const secret = [...url.searchParams.keys()].find((name) => SECRET_PARAMETER.test(name));
  if (secret !== undefined) {
    return err(`“${secret}” looks like a secret, and the address is saved in the page. Send it as a header instead.`);
  }
  return ok(url.href);
}

/** An environment variable for a secret, or why it cannot hold one. */
export function parseEnvName(input: string): Result<string, string> {
  const name = input.trim();
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
    return err('A variable name uses capital letters, numbers and underscores, such as API_TOKEN.');
  }
  // Astro sends PUBLIC_ variables to the browser, which would publish the secret.
  if (name.startsWith('PUBLIC_')) {
    return err('PUBLIC_ variables are sent to the browser. Use a name without PUBLIC_ for a secret.');
  }
  return ok(name);
}

function unwrapped<T>(result: Result<T, string>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function matching(pattern: RegExp, label: string): (input: unknown) => string {
  return (input) => {
    const value = text(input);
    if (!pattern.test(value)) {
      throw new Error(`Page template: invalid ${label}`);
    }
    return value;
  };
}

const parseCollection = matching(/^[A-Za-z_][\w.-]{0,127}$/, 'collection');
const parseNewCollection = matching(/^[a-z][A-Za-z0-9]{0,127}$/, 'new collection');
const parseProjectId = matching(/^[a-z0-9]{1,64}$/, 'Sanity project id');
const parseDataset = matching(/^[a-z0-9][\w-]{0,63}$/, 'Sanity dataset');
const parseDocumentType = matching(/^[A-Za-z][\w.-]{0,127}$/, 'Sanity document type');
const parseHeaderName = matching(/^[A-Za-z0-9-]{1,64}$/, 'header name');
const parseFieldName = matching(/^[A-Za-z_$][\w$-]{0,127}$/, 'field name');
const parseEnv = (input: unknown): string => unwrapped(parseEnvName(text(input)));
const parseURL = (input: unknown): string => unwrapped(parseSourceURL(text(input)));

function parseDataPath(input: unknown): string {
  const path = text(input);
  unwrapped(dataPathSegments(path));
  return path;
}

function parseSlugPath(input: unknown): string {
  const path = parseDataPath(input);
  if (path.length === 0) {
    throw new Error('Page template: expected a slug field');
  }
  return path;
}

function parseKind(input: unknown): SampleFieldKind {
  const kind = FIELD_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    throw new Error('Page template: unknown field kind');
  }
  return kind;
}

function bounded<T>(itemsMax: number, label: string, parse: (input: unknown) => T): (input: unknown) => readonly T[] {
  assert(itemsMax > 0, 'bounded: a list limit allows at least one item');
  const parseList = list(parse);
  return (input) => {
    const items = parseList(input);
    if (items.length > itemsMax) {
      throw new Error(`Page template: too many ${label}`);
    }
    return items;
  };
}

const parseField = object({ path: parseSlugPath, kind: parseKind });

function parseFields(input: unknown): readonly TemplateField[] {
  const fields = bounded(PAGE_TEMPLATE_LIMITS.fieldsMax, 'fields', parseField)(input);
  if (fields.length === 0) {
    throw new Error('Page template: expected at least one field');
  }
  if (new Set(fields.map((field) => field.path)).size !== fields.length) {
    throw new Error('Page template: a field is listed twice');
  }
  assert(fields.length <= PAGE_TEMPLATE_LIMITS.fieldsMax, 'parseFields: the fields stay within the limit');
  return fields;
}

function parseScheme(input: unknown): HeaderScheme {
  if (input === 'plain') {
    return 'plain';
  }
  if (input === 'bearer') {
    return 'bearer';
  }
  throw new Error('Page template: unknown header scheme');
}

const parseHeader = object({ name: parseHeaderName, env: parseEnv, scheme: parseScheme });
const parseHeaders = bounded(PAGE_TEMPLATE_LIMITS.headersMax, 'headers', parseHeader);

function parseTreatment(input: unknown): SlugTreatment {
  if (input === 'exact') {
    return 'exact';
  }
  if (input === 'slugified') {
    return 'slugified';
  }
  throw new Error('Page template: unknown slug treatment');
}

function parseContentSlug(input: unknown): ContentSlug {
  const value = record(input);
  if (value['kind'] === 'entry-id') {
    return { kind: 'entry-id' };
  }
  if (value['kind'] === 'field') {
    return { kind: 'field', name: parseFieldName(value['name']), treatment: parseTreatment(value['treatment']) };
  }
  throw new Error('Page template: unknown slug kind');
}

function parseOrigin(input: unknown): 'existing' | 'new' {
  if (input === 'existing') {
    return 'existing';
  }
  if (input === 'new') {
    return 'new';
  }
  throw new Error('Page template: unknown collection origin');
}

export function parseDataSource(input: unknown): DataSource {
  const value = record(input);
  switch (value['kind']) {
    case 'content-collection': {
      const origin = parseOrigin(value['origin']);
      // A new collection's name becomes a `const` in the config; an existing one may be any key.
      const collection = origin === 'new' ? parseNewCollection(value['collection']) : parseCollection(value['collection']);
      return { kind: 'content-collection', collection, origin, slug: parseContentSlug(value['slug']) };
    }
    case 'sanity':
      return {
        kind: 'sanity',
        projectId: parseProjectId(value['projectId']),
        dataset: parseDataset(value['dataset']),
        documentType: parseDocumentType(value['documentType']),
        tokenEnv: optional(parseEnv)(value['tokenEnv']),
        slugPath: parseSlugPath(value['slugPath']),
        slugTreatment: parseTreatment(value['slugTreatment']),
        fields: parseFields(value['fields']),
      };
    case 'http-json':
      return {
        kind: 'http-json',
        url: parseURL(value['url']),
        headers: parseHeaders(value['headers']),
        listPath: parseDataPath(value['listPath']),
        slugPath: parseSlugPath(value['slugPath']),
        slugTreatment: parseTreatment(value['slugTreatment']),
        fields: parseFields(value['fields']),
      };
    default:
      throw new Error('Page template: unknown data source');
  }
}

export function parsePageTemplateDraft(input: unknown): PageTemplateDraft {
  const value = record(input);
  const route = text(value['route']);
  unwrapped(parseTemplateRoute(route));
  assert(route.trim().startsWith('/'), 'parsePageTemplateDraft: a parsed route starts with /');
  return {
    route: route.trim(),
    layout: optional(object({ name: text, path: text }))(value['layout']),
    source: parseDataSource(value['source']),
  };
}

/** What the form asks the main process to fetch. */
export type DataSampleRequest =
  | { readonly kind: 'content-collection'; readonly collection: string }
  | { readonly kind: 'http-json'; readonly url: string; readonly headers: readonly SourceHeader[] }
  | { readonly kind: 'sanity-types'; readonly connectionId: string }
  | { readonly kind: 'sanity-documents'; readonly connectionId: string; readonly documentType: string };

export function parseDataSampleRequest(input: unknown): DataSampleRequest {
  const value = record(input);
  switch (value['kind']) {
    case 'content-collection':
      return { kind: 'content-collection', collection: parseCollection(value['collection']) };
    case 'http-json':
      return { kind: 'http-json', url: parseURL(value['url']), headers: parseHeaders(value['headers']) };
    case 'sanity-types':
      return { kind: 'sanity-types', connectionId: parseConnectionId(value['connectionId']) };
    case 'sanity-documents':
      return {
        kind: 'sanity-documents',
        connectionId: parseConnectionId(value['connectionId']),
        documentType: parseDocumentType(value['documentType']),
      };
    default:
      throw new Error('Page template: unknown sample request');
  }
}

export interface SampleField {
  /** Dotted from the item: `title`, or `slug.current`. */
  readonly path: string;
  readonly kind: SampleFieldKind;
  readonly example: string;
  /** This field's value in each of the first items, for stepping through them. */
  readonly examples?: readonly string[];
  /** Text and numbers only: nothing else can be offered as an address. */
  readonly address?: AddressFit;
}

export interface SampleList {
  /** Dotted from the reply; empty when the reply is the list. */
  readonly path: string;
  readonly count: number;
  readonly fields: readonly SampleField[];
}

/** Whether a dataset answers without a key, and so whether a built site needs one. */
export type DatasetAccess = 'public' | 'private';

export type DataSample =
  | { readonly kind: 'types'; readonly types: readonly string[]; readonly access: DatasetAccess }
  | { readonly kind: 'lists'; readonly lists: readonly SampleList[] };

function parseExample(input: unknown): string {
  const example = text(input);
  if (example.length > PAGE_TEMPLATE_LIMITS.exampleCharsMax) {
    throw new Error('Page template: example exceeds limit');
  }
  return example;
}

function parseAddressFit(input: unknown): AddressFit {
  const value = record(input);
  switch (value['kind']) {
    case 'exact':
      return { kind: 'exact' };
    case 'slugified':
      return { kind: 'slugified', example: parseExample(value['example']) };
    case 'unusable': {
      const reason = text(value['reason']);
      if (reason.length > ADDRESS_LIMITS.reasonCharsMax) {
        throw new Error('Page template: reason exceeds limit');
      }
      const rawRef = value['reasonRef'];
      if (rawRef === undefined) {
        return { kind: 'unusable', reason };
      }
      // A reference that fails its boundary parse is dropped: the English reason still shows (playbook section 7).
      const parsedRef = parseMessageRef(rawRef);
      return parsedRef.ok ? { kind: 'unusable', reason, reasonRef: parsedRef.value } : { kind: 'unusable', reason };
    }
    default:
      throw new Error('Page template: unknown address fit');
  }
}

const parseSampleField = object({
  path: parseDataPath,
  kind: parseKind,
  example: parseExample,
  examples: optional(bounded(PAGE_TEMPLATE_LIMITS.itemsPreviewMax, 'examples', parseExample)),
  address: optional(parseAddressFit),
});
const parseSampleList = object({
  path: parseDataPath,
  count,
  fields: bounded(PAGE_TEMPLATE_LIMITS.fieldsMax, 'sample fields', parseSampleField),
});

function parseAccess(input: unknown): DatasetAccess {
  if (input === 'public') {
    return 'public';
  }
  if (input === 'private') {
    return 'private';
  }
  throw new Error('Page template: unknown dataset access');
}

export function parseDataSample(input: unknown): DataSample {
  const value = record(input);
  if (value['kind'] === 'types') {
    return { kind: 'types', types: bounded(PAGE_TEMPLATE_LIMITS.typesMax, 'types', parseDocumentType)(value['types']), access: parseAccess(value['access']) };
  }
  if (value['kind'] === 'lists') {
    return { kind: 'lists', lists: bounded(PAGE_TEMPLATE_LIMITS.listsMax, 'lists', parseSampleList)(value['lists']) };
  }
  throw new Error('Page template: unknown sample');
}

/** A file the template will write, shown in full before anything happens. */
export interface PageTemplateChange {
  /** Relative to the project. */
  readonly path: string;
  readonly action: 'create' | 'edit';
  readonly text: string;
}

export interface EnvStatus {
  readonly name: string;
  readonly state: 'set' | 'missing';
}

export interface PageTemplatePlan {
  readonly route: string;
  readonly changes: readonly PageTemplateChange[];
  readonly env: readonly EnvStatus[];
}

function parseChangeText(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Page template: expected file text');
  }
  if (input.length > PAGE_TEMPLATE_LIMITS.changeCharsMax) {
    throw new Error('Page template: file text exceeds limit');
  }
  return input;
}

function parseAction(input: unknown): 'create' | 'edit' {
  if (input === 'create') {
    return 'create';
  }
  if (input === 'edit') {
    return 'edit';
  }
  throw new Error('Page template: unknown change');
}

function parseEnvState(input: unknown): 'set' | 'missing' {
  if (input === 'set') {
    return 'set';
  }
  if (input === 'missing') {
    return 'missing';
  }
  throw new Error('Page template: unknown variable state');
}

const parseChange = object({ path: text, action: parseAction, text: parseChangeText });
const parseEnvStatus = object({ name: parseEnv, state: parseEnvState });

export const parsePageTemplatePlan: (input: unknown) => PageTemplatePlan = object({
  route: text,
  changes: bounded(PAGE_TEMPLATE_LIMITS.changesMax, 'changes', parseChange),
  env: bounded(PAGE_TEMPLATE_LIMITS.envNamesMax, 'variables', parseEnvStatus),
});

export const parsePageTemplateCreated: (input: unknown) => { readonly pagePath: string } = object({ pagePath: text });

/** A secret on its way to the project's .env: one line, within the bound. */
export function parseSecretValue(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Project variable: expected text');
  }
  if (input.length === 0) {
    throw new Error('Project variable: expected a value');
  }
  if (input.length > PAGE_TEMPLATE_LIMITS.secretCharsMax) {
    throw new Error('Project variable: value exceeds limit');
  }
  if (/[\r\n]/.test(input)) {
    throw new Error('Project variable: a value is one line');
  }
  return input;
}

export const parseEnvPayloadName = parseEnv;

/** A connection's key to copy into .env as `env`, so a built site can read a private dataset. */
export interface ConnectionKeyCopy {
  readonly connectionId: string;
  readonly env: string;
}

export const parseConnectionKeyCopy: (input: unknown) => ConnectionKeyCopy = object({ connectionId: parseConnectionId, env: parseEnv });
