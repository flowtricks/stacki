// Goal: the Secrets wire shapes accept what the panel sends and main answers, and refuse each
// malformed or out-of-bound variant, without ever putting a value into an error message.
// Method: a known-good case per parser, then one known-bad case per rule (types, bounds, unknown
// kinds and codes), and a check that a rejected value's text is absent from the thrown message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENV_LIMITS } from '#dist/shared/properties/envFile.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  SECRETS_FILE_NAMES,
  parseSecretValueReply,
  parseSecretsChange,
  parseSecretsFileName,
  parseSecretsListing,
  parseSecretsResult,
  secretsFileIgnorable,
  secretsFileLoadsAfter,
} from '#dist/shared/properties/secrets.js';

const revision = 'a'.repeat(64);
const listing = {
  file: '.env',
  revision,
  exists: true,
  entries: [{ index: 0, name: 'A', duplicate: false, multiline: false }],
  invalidLines: 0,
  ignore: 'ignored',
};

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

test('files: the four dev files in load order, and nothing else', () => {
  assert.deepEqual(SECRETS_FILE_NAMES, ['.env', '.env.local', '.env.development', '.env.development.local']);
  for (const file of SECRETS_FILE_NAMES) {
    assert.equal(parseSecretsFileName(file), file);
  }
  for (const bad of ['.env.production', '.env.test', '../.env', '/etc/passwd', 'env', '', '.ENV', undefined, 3]) {
    assert.throws(() => parseSecretsFileName(bad), /expected a dev env file name/);
  }
  assert.equal(secretsFileLoadsAfter('.env.local', '.env'), true);
  assert.equal(secretsFileLoadsAfter('.env.development.local', '.env.development'), true);
  assert.equal(secretsFileLoadsAfter('.env', '.env.local'), false);
  assert.equal(secretsFileLoadsAfter('.env', '.env'), false);
  assert.deepEqual(
    SECRETS_FILE_NAMES.filter((file) => !secretsFileIgnorable(file)),
    ['.env.development'],
  );
});

test('listing: a row is overridden only by a file that loads after the listed one', () => {
  const entry = { index: 0, name: 'A', duplicate: false, multiline: false };
  const overridden = parseSecretsListing({ ...listing, entries: [{ ...entry, overriddenBy: '.env.local' }] });
  assert.equal(overridden.entries[0]?.overriddenBy, '.env.local');
  assert.equal('overriddenBy' in (parseSecretsListing(listing).entries[0] ?? {}), false);
  assert.throws(() => parseSecretsListing({ ...listing, file: '.env.production' }));
  assert.throws(() => parseSecretsListing({ ...listing, file: undefined }));
  assert.throws(() => parseSecretsListing({ ...listing, entries: [{ ...entry, overriddenBy: '.env.production' }] }));
  assert.throws(
    () => parseSecretsListing({ ...listing, file: '.env.local', entries: [{ ...entry, overriddenBy: '.env' }] }),
    /overridden only by a file that loads after its own/,
  );
  assert.throws(() => parseSecretsListing({ ...listing, entries: [{ ...entry, overriddenBy: '.env' }] }), /overridden only by a file that loads after its own/);
});

test('channels: payloads for list, read, apply and ignore name the file', () => {
  const site = { projectPath: '/site', file: '.env.local' };
  assert.deepEqual(parseIpcPayload('secrets:list', site), site);
  assert.equal(parseIpcPayload('secrets:read', { ...site, revision, index: 0 }).index, 0);
  assert.equal(parseIpcPayload('secrets:apply', { ...site, revision, change: { kind: 'remove', index: 0 } }).change.kind, 'remove');
  assert.deepEqual(parseIpcPayload('secrets:ignore', site), site);
  assert.throws(() => parseIpcPayload('secrets:read', { ...site, revision: 'short', index: 0 }));
  assert.throws(() => parseIpcPayload('secrets:read', { ...site, revision, index: -1 }));
  assert.throws(() => parseIpcPayload('secrets:apply', { ...site, revision, change: { kind: 'add', name: '', value: '' } }));
  assert.throws(() => parseIpcPayload('secrets:list', {}));
  assert.throws(() => parseIpcPayload('secrets:list', { projectPath: '/site' }));
  assert.throws(() => parseIpcPayload('secrets:list', { projectPath: '/site', file: '../.env' }));
  assert.throws(() => parseIpcPayload('secrets:apply', { projectPath: '/site', file: '.env.production', revision, change: { kind: 'create' } }));
  assert.throws(() => parseIpcPayload('secrets:ignore', { projectPath: '/site', file: '.env.development' }), /not offered for .gitignore/);
});
