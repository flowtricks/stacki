// Goal: the instructions registry accepts `.stacki/instructions.json` as the app writes it and refuses shapes the app would reject or ignore.
// Method: run a realistic document through the registry check and the app parser (refusalOfSource), then known-bad shapes:
// unknown key, wrong type, over the hidden-path bounds, duplicate paths, missing version.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTRUCTIONS_FILE } from '#dist/shared/properties/cli/files/instructionsFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { INSTRUCTION_LIMITS } from '#dist/shared/properties/instructions.js';

const schema = { kind: 'object', fields: INSTRUCTIONS_FILE.fields } as const;
const good = { version: 1, hidden: ['docs/archive', '**/CHANGELOG.md'] };

test('a document the app writes passes the registry and the parser', () => {
  assert.equal(checkValue(schema, good, 'instructions'), undefined);
  assert.equal(refusalOfSource(INSTRUCTIONS_FILE, serializeDocument(INSTRUCTIONS_FILE, good)), undefined);
  assert.equal(checkValue(schema, INSTRUCTIONS_FILE.empty, 'instructions'), undefined);
});

const bad: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown key', { ...good, hide: [] }],
  ['a wrong type', { version: 1, hidden: 'docs' }],
  ['a wrong item type', { version: 1, hidden: [3] }],
  ['an empty path', { version: 1, hidden: [''] }],
  ['a path over its bound', { version: 1, hidden: ['x'.repeat(INSTRUCTION_LIMITS.patternCharsMax + 1)] }],
  ['too many paths', { version: 1, hidden: Array.from({ length: INSTRUCTION_LIMITS.hiddenMax + 1 }, (_, index) => `p${index}`) }],
  ['a duplicate path', { version: 1, hidden: ['a', 'a'] }],
  ['a missing version', { hidden: [] }],
  ['another version', { version: 2, hidden: [] }],
];
for (const [name, document] of bad) {
  test(`the registry refuses ${name}`, () => {
    assert.notEqual(checkValue(schema, document, 'instructions'), undefined);
  });
}
