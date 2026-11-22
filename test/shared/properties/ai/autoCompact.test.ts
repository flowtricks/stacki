// Goal: "Auto-compact at" is saved only as an integer inside its bounds, reaches Claude as the one environment variable it
// reads, reaches nothing for an agent that cannot take it, and the context bar changes colour at 70% and 90%.
// Methodology: each parser gets valid values at both bounds and invalid ones one past them (and non-integers, strings, NaN);
// the environment mapping is checked per agent with and without a choice; the colour thresholds are checked on both sides.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_COMPACT_LIMITS,
  AUTO_COMPACT_PRESETS,
  AUTO_COMPACT_VARIABLE,
  autoCompactEnvironment,
  autoCompactSupported,
  contextBarTone,
  parseAutoCompactPercent,
} from '#dist/shared/properties/ai/autoCompact.js';

test('a percentage is an integer from the lowest to the highest bound', () => {
  assert.equal(parseAutoCompactPercent(AUTO_COMPACT_LIMITS.percentMin), 30);
  assert.equal(parseAutoCompactPercent(AUTO_COMPACT_LIMITS.percentMax), 95);
  for (const bad of [29, 96, 0, -1, 80.5, Number.NaN, Number.POSITIVE_INFINITY, '80', undefined, {}]) {
    assert.throws(() => parseAutoCompactPercent(bad), /Auto-compact/, `rejects ${String(bad)}`);
  }
  for (const preset of AUTO_COMPACT_PRESETS) {
    assert.equal(parseAutoCompactPercent(preset), preset, 'every preset is inside the bounds');
  }
});

test('Claude gets the override variable and the agent default sets nothing; Codex is never given one', () => {
  assert.deepEqual(autoCompactEnvironment('claude', 80), { [AUTO_COMPACT_VARIABLE]: '80' });
  assert.equal(AUTO_COMPACT_VARIABLE, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
  assert.deepEqual(autoCompactEnvironment('claude', undefined), {});
  assert.deepEqual(autoCompactEnvironment('codex', 80), {});
  assert.equal(autoCompactSupported('claude'), true);
  assert.equal(autoCompactSupported('codex'), false, 'the setting is hidden for Codex');
  assert.throws(() => autoCompactEnvironment('claude', 99), /out of range/, 'an unsaved bad value never reaches the environment');
});

test('the context bar is blue below 70%, amber from 70%, red from 90%, unknown without a window', () => {
  assert.equal(contextBarTone(undefined), 'unknown');
  assert.equal(contextBarTone(0), 'blue');
  assert.equal(contextBarTone(69), 'blue');
  assert.equal(contextBarTone(70), 'amber');
  assert.equal(contextBarTone(89), 'amber');
  assert.equal(contextBarTone(90), 'red');
  assert.equal(contextBarTone(100), 'red');
  assert.throws(() => contextBarTone(Number.NaN), /finite/);
});
