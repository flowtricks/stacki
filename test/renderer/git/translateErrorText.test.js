// Goal: error text from the main process shows in the language on screen when it carries a reference we know, and as received otherwise.
// Method: a fake translator stands in for the catalog; known references translate, unknown keys, bad params and plain text fall back to English.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');
const { withReferencedMessage } = require('#dist/shared/core/i18n/referencedMessage.js');
const { translateErrorText, translateFailure, translateReference } = loadRenderer('src/lib/i18n/translateErrorText.ts');
const { cleanError, failureOf } = loadRenderer('src/lib/cleanError.ts');

const translate = (key, params) => {
  if (key === 'git.error.deleteFailed') {
    return `es:${params.branch}`;
  }
  throw new Error('bad params');
};
const wire = (message, reference) => `Error invoking remote method 'git:deleteBranch': Error: ${withReferencedMessage(message, reference)}`;

test('a known reference translates and an unknown one shows the English', () => {
  assert.equal(translateReference('English.', { key: 'git.error.deleteFailed', params: { branch: 'b' } }, translate), 'es:b');
  assert.equal(translateReference('English.', { key: 'nope.nothing' }, translate), 'English.');
  assert.equal(translateReference('English.', undefined, translate), 'English.');
});

test('a reference whose parameters do not fit falls back to the English', () => {
  assert.equal(translateReference('English.', { key: 'git.error.mergeFailed', params: {} }, translate), 'English.');
});

test('failures from the bridge keep the reference and cleanError hides it', () => {
  const error = new Error(wire('English.', { key: 'git.error.deleteFailed', params: { branch: 'b' } }));
  assert.equal(cleanError(error), 'English.');
  const failure = failureOf(error);
  assert.deepEqual(failure, { ok: false, error: 'English.', errorRef: { key: 'git.error.deleteFailed', params: { branch: 'b' } } });
  assert.equal(translateFailure(failure, translate), 'es:b');
  assert.equal(translateErrorText(withReferencedMessage('English.', failure.errorRef), translate), 'es:b');
});

test('git’s own text is shown as received', () => {
  const failure = failureOf(new Error("Error invoking remote method 'git:merge': Error: fatal: not a git repository"));
  assert.deepEqual(failure, { ok: false, error: 'fatal: not a git repository' });
  assert.equal(translateFailure(failure, translate), 'fatal: not a git repository');
});
