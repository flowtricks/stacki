// Goal: `.stacki/breakpoint-sync.json` holds only bounded, canonical lists of places per breakpoint; every other shape is an error
// value (never a throw), equal records are equal bytes, and the file is never invented for an empty record.
// Method: parse the known-good file and each bad shape (not JSON, wrong version, extra keys at every level, bad paths including
// `..`, absolute and backslash, bad locators, bad timestamps, wrong types, lists past the bound); round-trip through the
// serializer; check sorting, deduplication, and that a record with nothing in it serializes to the bare version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SYNC_RECORD,
  SYNC_RECORD_LIMITS,
  entryOf,
  canonicalRefs,
  isProjectPath,
  parseBreakpointSyncRecord,
  parseBreakpointSyncSource,
  recordsEqual,
  serializeBreakpointSyncRecord,
  withEntry,
} from '#dist/shared/properties/breakpointSyncRecord.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const good = {
  version: 1,
  laptop: {
    excluded: [{ file: 'src/pages/index.astro', locator: '2d535645:0' }],
    linked: [{ file: 'src/styles/site.css', locator: 'a0446607:1' }],
    appliedAt: '2026-11-15T12:00:00.000Z',
  },
};

function failureCode(result: ReturnType<typeof parseBreakpointSyncRecord>): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error.code;
}

test('a missing file is the empty record, and the empty record writes the bare version', () => {
  assert.deepEqual(parseBreakpointSyncSource(undefined), { ok: true, value: EMPTY_SYNC_RECORD });
  assert.equal(serializeBreakpointSyncRecord(EMPTY_SYNC_RECORD), '{\n  "version": 1\n}\n');
});

test('the known-good file parses and keeps its places and time', () => {
  const parsed = parseBreakpointSyncSource(JSON.stringify(good));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? entryOf(parsed.value, 'laptop').excluded : [], good.laptop.excluded);
  assert.equal(parsed.ok ? entryOf(parsed.value, 'laptop').appliedAt : '', good.laptop.appliedAt);
  assert.deepEqual(parsed.ok ? entryOf(parsed.value, 'tablet') : undefined, { excluded: [], linked: [], appliedAt: undefined });
});

test('round trip is byte-stable, sorted and deduplicated', () => {
  const messy = {
    version: 1,
    phone: {
      excluded: [
        { file: 'src/b.astro', locator: '00000001:0' },
        { file: 'src/a.astro', locator: '00000002:0' },
        { file: 'src/b.astro', locator: '00000001:0' },
      ],
    },
  };
  const parsed = parseBreakpointSyncSource(JSON.stringify(messy));
  assert.equal(parsed.ok, true);
  const text = serializeBreakpointSyncRecord(parsed.ok ? parsed.value : EMPTY_SYNC_RECORD);
  assert.ok(text.indexOf('src/a.astro') < text.indexOf('src/b.astro'));
  assert.equal(text.split('src/b.astro').length - 1, 1);
  const again = parseBreakpointSyncSource(text);
  assert.equal(serializeBreakpointSyncRecord(again.ok ? again.value : EMPTY_SYNC_RECORD), text);
  assert.equal(text.endsWith('\n'), true);
});

test('shapes that are not this file are refused', () => {
  assert.equal(failureCode(parseBreakpointSyncRecord([])), 'breakpoint-sync-shape');
  assert.equal(failureCode(parseBreakpointSyncRecord({ version: 2 })), 'breakpoint-sync-version');
  assert.equal(failureCode(parseBreakpointSyncRecord({ ...good, 'Not An Id': {} })), 'breakpoint-sync-shape');
  assert.equal(parseBreakpointSyncRecord({ ...good, 'bp-1': { linked: [] } }).ok, true, 'a breakpoint the project added has an entry too');
  assert.equal(failureCode(parseBreakpointSyncRecord({ version: 1, laptop: { extra: [] } })), 'breakpoint-sync-shape');
  assert.equal(failureCode(parseBreakpointSyncRecord({ version: 1, laptop: [] })), 'breakpoint-sync-shape');
  assert.equal(failureCode(parseBreakpointSyncRecord({ version: 1, laptop: { excluded: 'x' } })), 'breakpoint-sync-shape');
  assert.equal(
    failureCode(parseBreakpointSyncRecord({ version: 1, laptop: { excluded: [{ file: 'a.css', locator: '00000001:0', note: 1 }] } })),
    'breakpoint-sync-shape',
  );
  assert.equal(failureCode(parseBreakpointSyncSource('{ "version": 1, ')), 'breakpoint-sync-unreadable');
  assert.equal(failureCode(parseBreakpointSyncSource('x'.repeat(SYNC_RECORD_LIMITS.fileBytesMax + 1))), 'breakpoint-sync-limit');
});

test('paths, locators and times are checked', () => {
  const withPlace = (file: unknown, locator: unknown) => parseBreakpointSyncRecord({ version: 1, tablet: { linked: [{ file, locator }] } });
  for (const file of ['', '/abs.css', '../up.css', 'a/../b.css', 'a\\b.css', 'a//b.css', './a.css', 5, undefined]) {
    assert.equal(failureCode(withPlace(file, '00000001:0')), 'breakpoint-sync-file', String(file));
  }
  for (const locator of ['', 'zz:0', '00000001', '00000001:x', '2d535645:0000000', 5, undefined]) {
    assert.equal(failureCode(withPlace('a.css', locator)), 'breakpoint-sync-locator', String(locator));
  }
  for (const appliedAt of ['yesterday', '2026-11-15', '2026-13-45T00:00:00Z', 5]) {
    assert.equal(failureCode(parseBreakpointSyncRecord({ version: 1, phone: { appliedAt } })), 'breakpoint-sync-timestamp', String(appliedAt));
  }
  assert.equal(isProjectPath('src/pages/index.astro'), true);
  assert.equal(isProjectPath('a'.repeat(SYNC_RECORD_LIMITS.fileCharsMax + 1)), false);
});

test('a list past the bound is refused, and serializing past it is a programmer error', () => {
  const many = Array.from({ length: SYNC_RECORD_LIMITS.refsMax + 1 }, (_, index) => ({ file: `f${index}.css`, locator: '00000001:0' }));
  assert.equal(failureCode(parseBreakpointSyncRecord({ version: 1, laptop: { excluded: many } })), 'breakpoint-sync-limit');
  const over = { laptop: { excluded: many, linked: [], appliedAt: undefined } };
  assert.throws(() => serializeBreakpointSyncRecord(over), /Assertion failed: serializeBreakpointSyncRecord/);
  const kept = withEntry(EMPTY_SYNC_RECORD, 'laptop', { excluded: many, linked: [], appliedAt: undefined });
  assert.equal(entryOf(kept, 'laptop').excluded.length, SYNC_RECORD_LIMITS.refsMax, 'withEntry keeps the newest places within the bound');
});

test('records compare by bytes, and canonical lists drop duplicates', () => {
  assert.equal(recordsEqual(EMPTY_SYNC_RECORD, EMPTY_SYNC_RECORD), true);
  const one = withEntry(EMPTY_SYNC_RECORD, 'phone', { excluded: [{ file: 'a.css', locator: '00000001:0' }], linked: [], appliedAt: undefined });
  assert.equal(recordsEqual(EMPTY_SYNC_RECORD, one), false);
  assert.equal(canonicalRefs([...entryOf(one, 'phone').excluded, ...entryOf(one, 'phone').excluded]).length, 1);
});

test('the metadata transport validates the file before any write', () => {
  assert.doesNotThrow(() => validateMetadata('breakpointSync', JSON.stringify(good)));
  assert.throws(
    () => validateMetadata('breakpointSync', JSON.stringify({ version: 1, laptop: { excluded: [{ file: '../x', locator: '00000001:0' }] } })),
    /project-relative/,
  );
  assert.throws(() => validateMetadata('breakpointSync', 'nope'), /not valid JSON/);
});
