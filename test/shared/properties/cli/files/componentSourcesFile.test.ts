// Goal: the registry of `.stacki/component-sources.json` accepts a package list the app reads and refuses what its parser rejects.
// Method: a realistic two-package file passes the registry and the app parser; known-bad documents (unknown key, wrong type,
// bad package name, import prefix without a trailing slash, too many sources, missing required) are refused by the registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPONENT_SOURCES_FILE } from '#dist/shared/properties/cli/files/componentSourcesFile.js';
import { refusalOfSource } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const registryRefusal = (document: unknown): string | undefined => checkValue({ kind: 'object', fields: COMPONENT_SOURCES_FILE.fields }, document, 'sources');

const source = { kind: 'package', package: '@acme/ui', directory: 'src/components', importPrefix: '@acme/ui/components/' };
const good = { version: 1, sources: [source, { kind: 'package', package: 'plain-ui', directory: 'lib', importPrefix: 'plain-ui/' }] };

test('a package list passes the registry and the app parser', () => {
  assert.equal(registryRefusal(good), undefined);
  assert.equal(refusalOfSource(COMPONENT_SOURCES_FILE, JSON.stringify(good, undefined, 2)), undefined);
});

test('the empty document passes both', () => {
  assert.equal(registryRefusal(COMPONENT_SOURCES_FILE.empty), undefined);
  assert.equal(refusalOfSource(COMPONENT_SOURCES_FILE, JSON.stringify(COMPONENT_SOURCES_FILE.empty)), undefined);
});

test('known-bad documents are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['an unknown top-level key', { ...good, packages: [] }, /unknown key/],
    ['an unknown source key', { version: 1, sources: [{ ...source, alias: 'x' }] }, /unknown key/],
    ['a wrong type', { version: 1, sources: 'x' }, /expected a list/],
    ['a wrong kind', { version: 1, sources: [{ ...source, kind: 'local' }] }, /expected "package"/],
    ['a missing directory', { version: 1, sources: [{ kind: 'package', package: 'a', importPrefix: 'a/' }] }, /directory: required/],
    ['a missing sources list', { version: 1 }, /sources: required/],
    ['an uppercase package name', { version: 1, sources: [{ ...source, package: 'Acme' }] }, /does not match/],
    ['an import prefix with no trailing slash', { version: 1, sources: [{ ...source, importPrefix: '@acme/ui' }] }, /does not match/],
    ['a directory that climbs out', { version: 1, sources: [{ ...source, directory: '../x' }] }, /does not match/],
    ['more than sixteen sources', { version: 1, sources: Array.from({ length: 17 }, () => source) }, /at most 16/],
  ];
  for (const [what, document, reason] of bad) {
    const refusal = registryRefusal(document);
    assert.ok(refusal !== undefined && reason.test(refusal), `${what}: ${String(refusal)}`);
  }
});
