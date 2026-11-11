// Goal: the first open of a left-rail panel in a session paints its content in
// its first frame. It used to flicker: a lazy panel committed an empty frame
// while React.lazy resolved its chunk, even a chunk already fetched, and a
// panel with a per-project data cache painted its loading skeleton until its
// first read returned. The app now preloads the chunks and prewarms the caches
// after a project opens (src/app/shell/panelPrefetch.ts).
//
// Method: the real lazyPanel and usePanelData are bundled and mounted in jsdom.
// Each render is committed synchronously (a non-async act), so what the DOM
// holds afterwards is the first frame the user would see. The baseline proves
// the measurement: without preload the first frame is empty. Then a preloaded
// panel must be there in its first frame; an instance mounted before its chunk
// arrived must keep its state when the chunk lands (no remount); and a
// prewarmed cache must open on its data rather than on the loading state, while
// a failed prewarm and an existing entry are left alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const create = React.createElement;

let modules;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/panel-first-open.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `export { lazyPanel } from './src/app/lazyPanel'; export { createPanelCache, prewarmPanelCache, usePanelData } from './src/lib/usePanelData';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  modules = require(outfile);
});

// A panel with local state, so a remount would show as a reset count.
function CountingPanel({ label }) {
  const [count, setCount] = React.useState(0);
  return create('button', { 'data-panel': label, onClick: () => setCount((value) => value + 1) }, `${label} ${count}`);
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    // Synchronous: the DOM afterwards is the first committed frame.
    render: (element) => act(() => root.render(element)),
    settle: () => act(async () => new Promise((resolve) => setTimeout(resolve, 10))),
    unmount: () => act(() => root.unmount()),
  };
}

test('baseline: without a preload the first frame of a lazy panel is empty', async () => {
  const Panel = modules.lazyPanel(async () => ({ default: CountingPanel }));
  const view = mount();
  view.render(create(Panel, { label: 'cold' }));
  assert.ok(view.host.querySelector('[data-panel]') === null, 'React.lazy suspends on its first render');
  await view.settle();
  assert.equal(view.host.textContent, 'cold 0');
  view.unmount();
});

test('a preloaded panel paints its content in its first frame', async () => {
  let loads = 0;
  const Panel = modules.lazyPanel(async () => {
    loads += 1;
    return { default: CountingPanel };
  });
  await Panel.preload();
  await Panel.preload();
  assert.equal(loads, 1, 'The chunk is fetched once');
  const view = mount();
  view.render(create(Panel, { label: 'warm' }));
  assert.equal(view.host.textContent, 'warm 0', 'No empty frame before the panel');
  view.unmount();
});

test('a panel mounted before its chunk keeps its state after the chunk lands', async () => {
  const Panel = modules.lazyPanel(async () => ({ default: CountingPanel }));
  const view = mount();
  view.render(create(Panel, { label: 'early' }));
  await view.settle();
  await act(async () => view.host.querySelector('button').click());
  assert.equal(view.host.textContent, 'early 1');
  view.render(create(Panel, { label: 'early' }));
  assert.equal(view.host.textContent, 'early 1', 'A rerender after loading does not remount the panel');
  view.unmount();
});

test('a failed preload is retried by the next open', async () => {
  let attempt = 0;
  const Panel = modules.lazyPanel(async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('offline');
    }
    return { default: CountingPanel };
  });
  await assert.rejects(Panel.preload(), /offline/);
  await Panel.preload();
  assert.equal(attempt, 2);
  const view = mount();
  view.render(create(Panel, { label: 'retried' }));
  assert.equal(view.host.textContent, 'retried 0');
  view.unmount();
});

function DataPanel({ cache }) {
  const read = React.useCallback(async () => ({ ok: true, value: 'fresh' }), []);
  const subscribe = React.useCallback(() => () => {}, []);
  const { state } = modules.usePanelData(cache, '/project', read, subscribe);
  return create('div', { 'data-state': state.kind }, state.kind === 'ready' ? state.value : '');
}

test('a prewarmed panel cache opens on its data, not on its loading state', async () => {
  const cold = modules.createPanelCache();
  const coldView = mount();
  coldView.render(create(DataPanel, { cache: cold }));
  assert.equal(coldView.host.querySelector('[data-state]').dataset.state, 'loading', 'baseline: an empty cache opens loading');
  await coldView.settle();
  coldView.unmount();

  const warm = modules.createPanelCache();
  await modules.prewarmPanelCache(warm, '/project', async () => ({ ok: true, value: 'prewarmed' }));
  const warmView = mount();
  warmView.render(create(DataPanel, { cache: warm }));
  assert.equal(warmView.host.querySelector('[data-state]').dataset.state, 'ready');
  assert.equal(warmView.host.textContent, 'prewarmed', 'The first frame shows the prewarmed data');
  await warmView.settle();
  assert.equal(warmView.host.textContent, 'fresh', 'The panel still revalidates');
  warmView.unmount();
});

test('a prewarm leaves an existing entry and a failed read alone', async () => {
  const cache = modules.createPanelCache();
  await modules.prewarmPanelCache(cache, '/project', async () => ({ ok: false, error: 'unreadable' }));
  assert.equal(cache.get('/project'), undefined, 'A failure is never cached as data');
  cache.set('/project', 'panel read');
  let reads = 0;
  await modules.prewarmPanelCache(cache, '/project', async () => {
    reads += 1;
    return { ok: true, value: 'older' };
  });
  assert.equal(reads, 0, 'A filled entry is not read again');
  assert.deepEqual(cache.get('/project'), { kind: 'ready', value: 'panel read' });
  // A read that lands after a panel filled the entry does not overwrite it.
  const late = modules.createPanelCache();
  await modules.prewarmPanelCache(late, '/project', async () => {
    late.set('/project', 'newer');
    return { ok: true, value: 'stale' };
  });
  assert.deepEqual(late.get('/project'), { kind: 'ready', value: 'newer' });
  await assert.rejects(
    modules.prewarmPanelCache(cache, '', async () => ({ ok: true, value: 'x' })),
    /prewarmPanelCache: the cache entry has a key/,
  );
});

test('the app shell prefetches the panels when a project opens', () => {
  const shell = fs.readFileSync(repoPath('src/app/shell/AppShell.tsx'), 'utf8');
  assert.match(
    shell,
    /useEffect\(\(\) => prefetchPanels\(\{ projectPath, preloadChunks: preloadPanels, hostReads: desktopPanelReads\(projectPath\) \}\), \[projectPath\]\)/,
  );
  for (const read of ['prewarmPageOrder', 'prewarmInstalledApps', 'prewarmKeepList', 'prewarmInstructionsListing']) {
    assert.ok(shell.includes(`() => ${read}(projectPath)`), `Desktop's prefetch pass includes ${read}`);
  }
  assert.match(shell, /prefetchTimeline\(projectPath, gitBranch, gitHead\)/);
  const prefetch = fs.readFileSync(repoPath('src/app/shell/panelPrefetch.ts'), 'utf8');
  for (const step of [
    'preloadChunks',
    'prefetchAstroHighlighter',
    'prewarmVariables',
    'prewarmAssetListing',
    'prewarmCmsCatalog',
    'prewarmCmsConnections',
    'hostReads',
  ]) {
    assert.ok(prefetch.includes(step), `The prefetch pass includes ${step}`);
  }
});

test('Studio prefetches the same panels when a project opens', () => {
  // Studio vendors panelPrefetch.ts and runs the same pass under the key its panels read
  // the project by ('studio'); its panels are in the main bundle, so there are no chunks.
  const sources = JSON.parse(fs.readFileSync(repoPath('studio/scripts/shared-source.json'), 'utf8'));
  assert.ok(sources.files.includes('src/app/shell/panelPrefetch.ts'), 'Studio vendors the prefetch pass');
  const editor = fs.readFileSync(repoPath('studio/src/app/Editor.tsx'), 'utf8');
  assert.match(editor, /prefetchPanels\(\{ projectPath: 'studio', preloadChunks: undefined, hostReads: \[\] \}\)/);
});
