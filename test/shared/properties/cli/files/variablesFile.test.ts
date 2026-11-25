// Goal: the registry of .stacki/variables.json holds exactly what the app accepts: a document written the way the app writes it passes the registry and the app's own parser, and documents the app would ignore or refuse are refused by the registry.
// Method: one known-good document through checkValue and refusalOfSource, the empty document through both, then known-bad documents (unknown key, legacy key, wrong type, out of bounds, missing required) through the registry alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRecord } from '#dist/shared/core/record.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { VARIABLES_FILE } from '#dist/shared/properties/cli/files/variablesFile.js';

// JSON.parse answers any; bound to unknown so the checks below narrow it.
const parseText = (text: string): unknown => JSON.parse(text);

const schema = { kind: 'object', fields: VARIABLES_FILE.fields } as const;
const good = { version: 1, hiddenFromSuggestions: ['--light-100', '--tint-100'] };

test('a document written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(checkValue(schema, good, 'variables'), undefined);
  assert.equal(refusalOfSource(VARIABLES_FILE, serializeDocument(VARIABLES_FILE, good)), undefined);
  assert.equal(checkValue(schema, VARIABLES_FILE.empty, 'variables'), undefined);
  assert.equal(refusalOfSource(VARIABLES_FILE, serializeDocument(VARIABLES_FILE, { ...VARIABLES_FILE.empty })), undefined);
});

test('the canonical writer sorts the names', () => {
  const text = serializeDocument(VARIABLES_FILE, { version: 1, hiddenFromSuggestions: ['--b', '--a'] });
  assert.deepEqual(toRecord(parseText(text))?.['hiddenFromSuggestions'], ['--a', '--b']);
});

test('documents the app would ignore or refuse are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown key', { ...good, hidden: [] }],
    ['a wrong type', { version: 1, hiddenFromSuggestions: '--a' }],
    ['a name without the dashes', { version: 1, hiddenFromSuggestions: ['light-100'] }],
    ['a name with a delimiter', { version: 1, hiddenFromSuggestions: ['--a;b'] }],
    ['a name that is too long', { version: 1, hiddenFromSuggestions: [`--${'a'.repeat(127)}`] }],
    ['a duplicate name', { version: 1, hiddenFromSuggestions: ['--a', '--a'] }],
    ['a missing list', { version: 1 }],
    ['a missing version', { hiddenFromSuggestions: [] }],
    ['a wrong version', { version: 2, hiddenFromSuggestions: [] }],
  ];
  for (const [label, document] of bad) {
    assert.notEqual(checkValue(schema, document, 'variables'), undefined, label);
  }
});
