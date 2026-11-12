// The Settings panel's MCP tab, main-process half (shared/properties/mcp.ts): read and change the
// project's `.mcp.json`, and read and change the person's Codex file, `~/.codex/config.toml`.
//
// A value leaves this process only in a `reveal` reply (one server, for a person who began editing it) or
// as the text of the file in a `readText` reply (the JSON view). Nothing here logs, and no error value is
// built from a name, a value, file text or a thrown message: every failure is the fixed text of its code.
//
// The project file is written through the document actors (documentWrites.ts): a temporary file in the
// project's `.stacki/io`, renamed over the target, the mode kept, a write whose base bytes are not the ones
// on disk refused. Every change names the revision it was authored against; a file that changed since is
// refused with `changed`, never overwritten.
//
// The Codex file is outside the project. Its path is one fixed place under the home folder, built here and
// nowhere else: the renderer never supplies a path. It is written by `replaceUserFile`, which stages a
// private temporary file beside it (so nothing is created in a `.stacki` folder of the person's Codex home),
// checks the file's digest again just before the rename, keeps the mode, and refuses a link whose target is
// missing, a file with other hard links, and anything that is not a regular file. Between that last check
// and the rename another program could still write; the window is the rename's own and cannot be closed
// without a lock the Codex CLI does not take.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { err, ok, type Result } from '../../shared/core/result';
import type {
  McpChange,
  McpCodexChange,
  McpCodexState,
  McpError,
  McpErrorCode,
  McpListing,
  McpResult,
  McpServerItem,
  McpText,
} from '../../shared/properties/mcp';
import { MCP_LIMITS, summarizeMcpServer, type McpServerConfig } from '../../shared/properties/mcpConfig';
import { MCP_FILE_NAME, changeMcpJson, mcpFileEntries, mcpJsonIssues, scanMcpJson, type McpJsonDocument } from '../../shared/properties/mcpJson';
import { changeCodexToml, codexServerEntries, scanCodexToml, type CodexDocument } from '../../shared/properties/mcpToml';
import { digestOf, errorCode, writeTargetOf } from '../documents/atomicWrite';
import { createProjectText, writeProjectText } from '../documents/documentWrites';

// Text per code, fixed so a failure can never carry file content.
const MESSAGES: Readonly<Record<McpErrorCode, string>> = {
  changed: 'The file changed on disk. Reload and try again.',
  'name-taken': 'A server with that name already exists.',
  'not-found': 'That server is no longer there.',
  'invalid-name': 'That is not a valid server name.',
  invalid: 'That configuration cannot be saved.',
  limit: 'The file is at its server limit.',
  unreadable: 'The file could not be read.',
  'too-large': 'The file is too large to edit here.',
  'not-text': 'The file is not valid UTF-8 text.',
  denied: 'Stacki is not allowed to read the file.',
  filesystem: 'The file could not be saved.',
  unmappable: 'That server cannot be written to Codex.',
  'codex-unavailable': 'The Codex configuration file is not available.',
  'codex-unsupported': 'The Codex configuration file is written in a way Stacki will not edit.',
};

const CODEX_DIRECTORY = '.codex';
const CODEX_FILE_NAME = 'config.toml';
const FALLBACK_MODE = 0o600;

interface TextSource {
  readonly text: string;
  readonly exists: boolean;
}

type ReadCode = Extract<McpErrorCode, 'unreadable' | 'too-large' | 'not-text' | 'denied'>;

function failure(code: McpErrorCode): McpResult<never> {
  return err(error(code));
}

function error(code: McpErrorCode): McpError {
  return { code, message: MESSAGES[code] };
}

// ---- The project's .mcp.json ----

/** The servers in `.mcp.json` as cards show them, and the revision a change must name. */
export function readMcpListing(projectRoot: string): McpResult<McpListing> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  return listingOf(source.value);
}

/** The file as text, for the JSON view. A project with no `.mcp.json` has empty text. */
export function readMcpText(projectRoot: string): McpResult<McpText> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  return ok({ revision: digestOf(source.value.text), exists: source.value.exists, text: source.value.text });
}

/** One server with its values, for a person who began editing it. */
export function revealMcpServer(projectRoot: string, revision: Digest, name: string): McpResult<McpServerConfig> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  if (digestOf(source.value.text) !== revision) {
    return failure('changed');
  }
  return configOf(source.value.text, name);
}

/** Applies `change` to the revision it was authored against and answers with the new listing. */
export function applyMcpChange(projectRoot: string, revision: Digest, change: McpChange): McpResult<McpListing> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  if (digestOf(source.value.text) !== revision) {
    return failure('changed');
  }
  const taken = takenNames(source.value.text);
  if (!taken.ok) {
    return taken;
  }
  if (change.kind === 'add' && taken.value.includes(change.name)) {
    return failure('name-taken');
  }
  if (change.kind !== 'add' && !taken.value.includes(change.name)) {
    return failure('not-found');
  }
  const next = changeMcpJson(source.value.text, change.kind === 'remove' ? change : { kind: 'upsert', name: change.name, config: change.config });
  if (!next.ok) {
    return failure(next.error === 'invalid-name' ? 'invalid-name' : next.error === 'too-many-servers' ? 'limit' : next.error);
  }
  return writeProjectAndList(projectRoot, source.value, next.value, revision);
}

/** Replaces the whole file with text a person edited in the JSON view, once it is valid. */
export function saveMcpText(projectRoot: string, revision: Digest, text: string): McpResult<McpListing> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  if (digestOf(source.value.text) !== revision) {
    return failure('changed');
  }
  if (new TextEncoder().encode(text).length > MCP_LIMITS.fileBytesMax) {
    return failure('too-large');
  }
  // The renderer checked this already; main checks again, because the renderer is not trusted with the file.
  if (mcpJsonIssues(text).length > 0) {
    return failure('invalid');
  }
  return writeProjectAndList(projectRoot, source.value, text, revision);
}

function takenNames(text: string): McpResult<readonly string[]> {
  const scanned = scanMcpJson(text);
  if (!scanned.ok) {
    return failure('unreadable');
  }
  return ok(mcpFileEntries(scanned.value).map((entry) => entry.name));
}

function configOf(text: string, name: string): McpResult<McpServerConfig> {
  const scanned = scanMcpJson(text);
  if (!scanned.ok) {
    return failure('unreadable');
  }
  const entry = mcpFileEntries(scanned.value).find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return failure('not-found');
  }
  return entry.status === 'server' ? ok(entry.config) : failure('invalid');
}

function listingOf(source: TextSource): McpResult<McpListing> {
  const scanned = scanMcpJson(source.text);
  if (!scanned.ok) {
    return failure(scanned.error.code === 'too-large' ? 'too-large' : 'unreadable');
  }
  return ok({ revision: digestOf(source.text), exists: source.exists, servers: itemsOf(scanned.value) });
}

function itemsOf(document: McpJsonDocument): readonly McpServerItem[] {
  return mcpFileEntries(document).map((entry): McpServerItem =>
    entry.status === 'server'
      ? { name: entry.name, status: 'server', summary: summarizeMcpServer(entry.config) }
      : { name: entry.name, status: 'invalid', problem: entry.problem },
  );
}

function projectFile(projectRoot: string): string {
  assert(path.isAbsolute(projectRoot), 'A project root is absolute');
  return path.join(projectRoot, MCP_FILE_NAME);
}

function readProjectSource(projectRoot: string): McpResult<TextSource> {
  const read = readTextFile(projectFile(projectRoot));
  return read.ok ? read : failure(read.error);
}

function writeProjectAndList(projectRoot: string, before: TextSource, text: string, revision: Digest): McpResult<McpListing> {
  const file = projectFile(projectRoot);
  try {
    if (before.exists) {
      writeProjectText(file, text, before.text);
    } else {
      createProjectText(file, text);
    }
  } catch {
    // A refused write reads the disk again to say whether another writer got there first.
    const now = readProjectSource(projectRoot);
    return failure(now.ok && digestOf(now.value.text) !== revision ? 'changed' : 'filesystem');
  }
  const after = readProjectSource(projectRoot);
  if (!after.ok) {
    return after;
  }
  assert(after.value.text === text, 'The saved .mcp.json reads back as planned');
  assert(scanMcpJson(after.value.text).ok, 'The saved .mcp.json scans');
  return listingOf(after.value);
}

// ---- Codex's ~/.codex/config.toml ----

/** The one place Codex's configuration is read or written: under the given home folder, never elsewhere. */
export function codexConfigPath(homeDirectory: string): string {
  assert(path.isAbsolute(homeDirectory), 'A home folder is absolute');
  return path.join(homeDirectory, CODEX_DIRECTORY, CODEX_FILE_NAME);
}

/** Codex's servers, or why they cannot be shown. A missing file is the ordinary state of a computer without Codex. */
export function readCodexState(homeDirectory: string): McpCodexState {
  const read = readCodexSource(homeDirectory);
  if (!read.ok) {
    return read.error;
  }
  return codexStateOf(read.value.document, read.value.text);
}

/** One Codex server with its values, shown only to a person who chose to bring it into the project. */
export function revealCodexServer(homeDirectory: string, revision: Digest, name: string): McpResult<McpServerConfig> {
  const read = readCodexSource(homeDirectory);
  if (!read.ok) {
    return failure('codex-unavailable');
  }
  if (digestOf(read.value.text) !== revision) {
    return failure('changed');
  }
  const entry = codexServerEntries(read.value.document).find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return failure('not-found');
  }
  return entry.config === undefined ? failure('unmappable') : ok(entry.config);
}

/**
 * Writes or removes the `[mcp_servers.<name>]` table for a server of the project. The server is read from
 * `.mcp.json` here, at `projectRevision`; only the one table of the Codex file changes.
 */
export function applyCodexChange(
  homeDirectory: string,
  projectRoot: string,
  revision: Digest,
  projectRevision: Digest,
  change: McpCodexChange,
): McpResult<McpCodexState> {
  const read = readCodexSource(homeDirectory);
  if (!read.ok) {
    return failure(read.error.state === 'missing' ? 'codex-unavailable' : read.error.code === 'codex-unsupported' ? 'codex-unsupported' : 'codex-unavailable');
  }
  if (digestOf(read.value.text) !== revision) {
    return failure('changed');
  }
  const edit = change.kind === 'remove' ? ok({ kind: 'remove' as const, name: change.name }) : putFromProject(projectRoot, projectRevision, change.name);
  if (!edit.ok) {
    return edit;
  }
  const next = changeCodexToml(read.value.text, edit.value);
  if (!next.ok) {
    return failure(codexFailure(next.error.code));
  }
  if (next.value !== read.value.text) {
    const written = replaceUserFile(codexConfigPath(homeDirectory), next.value, revision);
    if (!written.ok) {
      return written;
    }
  }
  const after = readCodexSource(homeDirectory);
  if (!after.ok) {
    return failure('codex-unavailable');
  }
  assert(after.value.text === next.value, 'The saved Codex file reads back as planned');
  return ok(codexStateOf(after.value.document, after.value.text));
}

function putFromProject(
  projectRoot: string,
  projectRevision: Digest,
  name: string,
): McpResult<{ readonly kind: 'put'; readonly name: string; readonly config: McpServerConfig }> {
  const source = readProjectSource(projectRoot);
  if (!source.ok) {
    return source;
  }
  if (digestOf(source.value.text) !== projectRevision) {
    return failure('changed');
  }
  const config = configOf(source.value.text, name);
  return config.ok ? ok({ kind: 'put', name, config: config.value }) : config;
}

function codexFailure(code: string): McpErrorCode {
  switch (code) {
    case 'unmappable':
      return 'unmappable';
    case 'not-found':
      return 'not-found';
    case 'bad-name':
      return 'invalid-name';
    case 'too-large':
      return 'too-large';
    case 'too-many':
      return 'limit';
    default:
      return 'codex-unsupported';
  }
}

interface CodexSource {
  readonly text: string;
  readonly document: CodexDocument;
}

function readCodexSource(homeDirectory: string): Result<CodexSource, Exclude<McpCodexState, { readonly state: 'ready' }>> {
  const read = readTextFile(codexConfigPath(homeDirectory));
  if (!read.ok) {
    return err({ state: 'unavailable', code: read.error });
  }
  if (!read.value.exists) {
    return err({ state: 'missing' });
  }
  const scanned = scanCodexToml(read.value.text);
  if (!scanned.ok) {
    return err({ state: 'unavailable', code: scanned.error.code === 'too-large' ? 'too-large' : 'codex-unsupported' });
  }
  return ok({ text: read.value.text, document: scanned.value });
}

function codexStateOf(document: CodexDocument, text: string): McpCodexState {
  const servers = codexServerEntries(document).map((entry): McpServerItem =>
    entry.config === undefined
      ? { name: entry.name, status: 'invalid', problem: { code: 'missing-target', path: `mcp_servers.${entry.name}` } }
      : { name: entry.name, status: 'server', summary: summarizeMcpServer(entry.config) },
  );
  return { state: 'ready', revision: digestOf(text), servers };
}

// ---- Shared file helpers ----

// The file's text, or empty text for none. Too large, not a regular file, or not UTF-8 is unreadable: reading it
// lossily could let a later save destroy it.
function readTextFile(file: string): Result<TextSource, ReadCode> {
  let bytes: Buffer;
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile()) {
      return err('unreadable');
    }
    if (stats.size > MCP_LIMITS.fileBytesMax) {
      return err('too-large');
    }
    bytes = fs.readFileSync(file);
  } catch (caught: unknown) {
    const code = errorCode(caught);
    if (code === 'ENOENT') {
      return ok({ text: '', exists: false });
    }
    return err(code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable');
  }
  try {
    // The byte-order mark is kept: the editors print it back.
    return ok({ text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), exists: true });
  } catch {
    return err('not-text');
  }
}

// Replaces an existing file of the person's own (see the header for what it guards and what it cannot).
function replaceUserFile(file: string, text: string, revision: Digest): McpResult<void> {
  const target = writeTargetOf(file);
  if (!target.ok) {
    return failure('filesystem');
  }
  const temporary = path.join(path.dirname(target.value), `.${path.basename(target.value)}.stacki-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const stats = fs.statSync(target.value);
    if (!stats.isFile() || stats.nlink > 1) {
      return failure('filesystem');
    }
    descriptor = fs.openSync(temporary, 'wx', stats.mode & 0o777 || FALLBACK_MODE);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // The last look before the rename: another program that wrote in the meantime wins, and this change is refused.
    const now = readTextFile(target.value);
    if (!now.ok || digestOf(now.value.text) !== revision) {
      fs.rmSync(temporary, { force: true });
      return failure('changed');
    }
    fs.renameSync(temporary, target.value);
    return ok(undefined);
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor was already closed; the temporary file is removed below either way.
      }
    }
    fs.rmSync(temporary, { force: true });
    return failure('filesystem');
  }
}
