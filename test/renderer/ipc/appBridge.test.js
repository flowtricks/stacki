// Goal: App's renderer boundary validates the lifecycle, write, and event
// values it receives from preload before the root component can use them.
//
// Methodology: bundle the real TypeScript bridge, drive representative valid
// operations through a preload stub, then corrupt one field in each shape and
// pin the boundary failure. The calls also prove payloads reach preload intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

const bridgeModule = loadRenderer('src/ipc/appBridge.ts');
// A legacy bridge answered a cancelled dialog with null; the parser still reads it as a
// cancellation, so the stub sends null as JSON would carry it.
const legacyCancel = JSON.parse('null');

test('App bridge preserves validated lifecycle and write operations', async () => {
  const calls = [];
  global.window = {
    avb: {
      settings: async () => ({ sound: true }),
      startDevServer: async (payload) => {
        calls.push(['start', payload]);
        return { url: 'http://localhost:4321' };
      },
      openProjectDialog: async () => legacyCancel,
      copySelection: async (payload) => {
        calls.push(['copy', payload]);
        return { ok: true, count: 2 };
      },
      writeSourceText: async (payload) => {
        calls.push(['source', payload]);
        return { ok: true };
      },
      writeAssetText: async (payload) => {
        calls.push(['asset', payload]);
        return { ok: true };
      },
    },
  };

  assert.deepEqual(await bridgeModule.readAppSettings(), { sound: true });
  assert.deepEqual(await bridgeModule.startProjectPreview('/project'), {
    trailingSlash: '',
    url: 'http://localhost:4321',
  });
  assert.deepEqual(await bridgeModule.openProject(), { canceled: true });
  assert.equal(await bridgeModule.copyEditorSelection('/project', ['page|n1']), true);
  await bridgeModule.writeProjectFile('src', '/project', 'src/data.ts', 'export {};');
  await bridgeModule.writeProjectFile('public', '/project', 'data.txt', 'value');

  assert.deepEqual(calls, [
    ['start', '/project'],
    ['copy', { projectPath: '/project', keys: ['page|n1'] }],
    ['source', { projectPath: '/project', rel: 'src/data.ts', text: 'export {};' }],
    ['asset', { projectPath: '/project', rel: 'data.txt', text: 'value' }],
  ]);
});

test('App bridge rejects malformed replies and event values', async () => {
  let pageCallback;
  let soundCallback;
  global.window = {
    avb: {
      settings: async () => ({ sound: 'yes' }),
      dynamicPaths: async () => ({
        entries: [{ params: {}, props: false, route: '/bad', label: 'Bad' }],
      }),
      editPage: async () => ({ ok: false }),
      onPageMaybeChanged: (callback) => {
        pageCallback = callback;
        return () => {};
      },
      onMenu: (_channel, callback) => {
        soundCallback = callback;
        return () => {};
      },
    },
  };

  await assert.rejects(bridgeModule.readAppSettings(), /Expected boolean/);
  await assert.rejects(bridgeModule.readDynamicPaths('/project', '/project/src/pages/[id].astro', ''), /Dynamic route props have an invalid value/);
  // A code save (step 8) is an edit request: a malformed reply is refused...
  const hunk = { span: { start: 0, end: 5 }, expected: 'Hello', text: 'Hi' };
  const codeSave = (authoredChecksum, hunks) =>
    bridgeModule.editProjectPage({
      pagePath: '/project/src/pages/index.astro',
      authoredChecksum,
      edit: { tag: 'code-patch', hunks },
    });
  await assert.rejects(codeSave('a'.repeat(64), [hunk]), /PageEditError: expected object/);
  // ...and a malformed checksum or patch is caught before anything crosses to main.
  assert.throws(() => codeSave('A'.repeat(64), [hunk]), /Digest: expected 64 lowercase hex characters/);
  assert.throws(() => codeSave('a'.repeat(64), [hunk, hunk]), /ascending disjoint spans/);

  let external = false;
  bridgeModule.onPageMaybeChanged((event) => {
    external = event.external;
  });
  pageCallback({ external: true });
  assert.equal(external, true);

  bridgeModule.onSoundSettingChanged(() => {});
  assert.throws(() => soundCallback('yes'), /Expected boolean/);
});

test('preview failures validate URLs before reporting them to recovery', () => {
  let deliver;
  let removed = false;
  const received = [];
  global.window = {
    avb: {
      onPreviewFailed(callback) {
        deliver = callback;
        return () => {
          removed = true;
        };
      },
    },
  };
  const stop = bridgeModule.onPreviewFailed((url) => received.push(url));
  deliver('http://127.0.0.1:4321/#avb-design');
  assert.deepEqual(received, ['http://127.0.0.1:4321/']);
  for (const invalid of [
    42,
    '',
    'file:///tmp/page',
    'https://example.com',
    'http://user:pass@localhost/',
    'http://localhost/' + 'x'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1),
  ]) {
    assert.throws(() => deliver(invalid));
  }
  stop();
  assert.equal(removed, true);
});
