// Goal: `stacki agents list|show|create|sync|delete` changes the paired agents of Settings > Agents with the panel's own rules
// and generator: the same names refused, the same bytes written, an edited generated file never overwritten without --force,
// and every write a dry run until --apply, journalled so `stacki undo` puts it back.
// Method: generated temporary projects only (never a real one). The command line is driven through `main()` exactly as a shell
// passes it, and its JSON envelope is read back by the boundary parsers below (unknown in, checked shape out), so a change to
// the output shape fails here. Negative space first (missing and bad names, huge instructions, unknown flags, a file outside
// the project), then create, list, show, drift and --force, delete and undo, roles, and last the byte-for-byte comparison of
// the CLI's files with those `saveAgent` (the function the panel's IPC handler calls) writes for the same fields.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { saveAgent } from '#dist/electron/project/agentFiles.js';
import { main } from '#dist/electron/project/cli/cliMain.js';
import { parseLine } from '#dist/shared/properties/cli/stackiArgs.js';
import { dig } from '../../../helpers/cliJson.ts';
import { makeProject, readText, removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

const FILES = ['.stacki/agents/code-reviewer.json', '.claude/agents/code-reviewer.md', '.codex/agents/code-reviewer.toml'] as const;
const CREATE = ['agents', 'create', 'code-reviewer', '--description', 'Reviews changes.', '--instructions', 'Read the diff and report bugs.'] as const;
const STATES = ['in-sync', 'edited', 'missing'] as const;
const DRIFTS = ['in-sync', 'edited', 'missing', 'unreadable'] as const;

interface Ran {
  readonly code: number;
  readonly envelope: Envelope;
}

interface Envelope {
  readonly ok: boolean;
  readonly mode: string | undefined;
  readonly errorCode: string | undefined;
  readonly message: string;
  readonly files: readonly { readonly file: string; readonly action: string }[];
  readonly result: unknown;
  readonly undoId: string | undefined;
}

interface PairedRow {
  readonly name: string;
  readonly source: string;
  readonly providers: readonly string[];
  readonly files: { readonly claude: string; readonly codex: string };
  readonly drift: string;
}

async function run(cwd: string, argv: readonly string[]): Promise<Ran> {
  let output = '';
  const code = await main([...argv, '--json'], cwd, (text) => {
    output += text;
  });
  return { code, envelope: parseEnvelope(JSON.parse(output)) };
}

// ----- Boundary parsers for the JSON the CLI prints: unknown in, checked values out. -----

function text(value: unknown, what: string): string {
  assert.equal(typeof value, 'string', `${what} is text`);
  return String(value);
}

function list(value: unknown, what: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${what} is a list`);
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, what: string): T {
  const found = values.find((candidate) => candidate === value);
  assert.ok(found !== undefined, `${what} is one of ${values.join(', ')}`);
  return found;
}

function parseEnvelope(input: unknown): Envelope {
  assert.equal(dig(input, 'schemaVersion'), 1, 'the envelope has schema version 1');
  const ok = dig(input, 'ok');
  assert.equal(typeof ok, 'boolean', 'ok is a boolean');
  const undoId = dig(input, 'undoId');
  return {
    ok: ok === true,
    mode: ok === true ? oneOf(['plan', 'apply', 'read'], dig(input, 'mode'), 'mode') : undefined,
    errorCode: ok === true ? undefined : text(dig(input, 'error', 'code'), 'error.code'),
    message: ok === true ? text(dig(input, 'summary'), 'summary') : text(dig(input, 'error', 'message'), 'error.message'),
    files:
      ok === true
        ? list(dig(input, 'files'), 'files').map((file) => ({
            file: text(dig(file, 'file'), 'file'),
            action: oneOf(['create', 'modify', 'delete', 'move'], dig(file, 'action'), 'action'),
          }))
        : [],
    result: dig(input, 'result'),
    undoId: undoId === undefined ? undefined : text(undoId, 'undoId'),
  };
}

function parsePairedRow(input: unknown): PairedRow {
  return {
    name: text(dig(input, 'name'), 'name'),
    source: text(dig(input, 'source'), 'source'),
    providers: list(dig(input, 'providers'), 'providers').map((provider) => oneOf(['claude', 'codex'], provider, 'provider')),
    files: { claude: oneOf(STATES, dig(input, 'files', 'claude'), 'files.claude'), codex: oneOf(STATES, dig(input, 'files', 'codex'), 'files.codex') },
    drift: oneOf(DRIFTS, dig(input, 'drift'), 'drift'),
  };
}

function parseListResult(input: unknown): { readonly paired: readonly PairedRow[]; readonly unpaired: readonly string[]; readonly truncated: boolean } {
  const truncated = dig(input, 'truncated');
  assert.equal(typeof truncated, 'boolean', 'truncated is a boolean');
  return {
    paired: list(dig(input, 'paired'), 'paired').map(parsePairedRow),
    unpaired: list(dig(input, 'unpaired'), 'unpaired').map((row) => text(dig(row, 'path'), 'unpaired path')),
    truncated: truncated === true,
  };
}

function snapshotOf(root: string): ReadonlyMap<string, string | undefined> {
  return new Map(FILES.map((file) => [file, readText(root, file)]));
}

// ----- Negative space -----

test('the line reader refuses a missing name, an unknown flag and a value past the argument bound, with usage (exit 2)', async () => {
  for (const line of [
    ['agents', 'create', '--description', 'x'],
    ['agents', 'show'],
    ['agents', 'delete'],
    ['agents', 'create', 'a', '--description', 'x', '--bogus', 'y'],
    ['agents', 'sync', 'a', '--forse'],
    ['agents', 'list', 'extra'],
    ['agents'],
  ]) {
    const parsed = parseLine(line);
    assert.ok(!parsed.ok, line.join(' '));
    assert.equal(parsed.ok ? '' : parsed.error.code, 'usage', line.join(' '));
  }
  const root = makeProject();
  const huge = await run(root, ['agents', 'create', 'a', '--description', 'x', '--instructions', 'y'.repeat(300_000)]);
  assert.equal(huge.code, 2, 'a value past the CLI argument bound is a usage error');
  const sync = await run(root, ['agents', 'sync']);
  assert.equal(sync.envelope.errorCode, 'usage', 'sync names one agent or --all');
  const both = await run(root, ['agents', 'sync', 'a', '--all']);
  assert.equal(both.envelope.errorCode, 'usage', 'sync does not take a name and --all');
});

test('a bad name, empty or huge fields and a file outside the project are refused, and nothing is written', async () => {
  const root = makeProject({ 'notes.md': 'From a file.\n' });
  const cases: ReadonlyArray<{ readonly argv: readonly string[]; readonly code: string }> = [
    { argv: ['agents', 'create', 'Code_Reviewer', '--description', 'x', '--instructions', 'y'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'double--hyphen', '--description', 'x', '--instructions', 'y'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a'.repeat(65), '--description', 'x', '--instructions', 'y'], code: 'invalid-value' },
    { argv: ['agents', 'show', '../etc'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a', '--description', '   ', '--instructions', 'y'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a', '--description', 'x'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a', '--description', 'x', '--instructions', 'y'.repeat(100_001)], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a', '--description', 'x', '--instructions', 'y', '--claude-model', 'bad model'], code: 'invalid-value' },
    { argv: ['agents', 'create', 'a', '--description', 'x', '--instructions', 'y', '--instructions-file', 'notes.md'], code: 'usage' },
    { argv: ['agents', 'create', 'a', '--description', 'x', '--instructions-file', '../outside.md'], code: 'bad-path' },
    { argv: ['agents', 'create', 'a', '--description', 'x', '--instructions-file', 'missing.md'], code: 'missing' },
  ];
  for (const each of cases) {
    const ran = await run(root, [...each.argv, '--apply']);
    assert.equal(ran.envelope.errorCode, each.code, `${each.argv.slice(0, 4).join(' ')}: ${ran.envelope.message}`);
    assert.equal(ran.code, each.code === 'usage' || each.code === 'bad-path' ? 2 : 1);
  }
  const long = await run(root, ['agents', 'create', 'a', '--description', 'x', '--instructions', 'y'.repeat(100_001)]);
  assert.match(long.envelope.message, /100000 characters/, 'the refusal names the bound');
  assert.equal(fs.existsSync(path.join(root, '.stacki/agents')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  const fromFile = await run(root, ['agents', 'create', 'a', '--description', 'x', '--instructions-file', 'notes.md', '--apply']);
  assert.ok(fromFile.envelope.ok, fromFile.envelope.message);
  assert.match(readText(root, '.claude/agents/a.md') ?? '', /From a file\./);
});

// ----- Create, list, show -----

test('create is a dry run until --apply, writes the source and both files, and refuses a name any agent uses', async () => {
  const root = makeProject({ '.codex/agents/taken.toml': 'name = "taken"\ndescription = "x"\ndeveloper_instructions = "y"\n' });
  const plan = await run(root, CREATE);
  assert.equal(plan.code, 0);
  assert.equal(plan.envelope.mode, 'plan');
  assert.deepEqual(
    plan.envelope.files.map((file) => [file.file, file.action]),
    FILES.map((file) => [file, 'create']),
  );
  assert.deepEqual([...snapshotOf(root).values()], [undefined, undefined, undefined], 'a plan writes nothing');
  const applied = await run(root, [...CREATE, '--apply']);
  assert.equal(applied.envelope.mode, 'apply');
  assert.ok(FILES.every((file) => readText(root, file) !== undefined));
  const again = await run(root, [...CREATE, '--apply']);
  assert.equal(again.envelope.errorCode, 'exists');
  assert.equal(again.code, 1);
  const taken = await run(root, ['agents', 'create', 'TAKEN', '--description', 'x', '--instructions', 'y', '--apply']);
  assert.equal(taken.envelope.errorCode, 'invalid-value', 'an uppercase name is not a name');
  const collision = await run(root, ['agents', 'create', 'taken', '--description', 'x', '--instructions', 'y', '--apply']);
  assert.equal(collision.envelope.errorCode, 'exists', 'a hand-written Codex agent holds the name');
  assert.equal(readText(root, '.claude/agents/taken.md'), undefined);
});

test('list and show report each pair, its providers and its drift in a stable JSON shape', async () => {
  const root = makeProject({ '.claude/agents/solo.md': '---\nname: solo\ndescription: By hand.\n---\nHello.\n' });
  assert.ok((await run(root, [...CREATE, '--tools', 'Read, Grep', '--claude-model', 'sonnet', '--apply'])).envelope.ok);
  const listed = await run(root, ['agents', 'list']);
  assert.equal(listed.envelope.mode, 'read');
  const result = parseListResult(listed.envelope.result);
  assert.deepEqual(result, {
    paired: [
      {
        name: 'code-reviewer',
        source: '.stacki/agents/code-reviewer.json',
        providers: ['claude', 'codex'],
        files: { claude: 'in-sync', codex: 'in-sync' },
        drift: 'in-sync',
      },
    ],
    unpaired: ['.claude/agents/solo.md'],
    truncated: false,
  });
  const shown = await run(root, ['agents', 'show', 'code-reviewer']);
  assert.deepEqual(dig(shown.envelope.result, 'fields'), {
    name: 'code-reviewer',
    description: 'Reviews changes.',
    instructions: 'Read the diff and report bugs.\n',
    tools: ['Read', 'Grep'],
    claudeModel: 'sonnet',
  });
  assert.equal(dig(shown.envelope.result, 'files', 'codex', 'path'), '.codex/agents/code-reviewer.toml');
  const byHand = await run(root, ['agents', 'show', 'solo']);
  assert.equal(byHand.envelope.errorCode, 'missing');
  assert.match(byHand.envelope.message, /written by hand/);
});

// ----- Drift, sync and --force -----

test('sync refuses an edited file with its drift, overwrites it only with --force, and undo puts the edit back', async () => {
  const root = makeProject();
  assert.ok((await run(root, [...CREATE, '--apply'])).envelope.ok);
  const codexFile = path.join(root, '.codex/agents/code-reviewer.toml');
  fs.appendFileSync(codexFile, 'model_reasoning_effort = "high"\n');
  const edited = readText(root, '.codex/agents/code-reviewer.toml');
  assert.equal(parseListResult((await run(root, ['agents', 'list'])).envelope.result).paired[0]?.drift, 'edited');
  const refused = await run(root, ['agents', 'sync', 'code-reviewer', '--apply']);
  assert.equal(refused.code, 1);
  assert.equal(refused.envelope.errorCode, 'refused');
  assert.match(refused.envelope.message, /\.codex\/agents\/code-reviewer\.toml \(\+1 -0 lines, from line \d+\)/);
  assert.match(refused.envelope.message, /--force/);
  assert.deepEqual(dig(list(dig(refused.envelope.result, 'edited'), 'edited')[0], 'drift'), { linesAdded: 1, linesRemoved: 0, firstLine: 7 });
  assert.equal(readText(root, '.codex/agents/code-reviewer.toml'), edited, 'a refusal writes nothing');
  const forced = await run(root, ['agents', 'sync', 'code-reviewer', '--force', '--apply']);
  assert.ok(forced.envelope.ok, forced.envelope.message);
  assert.deepEqual(
    forced.envelope.files.map((file) => [file.file, file.action]),
    [['.codex/agents/code-reviewer.toml', 'modify']],
  );
  assert.equal(parseListResult((await run(root, ['agents', 'list'])).envelope.result).paired[0]?.drift, 'in-sync');
  assert.ok(forced.envelope.undoId !== undefined);
  assert.ok((await run(root, ['undo', forced.envelope.undoId, '--apply'])).envelope.ok);
  assert.equal(readText(root, '.codex/agents/code-reviewer.toml'), edited, 'undo writes the edit back');
});

test('sync --all regenerates a missing file and changes nothing when every pair is in sync', async () => {
  const root = makeProject();
  assert.ok((await run(root, [...CREATE, '--apply'])).envelope.ok);
  const generated = readText(root, '.claude/agents/code-reviewer.md');
  fs.rmSync(path.join(root, '.claude/agents/code-reviewer.md'));
  const synced = await run(root, ['agents', 'sync', '--all', '--apply']);
  assert.ok(synced.envelope.ok, synced.envelope.message);
  assert.equal(readText(root, '.claude/agents/code-reviewer.md'), generated);
  const again = await run(root, ['agents', 'sync', '--all', '--apply']);
  assert.ok(again.envelope.ok);
  assert.equal(again.envelope.files.length, 0);
  assert.match(again.envelope.message, /No change/);
});

// ----- Delete and roles -----

test('delete needs --apply --yes, removes the pair and its source, and undo writes all three back', async () => {
  const root = makeProject();
  assert.ok((await run(root, [...CREATE, '--apply'])).envelope.ok);
  const before = snapshotOf(root);
  const unconfirmed = await run(root, ['agents', 'delete', 'code-reviewer', '--apply']);
  assert.equal(unconfirmed.envelope.errorCode, 'confirmation-required');
  assert.deepEqual(snapshotOf(root), before);
  const deleted = await run(root, ['agents', 'delete', 'code-reviewer', '--apply', '--yes']);
  assert.ok(deleted.envelope.ok, deleted.envelope.message);
  assert.deepEqual(
    deleted.envelope.files.map((file) => file.action),
    ['delete', 'delete', 'delete'],
  );
  assert.deepEqual([...snapshotOf(root).values()], [undefined, undefined, undefined]);
  assert.ok(deleted.envelope.undoId !== undefined);
  assert.ok((await run(root, ['undo', deleted.envelope.undoId, '--apply'])).envelope.ok);
  assert.deepEqual(snapshotOf(root), before, 'undo restores every file byte for byte');
});

test('a role needs cli:config and the access the panel asks (instructions:edit, which needs panel:instructions) to write agents; any role may read them', async () => {
  const roles = `${JSON.stringify({
    version: 1,
    defaultRole: 'viewer',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'configurer', name: 'Configurer', members: ['cc'], access: ['cli:read', 'cli:config'] },
      { id: 'writer', name: 'Writer', members: ['ww'], access: ['cli:read', 'cli:config', 'panel:instructions', 'instructions:edit'] },
      { id: 'viewer', name: 'Viewer', members: [], access: ['cli:read'] },
    ],
  })}\n`;
  const root = makeProject({ '.stacki/roles.json': roles });
  assert.equal((await run(root, [...CREATE, '--as-role', 'viewer'])).envelope.errorCode, 'role-denied');
  assert.equal((await run(root, [...CREATE, '--as-role', 'configurer'])).envelope.errorCode, 'role-denied');
  assert.ok((await run(root, [...CREATE, '--as-role', 'writer', '--apply'])).envelope.ok);
  assert.ok((await run(root, ['agents', 'list', '--as-role', 'viewer'])).envelope.ok);
});

test('config cannot write the agents folder: it names the agents commands instead', async () => {
  const root = makeProject();
  const ran = await run(root, ['config', 'set', '.stacki/agents/code-reviewer.json', 'name', 'x']);
  assert.equal(ran.envelope.errorCode, 'unsupported-file');
  assert.match(ran.envelope.message, /stacki agents create/);
});

// ----- One generator -----

test('the CLI and the panel write byte-identical files for the same source', async () => {
  const fields = {
    name: 'code-reviewer',
    description: 'Reviews changes: "carefully".',
    instructions: 'Read the diff.\r\nReport bugs with """quotes""" and a tab\there.',
    tools: ['Read', 'Bash(git status:*)'],
    claudeModel: 'sonnet',
    codexModel: 'gpt-5-codex',
  };
  const panel = makeProject({ 'package.json': '{}' });
  const cli = makeProject({ 'package.json': '{}' });
  assert.ok(saveAgent(panel, { fields, mode: 'create', overwrite: [] }).ok);
  const ran = await run(cli, [
    'agents',
    'create',
    fields.name,
    '--description',
    fields.description,
    '--instructions',
    fields.instructions,
    '--tools',
    fields.tools.join(','),
    '--claude-model',
    fields.claudeModel,
    '--codex-model',
    fields.codexModel,
    '--apply',
  ]);
  assert.ok(ran.envelope.ok, ran.envelope.message);
  for (const file of FILES) {
    const expected = readText(panel, file);
    assert.ok(expected !== undefined, `the panel wrote ${file}`);
    assert.equal(readText(cli, file), expected, `${file} is byte-identical`);
  }
});
