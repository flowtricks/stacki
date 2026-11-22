// Goal: the agent-definition contract (shared/properties/projectAgents.ts) reads what each CLI reads and
// refuses the rest as a problem, never a crash: Claude frontmatter with a byte-order mark, CRLF, a missing
// or unclosed fence, a key written twice and a file past the size bound; Codex TOML with its required keys,
// bad syntax and a repeated key. Paired agents: the generators are deterministic and agree with the readers
// (what Claude's and Codex's readers see is the fields), and the divergence check sees an edit in either
// file, ignores CRLF checkouts, and calls a deleted file missing. The wire parsers refuse each bad shape.
// Method: call the pure functions with hand-written sources; the YAML reading itself is main's
// (test/electron/project/agentFiles.test.ts covers it end to end).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_AGENT_LIMITS,
  agentFieldProblems,
  agentNameProblem,
  agentProviderOf,
  claudeAgentMeta,
  claudeFrontmatter,
  codexAgentMeta,
  generateClaudeAgent,
  generateCodexAgent,
  normalizeAgentFields,
  pairedFileState,
  pairedSourceOf,
  parseAgentDeleteTarget,
  parseAgentFields,
  parseAgentFilePath,
  parseAgentListing,
  parseAgentWriteResult,
  readAgentSource,
  agentSourceText,
  repeatedTopLevelKey,
} from '#dist/shared/properties/projectAgents.js';

const FIELDS = normalizeAgentFields({
  name: 'code-reviewer',
  description: 'Reviews changes for bugs. Use after editing code.',
  instructions: 'Read the diff.\r\nReport "real" bugs only \\ no style.\n',
  tools: ['Read', 'Grep', 'Bash(git diff:*)'],
  claudeModel: 'sonnet',
  codexModel: 'gpt-5.5',
});

test('Claude frontmatter is found through a byte-order mark and CRLF line endings', () => {
  const located = claudeFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nBody\r\n');
  assert.equal(located.kind, 'yaml');
  if (located.kind === 'yaml') {
    assert.equal(located.yaml, 'name: a\r\ndescription: b\r\n');
    assert.equal(located.body, 'Body\r\n');
  }
});

test('Claude frontmatter problems: none, unclosed, repeated key, too large', () => {
  assert.deepEqual(claudeFrontmatter('# Just a heading\n'), { kind: 'problem', problem: { kind: 'no-frontmatter' } });
  assert.deepEqual(claudeFrontmatter('---\nname: a\n'), { kind: 'problem', problem: { kind: 'unclosed-frontmatter' } });
  assert.deepEqual(claudeFrontmatter('---\nname: a\ndescription: b\nname: c\n---\n'), { kind: 'problem', problem: { kind: 'duplicate-key', key: 'name' } });
  assert.deepEqual(claudeFrontmatter('x'.repeat(PROJECT_AGENT_LIMITS.fileBytesMax + 1)), { kind: 'problem', problem: { kind: 'too-large' } });
  // A fence that closes past the frontmatter bound is not frontmatter at all.
  const late = `---\nname: a\n${'# filler\n'.repeat(Math.ceil(PROJECT_AGENT_LIMITS.frontmatterCharsMax / 9) + 1)}---\n`;
  assert.deepEqual(claudeFrontmatter(late), { kind: 'problem', problem: { kind: 'unclosed-frontmatter' } });
});

test('a repeated key counts top-level keys only, quoted or plain, never nested ones or comments', () => {
  assert.equal(repeatedTopLevelKey('name: a\nnested:\n  name: b\n# name: c\n'), undefined);
  assert.equal(repeatedTopLevelKey('"name": a\nname: b\n'), 'name');
  assert.equal(repeatedTopLevelKey("tools: Read\n'tools': Grep\n"), 'tools');
  assert.equal(repeatedTopLevelKey('- name: a\n- name: b\n'), undefined);
});

test('Claude meta: the required fields, the optional ones, and each wrong shape', () => {
  assert.deepEqual(claudeAgentMeta({ name: ' reviewer ', description: 'Reviews.', tools: 'Read, Grep', model: 'opus', color: 'blue' }), {
    name: 'reviewer',
    description: 'Reviews.',
    model: 'opus',
    tools: ['Read', 'Grep'],
    problems: [],
  });
  assert.deepEqual(claudeAgentMeta({ name: 'a', description: 'b', tools: ['Read', 'Write'] }).tools, ['Read', 'Write']);
  assert.deepEqual(claudeAgentMeta(['not', 'a', 'map']).problems, [{ kind: 'not-a-map' }]);
  assert.deepEqual(claudeAgentMeta(undefined).problems, [{ kind: 'not-a-map' }]);
  assert.deepEqual(claudeAgentMeta({ description: 'b' }).problems, [{ kind: 'missing-field', field: 'name' }]);
  assert.deepEqual(claudeAgentMeta({ name: '   ', description: 'b' }).problems, [{ kind: 'missing-field', field: 'name' }]);
  assert.deepEqual(claudeAgentMeta({ name: 7, description: 'b' }).problems, [{ kind: 'wrong-type', field: 'name' }]);
  assert.deepEqual(claudeAgentMeta({ name: 'a', description: 'b'.repeat(PROJECT_AGENT_LIMITS.descriptionCharsMax + 1) }).problems, [
    { kind: 'too-long', field: 'description' },
  ]);
  assert.deepEqual(claudeAgentMeta({ name: 'a', description: 'b', tools: { read: true } }).problems, [{ kind: 'wrong-type', field: 'tools' }]);
  assert.deepEqual(claudeAgentMeta({ name: 'a', description: 'b', tools: [1] }).problems, [{ kind: 'wrong-type', field: 'tools' }]);
  assert.deepEqual(claudeAgentMeta({ name: 'a', description: 'b', tools: Array.from({ length: PROJECT_AGENT_LIMITS.toolsMax + 1 }, () => 'Read') }).problems, [
    { kind: 'too-long', field: 'tools' },
  ]);
});

test('Codex meta: the three required keys, an optional model, a syntax error with its line, a repeated key', () => {
  const good = 'name = "reviewer"\ndescription = "Reviews."\nmodel = "gpt-5.5"\ndeveloper_instructions = """\nRead.\n"""\n[skills.config]\n';
  assert.deepEqual(codexAgentMeta(good), { name: 'reviewer', description: 'Reviews.', model: 'gpt-5.5', tools: undefined, problems: [] });
  assert.deepEqual(codexAgentMeta('﻿name = "a"\r\ndescription = "b"\r\ndeveloper_instructions = "c"\r\n').problems, []);
  assert.deepEqual(codexAgentMeta('name = "a"\ndescription = "b"\n').problems, [{ kind: 'missing-field', field: 'developer_instructions' }]);
  assert.deepEqual(codexAgentMeta('name = 3\ndescription = "b"\ndeveloper_instructions = "c"\n').problems, [{ kind: 'wrong-type', field: 'name' }]);
  const broken = codexAgentMeta('name = "a"\ndescription = \n');
  assert.equal(broken.problems[0]?.kind, 'syntax');
  const repeated = codexAgentMeta('name = "a"\nname = "b"\ndescription = "c"\ndeveloper_instructions = "d"\n');
  assert.deepEqual(repeated.problems, [{ kind: 'syntax', line: 2, detail: 'syntax' }]);
  assert.deepEqual(codexAgentMeta('x'.repeat(PROJECT_AGENT_LIMITS.fileBytesMax + 1)).problems, [{ kind: 'too-large' }]);
});

test('generated files read back as the fields they came from, each naming its source', () => {
  const claude = generateClaudeAgent(FIELDS);
  const located = claudeFrontmatter(claude);
  assert.equal(located.kind, 'yaml');
  if (located.kind === 'yaml') {
    assert.equal(located.body.trim(), FIELDS.instructions.trim());
    assert.match(located.yaml, /^# Generated by Stacki/);
    assert.match(located.yaml, /^tools: Read, Grep, Bash\(git diff:\*\)$/m);
  }
  assert.equal(pairedSourceOf(claude), '.stacki/agents/code-reviewer.json');
  const codex = generateCodexAgent(FIELDS);
  assert.deepEqual(codexAgentMeta(codex), { name: 'code-reviewer', description: FIELDS.description, model: 'gpt-5.5', tools: undefined, problems: [] });
  assert.equal(pairedSourceOf(codex), '.stacki/agents/code-reviewer.json');
  // Codex has no per-agent tools: the generator leaves them out rather than writing a key Codex ignores.
  assert.doesNotMatch(codex, /tools/);
  // Deterministic: the same fields always generate the same bytes.
  assert.equal(generateClaudeAgent(FIELDS), claude);
  assert.equal(generateCodexAgent(FIELDS), codex);
});

test('instructions holding """, backslashes and control characters stay one closed TOML string', () => {
  const tricky = normalizeAgentFields({ ...FIELDS, instructions: 'Say """ then \\ and \u0007 and \u007f.' });
  const meta = codexAgentMeta(generateCodexAgent(tricky));
  assert.deepEqual(meta.problems, []);
});

test('the divergence check sees an edit in either file, ignores CRLF, and calls a deleted file missing', () => {
  const claude = generateClaudeAgent(FIELDS);
  const codex = generateCodexAgent(FIELDS);
  assert.equal(pairedFileState(FIELDS, 'claude', claude), 'in-sync');
  assert.equal(pairedFileState(FIELDS, 'codex', codex), 'in-sync');
  assert.equal(pairedFileState(FIELDS, 'claude', claude.replace(/\n/g, '\r\n')), 'in-sync');
  assert.equal(pairedFileState(FIELDS, 'claude', claude.replace('Read the diff.', 'Read the whole file.')), 'edited');
  assert.equal(pairedFileState(FIELDS, 'codex', `${codex}model_reasoning_effort = "high"\n`), 'edited');
  assert.equal(pairedFileState(FIELDS, 'codex', undefined), 'missing');
  // Changed fields make the files on disk stale: the pair diverges until it is re-synced.
  assert.equal(pairedFileState({ ...FIELDS, description: 'Something else.' }, 'claude', claude), 'edited');
});

test('the source file round-trips and refuses each bad shape', () => {
  const text = agentSourceText(FIELDS);
  assert.deepEqual(readAgentSource(text, '.stacki/agents/code-reviewer.json'), { ok: true, value: FIELDS });
  assert.equal(readAgentSource(text, '.stacki/agents/other.json').ok, false);
  assert.deepEqual(readAgentSource('{', '.stacki/agents/a.json').ok, false);
  assert.deepEqual(readAgentSource('[]', '.stacki/agents/a.json'), { ok: false, error: { kind: 'not-a-map' } });
  assert.deepEqual(readAgentSource('{"version":2}', '.stacki/agents/a.json'), { ok: false, error: { kind: 'wrong-type', field: 'version' } });
  assert.deepEqual(readAgentSource('{"version":1,"name":"a","description":"b"}', '.stacki/agents/a.json'), {
    ok: false,
    error: { kind: 'missing-field', field: 'instructions' },
  });
  assert.deepEqual(readAgentSource('{"version":1,"name":"a","description":"b","instructions":"c","tools":[1]}', '.stacki/agents/a.json'), {
    ok: false,
    error: { kind: 'wrong-type', field: 'tools' },
  });
  assert.deepEqual(readAgentSource('{"version":1,"name":"Bad Name","description":"b","instructions":"c"}', '.stacki/agents/Bad Name.json').ok, false);
});

test('field problems: names, collisions ignoring case, empty and long fields, bad tools and models', () => {
  assert.deepEqual(agentFieldProblems(FIELDS, []), []);
  assert.equal(agentNameProblem(''), 'empty');
  assert.equal(agentNameProblem('Code Reviewer'), 'format');
  assert.equal(agentNameProblem('a--b'), 'format');
  assert.equal(agentNameProblem('../etc'), 'format');
  assert.equal(agentNameProblem('a'.repeat(PROJECT_AGENT_LIMITS.nameCharsMax + 1)), 'too-long');
  assert.deepEqual(agentFieldProblems(FIELDS, ['Code-Reviewer']), [{ field: 'name', code: 'taken' }]);
  assert.deepEqual(agentFieldProblems({ ...FIELDS, description: ' ', instructions: '' }, []), [
    { field: 'description', code: 'empty' },
    { field: 'instructions', code: 'empty' },
  ]);
  assert.deepEqual(agentFieldProblems({ ...FIELDS, tools: ['Read, Grep'] }, []), [{ field: 'tools', code: 'format' }]);
  assert.deepEqual(agentFieldProblems({ ...FIELDS, codexModel: 'gpt 5' }, []), [{ field: 'codexModel', code: 'format' }]);
});

test('wire parsers accept the listing main sends and refuse each bad shape', () => {
  const agent = { provider: 'claude', path: '.claude/agents/a.md', name: 'a', description: 'b', problems: [], pairedSource: undefined };
  const pair = { source: '.stacki/agents/a.json', fields: { ok: true, value: FIELDS }, files: { claude: 'in-sync', codex: 'missing' } };
  assert.equal(parseAgentListing({ agents: [agent], paired: [pair], truncated: false }).agents.length, 1);
  assert.throws(() => parseAgentListing({ agents: [{ ...agent, provider: 'codex' }], paired: [], truncated: false }), /wrong provider/);
  assert.throws(() => parseAgentListing({ agents: [{ ...agent, path: '.claude/agents/../x.md' }], paired: [], truncated: false }), /inside the project/);
  assert.throws(() => parseAgentListing({ agents: [{ ...agent, problems: [{ kind: 'nope' }] }], paired: [], truncated: false }), /Unknown agent problem/);
  assert.throws(
    () => parseAgentListing({ agents: [], paired: [{ ...pair, files: { claude: 'stale', codex: 'missing' } }], truncated: false }),
    /paired file state/,
  );
  assert.throws(() => parseAgentListing({ agents: [], paired: [], truncated: 'no' }));
  assert.equal(agentProviderOf('.codex/agents/a.toml'), 'codex');
  assert.equal(agentProviderOf('.codex/agents/nested/a.toml'), undefined);
  assert.equal(agentProviderOf('.claude/agents/a.toml'), undefined);
  assert.throws(() => parseAgentFilePath('/abs/.claude/agents/a.md'));
  assert.throws(() => parseAgentFilePath('docs/a.md'));
  assert.deepEqual(parseAgentDeleteTarget({ kind: 'paired', name: 'a' }), { kind: 'paired', name: 'a' });
  assert.throws(() => parseAgentDeleteTarget({ kind: 'paired', name: '../a' }));
  assert.throws(() => parseAgentDeleteTarget({ kind: 'folder', path: '.claude' }));
  assert.throws(() => parseAgentFields({ ...FIELDS, tools: Array.from({ length: PROJECT_AGENT_LIMITS.toolsMax + 1 }, () => 'Read') }));
  assert.deepEqual(parseAgentWriteResult({ ok: false, error: { code: 'exists', message: 'x' } }), { ok: false, error: { code: 'exists', message: 'x' } });
  assert.throws(() => parseAgentWriteResult({ ok: false, error: { code: 'boom', message: 'x' } }));
});
