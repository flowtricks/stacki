// Goal: both hosts accept the same bounded publish settings and reject unsafe command inputs.
// Method: parse round trips, corrupt each boundary, and inspect provider command arguments.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, parsePublishSource, parsePublishTarget } from '#dist/shared/properties/publishConfig.js';
import { savedPublishedSite } from '#dist/shared/properties/publishSite.js';
import { hostingCommand, scriptCommand } from '#dist/shared/properties/publishCommands.js';
import { parseDesktopPublishState } from '#dist/shared/properties/publishState.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const cloudflare = {
  provider: 'cloudflare',
  accountId: 'account123',
  project: 'my-site',
  branch: 'main',
  directory: 'dist',
} as const;

test('project publishing settings round-trip through metadata and IPC', () => {
  const config = {
    ...DEFAULT_PUBLISH_CONFIG,
    githubAccount: 'project-owner',
    hosting: cloudflare,
    beforePublish: ['check'],
    afterPublish: ['search:index', 'cache:purge'],
  };
  const source = JSON.stringify(config);
  assert.deepEqual(parsePublishSource(source), config);
  assert.deepEqual(parsePublishSource(undefined), DEFAULT_PUBLISH_CONFIG);
  assert.doesNotThrow(() => validateMetadata('publish', source));
  for (const target of ['all', 'github', 'hosting']) {
    assert.deepEqual(parseIpcPayload('publish:start', { projectPath: '/site', target }), {
      projectPath: '/site',
      target,
    });
  }
  assert.equal(parseIpcPayload('publish:state', '/site'), '/site');
  assert.throws(() => parseIpcPayload('publish:start', { projectPath: '/site', target: 'shell' }));
  assert.throws(() => parsePublishTarget(undefined));
});

test('malformed settings fail before anything can run', () => {
  const corruptions: readonly unknown[] = [
    undefined,
    {},
    { ...DEFAULT_PUBLISH_CONFIG, version: 2 },
    { ...DEFAULT_PUBLISH_CONFIG, defaultTarget: 'invalid' },
    { ...DEFAULT_PUBLISH_CONFIG, defaultTarget: 1 },
    { ...DEFAULT_PUBLISH_CONFIG, githubAccount: 'owner@example.com' },
    { ...DEFAULT_PUBLISH_CONFIG, githubAccount: 'a'.repeat(40) },
    { ...DEFAULT_PUBLISH_CONFIG, buildScript: '--help' },
    { ...DEFAULT_PUBLISH_CONFIG, beforePublish: ['build && upload'] },
    { ...DEFAULT_PUBLISH_CONFIG, beforePublish: Array.from({ length: 9 }, () => 'build') },
    { ...DEFAULT_PUBLISH_CONFIG, afterPublish: [13] },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'other' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, accountId: '' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, project: '--help' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, directory: '../outside' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, directory: '/outside' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, directory: 'dist/../outside' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, directory: 'dist\\outside' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { ...cloudflare, branch: 'main;echo token' } },
    { ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'vercel', projectId: 'prj_1' } },
  ];
  for (const value of corruptions) {
    assert.throws(() => parsePublishConfig(value), JSON.stringify(value));
  }
  assert.throws(() => parsePublishSource(' '.repeat(16_385)), /16 KiB/);
  assert.throws(() => scriptCommand(''), /must be named/);
  assert.throws(() => scriptCommand('--help'), /cannot be an option/);
});

test('the shared Publish button preference defaults to both and preserves each choice', () => {
  assert.equal(parsePublishSource(undefined).defaultTarget, 'all');
  const { defaultTarget: omitted, ...legacy } = DEFAULT_PUBLISH_CONFIG;
  assert.equal(omitted, 'all');
  assert.equal(parsePublishConfig(legacy).defaultTarget, 'all');
  for (const defaultTarget of ['all', 'github', 'hosting'] as const) {
    const config = { ...DEFAULT_PUBLISH_CONFIG, defaultTarget };
    const source = JSON.stringify(config);
    assert.deepEqual(parsePublishSource(source), config);
    assert.doesNotThrow(() => validateMetadata('publish', source));
  }
});

test('provider commands pin account and project without changing global CLI state', () => {
  assert.deepEqual(hostingCommand(cloudflare), {
    executable: 'wrangler',
    arguments: ['pages', 'deploy', 'dist', '--project-name', 'my-site', '--branch', 'main', '--commit-dirty=true'],
    environment: { CLOUDFLARE_ACCOUNT_ID: 'account123' },
  });
  assert.deepEqual(
    hostingCommand({
      provider: 'vercel',
      projectId: 'prj_123',
      organizationId: 'team_123',
    }),
    {
      executable: 'vercel',
      arguments: ['deploy', '--prod', '--yes'],
      environment: { VERCEL_ORG_ID: 'team_123', VERCEL_PROJECT_ID: 'prj_123' },
    },
  );
  assert.deepEqual(
    parseDesktopPublishState({
      kind: 'failed',
      github: true,
      hosting: false,
      message: 'Deployment failed',
    }),
    { kind: 'failed', github: true, hosting: false, message: 'Deployment failed' },
  );
  assert.throws(() => parseDesktopPublishState({ kind: 'done', github: 'yes', hosting: false }));
  assert.throws(() => parseDesktopPublishState({ kind: 'unknown' }));
});

test('Publishing parses commit messages at the IPC boundary', () => {
  const input = { projectPath: '/project', target: 'github' };
  assert.deepEqual(parseIpcPayload('publish:start', input), input);
  assert.deepEqual(parseIpcPayload('publish:start', { ...input, commitMessage: '  Fix heading  ' }), { ...input, commitMessage: 'Fix heading' });
  for (const commitMessage of ['', '  ', 123, 'x'.repeat(4001)]) {
    assert.throws(() => parseIpcPayload('publish:start', { ...input, commitMessage }));
  }
  assert.equal(
    parseIpcPayload('publish:start', {
      ...input,
      commitMessage: 'x'.repeat(4000),
    }).commitMessage?.length,
    4000,
  );
});

test('Publish progress accepts bounded stage counts and rejects impossible progress', () => {
  const state = { kind: 'running', step: 'Building', progress: { completed: 1, total: 4 } };
  assert.deepEqual(parseDesktopPublishState(state), state);
  assert.deepEqual(parseDesktopPublishState({ kind: 'running', step: 'Preparing' }), {
    kind: 'running',
    step: 'Preparing',
  });
  for (const progress of [
    { completed: -1, total: 4 },
    { completed: 1.5, total: 4 },
    { completed: 4, total: 4 },
    { completed: 5, total: 4 },
    { completed: 0, total: 2 },
    { completed: 0, total: 6 },
    { completed: '1', total: 4 },
    { completed: 0, total: Number.NaN },
  ]) {
    assert.throws(() => parseDesktopPublishState({ ...state, progress }));
  }
  assert.throws(() => parseDesktopPublishState({ ...state, progress: { completed: 4, total: 4 } }), /Running publish progress must be incomplete/);
});

test('Workers keep their Wrangler configuration and require an explicit account when saved', () => {
  const hosting = {
    provider: 'cloudflare-workers',
    accountId: 'account123',
    project: 'website',
  } as const;
  const config = { ...DEFAULT_PUBLISH_CONFIG, hosting };
  assert.deepEqual(parsePublishConfig(config), config);
  assert.deepEqual(hostingCommand(hosting), {
    executable: 'wrangler',
    arguments: ['deploy', '--name', 'website'],
    environment: { CLOUDFLARE_ACCOUNT_ID: 'account123' },
  });
  assert.throws(() => parsePublishConfig({ ...config, hosting: { ...hosting, accountId: '' } }));
  assert.throws(() => parsePublishConfig({ ...config, hosting: { ...hosting, project: '--help' } }));
});

test('published site links round-trip with their destination and reject unsafe metadata', () => {
  const publishedSite = { hosting: cloudflare, source: 'discovered', url: 'https://example.com' };
  const config = { ...DEFAULT_PUBLISH_CONFIG, hosting: cloudflare, publishedSite };
  assert.deepEqual(parsePublishSource(JSON.stringify(config)), config);
  assert.doesNotThrow(() => validateMetadata('publish', JSON.stringify(config)));
  for (const change of [
    { url: 'javascript:alert(1)' },
    { url: 'https://user:password@example.com' },
    { url: 'https://example.com/path' },
    { url: 'https://example.com?query=1' },
    { url: 'https://' + 'x'.repeat(2048) },
    { source: 'other' },
    { hosting: { provider: 'none' } },
    { hosting: { ...cloudflare, accountId: '' } },
  ]) {
    assert.throws(() => parsePublishConfig({ ...config, publishedSite: { ...publishedSite, ...change } }));
  }
});

test('saved links are scoped to the provider account and project', () => {
  const publishedSite = {
    hosting: cloudflare,
    source: 'manual' as const,
    url: 'https://example.com',
  };
  const config = { ...DEFAULT_PUBLISH_CONFIG, hosting: cloudflare, publishedSite };
  assert.equal(savedPublishedSite(config), publishedSite);
  assert.equal(savedPublishedSite(DEFAULT_PUBLISH_CONFIG), undefined);
  for (const hosting of [
    { ...cloudflare, accountId: 'other' },
    { ...cloudflare, project: 'other' },
    {
      provider: 'cloudflare-workers',
      accountId: cloudflare.accountId,
      project: cloudflare.project,
    },
    { provider: 'none' },
  ] as const) {
    assert.equal(savedPublishedSite({ ...config, hosting }), undefined);
  }
});
