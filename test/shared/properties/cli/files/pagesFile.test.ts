// Goal: the registry of `.stacki/pages.json` accepts the order the Pages panel writes and refuses what the parser rejects.
// Method: a realistic order (files and trailing-slash folders) passes the registry and the app parser; known-bad documents
// (unknown key, wrong type, duplicate entry, backslash path, missing required) are refused by the registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAGES_FILE } from '#dist/shared/properties/cli/files/pagesFile.js';
import { refusalOfSource } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const registryRefusal = (document: unknown): string | undefined => checkValue({ kind: 'object', fields: PAGES_FILE.fields }, document, 'pages');

const good = { version: 1, entries: ['index.astro', 'blog/', 'blog/first-post.md', 'about.mdx'] };

test('an order written by the Pages panel passes the registry and the app parser', () => {
  assert.equal(registryRefusal(good), undefined);
  assert.equal(refusalOfSource(PAGES_FILE, `${JSON.stringify(good, undefined, 2)}\n`), undefined);
});

test('the empty document passes both', () => {
  assert.equal(registryRefusal(PAGES_FILE.empty), undefined);
  assert.equal(refusalOfSource(PAGES_FILE, JSON.stringify(PAGES_FILE.empty)), undefined);
});

test('known-bad documents are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['an unknown key', { ...good, order: [] }, /unknown key/],
    ['a wrong type', { version: 1, entries: 'index.astro' }, /expected a list/],
    ['an entry of the wrong type', { version: 1, entries: [3] }, /expected text/],
    ['a wrong version', { version: 2, entries: [] }, /expected 1/],
    ['a missing entries list', { version: 1 }, /entries: required/],
    ['a duplicate entry', { version: 1, entries: ['a.astro', 'a.astro'] }, /unique/],
    ['a backslash path', { version: 1, entries: ['blog\\post.md'] }, /does not match/],
    ['an empty entry', { version: 1, entries: [''] }, /1 to 1024/],
    ['an overlong entry', { version: 1, entries: [`${'a'.repeat(1030)}.astro`] }, /1 to 1024/],
  ];
  for (const [what, document, reason] of bad) {
    const refusal = registryRefusal(document);
    assert.ok(refusal !== undefined && reason.test(refusal), `${what}: ${String(refusal)}`);
  }
});
