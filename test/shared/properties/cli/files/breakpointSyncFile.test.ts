// Goal: the registry of .stacki/breakpoint-sync.json holds exactly what the app accepts: a document written the way the app writes it passes the registry and the app's own parser, and documents the app would ignore or refuse are refused by the registry.
// Method: one known-good document through checkValue and refusalOfSource, the empty document through both, then known-bad documents (unknown key, legacy key, wrong type, out of bounds, missing required) through the registry alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { BREAKPOINT_SYNC_FILE } from '#dist/shared/properties/cli/files/breakpointSyncFile.js';

const schema = { kind: 'object', fields: BREAKPOINT_SYNC_FILE.fields } as const;

const good = {
  version: 1,
  laptop: {
    excluded: [{ file: 'src/pages/index.astro', locator: '2d535645:0' }],
    linked: [{ file: 'src/styles/site.css', locator: 'a0446607:1' }],
    appliedAt: '2026-11-15T12:00:00.000Z',
  },
  'bp-1': { excluded: [{ file: 'src/a.css', locator: '00000000:12' }] },
};

test('a document written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(checkValue(schema, good, 'sync'), undefined);
  assert.equal(refusalOfSource(BREAKPOINT_SYNC_FILE, serializeDocument(BREAKPOINT_SYNC_FILE, good)), undefined);
  assert.equal(checkValue(schema, BREAKPOINT_SYNC_FILE.empty, 'sync'), undefined);
  assert.equal(refusalOfSource(BREAKPOINT_SYNC_FILE, serializeDocument(BREAKPOINT_SYNC_FILE, { ...BREAKPOINT_SYNC_FILE.empty })), undefined);
});

test('documents the app would ignore or refuse are refused by the registry', () => {
  const place = { file: 'src/a.css', locator: '2d535645:0' };
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown key in an entry', { version: 1, laptop: { excluded: [], skipped: [] } }],
    ['an unknown key in a place', { version: 1, laptop: { excluded: [{ ...place, line: 3 }] } }],
    ['a wrong type', { version: 1, laptop: { excluded: 'src/a.css' } }],
    ['a file path that leaves the project', { version: 1, laptop: { excluded: [{ ...place, file: '../a.css' }] } }],
    ['an absolute file path', { version: 1, laptop: { excluded: [{ ...place, file: '/a.css' }] } }],
    ['a backslash in a file path', { version: 1, laptop: { excluded: [{ ...place, file: 'src\\a.css' }] } }],
    ['a locator that is not a locator', { version: 1, laptop: { linked: [{ ...place, locator: 'abc' }] } }],
    ['a timestamp without Z', { version: 1, laptop: { appliedAt: '2026-11-15T12:00:00' } }],
    ['a missing file in a place', { version: 1, laptop: { excluded: [{ locator: '2d535645:0' }] } }],
    ['a missing version', { laptop: {} }],
    ['a wrong version', { version: 2 }],
    [
      'too many places',
      { version: 1, laptop: { excluded: Array.from({ length: 2001 }, (_, index) => ({ file: `src/${index}.css`, locator: '2d535645:0' })) } },
    ],
    ['a duplicate place', { version: 1, laptop: { excluded: [place, place] } }],
  ];
  for (const [label, document] of bad) {
    assert.notEqual(checkValue(schema, document, 'sync'), undefined, label);
  }
});
