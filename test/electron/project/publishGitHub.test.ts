// Goal: a project's GitHub account survives unrelated global CLI account changes.
// Method: intercept the credential lookup, inspect child-only environment overrides, and reject
// malformed credentials without exposing their contents to callers.
import type { ExecFileOptions } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import nodeTools from '#dist/electron/lib/nodeTools.js';
import { publishingGitEnvironment } from '#dist/electron/project/publishGitHub.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';

test('account lookup never changes global credentials', async (context) => {
  const previous = process.env['GH_TOKEN'];
  const calls: unknown[] = [];
  context.mock.method(nodeTools, 'run', async (command: string, argumentsList: readonly string[], root: string, options?: ExecFileOptions) => {
    calls.push({ command, argumentsList, root });
    assert.equal(options?.env?.['GH_TOKEN'], undefined);
    assert.equal(options?.env?.['GITHUB_TOKEN'], undefined);
    return { stdout: 'gho_testcredential123\n', stderr: '' };
  });
  const environment = await publishingGitEnvironment('/project', {
    ...DEFAULT_PUBLISH_CONFIG,
    githubAccount: 'project-owner',
  });
  assert.deepEqual(calls, [
    {
      command: 'gh',
      argumentsList: ['auth', 'token', '--hostname', 'github.com', '--user', 'project-owner'],
      root: '/project',
    },
  ]);
  assert.equal(environment['GH_TOKEN'], 'gho_testcredential123');
  assert.equal(environment['GIT_CONFIG_VALUE_1'], '!gh auth git-credential');
  assert.equal(environment['GIT_CONFIG_VALUE_2'], 'git@github.com:');
  assert.equal(process.env['GH_TOKEN'], previous);
});

test('missing and malformed credentials fail before git is launched', async (context) => {
  context.mock.method(nodeTools, 'run', async () => ({ stdout: 'token\ninjected', stderr: '' }));
  await assert.rejects(
    publishingGitEnvironment('/project', {
      ...DEFAULT_PUBLISH_CONFIG,
      githubAccount: 'project-owner',
    }),
    /invalid credential/,
  );
  context.mock.restoreAll();
  context.mock.method(nodeTools, 'run', async () => {
    throw new Error('secret-value');
  });
  await assert.rejects(
    publishingGitEnvironment('/project', {
      ...DEFAULT_PUBLISH_CONFIG,
      githubAccount: 'project-owner',
    }),
    /Sign in once.*project-owner/,
  );
});
