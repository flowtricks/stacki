// The Settings panel's Secrets tab: the contract between the renderer and the main
// process for the project's `.env`. The list carries names only. A value crosses once,
// in a `secrets:read` reply, when a person reveals or edits it, and is never part of a
// listing, an error or a log line. Every change names the revision (a digest of the file's
// exact bytes) it was authored against, so a file edited outside Stacki is refused with
// `changed` rather than overwritten.
//
// The file itself is read and printed by `envFile.ts`; this module is the wire shape
// and the parsers for both directions.
import { assert } from '../core/assert';
import { digest, optional, record, text } from '../core/boundary';
import type { Digest } from '../core/brand';
import type { Result } from '../core/result';
import { ENV_LIMITS, envValueProblem, isEnvName, type EnvChange } from './envFile';

export const SECRETS_FILE_NAME = '.env';

/** Where `.env` stands with Git: `unknown` outside a repository, where nothing can be committed. */
export const SECRETS_IGNORE_STATES = ['ignored', 'not-ignored', 'tracked', 'unknown'] as const;
export type SecretsIgnore = (typeof SECRETS_IGNORE_STATES)[number];

export const SECRETS_ERROR_CODES = [
  'changed',
  'name-taken',
  'invalid-name',
  'invalid-value',
  'not-found',
  'read-only',
  'limit',
  'unreadable',
  'too-large',
  'not-text',
  'denied',
  'filesystem',
] as const;
export type SecretsErrorCode = (typeof SECRETS_ERROR_CODES)[number];

/** A failure the panel shows. The message is fixed text per code: it never holds a name or a value. */
export interface SecretsError {
  readonly code: SecretsErrorCode;
  readonly message: string;
}

export type SecretsResult<T> = Result<T, SecretsError>;

/** One variable in the list: its name and how it is stored, never its value. */
export interface SecretSummary {
  readonly index: number;
  readonly name: string;
  readonly duplicate: boolean;
  readonly multiline: boolean;
}

export interface SecretsListing {
  /** The digest of the file's bytes, or of no bytes when the file does not exist. */
  readonly revision: Digest;
  readonly exists: boolean;
  readonly entries: readonly SecretSummary[];
  /** Lines the panel keeps as written and does not understand. */
  readonly invalidLines: number;
  readonly ignore: SecretsIgnore;
}

export interface SecretValue {
  readonly value: string;
}

/** `create` makes an empty private `.env` when the project has none; with one it changes nothing. */
export type SecretsChange = EnvChange | { readonly kind: 'create' };

/** An index in a change or a read: a position in the list, bounded by the entry limit. */
function parseSecretIndex(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input >= ENV_LIMITS.entriesMax) {
    throw new Error('Secret: expected an entry index');
  }
  return input;
}

function parseSecretName(input: unknown): string {
  const name = text(input);
  if (!isEnvName(name)) {
    throw new Error('Secret: expected a variable name');
  }
  return name;
}

// A value never appears in the error text, only the rule it broke.
function parseSecretText(input: unknown): string {
  const value = text(input);
  if (envValueProblem(value) !== undefined) {
    throw new Error('Secret: expected a single-line value within the limit');
  }
  return value;
}

export const parseSecretReadIndex = parseSecretIndex;
export { digest as parseSecretsRevision };

/** A change a person made in the panel, checked before it leaves the renderer and again in main. */
export function parseSecretsChange(input: unknown): SecretsChange {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'add') {
    return { kind, name: parseSecretName(fields['name']), value: parseSecretText(fields['value']) };
  }
  if (kind === 'update') {
    const value = optional(parseSecretText)(fields['value']);
    return { kind, index: parseSecretIndex(fields['index']), name: parseSecretName(fields['name']), value };
  }
  if (kind === 'create') {
    return { kind };
  }
  if (kind === 'remove') {
    return { kind, index: parseSecretIndex(fields['index']) };
  }
  throw new Error('Secret: unknown change');
}

export function parseSecretsListing(input: unknown): SecretsListing {
  const fields = record(input);
  const entries = fields['entries'];
  if (!Array.isArray(entries) || entries.length > ENV_LIMITS.entriesMax) {
    throw new Error('Secrets: expected a bounded list');
  }
  const invalidLines = fields['invalidLines'];
  if (typeof invalidLines !== 'number' || !Number.isSafeInteger(invalidLines) || invalidLines < 0 || invalidLines > ENV_LIMITS.linesMax) {
    throw new Error('Secrets: expected a line count');
  }
  const ignore = SECRETS_IGNORE_STATES.find((state) => state === fields['ignore']);
  if (ignore === undefined) {
    throw new Error('Secrets: unknown ignore state');
  }
  const exists = fields['exists'];
  if (typeof exists !== 'boolean') {
    throw new Error('Secrets: expected a presence flag');
  }
  const listing: SecretsListing = { revision: digest(fields['revision']), exists, entries: entries.map(parseSummary), invalidLines, ignore };
  assert(
    listing.entries.every((entry, at) => entry.index === at),
    'Secrets are listed in index order',
  );
  return listing;
}

export function parseSecretValueReply(input: unknown): SecretValue {
  const fields = record(input);
  const value = fields['value'];
  if (typeof value !== 'string' || value.length > ENV_LIMITS.valueBytesMax * 4) {
    throw new Error('Secret: expected a value');
  }
  return { value };
}

/** A reply that is either a value parsed by `parseValue` or a failure with a known code. */
export function parseSecretsResult<T>(input: unknown, parseValue: (value: unknown) => T): SecretsResult<T> {
  const fields = record(input);
  if (fields['ok'] === true) {
    return { ok: true, value: parseValue(fields['value']) };
  }
  if (fields['ok'] !== false) {
    throw new Error('Secrets: expected a result');
  }
  const failure = record(fields['error']);
  const code = SECRETS_ERROR_CODES.find((known) => known === failure['code']);
  if (code === undefined) {
    throw new Error('Secrets: unknown failure code');
  }
  const message = text(failure['message']);
  assert(message.length <= 200, 'A secrets failure message is short');
  return { ok: false, error: { code, message } };
}

function parseSummary(input: unknown): SecretSummary {
  const fields = record(input);
  const { duplicate, multiline } = fields;
  if (typeof duplicate !== 'boolean' || typeof multiline !== 'boolean') {
    throw new Error('Secrets: expected entry flags');
  }
  return { index: parseSecretIndex(fields['index']), name: parseSummaryName(fields['name']), duplicate, multiline };
}

// A name read from a file is listed as written; only the editable ones pass `isEnvName`'s length bound.
function parseSummaryName(input: unknown): string {
  const name = text(input);
  if (name.length === 0) {
    throw new Error('Secrets: expected a variable name');
  }
  return name;
}
