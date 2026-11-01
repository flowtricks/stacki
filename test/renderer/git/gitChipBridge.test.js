// Goal: every GitChip IPC call validates its payload and response before UI
// state can use it. Methodology: parse every response variant, exercise each
// checkout mode through a scripted bridge, and separate transport from contract failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bridge = require('../../helpers/rendererModule')('src/features/git/gitChipBridge.ts');
const { repoPath } = require('../../helpers/sources.js');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const status = {
  path: 'src/pages/index.astro',
  from: undefined,
  status: 'M',
  staged: false,
  untracked: false,
  kind: 'page',
  label: 'Home',
};
const switched = {
  ok: true,
  restored: false,
  parkedFrom: undefined,
  from: 'main',
  parked: false,
};
const blocked = {
  ok: false,
  blocked: true,
  from: 'main',
  branch: 'topic',
  files: ['src/pages/index.astro'],
};

test('GitChip parsers cover status and checkout variants', () => {
  assert.deepEqual(bridge.parseGitStatus([status]), [status]);
  assert.deepEqual(bridge.parseGitCheckout(switched), switched);
  assert.deepEqual(bridge.parseGitCheckout({ ...switched, error: 'restore failed' }), {
    ...switched,
    error: 'restore failed',
  });
  assert.deepEqual(bridge.parseGitCheckout(blocked), blocked);
  for (const value of [jsonNull, {}, [{ ...status, kind: 'mystery' }], [{ ...status, staged: 'no' }], Array(100001).fill(status)]) {
    assert.throws(() => bridge.parseGitStatus(value));
  }
  for (const value of [
    jsonNull,
    {},
    { ...blocked, blocked: false },
    { ...switched, parkedFrom: 1 },
    // Absence is `undefined` (AGENTS.md §6): main never sends a null origin.
    { ...switched, parkedFrom: jsonNull },
    { ...blocked, files: Array(100001).fill('file') },
  ]) {
    assert.throws(() => bridge.parseGitCheckout(value));
  }
});

test('GitChip operations forward validated payloads for each action mode', async () => {
  const calls = [];
  global.window = {
    avb: {
      gitStatus: async (payload) => {
        calls.push(['status', payload]);
        return [status];
      },
      gitCheckout: async (payload) => {
        calls.push(['checkout', payload]);
        return switched;
      },
      gitCommit: async (payload) => {
        calls.push(['commit', payload]);
        return { ok: true, files: 1 };
      },
      gitInit: async (payload) => {
        calls.push(['init', payload]);
        return { ok: true };
      },
      gitPull: async (payload) => {
        calls.push(['pull', payload]);
        return { ok: true, into: 'main', changed: false };
      },
      gitPush: async (payload) => {
        calls.push(['push', payload]);
        return { ok: true };
      },
      gitResolveMerge: async (payload) => {
        calls.push(['resolve', payload]);
        return { ok: true, into: 'main', changed: true };
      },
    },
  };
  assert.equal((await bridge.readGitStatus('/project')).ok, true);
  assert.equal((await bridge.checkoutGitBranch('/project', 'topic', { kind: 'switch' })).ok, true);
  assert.equal((await bridge.checkoutGitBranch('/project', 'new', { kind: 'create' })).ok, true);
  assert.equal((await bridge.checkoutGitBranch('/project', 'topic', { kind: 'park' })).ok, true);
  assert.equal((await bridge.commitGitChanges('/project', 'Update', ['src/a.astro'])).ok, true);
  assert.equal((await bridge.initializeGit('/project')).ok, true);
  assert.equal((await bridge.pushGitBranch('/project', 'main')).ok, true);
  assert.equal((await bridge.pullGitBranch('/project', 'main')).ok, true);
  assert.equal((await bridge.resolveGitMerge('/project', 'topic', { 'a.astro': 'ours' })).ok, true);
  assert.deepEqual(calls, [
    ['status', { projectPath: '/project' }],
    ['checkout', { projectPath: '/project', branch: 'topic' }],
    ['checkout', { projectPath: '/project', branch: 'new', create: true }],
    ['checkout', { projectPath: '/project', branch: 'topic', parkFirst: true }],
    ['commit', { projectPath: '/project', message: 'Update', paths: ['src/a.astro'] }],
    ['init', '/project'],
    ['push', { projectPath: '/project', branch: 'main' }],
    ['pull', { projectPath: '/project', branch: 'main' }],
    ['resolve', { projectPath: '/project', branch: 'topic', choices: { 'a.astro': 'ours' } }],
  ]);
});

test('GitChip transport failures are values and malformed replies throw', async () => {
  global.window = {
    avb: {
      gitPush: async () => {
        throw new Error('offline');
      },
    },
  };
  assert.deepEqual(await bridge.pushGitBranch('/project', 'main'), {
    ok: false,
    error: 'offline',
  });
  global.window = { avb: { gitPush: async () => ({ ok: false }) } };
  await assert.rejects(bridge.pushGitBranch('/project', 'main'), /expected success/i);
  assert.throws(() => bridge.checkoutGitBranch('/project\0bad', 'topic', { kind: 'switch' }), /NUL/);
});

test('GitChip routes every direct Git operation through the parsed bridge', () => {
  const source = fs.readFileSync(repoPath('src/features/git/GitChip.tsx'), 'utf8');
  assert.doesNotMatch(source, /window\.avb\.git(?:Info|Status|Checkout|Commit|Init|Push|ResolveMerge)/);
  for (const operation of ['readGitStatus', 'checkoutGitBranch', 'commitGitChanges', 'initializeGit', 'resolveGitMerge']) {
    assert.match(source, new RegExp(`\\b${operation}\\(`));
  }
});

test('Pull validates requests, response variants and failures', async () => {
  global.window = { avb: { gitPull: async () => ({ ok: true, changed: 'yes' }) } };
  await assert.rejects(bridge.pullGitBranch('/project', 'main'), /boolean/i);
  assert.throws(() => bridge.pullGitBranch('/project', 1));
  assert.throws(() => bridge.pullGitBranch('/project', 'a'.repeat(BOUNDARY_LIMITS.textLengthMax + 1)));
  assert.throws(() => bridge.pullGitBranch('/project\0bad', 'main'), /NUL/);
  const dirty = { ok: false, dirty: true, from: 'main', branch: 'origin/main', files: ['a'] };
  global.window.avb.gitPull = async () => dirty;
  assert.deepEqual(await bridge.pullGitBranch('/project', 'main'), { ok: true, value: dirty });
  global.window.avb.gitPull = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await bridge.pullGitBranch('/project', 'main'), { ok: false, error: 'offline' });
});

test('Incoming counts parse bounded integers and distinguish offline from zero', async () => {
  const requests = [];
  global.window = {
    avb: {
      gitIncoming: async (payload) => {
        requests.push(payload);
        return 0;
      },
    },
  };
  assert.deepEqual(await bridge.readIncomingGitCommits('/project', 'main'), { ok: true, value: 0 });
  assert.deepEqual(requests, [{ projectPath: '/project', branch: 'main' }]);
  for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', undefined]) {
    window.avb.gitIncoming = async () => count;
    await assert.rejects(bridge.readIncomingGitCommits('/project', 'main'));
  }
  window.avb.gitIncoming = async () => {
    throw new Error('Offline');
  };
  assert.deepEqual(await bridge.readIncomingGitCommits('/project', 'main'), {
    ok: false,
    error: 'Offline',
  });
  assert.throws(() => bridge.readIncomingGitCommits('/project', undefined));
});
