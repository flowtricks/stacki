// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `stacki agents list|show|create|sync|delete`: the paired agents of Settings > Agents from the command line.
//
// Why no rule lives here: a paired agent is one source (`.stacki/agents/<name>.json`) and two files generated from it
// (`.claude/agents/<name>.md`, `.codex/agents/<name>.toml`). The names a save refuses, the files it writes and when a
// generated file counts as someone's edit are `agentSaveDecision`, `generateAgent` and `pairedFileState`
// (shared/properties/projectAgents.ts), read from disk and written by electron/project/agentFiles.ts: the same functions
// the panel's IPC handlers call. So the panel and the CLI cannot write different bytes for the same source.
//
// A write is an effect (`agent-files`, cliEffects.ts): every file with the text it held and the text it will hold. The
// runner prints it as the plan, applies it only with --apply, and journals it, so `stacki undo <id>` puts the files back.
// The Trash is Electron's (`shell.trashItem`) and out of reach here, so a delete is kept in the undo journal instead, as
// `components delete` is.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import { err, ok, type Result } from '../../../shared/core/result';
import { AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { diffJson, type CliError, type CliErrorCode, type PlannedFile } from '../../../shared/properties/cli/stackiOutput';
import {
  AGENT_SOURCE_FOLDER,
  PROJECT_AGENT_LIMITS,
  agentFileStem,
  agentNameProblem,
  agentPath,
  agentProviderOf,
  agentSourcePath,
  pairedFileDrift,
  type AgentFields,
  type AgentListing,
  type AgentProblem,
  type AgentWriteFailure,
  type PairedAgent,
  type PairedFileDrift,
  type PairedFileState,
} from '../../../shared/properties/projectAgents';
import { agentDeleteFiles, applyAgentChanges, listAgents, planAgentSave, readAgentText, type AgentFileChange } from '../agentFiles';
import type { CommandContext, Handler, Outcome } from './cliCommands';
import { registerEffectKind, type EffectRecord } from './cliEffects';
import { digestOfText } from './cliFiles';

export const AGENT_CLI_LIMITS = {
  /** Files one agents effect changes: every paired agent's source and its two files (`agents sync --all`). */
  effectFilesMax: PROJECT_AGENT_LIMITS.pairedMax * (AGENT_IDS.length + 1),
  /** Characters of one file's text an effect journals: a generated file is at most twice the size bound of what it is made from. */
  effectTextCharsMax: PROJECT_AGENT_LIMITS.fileBytesMax * 2,
  /** Edited files a refusal names in its sentence; all of them are in `result.edited`. */
  driftLinesMax: 8,
} as const satisfies Record<string, number>;

const EFFECT_KIND = 'agent-files';

/** A paired agent's overall state: the worst of its files, or `unreadable` when its source cannot be read (nothing is generated from it). */
export type AgentDrift = PairedFileState | 'unreadable';

export const AGENT_HANDLERS: Readonly<Record<string, Handler>> = {
  'agents list': agentsList,
  'agents show': agentsShow,
  'agents create': agentsCreate,
  'agents sync': agentsSync,
  'agents delete': agentsDelete,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function agentsList(context: CommandContext): Result<Outcome, CliError> {
  const listing = listAgents(context.root);
  const paired = listing.paired.map((pair) => pairedSummary(pair));
  const unpaired = listing.agents
    .filter((agent) => agent.pairedSource === undefined)
    .map((agent) => ({
      name: agent.name,
      provider: agent.provider,
      path: agent.path,
      ...(agent.description === undefined ? {} : { description: agent.description }),
      problems: agent.problems.length,
    }));
  const drifted = paired.filter((entry) => entry.drift !== 'in-sync').length;
  assert(paired.length <= PROJECT_AGENT_LIMITS.pairedMax, 'agents list: the listing holds its bound');
  return ok({
    kind: 'read',
    summary: `${paired.length} paired agent${paired.length === 1 ? '' : 's'} (${drifted} not in sync), ${unpaired.length} written by hand.`,
    result: { paired, unpaired, truncated: listing.truncated },
    notes: listing.truncated ? ['A folder holds more agents than one listing carries; the rest are not shown.'] : [],
  });
}

function agentsShow(context: CommandContext): Result<Outcome, CliError> {
  const name = checkedName(context.args['name']);
  if (!name.ok) {
    return name;
  }
  const listing = listAgents(context.root);
  const pair = pairOf(listing, name.value);
  if (!pair.ok) {
    return pair;
  }
  const fields = pair.value.fields;
  const files = Object.fromEntries(
    AGENT_IDS.map((provider) => {
      const relative = agentPath(provider, name.value);
      const state = pair.value.files[provider];
      const drift = state === 'edited' && fields.ok ? driftOf(context.root, fields.value, provider) : undefined;
      return [provider, { path: relative, state, ...(drift === undefined ? {} : { drift }) }];
    }),
  );
  const summary = pairedSummary(pair.value);
  return ok({
    kind: 'read',
    summary: `${name.value}: ${summary.drift}.`,
    result: {
      name: name.value,
      source: pair.value.source,
      drift: summary.drift,
      ...(fields.ok ? { fields: fieldsOut(fields.value) } : { problem: fields.error }),
      files,
    },
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function agentsCreate(context: CommandContext): Result<Outcome, CliError> {
  const name = checkedName(context.args['name']);
  if (!name.ok) {
    return name;
  }
  const instructions = instructionsOf(context);
  if (!instructions.ok) {
    return instructions;
  }
  const tools = typeof context.args['tools'] === 'string' ? context.args['tools'].split(',') : [];
  if (tools.length > PROJECT_AGENT_LIMITS.toolsMax) {
    return err({ code: 'invalid-value', message: `--tools lists ${tools.length} tools; an agent lists at most ${PROJECT_AGENT_LIMITS.toolsMax}.` });
  }
  const fields: AgentFields = {
    name: name.value,
    description: stringArg(context, 'description'),
    instructions: instructions.value,
    tools,
    claudeModel: optionalStringArg(context, 'claudeModel'),
    codexModel: optionalStringArg(context, 'codexModel'),
  };
  const plan = planAgentSave(context.root, { fields, mode: 'create', overwrite: [] });
  if (!plan.ok) {
    return err(cliErrorOf(plan.error));
  }
  const written = plan.value.changes.map((change) => change.path);
  return ok({
    kind: 'write',
    edits: [],
    effects: [effectOf(plan.value.changes)],
    summary: `Create the paired agent ${name.value}: ${written.join(', ')}.`,
    result: { name: name.value, files: written },
  });
}

function agentsSync(context: CommandContext): Result<Outcome, CliError> {
  const all = context.args['all'] === true;
  const named = context.args['name'];
  if (all === (named !== undefined)) {
    return err({ code: 'usage', message: 'agents sync: name one agent, or pass --all (not both).' });
  }
  const listing = listAgents(context.root);
  const targets: PairedAgent[] = [];
  if (all) {
    targets.push(...listing.paired);
  } else {
    const name = checkedName(named);
    if (!name.ok) {
      return name;
    }
    const pair = pairOf(listing, name.value);
    if (!pair.ok) {
      return pair;
    }
    targets.push(pair.value);
  }
  const force = context.args['force'] === true;
  const notes: string[] = [];
  const edited: { readonly name: string; readonly file: string; readonly provider: AgentId; readonly drift: PairedFileDrift }[] = [];
  const readable: { readonly pair: PairedAgent; readonly fields: AgentFields }[] = [];
  for (const pair of targets) {
    if (pair.fields.ok) {
      readable.push({ pair, fields: pair.fields.value });
      for (const provider of AGENT_IDS) {
        const drift = pair.files[provider] === 'edited' ? driftOf(context.root, pair.fields.value, provider) : undefined;
        if (drift !== undefined) {
          edited.push({ name: pair.fields.value.name, file: agentPath(provider, pair.fields.value.name), provider, drift });
        }
      }
    } else if (all) {
      notes.push(`${pair.source} is skipped: ${problemText(pair.fields.error)}. Nothing is generated from a source that does not read.`);
    } else {
      return err({ code: 'invalid-file', message: `${pair.source} cannot be read: ${problemText(pair.fields.error)}. Fix it before syncing.` });
    }
  }
  if (edited.length > 0 && !force) {
    return ok({
      kind: 'read',
      summary: `${edited.length} generated file${edited.length === 1 ? ' was' : 's were'} edited since Stacki wrote ${edited.length === 1 ? 'it' : 'them'}.`,
      result: { edited },
      notes,
      verdict: {
        code: 'refused',
        message: `${driftSentence(edited)} Nothing was written. Pass --force to overwrite ${edited.length === 1 ? 'it' : 'them'} with what the source generates, or move the edit into ${AGENT_SOURCE_FOLDER}/<name>.json first.`,
      },
    });
  }
  const changes: AgentFileChange[] = [];
  for (const target of readable) {
    const plan = planAgentSave(context.root, { fields: target.fields, mode: 'update', overwrite: force ? AGENT_IDS : [] });
    if (!plan.ok) {
      return err(cliErrorOf(plan.error));
    }
    changes.push(...plan.value.changes);
  }
  if (edited.length > 0) {
    notes.push(`--force overwrites edits: ${driftSentence(edited)}`);
  }
  assert(changes.length <= AGENT_CLI_LIMITS.effectFilesMax, 'agents sync: bounded by the paired agents a project keeps');
  return ok({
    kind: 'write',
    edits: [],
    effects: changes.length === 0 ? [] : [effectOf(changes)],
    summary: `Sync ${readable.length} paired agent${readable.length === 1 ? '' : 's'} with ${readable.length === 1 ? 'its source' : 'their sources'}.`,
    result: { synced: readable.map((target) => target.fields.name), files: changes.map((change) => change.path), overwritten: edited },
    notes,
  });
}

function agentsDelete(context: CommandContext): Result<Outcome, CliError> {
  const name = checkedName(context.args['name']);
  if (!name.ok) {
    return name;
  }
  // Only a pair is deleted here: a definition written by hand shares the file name of no source, and is the person's.
  const pair = pairOf(listAgents(context.root), name.value);
  if (!pair.ok) {
    return pair;
  }
  const files = agentDeleteFiles(context.root, { kind: 'paired', name: name.value });
  if (!files.ok) {
    return err(cliErrorOf(files.error));
  }
  const changes: AgentFileChange[] = [];
  for (const file of files.value) {
    const text = readAgentText(context.root, file.relative);
    if (text === undefined) {
      return err({
        code: 'refused',
        message: `${file.relative} cannot be read back (a link, or past ${PROJECT_AGENT_LIMITS.fileBytesMax} bytes), so it is not deleted.`,
      });
    }
    changes.push({ path: file.relative, before: text, after: undefined });
  }
  return ok({
    kind: 'write',
    edits: [],
    effects: [effectOf(changes)],
    summary: `Delete the paired agent ${name.value}: ${changes.map((change) => change.path).join(', ')}.`,
    notes: [
      'Deleted files are kept in the CLI undo journal, not the operating system Trash (which only the app can reach): "stacki undo <id>" writes them back.',
    ],
  });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function checkedName(input: unknown): Result<string, CliError> {
  if (typeof input !== 'string' || input === '') {
    return err({ code: 'usage', message: 'agents: <name> is required.' });
  }
  const problem = agentNameProblem(input);
  if (problem === undefined) {
    return ok(input);
  }
  const shown = input.length > PROJECT_AGENT_LIMITS.nameCharsMax ? `${input.slice(0, PROJECT_AGENT_LIMITS.nameCharsMax)}…` : input;
  return err({
    code: 'invalid-value',
    message:
      problem === 'too-long'
        ? `"${shown}" is longer than ${PROJECT_AGENT_LIMITS.nameCharsMax} characters.`
        : `"${shown}" is not an agent name: lowercase letters, digits and single hyphens, such as code-reviewer.`,
  });
}

function stringArg(context: CommandContext, name: string): string {
  const value = context.args[name];
  return typeof value === 'string' ? value : '';
}

function optionalStringArg(context: CommandContext, name: string): string | undefined {
  const value = context.args[name];
  return typeof value === 'string' ? value : undefined;
}

// The instructions as typed, or read from a project file. A file outside the project is refused: an MCP client could
// otherwise copy any file the CLI can read into a tracked agent file.
function instructionsOf(context: CommandContext): Result<string, CliError> {
  const typed = optionalStringArg(context, 'instructions');
  const file = optionalStringArg(context, 'instructionsFile');
  if (file === undefined) {
    return ok(typed ?? '');
  }
  if (typed !== undefined) {
    return err({ code: 'usage', message: 'agents create: pass --instructions or --instructions-file, not both.' });
  }
  const absolute = path.resolve(context.root, file);
  const inside = path.relative(context.root, absolute);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    return err({ code: 'bad-path', message: `--instructions-file ${file} is not a file inside the project.` });
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) {
      return err({ code: 'bad-path', message: `--instructions-file ${file} is not a plain file (links are not followed).` });
    }
    // Four bytes is the most one character takes in UTF-8, so a file past this bound cannot fit the character limit.
    if (stat.size > PROJECT_AGENT_LIMITS.instructionsCharsMax * 4) {
      return err({
        code: 'invalid-value',
        message: `--instructions-file ${file} is past the instructions limit of ${PROJECT_AGENT_LIMITS.instructionsCharsMax} characters.`,
      });
    }
    const real = path.relative(fs.realpathSync(context.root), fs.realpathSync(absolute));
    if (real.startsWith('..') || path.isAbsolute(real)) {
      return err({ code: 'bad-path', message: `--instructions-file ${file} leads outside the project.` });
    }
    return ok(fs.readFileSync(absolute, 'utf8'));
  } catch (error: unknown) {
    return err({ code: 'missing', message: `--instructions-file ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}` });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pairOf(listing: AgentListing, name: string): Result<PairedAgent, CliError> {
  const source = agentSourcePath(name);
  const pair = listing.paired.find((candidate) => candidate.source === source);
  if (pair !== undefined) {
    return ok(pair);
  }
  const byHand = listing.agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
  return err({
    code: 'missing',
    message:
      byHand === undefined
        ? `No paired agent named ${name} (${source} does not exist). Run "stacki agents list".`
        : `${byHand.path} is written by hand, not a paired agent: there is no ${source}. Edit it directly; the agents commands change paired agents only.`,
  });
}

function pairedSummary(pair: PairedAgent): {
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  readonly providers: readonly AgentId[];
  readonly files: Readonly<Record<AgentId, PairedFileState>>;
  readonly drift: AgentDrift;
} {
  const states = AGENT_IDS.map((provider) => pair.files[provider]);
  const drift: AgentDrift = !pair.fields.ok ? 'unreadable' : states.includes('edited') ? 'edited' : states.includes('missing') ? 'missing' : 'in-sync';
  return {
    name: pair.fields.ok ? pair.fields.value.name : agentFileStem(pair.source),
    ...(pair.fields.ok ? { description: pair.fields.value.description } : {}),
    source: pair.source,
    providers: AGENT_IDS.filter((provider) => pair.files[provider] !== 'missing'),
    files: pair.files,
    drift,
  };
}

// JSON has no undefined: an absent model is left out, as the source file leaves it out.
function fieldsOut(fields: AgentFields): Readonly<Record<string, unknown>> {
  return {
    name: fields.name,
    description: fields.description,
    instructions: fields.instructions,
    tools: fields.tools,
    ...(fields.claudeModel === undefined ? {} : { claudeModel: fields.claudeModel }),
    ...(fields.codexModel === undefined ? {} : { codexModel: fields.codexModel }),
  };
}

function driftOf(root: string, fields: AgentFields, provider: AgentId): PairedFileDrift | undefined {
  const onDisk = readAgentText(root, agentPath(provider, fields.name));
  return onDisk === undefined ? undefined : pairedFileDrift(fields, provider, onDisk);
}

function driftSentence(edited: readonly { readonly file: string; readonly drift: PairedFileDrift }[]): string {
  const shown = edited
    .slice(0, AGENT_CLI_LIMITS.driftLinesMax)
    .map(
      (entry) =>
        `${entry.file} (+${entry.drift.linesAdded} -${entry.drift.linesRemoved} lines${entry.drift.firstLine === undefined ? '' : `, from line ${entry.drift.firstLine}`})`,
    );
  const rest = edited.length - shown.length;
  return `Edited since Stacki wrote ${edited.length === 1 ? 'it' : 'them'}: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`;
}

function problemText(problem: AgentProblem): string {
  switch (problem.kind) {
    case 'too-large':
      return `it is past ${PROJECT_AGENT_LIMITS.fileBytesMax} bytes`;
    case 'no-frontmatter':
    case 'unclosed-frontmatter':
    case 'not-a-map':
      return `it is not a JSON object (${problem.kind})`;
    case 'syntax':
      return `it is not valid JSON (${problem.detail})`;
    case 'duplicate-key':
      return `the key ${problem.key} is written twice`;
    case 'missing-field':
      return `the ${problem.field} field is missing`;
    case 'wrong-type':
      return `the ${problem.field} field has the wrong type or format`;
    case 'too-long':
      return `the ${problem.field} field is past its limit`;
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

const FAILURE_CODES: Readonly<Record<AgentWriteFailure | 'conflict', CliErrorCode>> = {
  exists: 'exists',
  invalid: 'invalid-value',
  missing: 'missing',
  'write-failed': 'write-failed',
  conflict: 'conflict',
};

function cliErrorOf(failure: { readonly code: AgentWriteFailure | 'conflict'; readonly message: string }): CliError {
  assert(failure.message.length > 0, 'An agents failure says why');
  return { code: FAILURE_CODES[failure.code], message: failure.message };
}

// ---------------------------------------------------------------------------
// The effect: agent files as data, so a plan prints them and the journal can undo them
// ---------------------------------------------------------------------------

function effectOf(changes: readonly AgentFileChange[]): EffectRecord {
  assert(changes.length > 0, 'An agents effect changes a file');
  assert(changes.length <= AGENT_CLI_LIMITS.effectFilesMax, 'An agents effect holds its bound');
  return {
    kind: EFFECT_KIND,
    data: {
      files: changes.map((change) => ({
        file: change.path,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      })),
    },
  };
}

/** A path an agents effect may touch: a paired agent's source, or a definition directly in a CLI's agents folder. */
export function isAgentEffectPath(file: string): boolean {
  if (agentProviderOf(file) !== undefined) {
    return true;
  }
  const prefix = `${AGENT_SOURCE_FOLDER}/`;
  if (!file.startsWith(prefix) || !file.endsWith('.json')) {
    return false;
  }
  return agentNameProblem(file.slice(prefix.length, -'.json'.length)) === undefined;
}

/** A journalled agents effect read back: every file a path the effect may touch, every text bounded, each one a change. */
export function readAgentEffect(data: unknown): Result<readonly AgentFileChange[], CliError> {
  const list = toArray(toRecord(data)?.['files']);
  if (list === undefined || list.length === 0 || list.length > AGENT_CLI_LIMITS.effectFilesMax) {
    return err({ code: 'refused', message: 'An agents record lists between one and the bounded number of files.' });
  }
  const changes: AgentFileChange[] = [];
  for (const item of list) {
    const entry = toRecord(item);
    const file = entry?.['file'];
    const before = entry?.['before'];
    const after = entry?.['after'];
    if (typeof file !== 'string' || !isAgentEffectPath(file)) {
      return err({ code: 'refused', message: 'An agents record names a file outside the agents folders.' });
    }
    const texts = [before, after].filter((text) => text !== undefined);
    if (!texts.every((text) => typeof text === 'string' && text.length <= AGENT_CLI_LIMITS.effectTextCharsMax)) {
      return err({ code: 'refused', message: `An agents record holds a text for ${file} that is not bounded text.` });
    }
    const beforeText = typeof before === 'string' ? before : undefined;
    const afterText = typeof after === 'string' ? after : undefined;
    if (beforeText === afterText) {
      return err({ code: 'refused', message: `An agents record holds no change for ${file}.` });
    }
    changes.push({ path: file, before: beforeText, after: afterText });
  }
  assert(changes.length === list.length, 'readAgentEffect: every entry was read');
  return ok(changes);
}

function describeAgentFiles(changes: readonly AgentFileChange[]): readonly PlannedFile[] {
  return changes.map((change) => {
    const beforeDigest = digestOfText(change.before);
    const afterDigest = digestOfText(change.after);
    const isSource = change.path.startsWith(`${AGENT_SOURCE_FOLDER}/`);
    return {
      file: change.path,
      action: change.after === undefined ? 'delete' : change.before === undefined ? 'create' : 'modify',
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(afterDigest === undefined ? {} : { afterDigest }),
      changes: isSource ? diffJson(jsonOrEmpty(change.before), jsonOrEmpty(change.after)).changes : [],
    } satisfies PlannedFile;
  });
}

function jsonOrEmpty(text: string | undefined): unknown {
  if (text === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return {};
  }
}

// `read` answers the record itself once it checks, not the parsed changes: the other three receive what `read` answered and
// read it again, so the journalled shape is the only shape they ever see.
registerEffectKind(EFFECT_KIND, {
  read: (data) => {
    const changes = readAgentEffect(data);
    return changes.ok ? ok(data) : changes;
  },
  apply: (root, data) => {
    const changes = readAgentEffect(data);
    if (!changes.ok) {
      return changes;
    }
    const applied = applyAgentChanges(root, changes.value);
    return applied.ok ? ok(undefined) : err(cliErrorOf(applied.error));
  },
  reverse: (data) => {
    const changes = readAgentEffect(data);
    assert(changes.ok, 'An agents effect is reversed only after it was read');
    return effectOf([...changes.value].reverse().map((change) => ({ path: change.path, before: change.after, after: change.before })));
  },
  describe: (data) => {
    const changes = readAgentEffect(data);
    return changes.ok ? describeAgentFiles(changes.value) : [];
  },
});
