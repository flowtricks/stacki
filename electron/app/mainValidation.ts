// Disk and dev-server data are untrusted, even when a previous app run wrote
// them. Keep bounds and parsing separate from handlers so failures are testable.
import {
  boolean,
  count,
  data,
  dictionary,
  list,
  nullable,
  object,
  optional,
  pathText,
  record,
  text,
} from '../../shared/core/boundary';
import type { Data } from '../../shared/core/boundary';
import type { ContentCollection } from '../content/contentEntries';
import type { DynamicEntry } from '../lib/mainTypes';

// The generic parsers live in lib, where every area may reach them.
export { parseData, parseRecord, parseString, parseOptionalString } from '../lib/mainHelpers';
export interface AppSettings {
  readonly sound: boolean;
  readonly usageCountsEnabled: boolean;
  readonly usageNoticeVersion: number;
  readonly usageLastAttemptDay?: string;
}

export function parseSettings(input: unknown): AppSettings {
  const value = object({
    sound: boolean,
    usageCountsEnabled: optional(boolean),
    usageNoticeVersion: optional(count),
    usageLastAttemptDay: optional(text),
  })(input);
  if (value.usageNoticeVersion !== undefined && value.usageNoticeVersion > 10) {
    throw new Error('Settings: invalid usage notice version');
  }
  if (
    value.usageLastAttemptDay !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(value.usageLastAttemptDay)
  ) {
    throw new Error('Settings: invalid usage day');
  }
  return {
    sound: value.sound,
    usageCountsEnabled: value.usageCountsEnabled ?? true,
    usageNoticeVersion: value.usageNoticeVersion ?? 0,
    ...(value.usageLastAttemptDay === undefined
      ? {}
      : { usageLastAttemptDay: value.usageLastAttemptDay }),
  };
}
export const parseRecents = list(object({ path: pathText, name: text, openedAt: count }));

export interface Collection extends ContentCollection {
  readonly loader?: NonNullable<ContentCollection['loader']> & { readonly kind: string };
  readonly extensions?: readonly string[];
  readonly hasBody?: boolean;
  readonly idFromFile?: boolean;
  readonly crossFieldChecks?: boolean;
  readonly freeform?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface ContentConfig {
  readonly collections: readonly Collection[];
  readonly missing?: true;
  readonly error?: string;
  readonly configPath?: string;
}

export function parseContentConfig(input: unknown): ContentConfig {
  const source = record(input);
  const collections = list(parseCollection)(source['collections']);
  const configPath = optional(text)(source['configPath']);
  const error = optional(text)(source['error']);
  return {
    collections,
    ...(source['missing'] === true ? { missing: true } : {}),
    ...(configPath === undefined ? {} : { configPath }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseCollection(input: unknown): Collection {
  // Preserve extension metadata after bounding its JSON shape. Known fields
  // receive their own parsers because renderer panels rely on their types.
  const source = record(data(input));
  const metadata = object({
    name: text,
    editable: optional(boolean),
    freeform: optional(boolean),
    error: optional(text),
    extensions: optional(list(text)),
    hasBody: optional(boolean),
    idFromFile: optional(boolean),
    crossFieldChecks: optional(boolean),
    schema: data,
  })(source);
  const loader = source['loader'] === undefined ? undefined : parseLoader(source['loader']);
  return { ...source, ...metadata, ...(loader === undefined ? {} : { loader }) };
}

function parseLoader(input: unknown): NonNullable<Collection['loader']> {
  const source = record(data(input));
  const parsed = object({
    kind: text,
    base: optional(text),
    file: optional(text),
    pattern: optional((value) => (typeof value === 'string' ? text(value) : list(text)(value))),
    generateId: optional(boolean),
    parser: optional(boolean),
    name: optional(nullable(text)),
  })(source);
  return { ...source, ...parsed };
}

export function parseDynamicPaths(input: unknown): {
  readonly entries: readonly DynamicEntry[];
  readonly error: string | undefined;
} {
  const source = record(input);
  // The dev server's JSON writes `null` for no error; absence is `undefined` here.
  return {
    entries: list(parseDynamicEntry)(source['entries'] ?? []),
    error: optional(nullable(text))(source['error']) ?? undefined,
  };
}

function parseDynamicEntry(input: unknown): DynamicEntry {
  const source = record(input);
  // Older marker servers returned bare params. Preserve that supported wire shape.
  return {
    params: dictionary(data)(source['params'] ?? source),
    props: data(source['props']),
  };
}

export function parseSampleEntry(input: unknown): {
  readonly entry: Data;
  readonly error?: string;
} {
  const source = record(input);
  // The dev server's JSON writes `null` for no error; absence is `undefined` here.
  const error = optional(nullable(text))(source['error']) ?? undefined;
  return { entry: data(source['entry']), ...(error === undefined ? {} : { error }) };
}

export function parseSampleValue(input: unknown): {
  readonly value: Data;
  readonly error?: string;
} {
  const source = record(input);
  // The dev server's JSON writes `null` for no error; absence is `undefined` here.
  const error = optional(nullable(text))(source['error']) ?? undefined;
  return { value: data(source['value']), ...(error === undefined ? {} : { error }) };
}

export const parseValidationResult = object({
  issues: list(
    object({
      path: list((input): string | number =>
        typeof input === 'number' ? count(input) : text(input),
      ),
      message: text,
      code: text,
    }),
  ),
  unchecked: optional(boolean),
  error: optional(text),
});
