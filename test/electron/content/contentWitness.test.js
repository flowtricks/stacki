// Goal: direct canvas CMS edits never overwrite a newer entry or neighboring records.
// Method: write real JSON through the document actor, then replay stale entry witnesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeEntry } = require('#dist/electron/content/contentEntries.js');
const { parseIpcPayload } = require('#dist/shared/ipc/ipcPayloads.js');

test('CMS text writes preserve other records and reject stale snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-text-cms-'));
  try {
    const file = path.join(root, 'entries.json');
    const original = '[\n  {"title": "Hello"},\n  {"title": "Neighbor"}\n]\n';
    fs.writeFileSync(file, original);
    const entry = { file: 'entries.json', locator: [0] };
    const expected = { data: { title: 'Hello' } };
    writeEntry(root, entry, [{ path: ['title'], value: 'New title' }], { expected });
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(saved, original.replace('Hello', 'New title'));
    assert.throws(() => writeEntry(root, entry, [{ path: ['title'], value: 'Stale edit' }], { expected }), /Content changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.throws(() => writeEntry(root, { ...entry, locator: [10] }, [], { expected }), /Content changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('content write boundary preserves expected data and rejects malformed witnesses', () => {
  const input = {
    projectPath: '/site',
    entry: { file: 'entry.json', locator: [] },
    edits: [{ path: ['title'], value: 'New' }],
    expected: { data: { title: 'Old' } },
  };
  assert.deepEqual(parseIpcPayload('content:writeEntry', input).expected.data, { title: 'Old' });
  assert.throws(() => parseIpcPayload('content:writeEntry', { ...input, expected: 'invalid' }));
});
