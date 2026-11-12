// The Settings panel's Secrets tab, main-process half (shared/properties/secrets.ts): list the
// names in the project's `.env`, hand one value to the renderer when a person reveals or edits
// it, apply one change, and append `.env` to `.gitignore`.
//
// A value leaves this process only in a `readSecret` reply. Nothing here logs, and no error
// value is built from a name, a value or a thrown message: every failure is the fixed text of
// its code. A change is written through the document actors (documentWrites.ts), which write a
// temporary file in the project's `.stacki/io`, rename it over `.env`, keep its mode and owner,
// and refuse a write whose base bytes are not the ones on disk. A new `.env` is made private
// (mode 0600) before anything secret is put in it. Every change names the revision it was authored
// against; a file that changed since is refused with `changed`, never overwritten.
import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { err, ok } from '../../shared/core/result';
import { ENV_LIMITS, changeEnvFile, envEntries, envInvalidLines, parseEnvFile, serializeEnvFile, type EnvFile } from '../../shared/properties/envFile';
import {
  SECRETS_FILE_NAME,
  type SecretsChange,
  type SecretsErrorCode,
  type SecretsIgnore,
  type SecretsListing,
  type SecretsResult,
  type SecretValue,
} from '../../shared/properties/secrets';
import type { Digest } from '../../shared/core/brand';
import { createProjectText, writeProjectText } from '../documents/documentWrites';
import { digestOf } from '../documents/atomicWrite';
import { ignoreState, isTracked, writeIgnoreRule, type Git } from './projectEnv';

// Text per code, fixed so a failure can never carry file content.
const MESSAGES: Readonly<Record<SecretsErrorCode, string>> = {
  changed: 'The .env file changed on disk. Reload and try again.',
  'name-taken': 'A secret with that name already exists.',
  'invalid-name': 'That is not a valid secret name.',
  'invalid-value': 'That value cannot be saved.',
  'not-found': 'That secret is no longer there.',
  'read-only': 'This secret spans several lines. Edit it in the .env file.',
  limit: 'The .env file is at its size limit.',
  unreadable: 'The .env file could not be read.',
  'too-large': 'The .env file is too large to edit here.',
  'not-text': 'The .env file is not valid UTF-8 text.',
  denied: 'Stacki is not allowed to read the .env file.',
  filesystem: 'The .env file could not be saved.',
};

const PRIVATE_MODE = 0o600;

interface EnvSource {
  readonly text: string;
  readonly exists: boolean;
}

/** The names in `.env`, how it stands with Git, and the revision a change must name. */
export async function listSecrets(projectRoot: string, git: Git): Promise<SecretsResult<SecretsListing>> {
  const read = readSource(projectRoot);
  if (!read.ok) {
    return read;
  }
  return listingOf(projectRoot, read.value, git);
}

/** One value, for a person who revealed or began editing it. */
export function readSecret(projectRoot: string, revision: Digest, index: number): SecretsResult<SecretValue> {
  const read = readSource(projectRoot);
  if (!read.ok) {
    return read;
  }
  if (digestOf(read.value.text) !== revision) {
    return failure('changed');
  }
  const parsed = parseEnvFile(read.value.text);
  if (!parsed.ok) {
    return failure('unreadable');
  }
  const entry = envEntries(parsed.value)[index];
  if (entry === undefined) {
    return failure('not-found');
  }
  return ok({ value: entry.value });
}

/** Applies `change` to the revision it was authored against and answers with the new listing. */
export async function applySecretsChange(projectRoot: string, revision: Digest, change: SecretsChange, git: Git): Promise<SecretsResult<SecretsListing>> {
  const read = readSource(projectRoot);
  if (!read.ok) {
    return read;
  }
  if (digestOf(read.value.text) !== revision) {
    return failure('changed');
  }
  if (change.kind === 'create') {
    return createEmpty(projectRoot, read.value, revision, git);
  }
  const parsed = parseEnvFile(read.value.text);
  if (!parsed.ok) {
    return failure('unreadable');
  }
  const changed = changeEnvFile(parsed.value, change);
  if (!changed.ok) {
    return failure(changed.error);
  }
  const written = writeSource(projectRoot, read.value, serializeEnvFile(changed.value), revision);
  if (!written.ok) {
    return written;
  }
  const after = readSource(projectRoot);
  if (!after.ok) {
    return after;
  }
  assertWrote(after.value.text, changed.value);
  return listingOf(projectRoot, after.value, git);
}

// A project with no `.env` gets an empty private one; one that has it is left as it is.
async function createEmpty(projectRoot: string, source: EnvSource, revision: Digest, git: Git): Promise<SecretsResult<SecretsListing>> {
  if (!source.exists) {
    const written = writeSource(projectRoot, source, '', revision);
    if (!written.ok) {
      return written;
    }
  }
  return listSecrets(projectRoot, git);
}

/** Appends `.env` to `.gitignore` when no rule ignores it, and answers with the listing's new state. */
export async function ignoreEnvFile(projectRoot: string, git: Git): Promise<SecretsResult<SecretsListing>> {
  try {
    writeIgnoreRule(projectRoot);
  } catch {
    // The reason is not shown: a thrown message here could name a path the person did not ask about.
    return failure('filesystem');
  }
  return listSecrets(projectRoot, git);
}

function failure(code: SecretsErrorCode): SecretsResult<never> {
  return err({ code, message: MESSAGES[code] });
}

function envPath(projectRoot: string): string {
  assert(path.isAbsolute(projectRoot), 'A project root is absolute');
  return path.join(projectRoot, SECRETS_FILE_NAME);
}

// The file's text, or empty text for a project with none. A file that is too large, not a file,
// or not UTF-8 is unreadable: reading it lossily could let a later save destroy it.
function readSource(projectRoot: string): SecretsResult<EnvSource> {
  const file = envPath(projectRoot);
  let bytes: Buffer;
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile()) {
      return failure('unreadable');
    }
    if (stats.size > ENV_LIMITS.fileBytesMax) {
      return failure('too-large');
    }
    bytes = fs.readFileSync(file);
  } catch (error: unknown) {
    // A project with no .env is the ordinary case, not a failure.
    return isMissing(error) ? ok({ text: '', exists: false }) : failure(isDenied(error) ? 'denied' : 'unreadable');
  }
  try {
    // The byte-order mark is kept: the codec prints it back.
    return ok({ text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), exists: true });
  } catch {
    return failure('not-text');
  }
}

function isDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function writeSource(projectRoot: string, before: EnvSource, text: string, revision: Digest): SecretsResult<void> {
  const file = envPath(projectRoot);
  try {
    if (before.exists) {
      writeProjectText(file, text, before.text);
    } else {
      // Created empty and made private first, so the secret is never in a file others can read.
      createProjectText(file, '');
      fs.chmodSync(file, PRIVATE_MODE);
      writeProjectText(file, text, '');
    }
    return ok(undefined);
  } catch {
    // A refused write reads the disk again to say whether another writer got there first.
    const now = readSource(projectRoot);
    return failure(now.ok && digestOf(now.value.text) !== revision ? 'changed' : 'filesystem');
  }
}

// The read-back holds what was planned: the pair of the plan's assertion and the disk's.
function assertWrote(written: string, planned: EnvFile): void {
  assert(written === serializeEnvFile(planned), 'The saved .env reads back as planned');
  const reparsed = parseEnvFile(written);
  assert(reparsed.ok, 'The saved .env parses');
  assert(envEntries(reparsed.value).length === envEntries(planned).length, 'The saved .env holds the planned variables');
}

async function listingOf(projectRoot: string, source: EnvSource, git: Git): Promise<SecretsResult<SecretsListing>> {
  const parsed = parseEnvFile(source.text);
  if (!parsed.ok) {
    return failure('unreadable');
  }
  const ignore = await ignoreOf(projectRoot, git);
  const entries = envEntries(parsed.value).map(({ index, name, duplicate, multiline }) => ({ index, name, duplicate, multiline }));
  return ok({ revision: digestOf(source.text), exists: source.exists, entries, invalidLines: envInvalidLines(parsed.value), ignore });
}

async function ignoreOf(projectRoot: string, git: Git): Promise<SecretsIgnore> {
  if (await isTracked(projectRoot, git)) {
    return 'tracked';
  }
  const state = await ignoreState(projectRoot, git);
  return state === 'no-repository' ? 'unknown' : state;
}
