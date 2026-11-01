// Goal: GitHub publishing validates both directions of IPC and stops at the
// first expected failure. Methodology: drive the real workflow with a scripted
// preload bridge, verify ordering and payloads, then corrupt each wire reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGitCommit, parseGitInfo, parseGitPublish, parseGitSuccess } = require('../../helpers/rendererModule')('src/features/git/gitChipBridge.ts');
const { publishGitProject } = require('../../helpers/rendererModule')('src/features/git/gitPublishWorkflow.ts');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const cleanInfo = {
  isRepo: true,
  branch: 'main',
  branches: ['main'],
  remote: undefined,
  dirty: false,
  ahead: 0,
  parked: [],
};
const published = { ok: true, url: 'https://github.com/person/project', output: 'created' };

test('Git publish response parsers reject malformed and oversized data', () => {
  assert.deepEqual(parseGitInfo(cleanInfo), cleanInfo);
  assert.deepEqual(parseGitInfo({ isRepo: false }), { isRepo: false });
  assert.deepEqual(parseGitCommit({ ok: true, files: 2 }), { ok: true, files: 2 });
  assert.deepEqual(parseGitPublish(published), published);
  assert.equal(parseGitSuccess({ ok: true }), undefined);
  for (const value of [
    jsonNull,
    {},
    { ...cleanInfo, ahead: -1 },
    { ...cleanInfo, branch: 1 },
    // Absence is `undefined` (AGENTS.md §6): main never sends a null remote.
    { ...cleanInfo, remote: jsonNull },
    { ...cleanInfo, branches: Array(100001).fill('main') },
  ]) {
    assert.throws(() => parseGitInfo(value));
  }
  assert.throws(() => parseGitCommit({ ok: true, files: -1 }));
  assert.throws(() => parseGitPublish({ ok: true, url: jsonNull }));
  assert.throws(() => parseGitSuccess({ ok: false }));
});

test('clean publishing skips the initial commit and forwards validated payloads', async () => {
  const calls = [];
  const steps = [];
  global.window = {
    avb: {
      gitInfo: async (projectPath) => {
        calls.push(['info', projectPath]);
        return cleanInfo;
      },
      gitPublish: async (payload) => {
        calls.push(['publish', payload]);
        return published;
      },
    },
  };
  const result = await publishGitProject('/project', {
    kind: 'new',
    repoName: 'project',
    isPrivate: true,
    onStep: (step) => steps.push(step),
  });
  assert.deepEqual(result, { ok: true, value: published.url });
  assert.deepEqual(steps, ['Creating repository and pushing…']);
  assert.deepEqual(calls, [
    ['info', '/project'],
    ['publish', { projectPath: '/project', repoName: 'project', isPrivate: true }],
  ]);
});

test('dirty publishing commits before creating the repository', async () => {
  const calls = [];
  const steps = [];
  global.window = {
    avb: {
      gitInfo: async () => ({ ...cleanInfo, dirty: true }),
      gitCommit: async (payload) => {
        calls.push(['commit', payload]);
        return { ok: true, files: undefined };
      },
      gitPublish: async (payload) => {
        calls.push(['publish', payload]);
        return published;
      },
    },
  };
  const result = await publishGitProject('/project', {
    kind: 'new',
    repoName: 'project',
    isPrivate: false,
    onStep: (step) => steps.push(step),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(steps, ['Committing changes…', 'Creating repository and pushing…']);
  assert.deepEqual(calls, [
    ['commit', { projectPath: '/project', message: 'Initial commit from Stacki' }],
    ['publish', { projectPath: '/project', repoName: 'project', isPrivate: false }],
  ]);
});

test('expected publish failures are values and stop later operations', async () => {
  const request = { kind: 'new', repoName: 'project', isPrivate: true, onStep() {} };
  global.window = {
    avb: {
      gitInfo: async () => {
        throw new Error('cannot inspect');
      },
    },
  };
  assert.deepEqual(await publishGitProject('/project', request), {
    ok: false,
    error: 'cannot inspect',
  });

  let publishedAfterCommit = false;
  global.window = {
    avb: {
      gitInfo: async () => ({ ...cleanInfo, dirty: true }),
      gitCommit: async () => {
        throw new Error('cannot commit');
      },
      gitPublish: async () => {
        publishedAfterCommit = true;
        return published;
      },
    },
  };
  assert.deepEqual(await publishGitProject('/project', request), {
    ok: false,
    error: 'cannot commit',
  });
  assert.equal(publishedAfterCommit, false);

  global.window = {
    avb: {
      gitInfo: async () => cleanInfo,
      gitPublish: async () => {
        throw new Error('cannot publish');
      },
    },
  };
  assert.deepEqual(await publishGitProject('/project', request), {
    ok: false,
    error: 'cannot publish',
  });
});

test('invalid requests and contract bugs remain loud', async () => {
  let called = false;
  global.window = {
    avb: {
      gitInfo: async () => {
        called = true;
        return cleanInfo;
      },
    },
  };
  assert.deepEqual(
    await publishGitProject('/project', {
      kind: 'new',
      repoName: ' ',
      isPrivate: true,
      onStep() {},
    }),
    { ok: false, error: 'Enter a repository name.' },
  );
  assert.equal(called, false);
  await assert.rejects(
    publishGitProject('x'.repeat(32769), {
      kind: 'new',
      repoName: 'project',
      isPrivate: true,
      onStep() {},
    }),
    /Path exceeds limit/,
  );
  global.window = { avb: { gitInfo: async () => ({ ...cleanInfo, ahead: 'zero' }) } };
  await assert.rejects(
    publishGitProject('/project', {
      kind: 'new',
      repoName: 'project',
      isPrivate: true,
      onStep() {},
    }),
    /Expected number/,
  );
});

test('existing destination connects without creating a new repository', async () => {
  const calls = [];
  global.window = {
    avb: {
      gitInfo: async () => cleanInfo,
      gitConnect: async (payload) => {
        calls.push(payload);
        return published;
      },
      gitPublish: async () => {
        throw new Error('Must not create a repository');
      },
    },
  };
  assert.deepEqual(
    await publishGitProject('/project', {
      kind: 'existing',
      repository: 'owner/site',
      onStep() {},
    }),
    { ok: true, value: published.url },
  );
  assert.deepEqual(calls, [{ projectPath: '/project', repository: 'owner/site' }]);
});
