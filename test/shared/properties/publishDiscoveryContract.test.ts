// Goal: discovery accepts only bounded provider choices and never trusts provider or IPC data.
// Method: round-trip valid destinations, then corrupt identifiers, arrays, kinds and path fields.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiscoveryRequest, parsePublishDiscovery } from '#dist/shared/properties/publishDiscovery.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const ready = {
  kind: 'ready',
  accounts: [{ id: 'team_123', name: 'My team' }],
  projects: [
    {
      name: 'Website',
      hosting: { provider: 'vercel', organizationId: 'team_123', projectId: 'prj_123' },
    },
  ],
};
test('provider discovery round-trips through the shared IPC contract', () => {
  const request = { provider: 'vercel', account: 'team_123' };
  assert.deepEqual(parseDiscoveryRequest(request), request);
  assert.deepEqual(parseIpcPayload('publish:discover', { projectPath: '/site', request }), {
    projectPath: '/site',
    request,
  });
  assert.deepEqual(parsePublishDiscovery(ready), ready);
  assert.deepEqual(parsePublishDiscovery({ kind: 'failed', reason: 'signed-out', message: 'Sign in first.' }), {
    kind: 'failed',
    reason: 'signed-out',
    message: 'Sign in first.',
  });
  for (const input of [
    undefined,
    {},
    { provider: 'shell', account: '' },
    { provider: 'cloudflare', account: '--help' },
    { provider: 'vercel', account: '../outside' },
    { provider: 'github', account: 'a'.repeat(101) },
  ]) {
    assert.throws(() => parseDiscoveryRequest(input));
  }
});
test('discovery rejects malformed destinations and resource excess', () => {
  for (const input of [
    undefined,
    {},
    { kind: 'idle' },
    { ...ready, accounts: Array.from({ length: 501 }, () => ({ id: 'id', name: 'Account' })) },
    { ...ready, accounts: [{ id: 'team', name: 'a'.repeat(513) }] },
    { ...ready, projects: [{ name: 'Bad', hosting: { provider: 'other' } }] },
    {
      ...ready,
      projects: [
        {
          name: 'Bad',
          hosting: {
            provider: 'cloudflare',
            accountId: 'id',
            project: 'project',
            branch: 'main',
            directory: '../outside',
          },
        },
      ],
    },
    { kind: 'failed', reason: 'signed-out', message: 123 },
    // A failure must say why, so the panel can offer the matching fix.
    { kind: 'failed', message: 'Sign in first.' },
    { kind: 'failed', reason: 'offline', message: 'Sign in first.' },
  ]) {
    assert.throws(() => parsePublishDiscovery(input));
  }
});
