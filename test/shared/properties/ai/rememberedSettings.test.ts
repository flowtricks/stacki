// Goal: the remembered composer settings read back safely and change predictably. A damaged file is the
// defaults, a damaged entry loses only itself, each agent keeps its own set, the last writer wins, a reset
// clears one agent only, and a value the agent no longer offers is dropped instead of applied.
// Methodology: the pure functions from dist/, driven with known-good input and every known-bad shape
// (wrong types, empty and oversized text, repeats, past the bound, unknown agents), plus the negative space
// of usableSettings: an unknown option, a retired value, and a list that is no longer offered at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import type { ChatOption } from '#dist/shared/properties/ai/chatModel.js';
import {
  applyRemember,
  NO_REMEMBERED_SETTINGS,
  overlaySettings,
  parseRememberAction,
  parseRememberedFile,
  parseRememberedSettings,
  serializeRememberedSettings,
  usableSettings,
} from '#dist/shared/properties/ai/rememberedSettings.js';

// A platform null as it arrives from JSON.parse; written this way because the code itself never uses null.
const NULL: unknown = JSON.parse('null');
const choice = (value: string) => ({ value, name: value, description: undefined });
const OFFERED: readonly ChatOption[] = [
  { id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', choices: [choice('default'), choice('plan'), choice('bypassPermissions')] },
  { id: 'model', name: 'Model', category: 'model', currentValue: 'default', choices: [choice('default'), choice('opus')] },
];

test('a damaged file reads as nothing remembered, and a damaged entry loses only itself', () => {
  for (const damaged of [undefined, NULL, 7, 'text', [], {}, { agents: 3 }, { agents: [] }, { version: 1, agents: { claude: 'x', codex: 4 } }]) {
    assert.deepEqual(parseRememberedFile(damaged), NO_REMEMBERED_SETTINGS, JSON.stringify(damaged));
    assert.deepEqual(parseRememberedSettings(damaged), NO_REMEMBERED_SETTINGS, JSON.stringify(damaged));
  }
  const partial = parseRememberedFile({
    agents: {
      claude: [
        { option: 'model', value: 'opus' },
        { option: '', value: 'x' },
        { option: 'effort' },
        NULL,
        5,
        { option: 'model', value: 'again' },
        { option: 'mode', value: 'plan' },
      ],
      codex: 'broken',
      gemini: [{ option: 'model', value: 'x' }],
    },
  });
  assert.deepEqual(partial.claude, [
    { option: 'model', value: 'opus' },
    { option: 'mode', value: 'plan' },
  ]);
  assert.deepEqual(partial.codex, [], 'a broken agent does not touch the other');
  assert.equal('gemini' in partial, false, 'an unknown agent is not kept');
});

test('bounds: oversized text and too many entries are dropped, never stored', () => {
  const tooLong = 'x'.repeat(AI_LIMITS.idCharsMax + 1);
  assert.deepEqual(parseRememberedFile({ agents: { claude: [{ option: 'model', value: tooLong }] } }).claude, []);
  const many = Array.from({ length: AI_LIMITS.configOptionsMax + 20 }, (_, index) => ({ option: `o${index}`, value: 'v' }));
  assert.equal(parseRememberedFile({ agents: { claude: many } }).claude.length, AI_LIMITS.configOptionsMax);
  let set = NO_REMEMBERED_SETTINGS;
  for (let index = 0; index < AI_LIMITS.configOptionsMax + 5; index++) {
    set = applyRemember(set, 'claude', { kind: 'set', option: `o${index}`, value: 'v' });
  }
  assert.equal(set.claude.length, AI_LIMITS.configOptionsMax, 'the newest choices stay');
  assert.equal(set.claude.at(-1)?.option, `o${AI_LIMITS.configOptionsMax + 4}`);
});

test('per agent, last writer wins, and a reset clears one agent only', () => {
  let set = applyRemember(NO_REMEMBERED_SETTINGS, 'claude', { kind: 'set', option: 'mode', value: 'plan' });
  set = applyRemember(set, 'codex', { kind: 'set', option: 'mode', value: 'read-only' });
  set = applyRemember(set, 'claude', { kind: 'set', option: 'model', value: 'opus' });
  set = applyRemember(set, 'claude', { kind: 'set', option: 'mode', value: 'bypassPermissions' });
  assert.deepEqual(set.claude, [
    { option: 'model', value: 'opus' },
    { option: 'mode', value: 'bypassPermissions' },
  ]);
  assert.deepEqual(set.codex, [{ option: 'mode', value: 'read-only' }], "Claude's choices never reach Codex");
  const reset = applyRemember(set, 'claude', { kind: 'reset' });
  assert.deepEqual(reset.claude, []);
  assert.deepEqual(reset.codex, set.codex);
  assert.deepEqual(parseRememberedFile(JSON.parse(serializeRememberedSettings(set))), set, 'what is stored reads back the same');
});

test('a value the agent no longer offers is dropped; the rest is kept', () => {
  const kept = usableSettings(OFFERED, [
    { option: 'model', value: 'retired-model' },
    { option: 'mode', value: 'plan' },
    { option: 'removed-option', value: 'default' },
  ]);
  assert.deepEqual(kept, [{ option: 'mode', value: 'plan' }]);
  assert.deepEqual(usableSettings([], [{ option: 'mode', value: 'plan' }]), [], 'no options on offer: nothing applies');
  assert.deepEqual(
    overlaySettings(
      [{ option: 'model', value: 'a' }],
      [
        { option: 'model', value: 'b' },
        { option: 'mode', value: 'plan' },
      ],
    ),
    [
      { option: 'model', value: 'b' },
      { option: 'mode', value: 'plan' },
    ],
  );
});

test('the remember action refuses everything but a bounded set or a reset', () => {
  assert.deepEqual(parseRememberAction({ kind: 'reset' }), { kind: 'reset' });
  assert.deepEqual(parseRememberAction({ kind: 'set', option: 'model', value: 'opus' }), { kind: 'set', option: 'model', value: 'opus' });
  for (const bad of [NULL, 3, {}, { kind: 'forget' }, { kind: 'set' }, { kind: 'set', option: 'model', value: '' }, { kind: 'set', option: 4, value: 'x' }]) {
    assert.throws(() => parseRememberAction(bad), Error, JSON.stringify(bad));
  }
});
