// Goal: the Secrets wire shapes accept what the panel sends and main answers, and refuse each
// malformed or out-of-bound variant, without ever putting a value into an error message.
// Method: a known-good case per parser, then one known-bad case per rule (types, bounds, unknown
// kinds and codes), and a check that a rejected value's text is absent from the thrown message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENV_LIMITS } from '#dist/shared/properties/envFile.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseSecretValueReply, parseSecretsChange, parseSecretsListing, parseSecretsResult } from '#dist/shared/properties/secrets.js';

const revision = 'a'.repeat(64);
const listing = { revision, exists: true, entries: [{ index: 0, name: 'A', duplicate: false, multiline: false }], invalidLines: 0, ignore: 'ignored' };

test('changes: known-good shapes parse', () => {
  assert.deepEqual(parseSecretsChange({ kind: 'add', name: 'A_1', value: '' }), { kind: 'add', name: 'A_1', value: '' });
  assert.deepEqual(parseSecretsChange({ kind: 'update', index: 2, name: 'B', value: 'x' }), { kind: 'update', index: 2, name: 'B', value: 'x' });
  assert.equal(parseSecretsChange({ kind: 'update', index: 0, name: 'B' }).kind, 'update');
  assert.deepEqual(parseSecretsChange({ kind: 'remove', index: 0 }), { kind: 'remove', index: 0 });
  assert.deepEqual(parseSecretsChange({ kind: 'create' }), { kind: 'create' });
});

test('changes: each known-bad shape throws, and never quotes the value', () => {
  const bad: readonly unknown[] = [
    undefined,
    'add',
    { kind: 'nope' },
    { kind: 'add', name: '1A', value: 'x' },
    { kind: 'add', name: '', value: 'x' },
    { kind: 'add', name: 'x'.repeat(ENV_LIMITS.nameCharsMax + 1), value: 'x' },
    { kind: 'add', name: 'A' },
    { kind: 'add', name: 'A', value: 5 },
    { kind: 'add', name: 'A', value: 'a\nb' },
    { kind: 'add', name: 'A', value: 'a\0b' },
    { kind: 'add', name: 'A', value: 'x'.repeat(ENV_LIMITS.valueBytesMax + 1) },
    { kind: 'update', index: -1, name: 'A' },
    { kind: 'update', index: 1.5, name: 'A' },
    { kind: 'update', index: ENV_LIMITS.entriesMax, name: 'A' },
    { kind: 'remove' },
    { kind: 'remove', index: '0' },
  ];
  for (const input of bad) {
    assert.throws(
      () => parseSecretsChange(input),
      (error: unknown) => error instanceof Error && !error.message.includes('hunter2'),
    );
  }
  assert.throws(
    () => parseSecretsChange({ kind: 'add', name: 'A', value: 'hunter2\n' }),
    (error: unknown) => error instanceof Error && !error.message.includes('hunter2'),
  );
});

test('listing, value and result parsers', () => {
  assert.equal(parseSecretsListing(listing).entries.length, 1);
  assert.throws(() => parseSecretsListing({ ...listing, ignore: 'maybe' }));
  assert.throws(() => parseSecretsListing({ ...listing, revision: 'xyz' }));
  assert.throws(() => parseSecretsListing({ ...listing, exists: 'yes' }));
  assert.throws(() => parseSecretsListing({ ...listing, invalidLines: -1 }));
  assert.throws(() => parseSecretsListing({ ...listing, entries: [{ index: 1, name: 'A', duplicate: false, multiline: false }] }));
  assert.throws(() => parseSecretsListing({ ...listing, entries: [{ index: 0, name: 'A', duplicate: 1, multiline: false }] }));
  assert.throws(() => parseSecretsListing({ ...listing, entries: Array.from({ length: ENV_LIMITS.entriesMax + 1 }, () => ({})) }));
  assert.deepEqual(parseSecretValueReply({ value: 'v' }), { value: 'v' });
  assert.throws(() => parseSecretValueReply({ value: 3 }));
  assert.equal(parseSecretsResult({ ok: true, value: { value: 'v' } }, parseSecretValueReply).ok, true);
  const failed = parseSecretsResult({ ok: false, error: { code: 'changed', message: 'm' } }, parseSecretValueReply);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, 'changed');
  assert.throws(() => parseSecretsResult({ ok: false, error: { code: 'weird', message: 'm' } }, parseSecretValueReply));
  assert.throws(() => parseSecretsResult({ ok: 'maybe' }, parseSecretValueReply));
});

test('channels: payloads for list, read, apply and ignore', () => {
  assert.deepEqual(parseIpcPayload('secrets:list', { projectPath: '/site' }), { projectPath: '/site' });
  assert.equal(parseIpcPayload('secrets:read', { projectPath: '/site', revision, index: 0 }).index, 0);
  assert.equal(parseIpcPayload('secrets:apply', { projectPath: '/site', revision, change: { kind: 'remove', index: 0 } }).change.kind, 'remove');
  assert.deepEqual(parseIpcPayload('secrets:ignore', { projectPath: '/site' }), { projectPath: '/site' });
  assert.throws(() => parseIpcPayload('secrets:read', { projectPath: '/site', revision: 'short', index: 0 }));
  assert.throws(() => parseIpcPayload('secrets:read', { projectPath: '/site', revision, index: -1 }));
  assert.throws(() => parseIpcPayload('secrets:apply', { projectPath: '/site', revision, change: { kind: 'add', name: '', value: '' } }));
  assert.throws(() => parseIpcPayload('secrets:list', {}));
});
