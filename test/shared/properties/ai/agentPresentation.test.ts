// Goal: the composer's static presentation tables order, label and flag the
// choices the way the design says, and degrade to the adapter's own rows for a
// choice they do not know, never hiding one.
// Methodology: the choices recorded from the real adapters (test/fixtures/ai/acpTrace.jsonl)
// go through each helper; invariants (every choice shown once) are checked on
// shuffled and extended inputs.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  canCompact,
  effortRows,
  isDangerousMode,
  isRecommendedEffort,
  isRecommendedMode,
  modeChoices,
  orderedChoices,
  splitModels,
  toggleOptions,
} from '#dist/shared/properties/ai/agentPresentation.js';
import { parseSessionResult, parseAcpLine } from '#dist/shared/properties/ai/acpWire.js';

function options(agent: 'claude' | 'codex') {
  const line = fs
    .readFileSync(path.resolve('test/fixtures/ai/acpTrace.jsonl'), 'utf8')
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry): unknown => JSON.parse(entry))
    .find((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === `${agent}-session-new`);
  assert.ok(typeof line === 'object' && line !== null && 'line' in line && typeof line.line === 'string');
  const message = parseAcpLine(line.line);
  assert.ok(message.ok && message.value.kind === 'result');
  const session = parseSessionResult(message.value.result, undefined);
  assert.ok(session.ok);
  return session.value.options;
}

function choicesOf(agent: 'claude' | 'codex', id: string) {
  const option = options(agent).find((candidate) => candidate.id === id);
  assert.ok(option !== undefined, id);
  return option.choices;
}

test('Claude modes: Auto first and recommended, Manual second, Bypass last and dangerous', () => {
  const ordered = modeChoices('claude', choicesOf('claude', 'mode'));
  assert.deepEqual(
    ordered.map((choice) => choice.value),
    ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'],
  );
  assert.equal(isRecommendedMode('claude', 'auto'), true);
  assert.equal(isRecommendedMode('claude', 'default'), false);
  assert.equal(isDangerousMode('claude', 'bypassPermissions'), true);
  assert.equal(isDangerousMode('claude', 'plan'), false);
  assert.equal(isDangerousMode('codex', 'bypassPermissions'), false, 'the table is per agent');
});

test('Codex modes: full access is dangerous, nothing is recommended', () => {
  assert.deepEqual(
    modeChoices('codex', choicesOf('codex', 'mode')).map((choice) => choice.value),
    ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
  );
  assert.equal(isDangerousMode('codex', 'agent-full-access'), true);
  assert.equal(isRecommendedMode('codex', 'agent'), false);
});

test('effort rows: Extra for xhigh, the adapter’s default hidden, Ultra only where offered', () => {
  const claude = effortRows('claude', choicesOf('claude', 'effort'));
  assert.deepEqual(
    claude.map((row) => [row.value, row.label]),
    [
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra'],
      ['max', 'Max'],
    ],
  );
  const codex = effortRows('codex', choicesOf('codex', 'reasoning_effort'));
  assert.equal(codex[codex.length - 1]?.value, 'ultra');
  assert.equal(isRecommendedEffort('claude', 'medium'), true);
  assert.equal(isRecommendedEffort('claude', 'max'), false);
});

test('a choice the table does not know follows the known ones, in the adapter’s order, and none is lost', () => {
  const choices = [
    { value: 'zeta', name: 'Zeta', description: undefined },
    { value: 'plan', name: 'Plan', description: undefined },
    { value: 'alpha', name: 'Alpha', description: undefined },
    { value: 'auto', name: 'Auto', description: undefined },
  ];
  const ordered = modeChoices('claude', choices);
  assert.deepEqual(
    ordered.map((choice) => choice.value),
    ['auto', 'plan', 'zeta', 'alpha'],
  );
  assert.equal(orderedChoices([], choices).length, choices.length);
  assert.equal(effortRows('claude', [...choicesOf('claude', 'effort'), { value: 'turbo', name: 'Turbo', description: undefined }]).at(-1)?.label, 'Turbo');
});

test('models: the first four are listed, the rest sit behind More models', () => {
  const claude = splitModels('claude', choicesOf('claude', 'model'));
  assert.equal(claude.primary.length, 4);
  assert.equal(claude.more.length, 1);
  const codex = splitModels('codex', choicesOf('codex', 'model'));
  assert.equal(codex.primary.length + codex.more.length, 8);
  assert.equal(splitModels('claude', []).primary.length, 0);
});

test('switches: Ultracode and Fast mode for Claude, Fast mode for Codex, nothing that is not a clean on/off', () => {
  const claude = toggleOptions('claude', options('claude'));
  assert.deepEqual(
    claude.map((toggle) => [toggle.optionId, toggle.label, toggle.on]),
    [
      ['ultracode', 'Ultracode', false],
      ['fast', 'Fast mode', false],
    ],
  );
  const codex = toggleOptions('codex', options('codex'));
  assert.deepEqual(
    codex.map((toggle) => toggle.optionId),
    ['fast-mode'],
  );
  const three = options('claude').map((option) =>
    option.id === 'fast' ? { ...option, choices: [...option.choices, { value: 'turbo', name: 'T', description: undefined }] } : option,
  );
  assert.deepEqual(
    toggleOptions('claude', three).map((toggle) => toggle.optionId),
    ['ultracode'],
    'a three-way option is not a switch',
  );
  const on = options('claude').map((option) => (option.id === 'ultracode' ? { ...option, currentValue: 'on' } : option));
  assert.equal(toggleOptions('claude', on)[0]?.on, true);
  assert.deepEqual(toggleOptions('claude', []), []);
});

test('Compact exists for Claude only', () => {
  assert.equal(canCompact('claude'), true);
  assert.equal(canCompact('codex'), false);
});
