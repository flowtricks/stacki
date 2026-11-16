// Goal: the app settings registry (`.stacki/apps/settings.json`) accepts what the app's own settings parser accepts and refuses what it should not.
// Method: a known-good file with two apps passes the registry check, the app's parser through `refusalOfSource` and the canonical writer;
// then each known-bad shape (unknown top-level key, wrong type, bad app or setting id, over-long value, too many entries) is refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_SETTINGS_FILE } from '#dist/shared/properties/cli/files/appSettingsFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const clean: Record<string, unknown> = { version: 1, apps: { seo: { 'site-url': 'https://example.com', note: 'hello' }, forms: { region: 'eu' } } };
const schema = { kind: 'object', fields: APP_SETTINGS_FILE.fields } as const;

test('a settings file passes the registry, the parser and the writer', () => {
  assert.equal(checkValue(schema, clean, 'settings'), undefined);
  assert.equal(refusalOfSource(APP_SETTINGS_FILE, serializeDocument(APP_SETTINGS_FILE, clean)), undefined);
  assert.equal(checkValue(schema, APP_SETTINGS_FILE.empty, 'settings'), undefined);
  assert.equal(refusalOfSource(APP_SETTINGS_FILE, JSON.stringify(APP_SETTINGS_FILE.empty)), undefined);
});

test('the registry refuses an unknown key, a wrong type and an out-of-bounds value', () => {
  const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`app${index}`, {}]));
  const refused: Array<readonly [string, Record<string, unknown>]> = [
    ['unknown top-level key', { ...clean, secrets: {} }],
    ['wrong version', { version: 2, apps: {} }],
    ['apps a list', { version: 1, apps: [] }],
    ['app values a list', { version: 1, apps: { seo: [] } }],
    ['value a number', { version: 1, apps: { seo: { note: 5 } } }],
    ['app id uppercase', { version: 1, apps: { Seo: {} } }],
    ['setting id uppercase', { version: 1, apps: { seo: { Note: 'x' } } }],
    ['value over 4096 characters', { version: 1, apps: { seo: { note: 'x'.repeat(4097) } } }],
    ['more than 16 settings', { version: 1, apps: { seo: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`s${index}`, 'x'])) } }],
    ['more than 50 apps', { version: 1, apps: tooMany }],
  ];
  for (const [name, document] of refused) {
    assert.notEqual(checkValue(schema, document, 'settings'), undefined, name);
  }
});

test('the app parser refuses what the registry cannot state', () => {
  assert.notEqual(refusalOfSource(APP_SETTINGS_FILE, '{not json'), undefined);
  assert.notEqual(refusalOfSource(APP_SETTINGS_FILE, JSON.stringify({ version: 2, apps: {} })), undefined);
  assert.notEqual(refusalOfSource(APP_SETTINGS_FILE, JSON.stringify({ version: 1, apps: { 'Bad Id': { a: 'b' } } })), undefined);
});
