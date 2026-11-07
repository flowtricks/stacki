// Goal: the desktop transport of component photographs parses what the main process answers, and is absent
// where there is no main process.
// Methodology: bundle the transport, give it a fake window.avb, and feed it good and bad answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/desktop-shots.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/features/palette/desktopShots.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { desktopComponentShots } = require(output);

const withBridge = async (bridge, run) => {
  global.window = bridge === undefined ? {} : { avb: bridge };
  try {
    await run();
  } finally {
    delete global.window;
  }
};

test('without a main process there is no source', async () => {
  await withBridge(undefined, () => assert.equal(desktopComponentShots('/site'), undefined));
  await withBridge({}, () => assert.equal(desktopComponentShots('/site'), undefined), 'a bridge from before photographs existed');
});

test('list and read ask for the project and parse the answers', async () => {
  const calls = [];
  const bridge = {
    listComponentShots: async (payload) => {
      calls.push(['list', payload]);
      return { shots: [{ component: '/site/src/components/Hero.astro', width: 1440, height: 800 }] };
    },
    readComponentShot: async (payload) => {
      calls.push(['read', payload]);
      return 'data:image/jpeg;base64,AAAA';
    },
    onComponentShotsChanged: (listener) => {
      calls.push(['subscribe']);
      return () => calls.push(['unsubscribe', listener === undefined]);
    },
  };
  await withBridge(bridge, async () => {
    const source = desktopComponentShots('/site');
    assert.deepEqual(await source.list(), [{ component: '/site/src/components/Hero.astro', width: 1440, height: 800 }]);
    assert.equal(await source.read('/site/src/components/Hero.astro'), 'data:image/jpeg;base64,AAAA');
    source.onChanged(() => {})();
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['list', 'read', 'subscribe', 'unsubscribe'],
  );
  assert.equal(calls[0][1], '/site');
  assert.deepEqual(calls[1][1], { projectPath: '/site', component: '/site/src/components/Hero.astro' });
});

test('negative space: a malformed answer is refused', async () => {
  const bridge = {
    listComponentShots: async () => ({ shots: [{ component: '/a', width: 0, height: 1 }] }),
    readComponentShot: async () => 'data:text/html;base64,AAAA',
    onComponentShotsChanged: () => () => {},
  };
  await withBridge(bridge, async () => {
    const source = desktopComponentShots('/site');
    await assert.rejects(source.list());
    await assert.rejects(source.read('/a'));
  });
  await withBridge({ ...bridge, listComponentShots: async () => ({}), readComponentShot: async () => undefined }, async () => {
    const source = desktopComponentShots('/site');
    await assert.rejects(source.list(), Error, 'an answer without shots is refused');
    assert.equal(await source.read('/a'), undefined);
  });
});
