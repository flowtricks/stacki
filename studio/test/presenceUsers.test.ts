import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceUsers, otherPresenceUsers } from '../src/features/collaboration/presenceUsers';

test('multiple tabs share one avatar per GitHub user without mutating connections', () => {
  const peers = [
    { id: 'tab-a', githubId: 123, name: 'editor' },
    { id: 'tab-b', githubId: 123, name: 'editor' },
    { id: 'tab-c', githubId: 456, name: 'editor' },
  ];
  assert.deepEqual(presenceUsers(peers), [peers[0], peers[2]]);
  assert.equal(peers.length, 3);
  assert.deepEqual(presenceUsers(peers.slice(1)), [peers[1], peers[2]]);
  assert.deepEqual(presenceUsers(peers.slice(2)), [peers[2]]);
  assert.deepEqual(presenceUsers([]), []);
});

test('local editors with the same display name remain separate', () => {
  const peers = [
    { id: 'tab-a', name: 'Editor' },
    { id: 'tab-b', name: 'Editor' },
    { id: 'tab-c', name: 'Editor', githubId: 123 },
  ];
  assert.deepEqual(presenceUsers(peers), peers);
});

test('collaborator outlines exclude every connection owned by the signed-in account', () => {
  const peers = [
    { id: 'self', githubId: 123, updatedAt: 10 },
    { id: 'self-other-tab', githubId: 123, updatedAt: 30 },
    { id: 'other-old', githubId: 456, updatedAt: 5 },
    { id: 'other', githubId: 456, updatedAt: 20 },
  ];
  assert.deepEqual(otherPresenceUsers(peers, 'self', 123), [peers[3]]);
  assert.deepEqual(otherPresenceUsers(peers.slice(1), 'self', 123), [peers[3]], 'The viewer does not need to be present in the current peer snapshot');
  assert.deepEqual(otherPresenceUsers(peers, 'reconnected-self', 123), [peers[3]], 'An old connection must not become a collaborator after reconnecting');
  assert.deepEqual(otherPresenceUsers(peers, '', 123), [peers[3]], 'Account identity excludes self even before the socket handshake');
});

test('local overlays wait for a self identity and do not hide other people with the same name', () => {
  const peers = [
    { id: 'self', name: 'Editor' },
    { id: 'other', name: 'Editor' },
  ];
  assert.deepEqual(otherPresenceUsers(peers, ''), []);
  assert.deepEqual(otherPresenceUsers(peers, 'self'), [peers[1]]);
});
