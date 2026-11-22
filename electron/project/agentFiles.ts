// The project's agent definitions for Settings > Agents (shared/properties/projectAgents.ts): a bounded
// listing of `.claude/agents/*.md` and `.codex/agents/*.toml`, the paired agents in `.stacki/agents/`
// and whether each generated file still matches its fields, and the writes that create or re-sync a
// pair. Editing one definition's text is the Instructions editor's job (instructionFiles.ts); this file
// never rewrites a definition the person wrote, and overwrites a generated one only when asked to.
//
// Every write goes through the files' document actors (documentWrites.ts). A path is resolved inside
// the project once links are followed, and a link itself is refused, as the Instructions files are.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { AGENT_IDS, type AgentId } from '../../shared/properties/ai/agentIds';
import {
  AGENT_FOLDERS,
  AGENT_SOURCE_FOLDER,
  PROJECT_AGENT_LIMITS,
  agentFileStem,
  agentPath,
  agentProblemDetail,
  agentSaveDecision,
  agentSourcePath,
  claudeAgentMeta,
  claudeFrontmatter,
  codexAgentMeta,
  pairedFileState,
  pairedSourceOf,
  readAgentSource,
  type AgentDeleteTarget,
  type AgentFields,
  type AgentListing,
  type AgentMeta,
  type AgentWriteFailure,
  type AgentWriteResult,
  type PairedAgent,
  type PairedFileState,
  type ProjectAgent,
} from '../../shared/properties/projectAgents';
import { digestOf } from '../documents/atomicWrite';
import { describeWriteReport, documentHost } from '../documents/documentWrites';

/** Every definition each CLI reads from the project, and every paired agent with its files' state. Total: a bound cuts the listing short and says so. */
export function listAgents(root: string): AgentListing {
  assert(path.isAbsolute(root), 'listAgents: the project root is absolute');
  let truncated = false;
  const agents: ProjectAgent[] = [];
  for (const provider of AGENT_IDS) {
    const place = AGENT_FOLDERS[provider];
    const names = definitionNames(root, place.folder, place.extension);
    if (names.length > PROJECT_AGENT_LIMITS.agentsMax) {
      truncated = true;
    }
    for (const name of names.slice(0, PROJECT_AGENT_LIMITS.agentsMax)) {
      agents.push(agentEntry(root, provider, `${place.folder}/${name}`));
    }
  }
  const sources = definitionNames(root, AGENT_SOURCE_FOLDER, '.json');
  if (sources.length > PROJECT_AGENT_LIMITS.pairedMax) {
    truncated = true;
  }
  const paired = sources.slice(0, PROJECT_AGENT_LIMITS.pairedMax).map((name) => pairedEntry(root, `${AGENT_SOURCE_FOLDER}/${name}`));
  assert(agents.length <= PROJECT_AGENT_LIMITS.agentsMax * AGENT_IDS.length, 'listAgents: the listing holds its bound');
  assert(paired.length <= PROJECT_AGENT_LIMITS.pairedMax, 'listAgents: the paired listing holds its bound');
  return { agents, paired, truncated };
}

/** What a Claude definition's text says. The YAML reader refuses aliases, so a definition cannot expand into a huge value. */
export function readClaudeAgentMeta(source: string): AgentMeta {
  const located = claudeFrontmatter(source);
  if (located.kind === 'problem') {
    return { name: undefined, description: undefined, model: undefined, tools: undefined, problems: [located.problem] };
  }
  let parsed: unknown;
  try {
    const value: unknown = YAML.parse(located.yaml, { maxAliasCount: 0, prettyErrors: true, uniqueKeys: true });
    parsed = value;
  } catch (failure: unknown) {
    // Pretty errors carry the line (`linePos`); only their first line is kept as the detail.
    // The YAML starts on the file's second line, after the opening fence.
    const line = yamlLine(failure);
    return {
      name: undefined,
      description: undefined,
      model: undefined,
      tools: undefined,
      problems: [{ kind: 'syntax', line: line === undefined ? undefined : line + 1, detail: agentProblemDetail(failure) }],
    };
  }
  return claudeAgentMeta(parsed);
}

/** What a definition's text says, for its provider. */
export function readAgentMeta(provider: AgentId, source: string): AgentMeta {
  switch (provider) {
    case 'claude':
      return readClaudeAgentMeta(source);
    case 'codex':
      return codexAgentMeta(source);
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

/**
 * Creates a paired agent (`mode: 'create'`: none of its three files may exist), or writes changed fields
 * over an existing one (`mode: 'update'`). A generated file that no longer matches its old fields is an
 * edit someone made: it is overwritten only when its provider is in `overwrite`, which the person chose.
 */
export function saveAgent(
  root: string,
  request: { readonly fields: AgentFields; readonly mode: 'create' | 'update'; readonly overwrite: readonly AgentId[] },
): AgentWriteResult {
  const plan = planAgentSave(root, request);
  if (!plan.ok) {
    return plan;
  }
  const applied = applyAgentChanges(root, plan.value.changes);
  if (!applied.ok) {
    // The channel's failure codes have no `conflict`: a file changed between the read and the write is a failed write there.
    return failure(applied.error.code === 'conflict' ? 'write-failed' : applied.error.code, applied.error.message);
  }
  return ok({ written: applied.value });
}

/** One file a save or a delete changes: what it holds now and what it will hold (undefined: absent, or removed). */
export interface AgentFileChange {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** Why a planned change could not be applied: the channel's codes, and `conflict` for a file that changed after it was read. */
export type AgentApplyFailure = { readonly code: AgentWriteFailure | 'conflict'; readonly message: string };

/**
 * What a save would change, read from the disk and decided by `agentSaveDecision` (the rules the panel and
 * `stacki agents` share): each file whose text changes, with the text it holds now. Nothing is written.
 */
export function planAgentSave(
  root: string,
  request: { readonly fields: AgentFields; readonly mode: 'create' | 'update'; readonly overwrite: readonly AgentId[] },
): Result<{ readonly fields: AgentFields; readonly changes: readonly AgentFileChange[] }, { readonly code: AgentWriteFailure; readonly message: string }> {
  const decision = agentSaveDecision(listAgents(root), request);
  if (!decision.ok) {
    return decision;
  }
  const changes: AgentFileChange[] = [];
  for (const file of decision.value.files) {
    const absolute = projectPath(root, file.path);
    if (!absolute.ok) {
      return absolute;
    }
    const exists = fs.existsSync(absolute.value);
    if (exists && request.mode === 'create') {
      return failure('exists', `${file.path} already exists.`);
    }
    const before = exists ? readText(absolute.value) : undefined;
    if (exists && before === undefined) {
      return failure('invalid', `${file.path} is not a readable file of at most ${PROJECT_AGENT_LIMITS.fileBytesMax} bytes.`);
    }
    if (before !== file.text) {
      changes.push({ path: file.path, before, after: file.text });
    }
  }
  assert(changes.length <= AGENT_IDS.length + 1, 'planAgentSave: a pair is its source and one file per CLI');
  assert(request.mode === 'update' || changes.length === AGENT_IDS.length + 1, 'planAgentSave: a new pair writes all its files');
  return ok({ fields: decision.value.fields, changes });
}

/**
 * Writes planned changes all or none: each file must still hold the text the plan read (`conflict` otherwise, nothing
 * written), and on the first failure every file already changed is put back. A file whose `after` is undefined is
 * removed: only the command line does that, since the panel deletes to the Trash. Answers the paths written, in order.
 */
export function applyAgentChanges(root: string, changes: readonly AgentFileChange[]): Result<readonly string[], AgentApplyFailure> {
  assert(changes.length <= PROJECT_AGENT_LIMITS.pairedMax * (AGENT_IDS.length + 1), 'applyAgentChanges: bounded by the paired agents a project keeps');
  const targets: { readonly change: AgentFileChange; readonly absolute: string }[] = [];
  for (const change of changes) {
    assert(change.before !== change.after, 'applyAgentChanges: a change changes the file');
    const absolute = projectPath(root, change.path);
    if (!absolute.ok) {
      return absolute;
    }
    const current = fs.existsSync(absolute.value) ? (readText(absolute.value) ?? '') : undefined;
    if (current !== change.before) {
      return err({ code: 'conflict', message: `${change.path} changed since the plan read it; nothing was written.` });
    }
    targets.push({ change, absolute: absolute.value });
  }
  const done: { readonly change: AgentFileChange; readonly absolute: string }[] = [];
  for (const target of targets) {
    const written = writeChange(target.absolute, target.change.before, target.change.after);
    if (!written.ok) {
      // Newest first, each put back to the text it held: a half-made pair would read as edited.
      for (const undone of [...done].reverse()) {
        writeChange(undone.absolute, undone.change.after, undone.change.before);
      }
      return written;
    }
    done.push(target);
  }
  assert(done.length === changes.length, 'applyAgentChanges: every change was written');
  return ok(done.map((target) => target.change.path));
}

/** A project-relative agent file's text, read inside the project within the size bound; undefined when it is missing, unreadable, too large or a link. */
export function readAgentText(root: string, relative: string): string | undefined {
  const absolute = projectPath(root, relative);
  return absolute.ok ? readText(absolute.value) : undefined;
}

/** The files a delete removes, each resolved inside the project; `missing` when none of them exists. */
export function agentDeleteFiles(
  root: string,
  target: AgentDeleteTarget,
): Result<readonly { readonly relative: string; readonly absolute: string }[], { readonly code: AgentWriteFailure; readonly message: string }> {
  const relatives = target.kind === 'file' ? [target.path] : [agentSourcePath(target.name), ...AGENT_IDS.map((provider) => agentPath(provider, target.name))];
  const resolved: { readonly relative: string; readonly absolute: string }[] = [];
  for (const relative of relatives) {
    const absolute = projectPath(root, relative);
    if (!absolute.ok) {
      return absolute;
    }
    if (fs.existsSync(absolute.value)) {
      resolved.push({ relative, absolute: absolute.value });
    }
  }
  if (resolved.length === 0) {
    return failure('missing', `${relatives[0] ?? target.kind} is already gone.`);
  }
  assert(resolved.length <= AGENT_IDS.length + 1, 'agentDeleteFiles: one pair and its source at most');
  return ok(resolved);
}

/** Moves a definition, or a paired agent's source and both its files, to the Trash: never a permanent delete. */
export async function deleteAgent(root: string, target: AgentDeleteTarget, trash: (file: string) => Promise<void>): Promise<AgentWriteResult> {
  const resolved = agentDeleteFiles(root, target);
  if (!resolved.ok) {
    return resolved;
  }
  for (const file of resolved.value) {
    try {
      await trash(file.absolute);
    } catch (error: unknown) {
      return failure('write-failed', error instanceof Error ? error.message : String(error));
    }
  }
  return ok({ written: resolved.value.map((file) => file.relative) });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// One file from `before` to `after`: created, replaced as witnessed by `before`, or removed.
function writeChange(absolute: string, before: string | undefined, after: string | undefined): Result<undefined, AgentApplyFailure> {
  if (after === undefined) {
    try {
      fs.rmSync(absolute, { force: true });
      return ok(undefined);
    } catch (error: unknown) {
      return failure('write-failed', error instanceof Error ? error.message : String(error));
    }
  }
  return before === undefined ? createFile(absolute, after) : replaceFile(absolute, after, before);
}

function createFile(absolute: string, text: string): Result<undefined, { readonly code: AgentWriteFailure; readonly message: string }> {
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
  } catch (error: unknown) {
    return failure('write-failed', error instanceof Error ? error.message : String(error));
  }
  const host = documentHost();
  host.noteWrite(absolute);
  const created = host.documents.create(absolute, text);
  if (!created.ok) {
    return failure(created.error.code === 'exists' ? 'exists' : 'write-failed', created.error.message);
  }
  return ok(undefined);
}

// Witnessed by the text just read: a change made in between is refused, never overwritten.
function replaceFile(absolute: string, text: string, base: string): Result<undefined, { readonly code: AgentWriteFailure; readonly message: string }> {
  const host = documentHost();
  host.noteWrite(absolute);
  const report = host.documents.writeText(absolute, text, digestOf(base));
  if (report.tag !== 'applied') {
    return failure('write-failed', describeWriteReport(path.basename(absolute), report));
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The definition files directly in `folder` with `extension`, sorted; a missing folder has none.
function definitionNames(root: string, folder: string, extension: string): readonly string[] {
  const absolute = path.join(root, ...folder.split('/'));
  let entries: readonly fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension) && entry.name.length > extension.length)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true }));
}

function agentEntry(root: string, provider: AgentId, relative: string): ProjectAgent {
  const source = readText(path.join(root, ...relative.split('/')));
  const meta: AgentMeta =
    source === undefined
      ? { name: undefined, description: undefined, model: undefined, tools: undefined, problems: [{ kind: 'too-large' }] }
      : readAgentMeta(provider, source);
  const stem = agentFileStem(relative);
  return {
    provider,
    path: relative,
    name: (meta.name ?? stem).slice(0, PROJECT_AGENT_LIMITS.nameCharsMax),
    description: meta.description,
    model: meta.model,
    tools: meta.tools,
    problems: meta.problems,
    pairedSource: source === undefined ? undefined : pairedSourceOf(source),
  };
}

function pairedEntry(root: string, relative: string): PairedAgent {
  const text = readText(path.join(root, ...relative.split('/')));
  const fields = text === undefined ? err({ kind: 'too-large' as const }) : readAgentSource(text, relative);
  const stem = agentFileStem(relative);
  const stateOf = (provider: AgentId): PairedFileState => {
    const onDisk = readText(path.join(root, ...agentPath(provider, stem).split('/')));
    if (fields.ok) {
      return pairedFileState(fields.value, provider, onDisk);
    }
    // Unreadable fields generate nothing, so any file there counts as someone's edit.
    return onDisk === undefined ? 'missing' : 'edited';
  };
  return { source: relative, fields, files: { claude: stateOf('claude'), codex: stateOf('codex') } };
}

// A file's text, or undefined when it is missing, unreadable or past the size bound.
function readText(absolute: string): string | undefined {
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > PROJECT_AGENT_LIMITS.fileBytesMax) {
      return undefined;
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

function yamlLine(failure: unknown): number | undefined {
  if (typeof failure !== 'object' || failure === null) {
    return undefined;
  }
  const positions: unknown = Reflect.get(failure, 'linePos');
  if (!Array.isArray(positions)) {
    return undefined;
  }
  const first: unknown = positions[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  const line: unknown = Reflect.get(first, 'line');
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * A project-relative path as an absolute one inside the project, or why not: outside it once links
 * are followed, or a link itself. `.stacki/agents/` is allowed here, unlike the Instructions files.
 */
function projectPath(root: string, relative: string): Result<string, { readonly code: AgentWriteFailure; readonly message: string }> {
  assert(path.isAbsolute(root), 'projectPath: the project root is absolute');
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return failure('invalid', `${relative} is not a path inside the project.`);
  }
  const canonical = fs.realpathSync(root);
  const target = path.join(canonical, ...segments);
  let existing = target;
  for (let step = 0; step <= segments.length; step += 1) {
    if (fs.existsSync(existing)) {
      break;
    }
    existing = path.dirname(existing);
  }
  const inside = path.relative(canonical, fs.realpathSync(existing));
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return failure('invalid', `${relative} leads outside the project.`);
  }
  if (existing === target && fs.lstatSync(target).isSymbolicLink()) {
    return failure('invalid', `${relative} is a link.`);
  }
  return ok(target);
}

function failure(code: AgentWriteFailure, message: string): Result<never, { readonly code: AgentWriteFailure; readonly message: string }> {
  assert(message.length > 0, 'A failure says why');
  return err({ code, message });
}
