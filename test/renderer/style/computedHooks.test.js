// Goal: the style panel's computed-value hooks drop answers that arrive for a
// stale selection or document, and a swatch with a literal color never
// re-renders because of a canvas query.
// Method: the hooks are bundled with the canvas query replaced by a probe that
// hands each request's resolver to the test, mounted in jsdom, and resolved out
// of order while render counts are recorded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, stubSources } = require('../../helpers/sources.js');

// The canvas protocol answers an unresolved value as absent (`undefined`); the
// probe hands it over as the wire carries it.

test('computed hooks discard stale selections and ' + 'documents without waking literal swatches', async () => {
  const rootPath = ROOT;
  const outfile = path.join(rootPath, 'node_modules/.stacki-test/computed-hooks.bundle.js');
  await require('esbuild').build({
    stdin: {
      contents: `export { useResolvedColor, forgetComputedColors }
          from './src/features/style/model/computedColor';
        export { useHighlight, forgetComputedStyles }
          from './src/features/style/model/computedStyle';
        export { setHost } from './src/features/style/model/host';`,
      loader: 'ts',
      resolveDir: rootPath,
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['react'],
    logLevel: 'silent',
    plugins: [
      stubSources('canvas-probe', {
        'src/editor/canvasQuery.ts': () => ({
          contents: `export const onCanvasReady = () => () => {};
    export const hasCanvas = () => true;
          export const queryCanvas = (path, selectors, colors, props = []) =>
            new Promise((resolve) => {
            globalThis.__computedQueries.push({ path, colors, props, resolve });
          });`,
          loader: 'js',
        }),
      }),
    ],
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.__computedQueries = [];
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useResolvedColor, useHighlight, setHost, forgetComputedColors, forgetComputedStyles } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const renders = { literal: 0, resolved: 0 };
  const Swatch = React.memo(({ name, value }) => {
    renders[name]++;
    const result = useResolvedColor(value);
    return React.createElement('output', { id: name }, result);
  });
  const Style = () => React.createElement('output', { id: 'style' }, useHighlight('', 'display', ['block', 'flex', 'grid'], 'block'));
  const read = (id) => document.getElementById(id).textContent;
  const flush = async () => {
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  };
  const switchTo = async (selectedId, openFilePath = '/project/page.astro') => {
    await React.act(async () => setHost({ selectedId, openFilePath }));
    await flush();
    return global.__computedQueries.splice(0);
  };
  const answer = async (batch, color, display) => {
    await React.act(async () => {
      for (const query of batch) {
        query.resolve({
          computed: Object.fromEntries(query.colors.map((key) => [key, color])),
          computedProps: Object.fromEntries(query.props.map((key) => [key, display])),
          identity: { tag: 'div' },
        });
      }
    });
  };

  try {
    setHost({
      projectPath: '/project',
      openFilePath: '/project/page.astro',
      selectedId: 'a',
      nodes: [
        { id: 'a', kind: 'element', name: 'div' },
        { id: 'b', kind: 'element', name: 'div' },
      ],
      pathOf: (id) => (id === 'a' ? '0' : '1'),
    });
    await React.act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          {},
          React.createElement(Swatch, { name: 'literal', value: '#abc' }),
          React.createElement(Swatch, { name: 'resolved', value: 'var(--brand)' }),
          React.createElement(Style),
        ),
      ),
    );
    await flush();
    const first = global.__computedQueries.splice(0);
    assert.equal(first.length, 2);
    const literalRenders = renders.literal;
    const second = await switchTo('b');
    assert.equal(second.length, 2);
    assert.ok(second.every((query) => query.path === '1'));
    await answer(second, 'rgb(0 0 255)', 'grid');
    assert.equal(read('resolved'), 'rgb(0 0 255)');
    assert.equal(read('style'), 'grid');
    await answer(first, 'rgb(255 0 0)', 'flex');
    assert.equal(read('resolved'), 'rgb(0 0 255)', 'a late answer cannot recolor the new selection');
    assert.equal(read('style'), 'grid', 'a late answer cannot restyle the new selection');
    assert.equal(renders.literal, literalRenders, 'literal swatches do not subscribe to cache or host updates');

    const changedFile = await switchTo('b', '/project/other.astro');
    assert.equal(changedFile.length, 2, 'the same path in another document is queried again');
    assert.equal(read('resolved'), 'var(--brand)', "the previous document's color is not returned");
    await answer(changedFile, undefined, undefined);
    assert.equal(read('style'), 'block', 'a missing answer settles onto the fallback');
    assert.equal(read('resolved'), 'var(--brand)');
    await flush();
    assert.equal(global.__computedQueries.length, 0, 'settled misses do not retry forever');

    await React.act(async () => {
      forgetComputedColors();
      forgetComputedStyles();
    });
    await flush();
    assert.equal(global.__computedQueries.length, 2, 'explicit invalidation asks the canvas again');
  } finally {
    await React.act(async () => root.unmount());
    forgetComputedColors();
    forgetComputedStyles();
    dom.window.close();
    delete global.__computedQueries;
    delete global.window;
    delete global.document;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
