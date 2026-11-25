// Goal: app settings (shared/properties/appSettings.ts) accept exactly the
// declarations docs/apps.md describes, with the marketplace Worker's bounds: at
// most 16, ids `^[a-z][a-z0-9_-]*$` up to 64 characters and unique, labels 1 to
// 60 characters, descriptions up to 280, kind text, secret or url, required and
// advanced booleans that default to false. Values are checked against the declarations; the required ones that
// are empty are "missing"; secrets split away from the values the project file
// keeps; the settings file round-trips within its bound.
// Method: a known-good declaration, then one bad field at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_SETTINGS_LIMITS,
  missingRequiredSettings,
  parseAppSettingDeclarations,
  parseAppSettingValues,
  parseAppSettingsFileSource,
  serializeAppSettingsFile,
  splitAppSettingValues,
} from '#dist/shared/properties/appSettings.js';
import { APP_LIMITS, parseAppId, parseAppManifest } from '#dist/shared/properties/apps.js';

const KEY = { id: 'api-key', label: 'API key', kind: 'secret', required: true };
const URL_SETTING = { id: 'endpoint', label: 'Endpoint', kind: 'url' };

test('a declaration parses with its defaults', () => {
  assert.deepEqual(parseAppSettingDeclarations([KEY, URL_SETTING]), [
    { id: 'api-key', label: 'API key', description: undefined, kind: 'secret', required: true, placeholder: undefined, advanced: false },
    { id: 'endpoint', label: 'Endpoint', description: undefined, kind: 'url', required: false, placeholder: undefined, advanced: false },
  ]);
  assert.deepEqual(parseAppSettingDeclarations(undefined), []);
});

test('advanced is a boolean that defaults to false', () => {
  assert.equal(parseAppSettingDeclarations([{ ...URL_SETTING, advanced: true }])[0]?.advanced, true);
  assert.equal(parseAppSettingDeclarations([{ ...URL_SETTING, advanced: false }])[0]?.advanced, false);
  assert.equal(parseAppSettingDeclarations([URL_SETTING])[0]?.advanced, false);
  for (const advanced of ['yes', 1, 0, {}]) {
    assert.throws(() => parseAppSettingDeclarations([{ ...URL_SETTING, advanced }]), /Setting endpoint: advanced is true or false/, String(advanced));
  }
});

test('each bad declaration is refused', () => {
  const bad: readonly (readonly [unknown, RegExp])[] = [
    [{}, /is a list/],
    [[{ ...KEY, id: 'Api' }], /must start with a letter/],
    [[{ ...KEY, id: '1key' }], /must start with a letter/],
    [[{ ...KEY, id: 'k'.repeat(APP_SETTINGS_LIMITS.idCharsMax + 1) }], /1 to 64/],
    [[{ ...KEY, label: '' }], /label is empty/],
    [[{ ...KEY, label: 'l'.repeat(61) }], /exceeds 60/],
    [[{ ...KEY, description: 'd'.repeat(281) }], /exceeds 280/],
    [[{ ...KEY, kind: 'password' }], /text, secret or url/],
    [[{ ...KEY, required: 'yes' }], /true or false/],
    [[KEY, KEY], /share an id/],
    [Array.from({ length: APP_SETTINGS_LIMITS.settingsMax + 1 }, (_, index) => ({ ...KEY, id: `k${index}` })), /at most 16/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseAppSettingDeclarations(input), message, JSON.stringify(input).slice(0, 80));
  }
  assert.equal(parseAppSettingDeclarations(Array.from({ length: 16 }, (_, index) => ({ ...KEY, id: `k${index}` }))).length, 16);
});

test('the manifest carries its settings', () => {
  const manifest = parseAppManifest({ manifestVersion: 1, id: 'heat-map', name: 'Heat map', version: '1.0.0', entry: 'index.html', settings: [KEY] });
  assert.equal(manifest.settings[0]?.id, 'api-key');
  assert.throws(() => parseAppManifest({ manifestVersion: 1, id: 'heat-map', name: 'Heat map', version: '1.0.0', entry: 'index.html', settings: 'x' }), /list/);
});

test('values are checked against the declarations; empty is unset', () => {
  const declarations = parseAppSettingDeclarations([KEY, URL_SETTING]);
  assert.deepEqual(parseAppSettingValues({ 'api-key': 'abc', endpoint: ' https://example.test/api ' }, declarations), {
    'api-key': 'abc',
    endpoint: 'https://example.test/api',
  });
  assert.deepEqual(parseAppSettingValues({ endpoint: '' }, declarations), {});
  assert.throws(() => parseAppSettingValues({ other: 'x' }, declarations), /declares no setting/);
  assert.throws(() => parseAppSettingValues({ endpoint: 'ftp://x' }, declarations), /https/);
  assert.throws(() => parseAppSettingValues({ endpoint: 'not a url' }, declarations), /web address/);
  assert.throws(() => parseAppSettingValues({ 'api-key': 'x'.repeat(APP_SETTINGS_LIMITS.valueCharsMax + 1) }, declarations), /exceeds/);
});

test('missing settings are the required ones without a value', () => {
  const declarations = parseAppSettingDeclarations([KEY, URL_SETTING]);
  assert.deepEqual(
    missingRequiredSettings(declarations, {}).map((setting) => setting.id),
    ['api-key'],
  );
  assert.deepEqual(missingRequiredSettings(declarations, { 'api-key': 'k' }), []);
});

test('secrets never land among the project file’s values', () => {
  const declarations = parseAppSettingDeclarations([KEY, URL_SETTING]);
  const split = splitAppSettingValues(declarations, { 'api-key': 'secret', endpoint: 'https://example.test' });
  assert.deepEqual(split.plain, { endpoint: 'https://example.test' });
  assert.deepEqual(split.secret, { 'api-key': 'secret' });
});

test('the settings file round-trips, sorted, and refuses bad shapes', () => {
  const source = serializeAppSettingsFile({ version: 1, apps: { zeta: { b: '2', a: '1' }, alpha: { url: 'https://x.test' }, empty: {} } });
  assert.equal(
    source,
    '{\n  "version": 1,\n  "apps": {\n    "alpha": {\n      "url": "https://x.test"\n    },\n    "zeta": {\n      "a": "1",\n      "b": "2"\n    }\n  }\n}\n',
  );
  assert.deepEqual(parseAppSettingsFileSource(source, parseAppId).apps['zeta'], { a: '1', b: '2' });
  assert.throws(() => parseAppSettingsFileSource('{"version":2,"apps":{}}', parseAppId), /version/);
  assert.throws(() => parseAppSettingsFileSource('{"version":1,"apps":{"Bad App":{}}}', parseAppId), /lowercase/);
  assert.throws(() => parseAppSettingsFileSource('x'.repeat(APP_SETTINGS_LIMITS.fileBytesMax + 1), parseAppId), /exceeds/);
  assert.equal(APP_SETTINGS_LIMITS.appsMax, APP_LIMITS.appsMax, 'The settings file names at most the installed apps');
});
