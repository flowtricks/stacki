// Goal: the AI panel's agent choice per surface (shared/properties/ai/agentChoices.ts) survives storage
// and its damage, and is applied when a chat is built: a usable Claude agent becomes the session option
// `agent` the Claude adapter offers, a Codex agent is never sent (Codex takes no main-thread agent), and a
// choice whose agent was deleted or broken degrades to the default as `missing` so the panel can say so.
// Method: call the pure parser, the update and the resolution with hand-built definitions.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_CHOICE_LIMITS,
  CLAUDE_AGENT_OPTION_ID,
  EMPTY_STORED_AGENT_CHOICES,
  NO_AGENT_CHOICES,
  agentSettingsFor,
  choicesFor,
  parseStoredAgentChoices,
  providerFor,
  resolveAgentChoice,
  serializeStoredAgentChoices,
  withAgentChoice,
} from '#dist/shared/properties/ai/agentChoices.js';

const REVIEWER = {
  provider: 'claude' as const,
  path: '.claude/agents/reviewer.md',
  name: 'reviewer',
  description: 'Reviews.',
  model: undefined,
  tools: undefined,
  problems: [],
  pairedSource: undefined,
};

test('stored choices round-trip per project and per surface', () => {
  const stored = withAgentChoice(EMPTY_STORED_AGENT_CHOICES, { projectPath: '/site', surface: 'auditFix', choice: { provider: 'claude', name: 'reviewer' } });
  const read = parseStoredAgentChoices(serializeStoredAgentChoices(stored));
  assert.deepEqual(choicesFor(read, '/site'), { chat: undefined, auditFix: { provider: 'claude', name: 'reviewer' }, appBuild: undefined });
  assert.deepEqual(choicesFor(read, '/other'), NO_AGENT_CHOICES);
  const cleared = withAgentChoice(read, { projectPath: '/site', surface: 'auditFix', choice: undefined });
  assert.deepEqual(choicesFor(cleared, '/site'), NO_AGENT_CHOICES);
});

test('damaged storage reads as no choices, and a damaged entry loses only itself', () => {
  for (const raw of [undefined, JSON.parse('null'), 3, '', '{', '[]', '{"version":2,"projects":[]}', '{"version":1,"projects":{}}']) {
    assert.deepEqual(parseStoredAgentChoices(raw), EMPTY_STORED_AGENT_CHOICES);
  }
  const raw = JSON.stringify({
    version: 1,
    projects: [
      'junk',
      { projectPath: '', choices: {} },
      {
        projectPath: '/site',
        choices: { chat: { provider: 'gemini', name: 'x' }, auditFix: { provider: 'claude', name: '' }, appBuild: { provider: 'claude', name: 'builder' } },
      },
    ],
  });
  assert.deepEqual(parseStoredAgentChoices(raw).projects, [
    { projectPath: '/site', choices: { chat: undefined, auditFix: undefined, appBuild: { provider: 'claude', name: 'builder' } } },
  ]);
  const long = JSON.stringify({
    version: 1,
    projects: [{ projectPath: '/site', choices: { chat: { provider: 'claude', name: 'a'.repeat(AGENT_CHOICE_LIMITS.nameCharsMax + 1) } } }],
  });
  assert.deepEqual(choicesFor(parseStoredAgentChoices(long), '/site'), NO_AGENT_CHOICES);
});

test('the stored set keeps the most recently written projects within its bound', () => {
  let stored = EMPTY_STORED_AGENT_CHOICES;
  for (let index = 0; index < AGENT_CHOICE_LIMITS.projectsMax + 5; index += 1) {
    stored = withAgentChoice(stored, { projectPath: `/site-${index}`, surface: 'chat', choice: { provider: 'claude', name: 'a' } });
  }
  assert.equal(stored.projects.length, AGENT_CHOICE_LIMITS.projectsMax);
  assert.equal(stored.projects[0]?.projectPath, '/site-5');
  const repeated = JSON.stringify({
    version: 1,
    projects: [
      { projectPath: '/a', choices: {} },
      { projectPath: '/a', choices: { chat: { provider: 'claude', name: 'b' } } },
    ],
  });
  assert.deepEqual(parseStoredAgentChoices(repeated).projects, [
    { projectPath: '/a', choices: { chat: { provider: 'claude', name: 'b' }, auditFix: undefined, appBuild: undefined } },
  ]);
});

test('a usable Claude choice becomes the session option a new Claude chat carries', () => {
  const resolved = resolveAgentChoice({ provider: 'claude', name: 'reviewer' }, [REVIEWER]);
  assert.equal(resolved.kind, 'agent');
  assert.deepEqual(agentSettingsFor(resolved, 'claude'), [{ option: CLAUDE_AGENT_OPTION_ID, value: 'reviewer' }]);
  assert.equal(CLAUDE_AGENT_OPTION_ID, 'agent');
  // A chat on the other provider runs its own default: the Claude agent is not sent to Codex.
  assert.deepEqual(agentSettingsFor(resolved, 'codex'), []);
  assert.equal(providerFor(resolved, 'codex'), 'claude');
});

test('the default, a deleted or broken agent, and a Codex agent send nothing', () => {
  assert.deepEqual(resolveAgentChoice(undefined, [REVIEWER]), { kind: 'default' });
  assert.deepEqual(agentSettingsFor({ kind: 'default' }, 'claude'), []);
  const gone = resolveAgentChoice({ provider: 'claude', name: 'deleted' }, [REVIEWER]);
  assert.deepEqual(gone, { kind: 'missing', choice: { provider: 'claude', name: 'deleted' } });
  assert.deepEqual(agentSettingsFor(gone, 'claude'), []);
  const broken = resolveAgentChoice({ provider: 'claude', name: 'reviewer' }, [{ ...REVIEWER, problems: [{ kind: 'no-frontmatter' }] }]);
  assert.equal(broken.kind, 'missing');
  const codex = resolveAgentChoice({ provider: 'codex', name: 'reviewer' }, [{ ...REVIEWER, provider: 'codex', path: '.codex/agents/reviewer.toml' }]);
  assert.equal(codex.kind, 'unsupported');
  assert.deepEqual(agentSettingsFor(codex, 'codex'), []);
  assert.equal(providerFor(codex, 'claude'), 'claude');
});
