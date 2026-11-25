// Goal: welcome-screen IPC data is parsed before it controls cards or project creation.
// Methodology: exercise valid dialog/recent/thumbnail shapes, reject malformed and
// duplicate records, and verify transport failures remain explicit Result values.
const test = require('node:test');
const assert = require('node:assert/strict');
const welcome = require('../../helpers/rendererModule')('src/features/welcome/welcomeBridge.ts');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');

const recent = {
  thumb: undefined,
  stale: true,
  canRefresh: true,
  path: '/project',
  name: 'Project',
  openedAt: 123,
};

test('welcome parsers preserve valid recent, thumbnail, and dialog variants', () => {
  assert.deepEqual(welcome.parseRecentProjects([recent]), [recent]);
  assert.deepEqual(welcome.parseRefreshThumb({ ok: true, thumb: 'data:image/png,x', stale: false }), {
    ok: true,
    thumb: 'data:image/png,x',
    stale: false,
  });
  assert.deepEqual(welcome.parseRefreshThumb({ ok: false, error: 'failed', thumb: undefined, stale: true }), {
    ok: false,
    error: 'failed',
    thumb: undefined,
    stale: true,
  });
  assert.deepEqual(welcome.parseProjectDialog({ canceled: true }), { canceled: true });
  assert.deepEqual(welcome.parseProjectDialog({ canceled: false, error: 'not Astro' }), {
    canceled: false,
    error: 'not Astro',
  });
  assert.deepEqual(welcome.parseProjectDialog({ canceled: false, projectPath: '/project' }), {
    canceled: false,
    projectPath: '/project',
  });
  assert.deepEqual(welcome.parseParentDialog({ canceled: false, parentPath: '/sites' }), {
    canceled: false,
    parentPath: '/sites',
  });
});

test('welcome parsers reject missing, duplicate, invalid, and oversized records', () => {
  for (const value of [
    PLATFORM_NULL,
    [{ ...recent, openedAt: -1 }],
    [{ ...recent, path: 'bad\0path' }],
    [recent, recent],
    // Absence is `undefined` (AGENTS.md §6); main never sends a null thumbnail.
    [{ ...recent, thumb: PLATFORM_NULL }],
    Array(100_001).fill(recent),
  ]) {
    assert.throws(() => welcome.parseRecentProjects(value));
  }
  assert.throws(() => welcome.parseRefreshThumb({ ok: false, thumb: undefined, stale: true }));
  assert.throws(() => welcome.parseProjectDialog({ canceled: false }));
  assert.throws(() => welcome.parseParentDialog({ canceled: false, parentPath: PLATFORM_NULL }));
});

test('welcome operations validate replies and preserve expected transport failures', async () => {
  global.window = {
    avb: {
      listRecents: async () => [recent],
      refreshThumb: async () => ({ ok: true, thumb: undefined, stale: false }),
      removeRecent: async () => {
        throw new Error('disk unavailable');
      },
    },
  };
  assert.equal((await welcome.listRecentProjects()).ok, true);
  assert.equal((await welcome.refreshRecentThumbnail('/project')).ok, true);
  assert.deepEqual(await welcome.removeRecentProject('/project'), {
    ok: false,
    error: 'disk unavailable',
  });
  delete global.window;
});

test('shadcn preset inspection parses the code and rejects malformed IPC replies', async () => {
  const requests = [];
  let reply = { ok: true, value: { iconLibrary: 'remixicon', style: 'nova' } };
  global.window = {
    avb: {
      inspectShadcnPreset: async (request) => {
        requests.push(request);
        return reply;
      },
    },
  };
  try {
    assert.throws(() => welcome.inspectShadcnPreset('--preset'));
    assert.equal(requests.length, 0);
    assert.deepEqual(await welcome.inspectShadcnPreset('b0'), { ok: true, value: reply });
    assert.deepEqual(requests, [{ preset: 'b0' }]);
    reply = { ok: false, error: { message: 'Preset checking is busy.' } };
    assert.deepEqual(await welcome.inspectShadcnPreset('b0'), { ok: true, value: reply });
    reply = { ok: true, value: { iconLibrary: 'unknown', style: 'nova' } };
    await assert.rejects(welcome.inspectShadcnPreset('b0'), /supported shadcn icon library/);
  } finally {
    delete global.window;
  }
});
