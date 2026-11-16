// Goal: a site Stacki creates starts with `newStyleTag.isGlobal` on, and nothing else in
// `.stacki/styles.json` is lost; a site that never goes through creation keeps the legacy default.
// Method: real folders under the OS temp directory: an empty site, a site whose starter shipped a
// styles file (keep list and a locked stylesheet), one that already chose a scoped tag, and an
// unreadable file that must be left byte for byte. The pure rule is checked on its own too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeNewProjectDefaults } from '#dist/electron/project/newProjectDefaults.js';
import { LEGACY_NEW_STYLE_TAG } from '#dist/shared/properties/newStyleTag.js';
import { newProjectStylesSource, parseStyleKeepList } from '#dist/shared/properties/styleKeepList.js';

const site = (content?: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-new-site-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(directory, '.stacki'));
    fs.writeFileSync(path.join(directory, '.stacki', 'styles.json'), content);
  }
  return directory;
};
const read = (directory: string): string => fs.readFileSync(path.join(directory, '.stacki', 'styles.json'), 'utf8');

test('a new site gets isGlobal on and no template', () => {
  const directory = site();
  assert.deepEqual(writeNewProjectDefaults(directory), { written: true });
  const settings = parseStyleKeepList(JSON.parse(read(directory))).newStyleTag;
  assert.deepEqual(settings, { scope: 'global', content: '' });
});

test('a starter that shipped a styles file keeps its keep list and locks', () => {
  const directory = site(JSON.stringify({ version: 1, keep: ['is-*'], lockedStylesheets: ['src/styles/vendor/'] }));
  writeNewProjectDefaults(directory);
  const parsed = parseStyleKeepList(JSON.parse(read(directory)));
  assert.deepEqual(parsed.keep, ['is-*']);
  assert.deepEqual(parsed.lockedStylesheets, ['src/styles/vendor/']);
  assert.equal(parsed.newStyleTag?.scope, 'global');
});

test('a choice already written is kept, and an unreadable file is never overwritten', () => {
  const chosen = JSON.stringify({ version: 1, keep: [], newStyleTag: { version: 1, isGlobal: false, content: '@layer a {}' } });
  const directory = site(chosen);
  writeNewProjectDefaults(directory);
  assert.deepEqual(parseStyleKeepList(JSON.parse(read(directory))).newStyleTag, { scope: 'scoped', content: '@layer a {}' });
  const broken = site('{ not json');
  const outcome = writeNewProjectDefaults(broken);
  assert.equal(outcome.written, false);
  assert.equal(read(broken), '{ not json');
  assert.equal(newProjectStylesSource('{ "version": 2 }'), undefined);
});

test('a site that never went through creation reads as the legacy behaviour', () => {
  assert.equal(parseStyleKeepList({ version: 1, keep: [] }).newStyleTag ?? LEGACY_NEW_STYLE_TAG, LEGACY_NEW_STYLE_TAG);
});
