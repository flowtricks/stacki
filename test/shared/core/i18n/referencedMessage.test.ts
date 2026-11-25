// Goal: a message reference travels inside an error's text across a boundary that keeps only the message (Electron IPC rejections), and
// comes back out intact, while text without a valid reference is never mangled.
// Method: round trip a reference with and without params, then feed each malformed tail (not JSON, wrong shape, bad key, oversized).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_SEPARATOR, referenceOfError, splitReferencedMessage, withReferencedMessage } from '#dist/shared/core/i18n/referencedMessage.js';

test('a reference round trips behind the English sentence', () => {
  const reference = { key: 'git.error.deleteFailed', params: { branch: 'main', count: 2 } };
  const text = withReferencedMessage('Could not delete "main".', reference);
  assert.equal(text.startsWith('Could not delete "main".'), true);
  assert.deepEqual(splitReferencedMessage(text), { message: 'Could not delete "main".', messageRef: reference });
});

test('no reference leaves the message alone', () => {
  assert.equal(withReferencedMessage('Plain.', undefined), 'Plain.');
  assert.deepEqual(splitReferencedMessage('Plain.'), { message: 'Plain.', messageRef: undefined });
});

test('every malformed tail is dropped and the English sentence survives', () => {
  const tails = ['not json', '[]', '{}', '{"key":3}', '{"key":"nodot"}', `{"key":"a.b","params":{"x":${'1'.repeat(200_000)}}}`];
  for (const tail of tails) {
    assert.deepEqual(splitReferencedMessage(`Sentence.${REFERENCE_SEPARATOR}${tail}`), { message: 'Sentence.', messageRef: undefined }, tail.slice(0, 40));
  }
});

test('a thrown value exposes its reference only when well formed', () => {
  const error = Object.assign(new Error('English.'), { messageRef: { key: 'git.error.deleteFailed', params: { branch: 'x' } } });
  assert.deepEqual(referenceOfError(error), { key: 'git.error.deleteFailed', params: { branch: 'x' } });
  assert.equal(referenceOfError(Object.assign(new Error('English.'), { messageRef: { key: 3 } })), undefined);
  assert.equal(referenceOfError(new Error('English.')), undefined);
  assert.equal(referenceOfError('English.'), undefined);
});
