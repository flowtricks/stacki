// Goal: a project plugin that also loads .astro files never costs the canvas its
// markers. Vite serves a module from the first plugin whose `load` returns
// source, and a plugin written as `load: { order: 'pre', handler }` (the shape
// component-navigator and outline integrations use, added by an Astro
// integration so it comes after the config's own plugins) sorts ahead of a
// bare `load` even when both are enforce:'pre'. The marker plugin was bare, so
// on such a project (a Lumos scaffold with a navigator integration) no file
// carried a stamp, and every canvas click ended in "The canvas isn't showing
// src/pages/index.astro". Marking must win the first load of a project file.
// Method: write the real preview config into a temporary project with the
// windowless main harness, import it as Astro would, and run its plugins in a
// real Vite server's plugin container beside competing plugins shaped like the
// ones projects ship. Each case asks the container for the page and reads what
// it served: Stacki's stamp present, the competitor's output absent, and
// everything else (files outside src/, virtual modules) still the competitor's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE = '<main><h1>Home</h1></main>\n';
const COMPETITOR_SOURCE = '<main data-nav-source="competitor"></main>';

// A competitor that claims every .astro file under src/ the way the
// navigator integration does: enforce:'pre' and an ordered `load`.
const claimingPlugin = (name = 'navigator-source-markers') => ({
  name,
  enforce: 'pre',
  load: {
    order: 'pre',
    handler(id) {
      return id.endsWith('.astro') && !id.includes('node_modules') ? COMPETITOR_SOURCE : undefined;
    },
  },
});

// A project with the generated config imported, and a Vite server running its
// plugins followed by `competitors` (the order an integration's plugins get).
async function serve(competitors) {
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const { createServer } = await import('vite');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-competing-')));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'src', 'pages', 'index.astro'), PAGE);
  const harness = mainHarness(path.join(root, 'user'));
  const configPath = harness.call('writeMarkerConfig', root);
  assert.equal(typeof configPath, 'string', 'the generated config parses');
  const config = (await import(pathToFileURL(configPath).href)).default;
  const markers = config.vite.plugins.find((candidate) => candidate.name === 'avb-node-markers');
  assert.ok(markers, 'the config carries the marker plugin');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, ws: false, watch: { ignored: ['**/*'] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [markers, ...competitors],
  });
  const load = async (relative) => {
    const result = await server.environments.ssr.pluginContainer.load(path.join(root, ...relative.split('/')));
    if (typeof result === 'string') {
      return result;
    }
    return typeof result === 'object' && result !== undefined && 'code' in result ? result.code : undefined;
  };
  const dispose = async () => {
    await server.close();
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { load, dispose, root };
}

test('an ordered competing load does not take the page from the marker plugin', async () => {
  const { load, dispose } = await serve([claimingPlugin()]);
  try {
    const served = await load('src/pages/index.astro');
    assert.match(served ?? '', /<!--avb-d:[0-9a-f]{64}:src\/pages\/index\.astro-->/, 'the page carries its stamp');
    assert.match(served ?? '', /<!--avb-s:0-->/, 'and its node markers');
    assert.doesNotMatch(served ?? '', /competitor/, 'the competitor never served the page');
  } finally {
    await dispose();
  }
});

test('two competing plugins, ordered and bare, still leave the page marked', async () => {
  const bare = { name: 'bare-loader', enforce: 'pre', load: (id) => (id.endsWith('.astro') ? COMPETITOR_SOURCE : undefined) };
  const { load, dispose } = await serve([claimingPlugin('first'), bare, claimingPlugin('second')]);
  try {
    assert.match((await load('src/pages/index.astro')) ?? '', /avb-d:[0-9a-f]{64}:src\/pages\/index\.astro/);
  } finally {
    await dispose();
  }
});

test('what the marker plugin does not own still falls to the competitor', async () => {
  const { load, dispose, root } = await serve([claimingPlugin()]);
  try {
    // Outside src/ marking declines, so the competitor's load is the one that answers.
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(root, 'other', 'Outside.astro'), PAGE);
    assert.equal(await load('other/Outside.astro'), COMPETITOR_SOURCE, 'a file the markers decline is served by the plugin that claims it');
  } finally {
    await dispose();
  }
});
