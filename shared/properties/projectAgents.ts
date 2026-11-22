// i18n-ignore-file: the generated files' header comments are text written into the project's agent files, not interface text; problems travel as codes the renderer words.
// The project's agent definitions for Settings > Agents and the AI panel's agent choice: where each
// coding agent's CLI reads them, what a definition must say, and the paired agents Stacki creates for
// both CLIs from one set of fields.
//
// Where each CLI reads project agents (checked against the installed CLI and the providers' docs):
//
// - Claude Code: `.claude/agents/<name>.md`, Markdown whose YAML frontmatter holds `name` and
//   `description` (required) and `tools`, `model` and more (optional); the body is the system prompt.
//   The ACP adapter offers them as the session's `agent` option (claude-agent-acp 0.105.0).
// - Codex: `.codex/agents/<name>.toml`, one standalone TOML file per agent with `name`,
//   `description` and `developer_instructions` (required) and `model`, `model_reasoning_effort` and
//   other config keys (optional), per OpenAI's Codex subagents documentation. Codex reads `name`, not
//   the file name. Not checked against an installed Codex: none is installed where this was written.
//
// A paired agent is one set of fields (`.stacki/agents/<name>.json`, tracked, shared with the team)
// and the two files generated from it. The generators are pure and deterministic, so whether a file
// still matches its fields is a comparison with what the fields generate now: an edit made in either
// file shows as "edited" and is never overwritten without the person choosing to re-sync.
import { assert } from '../core/assert';
import { boolean, count, list, pathText, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { AGENT_IDS, parseAgentId, type AgentId } from './ai/agentIds';
import { yamlScalar } from './instructions';
import { scanCodexToml, type TomlEntry } from './mcpToml';

// The bounds live beside the parsers and the walk that enforce them (AGENTS.md §10).
export const PROJECT_AGENT_LIMITS = {
  /** Definitions one provider's folder lists; past it the listing says it is cut short. */
  agentsMax: 200,
  /** Paired agents (`.stacki/agents/*.json`) one project keeps. */
  pairedMax: 200,
  /** The largest definition or source file read. */
  fileBytesMax: 256 * 1024,
  /** The frontmatter a Claude definition may open with. */
  frontmatterCharsMax: 65_536,
  /** An agent's name. */
  nameCharsMax: 64,
  /** An agent's description, as Claude Code limits a skill's. */
  descriptionCharsMax: 1_024,
  /** An agent's instructions: the Claude body, the Codex `developer_instructions`. */
  instructionsCharsMax: 100_000,
  /** Tools one Claude agent lists. */
  toolsMax: 64,
  /** Characters in one tool name or rule (`Bash(git status:*)`). */
  toolCharsMax: 128,
  /** Characters in one model name. */
  modelCharsMax: 128,
  /** Characters of a parser's own words kept in a problem. */
  problemDetailCharsMax: 300,
  /** Problems one definition reports. */
  problemsMax: 8,
  /** Characters in one project-relative path. */
  pathCharsMax: 512,
} as const satisfies Record<string, number>;

/** Where each CLI reads the project's agents, and the extension of a definition there. */
export const AGENT_FOLDERS: Readonly<Record<AgentId, { readonly folder: string; readonly extension: string }>> = {
  claude: { folder: '.claude/agents', extension: '.md' },
  codex: { folder: '.codex/agents', extension: '.toml' },
};

/** Where the fields of paired agents are kept: tracked project metadata. */
export const AGENT_SOURCE_FOLDER = '.stacki/agents';

/** Why a definition cannot be used as it stands. The renderer words each kind. */
export type AgentProblem =
  | { readonly kind: 'too-large' }
  | { readonly kind: 'no-frontmatter' }
  | { readonly kind: 'unclosed-frontmatter' }
  | { readonly kind: 'syntax'; readonly line: number | undefined; readonly detail: string }
  | { readonly kind: 'duplicate-key'; readonly key: string }
  | { readonly kind: 'not-a-map' }
  | { readonly kind: 'missing-field'; readonly field: string }
  | { readonly kind: 'wrong-type'; readonly field: string }
  | { readonly kind: 'too-long'; readonly field: string };

export const AGENT_PROBLEM_KINDS = [
  'too-large',
  'no-frontmatter',
  'unclosed-frontmatter',
  'syntax',
  'duplicate-key',
  'not-a-map',
  'missing-field',
  'wrong-type',
  'too-long',
] as const satisfies readonly AgentProblem['kind'][];

/** What a definition file says, as far as it can be read. `problems` empty means each CLI can use it. */
export interface AgentMeta {
  /** The definition's `name`; undefined when it has none usable (the file name then stands in). */
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly model: string | undefined;
  /** Claude's `tools`; undefined when the definition lists none (every tool) or for Codex. */
  readonly tools: readonly string[] | undefined;
  readonly problems: readonly AgentProblem[];
}

/** A paired file's state: what the fields generate, someone's edit, or gone. */
export type PairedFileState = 'in-sync' | 'edited' | 'missing';

export interface ProjectAgent {
  readonly provider: AgentId;
  /** Project-relative, `/`-separated. */
  readonly path: string;
  /** The name the CLI uses: the definition's own, else the file name without its extension. */
  readonly name: string;
  readonly description: string | undefined;
  readonly model: string | undefined;
  readonly tools: readonly string[] | undefined;
  readonly problems: readonly AgentProblem[];
  /** The paired agent's source when Stacki generated this file; undefined for one written by hand. */
  readonly pairedSource: string | undefined;
}

export interface PairedAgent {
  /** `.stacki/agents/<name>.json`. */
  readonly source: string;
  /** The fields, or why the source cannot be read (then nothing is generated from it). */
  readonly fields: Result<AgentFields, AgentProblem>;
  readonly files: Readonly<Record<AgentId, PairedFileState>>;
}

export interface AgentListing {
  /** Claude's first, then Codex's, each sorted by path. */
  readonly agents: readonly ProjectAgent[];
  readonly paired: readonly PairedAgent[];
  /** A folder held more definitions than a listing carries. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The definition path a provider's CLI reads for `name`. */
export function agentPath(provider: AgentId, name: string): string {
  assert(name.length > 0, 'agentPath: an agent has a name');
  assert(!name.includes('/'), 'agentPath: a name is one path segment');
  const place = AGENT_FOLDERS[provider];
  return `${place.folder}/${name}${place.extension}`;
}

/** The paired agent's source path for `name`. */
export function agentSourcePath(name: string): string {
  assert(agentNameProblem(name) === undefined, 'agentSourcePath: a paired agent has a valid name');
  return `${AGENT_SOURCE_FOLDER}/${name}.json`;
}

/** The provider whose CLI reads `path` as an agent, or undefined: a file directly in that provider's folder with its extension. */
export function agentProviderOf(path: string): AgentId | undefined {
  for (const provider of AGENT_IDS) {
    const place = AGENT_FOLDERS[provider];
    const prefix = `${place.folder}/`;
    if (path.startsWith(prefix)) {
      const name = path.slice(prefix.length);
      if (name.length > place.extension.length && !name.includes('/') && name.toLowerCase().endsWith(place.extension)) {
        return provider;
      }
    }
  }
  return undefined;
}

/** Whether `path` is a Codex agent definition: the one TOML file the Instructions editor opens. */
export function isCodexAgentPath(path: string): boolean {
  return agentProviderOf(path) === 'codex';
}

/** The file name without its folder or extension: the name of a definition that names none. */
export function agentFileStem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  assert(stem.length > 0, 'agentFileStem: a definition file has a name');
  return stem;
}

// ---------------------------------------------------------------------------
// Claude definitions: Markdown with YAML frontmatter
// ---------------------------------------------------------------------------

/** The frontmatter of a Claude definition, located without touching a byte: its YAML, or the problem that stops it being read. */
export type ClaudeFrontmatter =
  { readonly kind: 'yaml'; readonly yaml: string; readonly body: string } | { readonly kind: 'problem'; readonly problem: AgentProblem };

const BOM = '﻿';
const FENCE_OPEN = /^---[ \t]*\r?\n/;

/**
 * Finds the frontmatter of a Claude definition. A byte-order mark is read past (an editor on Windows may
 * write one; the file keeps it, since nothing here writes), CRLF and LF both close a fence, and a key
 * written twice at the top level is a problem before any YAML is parsed, so the answer never depends
 * on which of the two a YAML reader keeps.
 */
export function claudeFrontmatter(source: string): ClaudeFrontmatter {
  if (source.length > PROJECT_AGENT_LIMITS.fileBytesMax) {
    return { kind: 'problem', problem: { kind: 'too-large' } };
  }
  const content = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const open = FENCE_OPEN.exec(content);
  if (open === null) {
    return { kind: 'problem', problem: { kind: 'no-frontmatter' } };
  }
  const start = open[0].length;
  // A fresh expression per call: a shared global one would carry its position between files.
  const fenceClose = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  fenceClose.lastIndex = start;
  const close = fenceClose.exec(content);
  if (close === null || close.index > PROJECT_AGENT_LIMITS.frontmatterCharsMax) {
    return { kind: 'problem', problem: { kind: 'unclosed-frontmatter' } };
  }
  const yaml = content.slice(start, close.index);
  const repeated = repeatedTopLevelKey(yaml);
  if (repeated !== undefined) {
    return { kind: 'problem', problem: { kind: 'duplicate-key', key: repeated } };
  }
  const body = content.slice(close.index + close[0].length);
  assert(yaml.length <= PROJECT_AGENT_LIMITS.frontmatterCharsMax, 'claudeFrontmatter: the YAML is bounded');
  return { kind: 'yaml', yaml, body };
}

// A top-level mapping key: at the start of a line, plain or quoted, followed by a colon.
const TOP_LEVEL_KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:,[\]{}&*!|>%@`][^:#]*?))[ \t]*:(?:[ \t]|$)/;

/** The first top-level key written twice, compared as written; undefined when every key is written once. */
export function repeatedTopLevelKey(yaml: string): string | undefined {
  const seen = new Set<string>();
  const lines = yaml.split(/\r?\n/);
  assert(lines.length <= PROJECT_AGENT_LIMITS.frontmatterCharsMax + 1, 'repeatedTopLevelKey: bounded by the frontmatter');
  for (const line of lines) {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match !== null) {
      const key = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (seen.has(key)) {
        return key;
      }
      seen.add(key);
    }
  }
  return undefined;
}

/** What a Claude definition says, from its parsed frontmatter (the YAML is read by the caller, in main). */
export function claudeAgentMeta(frontmatter: unknown): AgentMeta {
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return { name: undefined, description: undefined, model: undefined, tools: undefined, problems: [{ kind: 'not-a-map' }] };
  }
  const fields = record(frontmatter);
  const problems: AgentProblem[] = [];
  const name = requiredText(fields, 'name', PROJECT_AGENT_LIMITS.nameCharsMax, problems);
  const description = requiredText(fields, 'description', PROJECT_AGENT_LIMITS.descriptionCharsMax, problems);
  const model = optionalText(fields, 'model', PROJECT_AGENT_LIMITS.modelCharsMax, problems);
  const tools = claudeTools(fields['tools'], problems);
  assert(problems.length <= PROJECT_AGENT_LIMITS.problemsMax, 'claudeAgentMeta: problems are bounded');
  return { name, description, model, tools, problems };
}

// Claude reads `tools` as a comma-separated string or a YAML list; absent means every tool.
function claudeTools(input: unknown, problems: AgentProblem[]): readonly string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  let items: readonly unknown[];
  if (typeof input === 'string') {
    items = input.split(',');
  } else if (Array.isArray(input)) {
    items = input;
  } else {
    problems.push({ kind: 'wrong-type', field: 'tools' });
    return undefined;
  }
  if (items.length > PROJECT_AGENT_LIMITS.toolsMax) {
    problems.push({ kind: 'too-long', field: 'tools' });
    return undefined;
  }
  const tools: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      problems.push({ kind: 'wrong-type', field: 'tools' });
      return undefined;
    }
    const tool = item.trim();
    if (tool.length > PROJECT_AGENT_LIMITS.toolCharsMax) {
      problems.push({ kind: 'too-long', field: 'tools' });
      return undefined;
    }
    if (tool !== '') {
      tools.push(tool);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Codex definitions: standalone TOML
// ---------------------------------------------------------------------------

/** What a Codex definition says. The TOML is read by the shared Codex scanner (mcpToml.ts), which refuses what it cannot read exactly. */
export function codexAgentMeta(source: string): AgentMeta {
  if (source.length > PROJECT_AGENT_LIMITS.fileBytesMax) {
    return { name: undefined, description: undefined, model: undefined, tools: undefined, problems: [{ kind: 'too-large' }] };
  }
  const content = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const scanned = scanCodexToml(content);
  if (!scanned.ok) {
    const problem: AgentProblem =
      scanned.error.code === 'too-large' ? { kind: 'too-large' } : { kind: 'syntax', line: scanned.error.line, detail: scanned.error.code };
    return { name: undefined, description: undefined, model: undefined, tools: undefined, problems: [problem] };
  }
  const fields = rootStrings(scanned.value.rootEntries);
  const problems: AgentProblem[] = [];
  const name = requiredText(fields, 'name', PROJECT_AGENT_LIMITS.nameCharsMax, problems);
  const description = requiredText(fields, 'description', PROJECT_AGENT_LIMITS.descriptionCharsMax, problems);
  requiredText(fields, 'developer_instructions', PROJECT_AGENT_LIMITS.instructionsCharsMax, problems);
  const model = optionalText(fields, 'model', PROJECT_AGENT_LIMITS.modelCharsMax, problems);
  assert(problems.length <= PROJECT_AGENT_LIMITS.problemsMax, 'codexAgentMeta: problems are bounded');
  return { name, description, model, tools: undefined, problems };
}

// The file's top-level single keys: a string as its text, anything else as a marker the field checks refuse.
function rootStrings(entries: readonly TomlEntry[]): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key[0];
    if (entry.key.length === 1 && key !== undefined) {
      fields[key] = entry.value.kind === 'string' ? entry.value.value : { kind: entry.value.kind };
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Field checks shared by both readers
// ---------------------------------------------------------------------------

function requiredText(fields: Readonly<Record<string, unknown>>, field: string, charsMax: number, problems: AgentProblem[]): string | undefined {
  const value = fields[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    problems.push({ kind: 'missing-field', field });
    return undefined;
  }
  return checkedText(value, field, charsMax, problems);
}

function optionalText(fields: Readonly<Record<string, unknown>>, field: string, charsMax: number, problems: AgentProblem[]): string | undefined {
  const value = fields[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  return checkedText(value, field, charsMax, problems);
}

function checkedText(value: unknown, field: string, charsMax: number, problems: AgentProblem[]): string | undefined {
  if (typeof value !== 'string') {
    problems.push({ kind: 'wrong-type', field });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > charsMax) {
    problems.push({ kind: 'too-long', field });
    return undefined;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Paired agents: one set of fields, a file for each CLI
// ---------------------------------------------------------------------------

/** What the New agent form asks for, and what `.stacki/agents/<name>.json` keeps. */
export interface AgentFields {
  readonly name: string;
  /** One line: both CLIs read it to decide when to use the agent. */
  readonly description: string;
  readonly instructions: string;
  /** Claude only (Codex has no per-agent tool list); empty means every tool. */
  readonly tools: readonly string[];
  /** Claude's model alias (`sonnet`, `opus`, `haiku`, `inherit`); undefined is Claude's own default. */
  readonly claudeModel: string | undefined;
  /** Codex's model id; undefined is the session's model. */
  readonly codexModel: string | undefined;
}

/** What a field the form shows can be wrong with. The renderer words each code. */
export type AgentFieldProblem = {
  readonly field: 'name' | 'description' | 'instructions' | 'tools' | 'claudeModel' | 'codexModel';
  readonly code: 'empty' | 'format' | 'too-long' | 'taken' | 'too-many';
};

const NAME_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_FORMAT = /^[A-Za-z0-9_*:()./@ -]+$/;
const MODEL_FORMAT = /^[A-Za-z0-9._:/[\]-]+$/;

/**
 * Why a typed name cannot name a paired agent, or undefined. Lowercase letters, digits and single hyphens:
 * Claude Code asks for lowercase and hyphens, and the name is also both files' name, so it must be a
 * safe file name on every system.
 */
export function agentNameProblem(name: string): AgentFieldProblem['code'] | undefined {
  if (name === '') {
    return 'empty';
  }
  if (name.length > PROJECT_AGENT_LIMITS.nameCharsMax) {
    return 'too-long';
  }
  return NAME_FORMAT.test(name) ? undefined : 'format';
}

/**
 * Every problem with the fields, for a new agent (`taken` lists the names already used by any agent of
 * either CLI, compared ignoring case, so the pair never shadows a definition written by hand) or for an
 * edit of an existing pair (`taken` then leaves out its own name).
 */
export function agentFieldProblems(fields: AgentFields, taken: readonly string[]): readonly AgentFieldProblem[] {
  const problems: AgentFieldProblem[] = [];
  const nameCode = agentNameProblem(fields.name);
  if (nameCode !== undefined) {
    problems.push({ field: 'name', code: nameCode });
  } else if (taken.some((other) => other.toLowerCase() === fields.name.toLowerCase())) {
    problems.push({ field: 'name', code: 'taken' });
  }
  textProblem(problems, 'description', fields.description, PROJECT_AGENT_LIMITS.descriptionCharsMax);
  textProblem(problems, 'instructions', fields.instructions, PROJECT_AGENT_LIMITS.instructionsCharsMax);
  if (fields.tools.length > PROJECT_AGENT_LIMITS.toolsMax) {
    problems.push({ field: 'tools', code: 'too-many' });
  } else if (fields.tools.some((tool) => tool.length > PROJECT_AGENT_LIMITS.toolCharsMax)) {
    problems.push({ field: 'tools', code: 'too-long' });
  } else if (fields.tools.some((tool) => tool.trim() === '' || !TOOL_FORMAT.test(tool))) {
    problems.push({ field: 'tools', code: 'format' });
  }
  modelProblem(problems, 'claudeModel', fields.claudeModel);
  modelProblem(problems, 'codexModel', fields.codexModel);
  assert(problems.length <= 6, 'agentFieldProblems: at most one problem per field');
  return problems;
}

function textProblem(problems: AgentFieldProblem[], field: 'description' | 'instructions', value: string, charsMax: number): void {
  if (value.trim() === '') {
    problems.push({ field, code: 'empty' });
  } else if (value.length > charsMax) {
    problems.push({ field, code: 'too-long' });
  }
}

function modelProblem(problems: AgentFieldProblem[], field: 'claudeModel' | 'codexModel', value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (value.length > PROJECT_AGENT_LIMITS.modelCharsMax) {
    problems.push({ field, code: 'too-long' });
  } else if (!MODEL_FORMAT.test(value)) {
    problems.push({ field, code: 'format' });
  }
}

/** The fields as the form hands them over, tidied: trimmed, one-line description, LF line breaks, no empty tools or models. */
export function normalizeAgentFields(fields: AgentFields): AgentFields {
  const claudeModel = fields.claudeModel?.trim();
  const codexModel = fields.codexModel?.trim();
  const normal: AgentFields = {
    name: fields.name.trim(),
    description: fields.description.trim().replace(/\s+/g, ' '),
    instructions: `${fields.instructions.replace(/\r\n?/g, '\n').trim()}\n`,
    tools: fields.tools.map((tool) => tool.trim()).filter((tool) => tool !== ''),
    claudeModel: claudeModel === undefined || claudeModel === '' ? undefined : claudeModel,
    codexModel: codexModel === undefined || codexModel === '' ? undefined : codexModel,
  };
  assert(!normal.description.includes('\n'), 'normalizeAgentFields: the description is one line');
  assert(!normal.instructions.includes('\r'), 'normalizeAgentFields: the instructions use LF');
  return normal;
}

/** The source file's text: stable, two-space JSON with a final newline. */
export function agentSourceText(fields: AgentFields): string {
  assert(agentNameProblem(fields.name) === undefined, 'agentSourceText: a paired agent has a valid name');
  const stored = {
    version: 1,
    name: fields.name,
    description: fields.description,
    instructions: fields.instructions,
    tools: fields.tools,
    models: {
      ...(fields.claudeModel === undefined ? {} : { claude: fields.claudeModel }),
      ...(fields.codexModel === undefined ? {} : { codex: fields.codexModel }),
    },
  };
  const source = `${JSON.stringify(stored, undefined, 2)}\n`;
  assert(source.length <= PROJECT_AGENT_LIMITS.fileBytesMax * 2, 'agentSourceText: bounded fields serialize within bounds');
  return source;
}

/** The source file read back: the fields, or the problem that stops anything being generated from them. */
export function readAgentSource(source: string, path: string): Result<AgentFields, AgentProblem> {
  if (source.length > PROJECT_AGENT_LIMITS.fileBytesMax) {
    return err({ kind: 'too-large' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (failure: unknown) {
    return err({ kind: 'syntax', line: undefined, detail: detailOf(failure) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ kind: 'not-a-map' });
  }
  const fields = record(parsed);
  if (fields['version'] !== 1) {
    return err({ kind: 'wrong-type', field: 'version' });
  }
  const models = fields['models'] === undefined ? {} : fields['models'];
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    return err({ kind: 'wrong-type', field: 'models' });
  }
  const modelFields = record(models);
  const candidate = {
    name: fields['name'],
    description: fields['description'],
    instructions: fields['instructions'],
    tools: fields['tools'] ?? [],
    claudeModel: modelFields['claude'],
    codexModel: modelFields['codex'],
  };
  for (const key of ['name', 'description', 'instructions'] as const) {
    if (typeof candidate[key] !== 'string') {
      return err({ kind: 'missing-field', field: key });
    }
  }
  if (!Array.isArray(candidate.tools) || !candidate.tools.every((tool: unknown) => typeof tool === 'string')) {
    return err({ kind: 'wrong-type', field: 'tools' });
  }
  for (const key of ['claudeModel', 'codexModel'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'string') {
      return err({ kind: 'wrong-type', field: key });
    }
  }
  // Every field is checked above; the shape is rebuilt from the checked values only.
  const read: AgentFields = {
    name: String(candidate.name),
    description: String(candidate.description),
    instructions: String(candidate.instructions),
    tools: candidate.tools.map((tool: unknown) => String(tool)),
    claudeModel: typeof candidate.claudeModel === 'string' ? candidate.claudeModel : undefined,
    codexModel: typeof candidate.codexModel === 'string' ? candidate.codexModel : undefined,
  };
  const problem = agentFieldProblems(read, [])[0];
  if (problem !== undefined) {
    return err(
      problem.code === 'too-long' || problem.code === 'too-many' ? { kind: 'too-long', field: problem.field } : { kind: 'wrong-type', field: problem.field },
    );
  }
  if (`${AGENT_SOURCE_FOLDER}/${read.name}.json` !== path) {
    return err({ kind: 'wrong-type', field: 'name' });
  }
  return ok(read);
}

/** The first line of each generated file: says where it came from, so a person editing it knows the pair exists. */
export function generatedMarker(fields: Pick<AgentFields, 'name'>, other: AgentId): string {
  return `Generated by Stacki from ${agentSourcePath(fields.name)} with the ${other === 'claude' ? 'Claude' : 'Codex'} copy. Edit both in Settings > Agents.`;
}

/** Whether a definition's text carries the marker of a paired agent's source; the source path, or undefined. */
export function pairedSourceOf(source: string): string | undefined {
  const head = source.slice(0, 1024);
  const match = /Generated by Stacki from (\.stacki\/agents\/[a-z0-9-]+\.json) with the /.exec(head);
  return match?.[1];
}

/** The Claude definition the fields generate: the marker as a YAML comment, so Claude reads nothing more than the fields. */
export function generateClaudeAgent(fields: AgentFields): string {
  assert(agentFieldProblems(fields, []).length === 0, 'generateClaudeAgent: the fields were checked');
  const lines = ['---', `# ${generatedMarker(fields, 'codex')}`, `name: ${fields.name}`, `description: ${yamlScalar(fields.description)}`];
  if (fields.tools.length > 0) {
    lines.push(`tools: ${yamlScalar(fields.tools.join(', '))}`);
  }
  if (fields.claudeModel !== undefined) {
    lines.push(`model: ${yamlScalar(fields.claudeModel)}`);
  }
  lines.push('---', '', fields.instructions.replace(/\n+$/, ''), '');
  const source = lines.join('\n');
  assert(pairedSourceOf(source) === agentSourcePath(fields.name), 'generateClaudeAgent: the file names its source');
  return source;
}

/** The Codex definition the fields generate. Tools are not written: Codex has no per-agent tool list. */
export function generateCodexAgent(fields: AgentFields): string {
  assert(agentFieldProblems(fields, []).length === 0, 'generateCodexAgent: the fields were checked');
  const lines = [`# ${generatedMarker(fields, 'claude')}`, `name = ${tomlString(fields.name)}`, `description = ${tomlString(fields.description)}`];
  if (fields.codexModel !== undefined) {
    lines.push(`model = ${tomlString(fields.codexModel)}`);
  }
  lines.push(`developer_instructions = """\n${tomlMultilineBody(fields.instructions.replace(/\n+$/, ''))}\n"""`, '');
  const source = lines.join('\n');
  assert(pairedSourceOf(source) === agentSourcePath(fields.name), 'generateCodexAgent: the file names its source');
  return source;
}

/** The file the fields generate for `provider`. */
export function generateAgent(fields: AgentFields, provider: AgentId): string {
  switch (provider) {
    case 'claude':
      return generateClaudeAgent(fields);
    case 'codex':
      return generateCodexAgent(fields);
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

/**
 * Whether a paired file still says what its fields generate. Line endings are ignored, because git may
 * check a file out with CRLF on Windows; any other difference is an edit, never repaired silently.
 */
export function pairedFileState(fields: AgentFields, provider: AgentId, onDisk: string | undefined): PairedFileState {
  if (onDisk === undefined) {
    return 'missing';
  }
  const expected = generateAgent(fields, provider);
  assert(!expected.includes('\r'), 'pairedFileState: generated files use LF');
  return onDisk.replace(/\r\n/g, '\n') === expected ? 'in-sync' : 'edited';
}

/** How far an edited file has moved from what its fields generate: lines only on disk, lines only in the generated text, the first line that differs. */
export interface PairedFileDrift {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** 1-based; undefined when the texts hold the same lines. */
  readonly firstLine: number | undefined;
}

/**
 * The drift of a paired file from its fields, for a person deciding whether to overwrite it (`stacki agents sync`
 * prints it before refusing). Lines are compared as multisets, so a moved line counts once each way; it is a
 * summary, not a diff. Line endings are ignored, as `pairedFileState` ignores them.
 */
export function pairedFileDrift(fields: AgentFields, provider: AgentId, onDisk: string): PairedFileDrift {
  assert(onDisk.length <= PROJECT_AGENT_LIMITS.fileBytesMax, 'pairedFileDrift: the file read is within the size bound');
  const expected = generateAgent(fields, provider).split('\n');
  const actual = onDisk.replace(/\r\n/g, '\n').split('\n');
  const remaining = new Map<string, number>();
  for (const line of expected) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let linesAdded = 0;
  for (const line of actual) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
    } else {
      linesAdded += 1;
    }
  }
  let linesRemoved = 0;
  for (const left of remaining.values()) {
    linesRemoved += left;
  }
  const shared = Math.min(expected.length, actual.length);
  let first: number | undefined;
  for (let index = 0; index < shared; index += 1) {
    if (expected[index] !== actual[index]) {
      first = index + 1;
      break;
    }
  }
  if (first === undefined && expected.length !== actual.length) {
    first = shared + 1;
  }
  assert(linesAdded <= actual.length, 'pairedFileDrift: no more lines added than the file holds');
  assert(linesRemoved <= expected.length, 'pairedFileDrift: no more lines removed than the fields generate');
  return { linesAdded, linesRemoved, firstLine: first };
}

/**
 * A field problem as one English sentence, for the command line and for logs; the panel words each code itself.
 * The bounds are named, so a script that hit one knows what to cut.
 */
export function agentFieldProblemText(problem: AgentFieldProblem): string {
  const limits: Readonly<Record<AgentFieldProblem['field'], string>> = {
    name: `${PROJECT_AGENT_LIMITS.nameCharsMax} characters`,
    description: `${PROJECT_AGENT_LIMITS.descriptionCharsMax} characters`,
    instructions: `${PROJECT_AGENT_LIMITS.instructionsCharsMax} characters`,
    tools: `${PROJECT_AGENT_LIMITS.toolsMax} tools of ${PROJECT_AGENT_LIMITS.toolCharsMax} characters each`,
    claudeModel: `${PROJECT_AGENT_LIMITS.modelCharsMax} characters`,
    codexModel: `${PROJECT_AGENT_LIMITS.modelCharsMax} characters`,
  };
  switch (problem.code) {
    case 'empty':
      return `The ${problem.field} field is empty.`;
    case 'format':
      return problem.field === 'name'
        ? 'The name field is not in the allowed format: lowercase letters, digits and single hyphens, such as code-reviewer.'
        : `The ${problem.field} field holds a character it may not.`;
    case 'too-long':
    case 'too-many':
      return `The ${problem.field} field is past its limit of ${limits[problem.field]}.`;
    case 'taken':
      return 'The name field is already used by another agent of either CLI (compared ignoring case).';
    default: {
      const exhaustive: never = problem.code;
      return exhaustive;
    }
  }
}

/** What a save writes: the tidied fields and each file's path and text, the source first and then each CLI's file. */
export interface AgentSaveDecision {
  readonly fields: AgentFields;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/**
 * The rules of a save, shared by Settings > Agents (`saveAgent` in electron/project/agentFiles.ts) and `stacki agents
 * create|sync`, so the panel and the command line refuse the same names and the same overwrites. `create` refuses a name
 * any agent of either CLI already uses; `update` needs the pair to exist, and refuses a generated file someone edited
 * unless its provider is in `overwrite`. Whether a file to create already exists on disk is the caller's to check.
 */
export function agentSaveDecision(
  listing: AgentListing,
  request: { readonly fields: AgentFields; readonly mode: 'create' | 'update'; readonly overwrite: readonly AgentId[] },
): Result<AgentSaveDecision, { readonly code: AgentWriteFailure; readonly message: string }> {
  const fields = normalizeAgentFields(request.fields);
  const ownSource = agentNameProblem(fields.name) === undefined ? agentSourcePath(fields.name) : undefined;
  const taken = [
    ...listing.agents.filter((agent) => agent.pairedSource !== ownSource || request.mode === 'create').map((agent) => agent.name),
    ...listing.paired
      .filter((pair) => pair.source !== ownSource || request.mode === 'create')
      .flatMap((pair) => (pair.fields.ok ? [pair.fields.value.name] : [])),
  ];
  const firstProblem = agentFieldProblems(fields, taken)[0];
  if (firstProblem !== undefined) {
    return err({ code: firstProblem.code === 'taken' ? 'exists' : 'invalid', message: agentFieldProblemText(firstProblem) });
  }
  assert(ownSource !== undefined, 'agentSaveDecision: fields without problems have a valid name');
  if (request.mode === 'update') {
    const pair = listing.paired.find((candidate) => candidate.source === ownSource);
    if (pair === undefined) {
      return err({ code: 'missing', message: `${ownSource} does not exist.` });
    }
    for (const provider of AGENT_IDS) {
      if (pair.files[provider] === 'edited' && !request.overwrite.includes(provider)) {
        return err({ code: 'exists', message: `${agentPath(provider, fields.name)} was edited since Stacki wrote it.` });
      }
    }
  }
  const files = [
    { path: ownSource, text: agentSourceText(fields) },
    ...AGENT_IDS.map((provider) => ({ path: agentPath(provider, fields.name), text: generateAgent(fields, provider) })),
  ];
  assert(files.length === AGENT_IDS.length + 1, 'agentSaveDecision: a pair is its source and one file per CLI');
  return ok({ fields, files });
}

// A TOML basic string: TOML allows no raw control character but tab, and DEL is a control character too.
function tomlString(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += tomlEscape(character, { multiline: false });
  }
  return `"${escaped}"`;
}

// The inside of a multi-line basic string: line breaks stay, every quote is escaped so `"""` never closes it early.
function tomlMultilineBody(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += tomlEscape(character, { multiline: true });
  }
  return escaped;
}

function tomlEscape(character: string, options: { readonly multiline: boolean }): string {
  if (character === '\\') {
    return '\\\\';
  }
  if (character === '"') {
    return '\\"';
  }
  if (character === '\n') {
    return options.multiline ? '\n' : '\\n';
  }
  if (character === '\t') {
    return '\t';
  }
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return character;
}

function detailOf(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return (message.split('\n')[0] ?? '').slice(0, PROJECT_AGENT_LIMITS.problemDetailCharsMax);
}

/** A parser's message as a problem detail: first line only, bounded. */
export function agentProblemDetail(failure: unknown): string {
  return detailOf(failure);
}

// ---------------------------------------------------------------------------
// The listing on the wire
// ---------------------------------------------------------------------------

/** A project-relative path the agents channels accept: bounded, `/`-separated, inside the project. */
export function parseAgentFilePath(input: unknown): string {
  const path = pathText(input);
  if (path.length === 0 || path.length > PROJECT_AGENT_LIMITS.pathCharsMax) {
    throw new Error('An agent path is between 1 and 512 characters.');
  }
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    throw new Error('An agent path is project-relative.');
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('An agent path stays inside the project.');
  }
  if (agentProviderOf(path) === undefined) {
    throw new Error('An agent path is a definition in .claude/agents or .codex/agents.');
  }
  return path;
}

/** A paired agent's name as a channel carries it. */
export function parseAgentName(input: unknown): string {
  const name = text(input);
  if (agentNameProblem(name) !== undefined) {
    throw new Error('An agent name is lowercase letters, digits and hyphens.');
  }
  return name;
}

function optionalBoundedText(input: unknown, charsMax: number): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = text(input);
  if (value.length > charsMax) {
    throw new Error('An agent field exceeds its limit');
  }
  return value;
}

/** The form's fields as a channel carries them; their content is checked again by `agentFieldProblems` in main. */
export function parseAgentFields(input: unknown): AgentFields {
  const fields = record(input);
  const tools = list(text)(fields['tools']);
  if (tools.length > PROJECT_AGENT_LIMITS.toolsMax) {
    throw new Error('An agent lists too many tools');
  }
  return {
    name: parseAgentName(fields['name']),
    description: optionalBoundedText(fields['description'], PROJECT_AGENT_LIMITS.descriptionCharsMax) ?? '',
    instructions: optionalBoundedText(fields['instructions'], PROJECT_AGENT_LIMITS.instructionsCharsMax) ?? '',
    tools,
    claudeModel: optionalBoundedText(fields['claudeModel'], PROJECT_AGENT_LIMITS.modelCharsMax),
    codexModel: optionalBoundedText(fields['codexModel'], PROJECT_AGENT_LIMITS.modelCharsMax),
  };
}

export function parseAgentProblem(input: unknown): AgentProblem {
  const fields = record(input);
  const kind = AGENT_PROBLEM_KINDS.find((each) => each === fields['kind']);
  switch (kind) {
    case 'too-large':
    case 'no-frontmatter':
    case 'unclosed-frontmatter':
    case 'not-a-map':
      return { kind };
    case 'syntax': {
      const line = fields['line'] === undefined ? undefined : count(fields['line']);
      const detail = text(fields['detail']);
      if (detail.length > PROJECT_AGENT_LIMITS.problemDetailCharsMax) {
        throw new Error('An agent problem detail exceeds its limit');
      }
      return { kind, line, detail };
    }
    case 'duplicate-key':
      return { kind, key: boundedField(fields['key']) };
    case 'missing-field':
    case 'wrong-type':
    case 'too-long':
      return { kind, field: boundedField(fields['field']) };
    case undefined:
      throw new Error('Unknown agent problem');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function boundedField(input: unknown): string {
  const value = text(input);
  if (value.length > PROJECT_AGENT_LIMITS.nameCharsMax * 4) {
    throw new Error('An agent problem names too long a field');
  }
  return value;
}

function parseProblems(input: unknown): readonly AgentProblem[] {
  const problems = list(parseAgentProblem)(input);
  if (problems.length > PROJECT_AGENT_LIMITS.problemsMax) {
    throw new Error('An agent reports too many problems');
  }
  return problems;
}

function parseProjectAgent(input: unknown): ProjectAgent {
  const fields = record(input);
  const path = parseAgentFilePath(fields['path']);
  const provider = parseAgentId(fields['provider']);
  if (agentProviderOf(path) !== provider) {
    throw new Error(`${path} is listed under the wrong provider`);
  }
  const name = text(fields['name']);
  if (name.length === 0 || name.length > PROJECT_AGENT_LIMITS.nameCharsMax) {
    throw new Error('An agent name exceeds its limit');
  }
  const tools = fields['tools'] === undefined ? undefined : list(text)(fields['tools']);
  if (tools !== undefined && tools.length > PROJECT_AGENT_LIMITS.toolsMax) {
    throw new Error('An agent lists too many tools');
  }
  const pairedSource = fields['pairedSource'] === undefined ? undefined : pathText(fields['pairedSource']);
  if (pairedSource !== undefined && !pairedSource.startsWith(`${AGENT_SOURCE_FOLDER}/`)) {
    throw new Error('A paired agent source lives in .stacki/agents');
  }
  return {
    provider,
    path,
    name,
    description: optionalBoundedText(fields['description'], PROJECT_AGENT_LIMITS.descriptionCharsMax),
    model: optionalBoundedText(fields['model'], PROJECT_AGENT_LIMITS.modelCharsMax),
    tools,
    problems: parseProblems(fields['problems']),
    pairedSource,
  };
}

const PAIRED_FILE_STATES = ['in-sync', 'edited', 'missing'] as const satisfies readonly PairedFileState[];

function parsePairedFileState(input: unknown): PairedFileState {
  const found = PAIRED_FILE_STATES.find((each) => each === input);
  if (found === undefined) {
    throw new Error('Unknown paired file state');
  }
  return found;
}

function parsePairedAgent(input: unknown): PairedAgent {
  const fields = record(input);
  const source = pathText(fields['source']);
  if (!source.startsWith(`${AGENT_SOURCE_FOLDER}/`) || !source.endsWith('.json') || source.length > PROJECT_AGENT_LIMITS.pathCharsMax) {
    throw new Error('A paired agent source is a JSON file in .stacki/agents');
  }
  const stored = record(fields['fields']);
  const parsedFields: Result<AgentFields, AgentProblem> =
    stored['ok'] === true ? ok(parseAgentFields(stored['value'])) : err(parseAgentProblem(record(stored)['error']));
  if (stored['ok'] !== true && stored['ok'] !== false) {
    throw new Error('PairedAgent.fields.ok: expected boolean');
  }
  const files = record(fields['files']);
  return { source, fields: parsedFields, files: { claude: parsePairedFileState(files['claude']), codex: parsePairedFileState(files['codex']) } };
}

/** The listing main sends, checked: bounded, and every definition under the provider its path decides. */
export function parseAgentListing(input: unknown): AgentListing {
  const fields = record(input);
  const agents = list(parseProjectAgent)(fields['agents']);
  const paired = list(parsePairedAgent)(fields['paired']);
  if (agents.length > PROJECT_AGENT_LIMITS.agentsMax * AGENT_IDS.length) {
    throw new Error('An agents listing exceeds its limit');
  }
  if (paired.length > PROJECT_AGENT_LIMITS.pairedMax) {
    throw new Error('An agents listing exceeds its paired limit');
  }
  return { agents, paired, truncated: boolean(fields['truncated']) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** What a create, re-sync or delete answers. */
export type AgentWriteResult = Result<{ readonly written: readonly string[] }, { readonly code: AgentWriteFailure; readonly message: string }>;
export const AGENT_WRITE_FAILURES = ['exists', 'invalid', 'missing', 'write-failed'] as const;
export type AgentWriteFailure = (typeof AGENT_WRITE_FAILURES)[number];

export function parseAgentWriteResult(input: unknown): AgentWriteResult {
  const fields = record(input);
  if (fields['ok'] === true) {
    const written = list(pathText)(record(fields['value'])['written']);
    assert(written.length <= AGENT_IDS.length + 1, 'parseAgentWriteResult: a write touches one pair and its source at most');
    return ok({ written });
  }
  if (fields['ok'] !== false) {
    throw new Error('AgentWriteResult.ok: expected boolean');
  }
  const failure = record(fields['error']);
  const code = AGENT_WRITE_FAILURES.find((each) => each === failure['code']);
  if (code === undefined) {
    throw new Error('Unknown agent write failure');
  }
  return err({ code, message: text(failure['message']) });
}

/** What a delete names: one definition written by hand, or a paired agent with both its files and its source. */
export type AgentDeleteTarget = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'paired'; readonly name: string };

export function parseAgentDeleteTarget(input: unknown): AgentDeleteTarget {
  const fields = record(input);
  if (fields['kind'] === 'file') {
    return { kind: 'file', path: parseAgentFilePath(fields['path']) };
  }
  if (fields['kind'] === 'paired') {
    return { kind: 'paired', name: parseAgentName(fields['name']) };
  }
  throw new Error('Unknown agent delete target');
}
