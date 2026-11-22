// Goal: the main process lists every agent definition each CLI reads from a project (Claude's Markdown in
// .claude/agents, Codex's TOML in .codex/agents) with its problems shown, not hidden: YAML that does not
// parse, a repeated key, a missing field, a BOM and CRLF that still read. It creates a paired agent as one
// source and two generated files, refuses a name collision with any agent of either CLI, sees a hand edit
// of either generated file as `edited`, refuses to overwrite it unless asked, re-syncs when asked, and
// moves files to the Trash (a fake one here) rather than deleting them.
// Method: temporary projects on disk and the real module the IPC handlers delegate to
// (electron/project/agentFiles.ts); every write goes through the document actors as in the app.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deleteAgent, listAgents, readClaudeAgentMeta, saveAgent } from '#dist/electron/project/agentFiles.js';
import { concerns } from '#dist/electron/project/instructionsWatcher.js';

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agents-')));
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const FIELDS = {
  name: 'code-reviewer',
  description: 'Reviews changes.',
  instructions: 'Read the diff and report bugs.',
  tools: ['Read', 'Grep'],
  claudeModel: 'sonnet',
  codexModel: undefined,
};

test('discovery lists both CLIs’ definitions and shows each problem inline', (context) => {
  const root = project({
    'package.json': '{}',
    '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\ncolor: blue\n---\nBody\n',
    '.claude/agents/windows.md': '﻿---\r\nname: windows\r\ndescription: Saved on Windows.\r\n---\r\nBody\r\n',
    '.claude/agents/broken.md': '---\nname: [unclosed\ndescription: x\n---\n',
    '.claude/agents/twice.md': '---\nname: a\nname: b\ndescription: x\n---\n',
    '.claude/agents/nameless.md': '---\ndescription: x\n---\n',
    '.claude/agents/notes.txt': 'not an agent',
    '.claude/agents/nested/deep.md': '---\nname: deep\ndescription: x\n---\n',
    '.codex/agents/explorer.toml': 'name = "explorer"\ndescription = "Maps code."\ndeveloper_instructions = """\nExplore.\n"""\n',
    '.codex/agents/bad.toml': 'name = "bad"\n',
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const listing = listAgents(root);
  assert.deepEqual(
    listing.agents.map((agent) => [agent.provider, agent.path, agent.name, agent.problems.map((problem) => problem.kind)]),
    [
      ['claude', '.claude/agents/broken.md', 'broken', ['syntax']],
      ['claude', '.claude/agents/nameless.md', 'nameless', ['missing-field']],
      ['claude', '.claude/agents/reviewer.md', 'reviewer', []],
      ['claude', '.claude/agents/twice.md', 'twice', ['duplicate-key']],
      ['claude', '.claude/agents/windows.md', 'windows', []],
      ['codex', '.codex/agents/bad.toml', 'bad', ['missing-field', 'missing-field']],
      ['codex', '.codex/agents/explorer.toml', 'explorer', []],
    ],
  );
  assert.deepEqual(listing.agents[2]?.tools, ['Read', 'Grep']);
  assert.equal(listing.truncated, false);
  const syntax = listing.agents[0]?.problems[0];
  assert.ok(syntax?.kind === 'syntax' && syntax.line !== undefined && syntax.line >= 2);
});

test('YAML aliases cannot expand a definition, and a huge file is a problem', () => {
  const bomb = `---\na: &a ["x","x"]\nb: [*a,*a]\nname: a\ndescription: b\n---\n`;
  assert.equal(readClaudeAgentMeta(bomb).problems[0]?.kind, 'syntax');
  assert.deepEqual(readClaudeAgentMeta(`---\nname: a\ndescription: b\n---\n${'x'.repeat(300 * 1024)}`).problems, [{ kind: 'too-large' }]);
});

test('a paired agent is a source and two files; a collision with any agent is refused', (context) => {
  const root = project({ 'package.json': '{}', '.codex/agents/taken.toml': 'name = "taken"\ndescription = "x"\ndeveloper_instructions = "y"\n' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = saveAgent(root, { fields: FIELDS, mode: 'create', overwrite: [] });
  assert.deepEqual(created, {
    ok: true,
    value: { written: ['.stacki/agents/code-reviewer.json', '.claude/agents/code-reviewer.md', '.codex/agents/code-reviewer.toml'] },
  });
  const listing = listAgents(root);
  assert.deepEqual(listing.paired[0]?.files, { claude: 'in-sync', codex: 'in-sync' });
  assert.ok(listing.agents.every((agent) => agent.problems.length === 0));
  assert.equal(listing.agents.find((agent) => agent.provider === 'claude')?.pairedSource, '.stacki/agents/code-reviewer.json');
  assert.equal(saveAgent(root, { fields: FIELDS, mode: 'create', overwrite: [] }).ok, false);
  const collision = saveAgent(root, { fields: { ...FIELDS, name: 'taken' }, mode: 'create', overwrite: [] });
  assert.deepEqual(collision.ok ? undefined : collision.error.code, 'exists');
  assert.equal(fs.existsSync(path.join(root, '.claude/agents/taken.md')), false);
  const invalid = saveAgent(root, { fields: { ...FIELDS, name: 'other', description: '' }, mode: 'create', overwrite: [] });
  assert.deepEqual(invalid.ok ? undefined : invalid.error.code, 'invalid');
});

test('a hand edit of a generated file is detected and overwritten only when asked', (context) => {
  const root = project({ 'package.json': '{}' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(saveAgent(root, { fields: FIELDS, mode: 'create', overwrite: [] }).ok, true);
  const codexFile = path.join(root, '.codex/agents/code-reviewer.toml');
  fs.appendFileSync(codexFile, 'model_reasoning_effort = "high"\n');
  assert.deepEqual(listAgents(root).paired[0]?.files, { claude: 'in-sync', codex: 'edited' });
  const refused = saveAgent(root, { fields: { ...FIELDS, description: 'Reviews carefully.' }, mode: 'update', overwrite: [] });
  assert.equal(refused.ok, false);
  assert.match(fs.readFileSync(codexFile, 'utf8'), /model_reasoning_effort/);
  const resynced = saveAgent(root, { fields: { ...FIELDS, description: 'Reviews carefully.' }, mode: 'update', overwrite: ['codex'] });
  assert.equal(resynced.ok, true);
  assert.deepEqual(listAgents(root).paired[0]?.files, { claude: 'in-sync', codex: 'in-sync' });
  assert.doesNotMatch(fs.readFileSync(codexFile, 'utf8'), /model_reasoning_effort/);
  fs.rmSync(codexFile);
  assert.deepEqual(listAgents(root).paired[0]?.files, { claude: 'in-sync', codex: 'missing' });
  assert.equal(saveAgent(root, { fields: { ...FIELDS, description: 'Reviews carefully.' }, mode: 'update', overwrite: [] }).ok, true);
  assert.equal(fs.existsSync(codexFile), true);
});

test('deleting moves a definition, or a pair and its source, to the Trash', async (context) => {
  const root = project({ 'package.json': '{}', '.claude/agents/solo.md': '---\nname: solo\ndescription: x\n---\n' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(saveAgent(root, { fields: FIELDS, mode: 'create', overwrite: [] }).ok, true);
  const trashed: string[] = [];
  const trash = (file: string): Promise<void> => {
    trashed.push(path.relative(root, file).split(path.sep).join('/'));
    fs.rmSync(file);
    return Promise.resolve();
  };
  assert.deepEqual(await deleteAgent(root, { kind: 'file', path: '.claude/agents/solo.md' }, trash), {
    ok: true,
    value: { written: ['.claude/agents/solo.md'] },
  });
  assert.equal((await deleteAgent(root, { kind: 'paired', name: 'code-reviewer' }, trash)).ok, true);
  assert.deepEqual(trashed, [
    '.claude/agents/solo.md',
    '.stacki/agents/code-reviewer.json',
    '.claude/agents/code-reviewer.md',
    '.codex/agents/code-reviewer.toml',
  ]);
  assert.deepEqual(listAgents(root), { agents: [], paired: [], truncated: false });
  const again = await deleteAgent(root, { kind: 'file', path: '.claude/agents/solo.md' }, trash);
  assert.equal(again.ok ? undefined : again.error.code, 'missing');
});

test('the watcher hears Codex definitions and paired sources, not other TOML or JSON', () => {
  assert.equal(concerns('.codex/agents/a.toml'), true);
  assert.equal(concerns('.stacki/agents/a.json'), true);
  assert.equal(concerns('.codex/config.toml'), false);
  assert.equal(concerns('.stacki/components.json'), false);
});
