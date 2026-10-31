// Goal: a CMS request that fails for want of a network says so in words a person can act on,
// rather than fetch's own "fetch failed", and any other failure keeps its own message.
// Method: the failures fetch and AbortSignal.timeout really throw are passed to the formatter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { failureMessage } = require('#dist/electron/handlers/cmsConnectionHandlers.js');

test('offline and timed-out requests read as connection problems', () => {
  assert.match(failureMessage(new TypeError('fetch failed')), /internet connection/);
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.match(failureMessage(timeout), /took too long/);
});

test('other failures keep their message, and an empty one gets a fallback', () => {
  assert.equal(failureMessage(new Error('Document not found')), 'Document not found');
  assert.equal(failureMessage(new Error('')), 'The CMS request failed.');
  assert.equal(failureMessage('plain'), 'plain');
});
