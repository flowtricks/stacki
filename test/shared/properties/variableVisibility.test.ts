// Goal: `.stacki/variables.json` parses only into a bounded, sorted, unique list of custom property names; every other
// shape is an error value (never a throw), and the pure toggle and serialize functions keep the list sorted, unique,
// idempotent and bounded.
// Method: parse the known-good file, then each known-bad shape and each bound one past its limit, pinning the error
// code; round-trip through the serializer; hide and show names, repeatedly and out of order; apply the suggestion rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_VARIABLE_VISIBILITY,
  VARIABLE_VISIBILITY_LIMITS,
  hiddenNameSet,
  isHiddenFromSuggestions,
  isVariableName,
  parseVariableVisibility,
  parseVariableVisibilitySource,
  serializeVariableVisibility,
  suggestionNames,
  withHidden,
  withShown,
} from '#dist/shared/properties/variableVisibility.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const parsedNull: unknown = JSON.parse('null');
const good = { version: 1, hiddenFromSuggestions: ['--light-100', '--tint-100'] };

function failureCode(result: ReturnType<typeof parseVariableVisibility>): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error.code;
}

test('a missing file reads as nothing hidden', () => {
  assert.deepEqual(parseVariableVisibilitySource(undefined), { ok: true, value: EMPTY_VARIABLE_VISIBILITY });
});

test('the known-good file parses and keeps its names', () => {
  const parsed = parseVariableVisibilitySource(JSON.stringify(good));
  assert.deepEqual(parsed, { ok: true, value: good });
});

test('an unsorted file is accepted and read back sorted', () => {
  const parsed = parseVariableVisibility({ version: 1, hiddenFromSuggestions: ['--b', '--a'] });
  assert.deepEqual(parsed, { ok: true, value: { version: 1, hiddenFromSuggestions: ['--a', '--b'] } });
});

test('each known-bad shape is an error value with its own code', () => {
  assert.equal(failureCode(parseVariableVisibilitySource('{broken')), 'variables-visibility-unreadable');
  assert.equal(failureCode(parseVariableVisibilitySource('')), 'variables-visibility-unreadable');
  assert.equal(failureCode(parseVariableVisibility('text')), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility(undefined)), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility(parsedNull)), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility([])), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ ...good, version: 2 })), 'variables-visibility-version');
  assert.equal(failureCode(parseVariableVisibility({ hiddenFromSuggestions: [] })), 'variables-visibility-version');
  assert.equal(failureCode(parseVariableVisibility({ version: 1 })), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: '--a' })), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: { 0: '--a' } })), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: [1] })), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: [undefined] })), 'variables-visibility-shape');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: ['light-100'] })), 'variables-visibility-name');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: ['--'] })), 'variables-visibility-name');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: ['--has space'] })), 'variables-visibility-name');
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: ['--a', '--a'] })), 'variables-visibility-duplicate');
});

test('the name bound: at the limit parses, one past is refused', () => {
  const longest = '--' + 'a'.repeat(VARIABLE_VISIBILITY_LIMITS.nameCharsMax - 2);
  assert.equal(parseVariableVisibility({ version: 1, hiddenFromSuggestions: [longest] }).ok, true);
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: [longest + 'a'] })), 'variables-visibility-limit');
});

test('the count bound: at the limit parses, one past is refused', () => {
  const names = Array.from({ length: VARIABLE_VISIBILITY_LIMITS.hiddenMax }, (_, index) => `--v${index}`);
  assert.equal(parseVariableVisibility({ version: 1, hiddenFromSuggestions: names }).ok, true);
  assert.equal(failureCode(parseVariableVisibility({ version: 1, hiddenFromSuggestions: [...names, '--extra'] })), 'variables-visibility-limit');
});

test('a parse failure never throws, and its message names the file', () => {
  const parsed = parseVariableVisibilitySource('[1, 2');
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error.message, /^\.stacki\/variables\.json: not valid JSON/);
});

test('isVariableName accepts custom property names and nothing else', () => {
  assert.equal(isVariableName('--light-100'), true);
  assert.equal(isVariableName('--_private'), true);
  assert.equal(isVariableName('--größe'), true);
  assert.equal(isVariableName('light-100'), false);
  assert.equal(isVariableName('-light'), false);
  assert.equal(isVariableName('--'), false);
  assert.equal(isVariableName(''), false);
  assert.equal(isVariableName('--a;b'), false);
  assert.equal(isVariableName('--a{'), false);
});

test('hiding keeps the list sorted and unique, and is idempotent', () => {
  let value = EMPTY_VARIABLE_VISIBILITY;
  for (const name of ['--b', '--c', '--a', '--b']) {
    const next = withHidden(value, name);
    assert.equal(next.ok, true);
    value = next.ok ? next.value : value;
  }
  assert.deepEqual(value.hiddenFromSuggestions, ['--a', '--b', '--c']);
  assert.deepEqual(withHidden(value, '--a'), { ok: true, value });
});

test('showing removes only that name, and showing a visible name changes nothing', () => {
  const start = { version: 1 as const, hiddenFromSuggestions: ['--a', '--b'] };
  assert.deepEqual(withShown(start, '--a'), { ok: true, value: { version: 1, hiddenFromSuggestions: ['--b'] } });
  assert.deepEqual(withShown(start, '--z'), { ok: true, value: start });
  assert.deepEqual(withShown(EMPTY_VARIABLE_VISIBILITY, '--a'), { ok: true, value: EMPTY_VARIABLE_VISIBILITY });
});

test('hiding does not mutate its input', () => {
  const start = Object.freeze({ version: 1 as const, hiddenFromSuggestions: Object.freeze(['--a']) });
  assert.equal(withHidden(start, '--b').ok, true);
  assert.deepEqual(start.hiddenFromSuggestions, ['--a']);
});

test('hiding a bad name or past the count bound is an error value', () => {
  assert.equal(failureCode(withHidden(EMPTY_VARIABLE_VISIBILITY, 'light-100')), 'variables-visibility-name');
  const full = {
    version: 1 as const,
    hiddenFromSuggestions: Array.from({ length: VARIABLE_VISIBILITY_LIMITS.hiddenMax }, (_, index) => `--v${index}`),
  };
  assert.equal(failureCode(withHidden(full, '--one-too-many')), 'variables-visibility-limit');
  assert.equal(withHidden(full, '--v0').ok, true);
  assert.equal(withShown(full, '--v0').ok, true);
});

test('the serialized file is pretty-printed, sorted, de-duplicated and ends in a newline', () => {
  const text = serializeVariableVisibility({ version: 1, hiddenFromSuggestions: ['--b', '--a', '--b'] });
  assert.equal(text, '{\n  "version": 1,\n  "hiddenFromSuggestions": [\n    "--a",\n    "--b"\n  ]\n}\n');
  assert.deepEqual(parseVariableVisibilitySource(text), { ok: true, value: { version: 1, hiddenFromSuggestions: ['--a', '--b'] } });
});

test('serializing refuses what the parser would refuse', () => {
  assert.throws(() => serializeVariableVisibility({ version: 1, hiddenFromSuggestions: ['nope'] }), /every name is a custom property name/);
});

test('the metadata validator refuses a bad variables file and accepts a good one', () => {
  assert.doesNotThrow(() => validateMetadata('variables', JSON.stringify(good)));
  assert.throws(() => validateMetadata('variables', '{broken'), /\.stacki\/variables\.json: not valid JSON/);
  assert.throws(() => validateMetadata('variables', JSON.stringify({ version: 2, hiddenFromSuggestions: [] })), /unsupported version/);
});

test('suggestions drop hidden names but always keep the one applied', () => {
  const hidden = hiddenNameSet({ version: 1, hiddenFromSuggestions: ['--a', '--c'] });
  const candidates = ['--a', '--b', '--c', '--d'];
  assert.deepEqual(suggestionNames(candidates, hidden, undefined), ['--b', '--d']);
  assert.deepEqual(
    suggestionNames(candidates, hidden, '--c'),
    ['--a', '--b', '--c', '--d'].filter((name) => name !== '--a'),
  );
  assert.deepEqual(suggestionNames(candidates, hidden, '--b'), ['--b', '--d']);
  assert.equal(isHiddenFromSuggestions(hidden, '--a'), true);
  assert.equal(isHiddenFromSuggestions(hidden, '--b'), false);
});
