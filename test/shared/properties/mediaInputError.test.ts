// Goal: the media-host form validators fail with a message reference beside the English sentence, and a failure reply keeps a
// well-formed `messageRef` while dropping a malformed one (docs/i18n-playbook.md, "Shared-layer strings").
// Method: one bad URL and one bad bucket through the real parsers (the error carries the key, the field name as a parameter and the
// exact English the panel always showed), then `parseMediaResult` and `parseMediaSaveResult` with a good, a bad-shaped and an absent ref.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMediaConnectionDraft, parseMediaResult, parseMediaSaveResult, parseMediaURL } from '#dist/shared/properties/mediaHosting.js';
import { MediaInputError } from '#dist/shared/properties/mediaInputError.js';

test('a bad URL throws a MediaInputError with a reference and the unchanged English', () => {
  assert.throws(
    () => parseMediaURL('ftp://example.com', 'pull zone URL'),
    (error: unknown) =>
      error instanceof MediaInputError &&
      error.message === 'The pull zone URL must use https (http only for localhost).' &&
      error.messageRef.key === 'assets.input.url.https' &&
      error.messageRef.params?.['what'] === 'pull zone URL',
  );
});

test('a bad bucket name in a draft throws a MediaInputError', () => {
  const draft = {
    kind: 'r2',
    label: 'Media',
    accountId: 'a'.repeat(32),
    bucket: 'X',
    publicBaseUrl: 'https://media.example.com',
    secret: { kind: 'keyPair', accessKeyId: 'AKIA', secretAccessKey: 'secret' },
  };
  assert.throws(
    () => parseMediaConnectionDraft(draft),
    (error: unknown) => error instanceof MediaInputError && error.messageRef.key === 'assets.input.bucket',
  );
});

test('a failure reply keeps a good messageRef and drops a bad one', () => {
  const good = parseMediaResult({ ok: false, message: 'Offline', messageRef: { key: 'assets.request.failed' } }, (value) => value);
  assert.deepEqual(good, { ok: false, message: 'Offline', messageRef: { key: 'assets.request.failed' } });
  const bad = parseMediaResult({ ok: false, message: 'Offline', messageRef: { key: 42 } }, (value) => value);
  assert.deepEqual(bad, { ok: false, message: 'Offline' });
  const absent = parseMediaSaveResult({ ok: false, message: 'Offline' });
  assert.deepEqual(absent, { ok: false, message: 'Offline' });
  const saved = parseMediaSaveResult({ ok: false, message: 'Offline', messageRef: { key: 'assets.request.failed', params: { n: 1 } } });
  assert.deepEqual(saved, { ok: false, message: 'Offline', messageRef: { key: 'assets.request.failed', params: { n: 1 } } });
});
