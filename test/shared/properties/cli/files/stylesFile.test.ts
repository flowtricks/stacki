// Goal: the registry of `.stacki/styles.json` accepts the keep list the Selectors panel writes and refuses what the parser rejects
// or the app would drop (the legacy trustedScripts key).
// Method: a realistic file passes the registry and the app parser, and survives the file's own serializer unchanged in key order;
// known-bad documents (unknown key, legacy key, wrong type, whitespace pattern, absolute path, missing required) are refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STYLES_FILE } from '#dist/shared/properties/cli/files/stylesFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const registryRefusal = (document: unknown): string | undefined => checkValue({ kind: 'object', fields: STYLES_FILE.fields }, document, 'styles');

const good = { version: 1, keep: ['is-*', 'js-open'], lockedStylesheets: ['src/styles/patterns.css', 'src/styles/vendor/'] };

test('a keep list written by the app passes the registry and the app parser', () => {
  assert.equal(registryRefusal(good), undefined);
  assert.equal(refusalOfSource(STYLES_FILE, serializeDocument(STYLES_FILE, good)), undefined);
  assert.equal(serializeDocument(STYLES_FILE, good), `${JSON.stringify(good, undefined, 2)}\n`);
});

test('the empty document passes both', () => {
  assert.equal(registryRefusal(STYLES_FILE.empty), undefined);
  assert.equal(refusalOfSource(STYLES_FILE, serializeDocument(STYLES_FILE, { ...STYLES_FILE.empty })), undefined);
});

test('known-bad documents are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['an unknown key', { ...good, kept: [] }, /unknown key/],
    ['the legacy trustedScripts key', { ...good, trustedScripts: [] }, /unknown key/],
    ['a wrong type', { version: 1, keep: 'is-*' }, /expected a list/],
    ['a wrong version', { version: 2 }, /expected 1/],
    ['a missing version', { keep: [] }, /version: required/],
    ['a pattern with a space', { version: 1, keep: ['is open'] }, /does not match/],
    ['a pattern with a comma', { version: 1, keep: ['a,b'] }, /does not match/],
    ['an overlong pattern', { version: 1, keep: ['a'.repeat(129)] }, /1 to 128/],
    ['too many patterns', { version: 1, keep: Array.from({ length: 1001 }, (_, index) => `c${index}`) }, /at most 1000/],
    ['an absolute locked path', { version: 1, lockedStylesheets: ['/src/a.css'] }, /does not match/],
    ['a backslash locked path', { version: 1, lockedStylesheets: ['src\\a.css'] }, /does not match/],
    ['a duplicate locked path', { version: 1, lockedStylesheets: ['a.css', 'a.css'] }, /unique/],
  ];
  for (const [what, document, reason] of bad) {
    const refusal = registryRefusal(document);
    assert.ok(refusal !== undefined && reason.test(refusal), `${what}: ${String(refusal)}`);
  }
});
