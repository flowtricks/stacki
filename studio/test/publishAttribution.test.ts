// Goal: a person who is not a GitHub person is named in the commit message, safely; a GitHub person's commit is unchanged.
// Method: table tests of the message for every provider's identity, and hostile identities (newlines, trailer forgery,
// control characters, over-long values) that must never add a line, a trailer or unbounded text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISH_COMMIT_SUBJECT, publishCommitMessage } from '../src/features/publishing/publishAttribution';

test('non-GitHub editors are named in one footer line; GitHub editors and absent ones change nothing', () => {
  assert.equal(publishCommitMessage(undefined), PUBLISH_COMMIT_SUBJECT);
  assert.equal(publishCommitMessage('github:octocat'), PUBLISH_COMMIT_SUBJECT);
  for (const identity of ['google:a@b.com', 'oidc:a@b.com', 'access:a@b.com', 'passkey:client-acme']) {
    assert.equal(publishCommitMessage(identity), `${PUBLISH_COMMIT_SUBJECT}\n\nEdited by ${identity} via Stacki Studio`);
  }
});

test('hostile identities never add a line, a trailer or unbounded text', () => {
  for (const hostile of [
    'google:a@b.com\nCo-authored-by: Boss <boss@x.com>',
    'google:a b',
    'google:\u0000',
    '',
    'x',
    'google:' + 'a'.repeat(300),
    'GOOGLE:a',
    'google:a,b',
  ]) {
    const message = publishCommitMessage(hostile);
    assert.equal(message, PUBLISH_COMMIT_SUBJECT, JSON.stringify(hostile).slice(0, 40));
  }
  const longest = publishCommitMessage(`passkey:${'a'.repeat(200)}`);
  assert.equal(longest.split('\n').length, 3);
  assert.ok(longest.length < 400);
  assert.ok(!/co-authored-by/i.test(publishCommitMessage('google:a@b.com')), 'no trailer a host would interpret as another author');
});
