// Goal: the apps lock registry (`.stacki/apps/apps.json`) accepts what the app's own lock parser accepts and refuses what it should not.
// Method: a known-good lock of one app per install source passes the registry check, the app's parser through `refusalOfSource`, and
// the canonical writer; then each known-bad shape (unknown key, wrong type, out-of-bounds value, missing key) is refused by the registry,
// and the parser-level rules the registry cannot state (a duplicate id, a marketplace id that is not the entry id) by `refusalOfSource`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPS_FILE } from '#dist/shared/properties/cli/files/appsFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const SHA = 'a'.repeat(64);
const entry = (id: string, source: Record<string, unknown>): Record<string, unknown> => ({
  id,
  version: '1.2.3',
  sha256: SHA,
  installedAt: '2026-01-02T03:04:05.000Z',
  source,
  autoUpdate: false,
});
const good = {
  version: 1,
  apps: [
    entry('heatmap', { kind: 'file', fileName: 'heatmap.zip' }),
    entry('seo', { kind: 'github', owner: 'acme', repository: 'seo-app', asset: 'seo.zip', tag: 'v1.2.3' }),
    entry('forms', { kind: 'marketplace', id: 'forms', version: '1.2.3' }),
    entry('mine', { kind: 'local' }),
  ],
};
const schema = { kind: 'object', fields: APPS_FILE.fields } as const;
const withEntry = (change: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  apps: [{ ...entry('heatmap', { kind: 'file', fileName: 'heatmap.zip' }), ...change }],
});

test('a lock of every install source passes the registry, the parser and the writer', () => {
  assert.equal(checkValue(schema, good, 'apps'), undefined);
  assert.equal(refusalOfSource(APPS_FILE, serializeDocument(APPS_FILE, good)), undefined);
  assert.equal(checkValue(schema, APPS_FILE.empty, 'apps'), undefined);
  assert.equal(refusalOfSource(APPS_FILE, JSON.stringify(APPS_FILE.empty)), undefined);
  assert.ok(serializeDocument(APPS_FILE, good).endsWith('\n'), 'the writer ends the file with a newline');
});

test('the registry refuses an unknown key, a wrong type and an out-of-bounds value', () => {
  const refused: Array<readonly [string, Record<string, unknown>]> = [
    ['unknown top-level key', { ...good, visibel: true }],
    ['unknown entry key', withEntry({ enabled: true })],
    ['wrong version', { version: 2, apps: [] }],
    ['apps not a list', { version: 1, apps: {} }],
    ['autoUpdate a string', withEntry({ autoUpdate: 'yes' })],
    ['id uppercase', withEntry({ id: 'Heatmap' })],
    ['id too long', withEntry({ id: 'a'.repeat(65) })],
    ['version not semver', withEntry({ version: '1.2' })],
    ['sha256 short', withEntry({ sha256: 'abc' })],
    ['source kind unknown', withEntry({ source: { kind: 'ftp' } })],
    ['github asset not a zip', withEntry({ source: { kind: 'github', owner: 'acme', repository: 'r', asset: 'a.tar', tag: 'v1' } })],
    ['github missing tag', withEntry({ source: { kind: 'github', owner: 'acme', repository: 'r', asset: 'a.zip' } })],
    ['update sha256 bad', withEntry({ update: { version: '1.3.0', tag: 'v1.3.0', sha256: 'zz' } })],
    ['more than 50 apps', { version: 1, apps: Array.from({ length: 51 }, (_, index) => entry(`app${index}`, { kind: 'local' })) }],
  ];
  for (const [name, document] of refused) {
    assert.notEqual(checkValue(schema, document, 'apps'), undefined, name);
  }
});

test('the app parser refuses what the registry cannot state', () => {
  const duplicate = { version: 1, apps: [entry('heatmap', { kind: 'local' }), entry('heatmap', { kind: 'local' })] };
  assert.match(refusalOfSource(APPS_FILE, JSON.stringify(duplicate)) ?? '', /twice/);
  const wrongMarketplace = { version: 1, apps: [entry('heatmap', { kind: 'marketplace', id: 'other', version: '1.2.3' })] };
  assert.notEqual(refusalOfSource(APPS_FILE, JSON.stringify(wrongMarketplace)), undefined);
  assert.notEqual(refusalOfSource(APPS_FILE, JSON.stringify(withEntry({ installedAt: 'yesterday' }))), undefined);
  assert.notEqual(refusalOfSource(APPS_FILE, '{not json'), undefined);
});
