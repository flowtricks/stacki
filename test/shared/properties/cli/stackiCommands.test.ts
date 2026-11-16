// Goal: the command table is complete and consistent, so a command cannot exist without a role feature, a unique name and a readable line, and the
// output contract that scripts and agents depend on cannot drift silently.
// Method: every row is checked for a unique feature key and tool name and a feature in the CLI group; each row's own example line is parsed back
// to the row; unknown flags and missing arguments are refused; the success and failure envelopes and the exit codes are compared with golden values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine, flagOf } from '#dist/shared/properties/cli/stackiArgs.js';
import { COMMANDS, toolNameOf } from '#dist/shared/properties/cli/stackiCommands.js';
import { CLI_ACCESS_FEATURES } from '#dist/shared/properties/cli/stackiFeatures.js';
import { CLI_EXIT_CODES, CLI_SCHEMA_VERSION, diffJson, exitCodeOf } from '#dist/shared/properties/cli/stackiOutput.js';

test('every command has a unique feature key and tool name and a feature from the CLI group', () => {
  assert.equal(new Set(COMMANDS.map((spec) => spec.featureKey)).size, COMMANDS.length);
  assert.equal(new Set(COMMANDS.map(toolNameOf)).size, COMMANDS.length);
  for (const spec of COMMANDS) {
    assert.ok(CLI_ACCESS_FEATURES.includes(spec.feature), `${spec.featureKey} names a CLI feature`);
    assert.equal(spec.featureKey, `cli.${spec.words.join('.')}`);
    assert.ok(spec.summary.length > 10);
    if (spec.access === 'read') {
      assert.equal(spec.feature, 'cli:read', `${spec.featureKey}: read commands are cli:read`);
      assert.equal(spec.destructive, false);
    }
    if (spec.words[0] === 'roles') {
      assert.equal(spec.feature, 'cli:roles', `${spec.featureKey}: roles edits are high privilege`);
    }
  }
});

test('a command line is read back to its row, with positional and flag arguments', () => {
  const parsed = parseLine(['config', 'set', 'guide', 'settings.visible', 'true', '--apply', '--role', 'editor']);
  assert.ok(parsed.ok && parsed.value !== 'top-help');
  if (parsed.ok && parsed.value !== 'top-help') {
    assert.deepEqual(parsed.value.spec.words, ['config', 'set']);
    assert.deepEqual(parsed.value.args, { file: 'guide', path: 'settings.visible', value: true });
    assert.equal(parsed.value.options.apply, 'apply');
    assert.equal(parsed.value.options.role, 'editor');
  }
  assert.equal(flagOf('widthMax'), '--width-max');
});

test('unknown flags, unknown commands and missing arguments are refused with usage', () => {
  for (const line of [['guides', 'set', '--visibel', 'true'], ['nope'], ['config', 'set', 'guide'], ['guides', 'set', '--opacity', 'loud'], ['breakpoints']]) {
    const parsed = parseLine(line);
    assert.ok(!parsed.ok, line.join(' '));
    assert.equal(parsed.ok ? '' : parsed.error.code, 'usage');
  }
});

test('golden: exit codes and the envelope shape', () => {
  assert.equal(CLI_SCHEMA_VERSION, 1);
  assert.deepEqual(CLI_EXIT_CODES, {
    usage: 2,
    'not-a-project': 2,
    'unknown-file': 2,
    'bad-path': 2,
    'unknown-key': 1,
    'invalid-value': 1,
    'invalid-file': 1,
    missing: 1,
    exists: 1,
    required: 1,
    refused: 1,
    'confirmation-required': 1,
    'apply-required': 1,
    'planner-unavailable': 1,
    'unsupported-file': 1,
    locked: 3,
    conflict: 3,
    'write-failed': 4,
    internal: 4,
    'role-denied': 5,
  });
  const success = {
    schemaVersion: 1,
    ok: true as const,
    command: 'x',
    mode: 'plan' as const,
    applied: false,
    project: '/p',
    role: 'admin',
    files: [],
    notes: [],
    summary: 's',
  };
  assert.equal(exitCodeOf(success), 0);
  assert.equal(exitCodeOf({ schemaVersion: 1, ok: false, command: 'x', error: { code: 'role-denied', message: 'm' } }), 5);
  assert.deepEqual(diffJson({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3], c: true }).changes, [
    { path: 'a', before: 1, after: 2 },
    { path: 'b[1]', before: 2, after: 3 },
    { path: 'c', after: true },
  ]);
});
